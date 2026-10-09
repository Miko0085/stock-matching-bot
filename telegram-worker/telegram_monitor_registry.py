"""
telegram_monitor_registry.py — a small, persistent, worker-local registry
of dynamically-added monitored (account_id, chat_id) pairs
(state/monitored_chats.json), so POST /telegram/join can enable monitoring
for a newly-joined group WITHOUT rewriting .env and WITHOUT restarting the
worker.

Implements the same is_monitored(account_id, chat_id) interface as
telegram_events.MonitoredChatsProvider (in fact subclasses it), so it is a
drop-in replacement wherever the env-only provider was used: the runtime
lookup merges (1) the static TELEGRAM_MONITOR_CHAT_IDS list and (2) this
persistent dynamic list, in memory, with no added latency on the hot
message-received path.

ACCOUNT SCOPING (AUDIT item #3 release blocker): identity here MUST match
the same principle used everywhere else in this project (source catalog,
event dedup) -- (account_id, chat_id), never chat_id alone. Two different
Telegram accounts can independently be members of the same chat_id (a
public group both accounts joined, or -- worse -- Telegram's own id space
is not guaranteed disjoint across very different chat types); enabling
monitoring for account A must never make account B's traffic in a
same-numbered chat_id monitored too. Entries are keyed on the composite
string f"{account_id}:{chat_id}".

No secrets or credentials are ever stored here -- only chat_id/account_id
and display metadata (title/username/added_at).
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from telegram_events import MonitoredChatsProvider
from worker_logging import log_action

logger = logging.getLogger("telegram_monitor_registry")


def _log(message: str, level: int = logging.INFO, **fields: Any) -> None:
    log_action(logger, message, level, **fields)


class DynamicMonitoredChatsRegistry(MonitoredChatsProvider):
    def __init__(self, state_path: Path, static_chat_ids: Optional[Set[str]] = None) -> None:
        self._state_path = state_path
        # Legacy/bootstrap only (AGENTS.md: env allowlists are migration
        # fallback, not the long-term control plane) -- TELEGRAM_MONITOR_
        # CHAT_IDS has no per-account concept by design. This is a
        # documented compatibility limitation of the STATIC half only; it
        # must never be used as a reason to weaken the DYNAMIC half's
        # account-scoped isolation below.
        self._static_chat_ids: Set[str] = set(static_chat_ids or set())
        self._lock = threading.Lock()
        self._entries: Dict[str, Dict[str, Any]] = {}
        self._load()

    # ------------------------------------------------------------
    # Persistence (atomic: write to a temp file in the same directory,
    # then os.replace() -- a crash or concurrent read never observes a
    # partially-written file).
    # ------------------------------------------------------------

    @staticmethod
    def _key(account_id: str, chat_id: str) -> str:
        return f"{account_id}:{chat_id}"

    def _load(self) -> None:
        if not self._state_path.exists():
            self._entries = {}
            return
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8") or "{}")
            chats = dict(raw.get("chats") or {})
        except Exception as e:
            _log(
                "monitor_registry_load_failed",
                level=logging.ERROR,
                path=str(self._state_path),
                error=f"{type(e).__name__}: {e}",
            )
            chats = {}

        entries: Dict[str, Dict[str, Any]] = {}
        for raw_key, raw_meta in chats.items():
            meta = dict(raw_meta or {})
            account_id = str(meta.get("account_id") or "").strip()
            chat_id = str(meta.get("chat_id") or raw_key)

            if not account_id:
                # Migration rule (AUDIT item #3): a pre-account-scoping
                # entry with no recorded account_id must NEVER be silently
                # enabled for every account. It is dropped from the active
                # registry entirely (inert) rather than guessed -- logged
                # loudly so an operator notices and re-adds it explicitly
                # (e.g. via POST /telegram/join with monitor=true).
                _log(
                    "monitor_registry_legacy_entry_without_account_dropped",
                    level=logging.WARNING,
                    chat_id=chat_id,
                )
                continue

            key = self._key(account_id, chat_id)
            entries[key] = {**meta, "account_id": account_id, "chat_id": chat_id}

        self._entries = entries

    def _persist_locked(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"chats": self._entries}, ensure_ascii=False, indent=2)
        fd, tmp_path = tempfile.mkstemp(
            dir=str(self._state_path.parent), prefix=".monitored_chats-", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            os.replace(tmp_path, self._state_path)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    # ------------------------------------------------------------
    # MonitoredChatsProvider interface
    # ------------------------------------------------------------

    @property
    def configured_count(self) -> int:
        # A simple sum, not a union: a chat_id monitored dynamically for
        # two different accounts is now legitimately two distinct
        # configurations, not one (this is the whole point of the fix).
        with self._lock:
            return len(self._static_chat_ids) + len(self._entries)

    def is_monitored(self, account_id: str, chat_id: str) -> bool:
        chat_id = str(chat_id)
        account_id = str(account_id or "")
        with self._lock:
            if chat_id in self._static_chat_ids:
                return True
            return self._key(account_id, chat_id) in self._entries

    # ------------------------------------------------------------
    # Mutation -- called from the /telegram/join and
    # /telegram/monitored-chats routes.
    # ------------------------------------------------------------

    def add(self, account_id: str, chat_id: str, *, title: str = "", username: str = "") -> None:
        """Idempotent upsert -- adding an already-registered (account_id,
        chat_id) pair again updates its metadata in place rather than
        creating a duplicate. `account_id` is required: this registry's
        whole purpose is per-account isolation, so a caller that doesn't
        know its account must resolve one first (telegram_adapter.
        resolve_account_id) rather than register an unscoped entry."""
        import datetime

        account_id = str(account_id or "").strip()
        chat_id = str(chat_id)
        if not account_id:
            raise ValueError("account_id is required to add a dynamically monitored chat")

        key = self._key(account_id, chat_id)
        with self._lock:
            existing = self._entries.get(key, {})
            self._entries[key] = {
                "account_id": account_id,
                "chat_id": chat_id,
                "title": title or existing.get("title", ""),
                "username": username or existing.get("username", ""),
                "added_at": existing.get("added_at") or datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            self._persist_locked()
        _log("monitor_registry_chat_added", account_id=account_id, chat_id=chat_id)

    def remove(self, account_id: str, chat_id: str) -> bool:
        key = self._key(str(account_id or ""), str(chat_id))
        with self._lock:
            if key not in self._entries:
                return False
            del self._entries[key]
            self._persist_locked()
        _log("monitor_registry_chat_removed", account_id=account_id, chat_id=chat_id)
        return True

    def list_dynamic(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(meta) for _, meta in sorted(self._entries.items())]
