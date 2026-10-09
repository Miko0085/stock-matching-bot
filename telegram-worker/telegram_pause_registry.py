"""
telegram_pause_registry.py — per-account "paused" flag, persisted to
state/paused_accounts.json so it survives a worker restart.

When an account is paused, make_new_message_handler() (telegram_events.py)
skips ALL processing for its inbound events -- no webhook forwarding, no
private-reply debounce, no outbound tracking -- as if the worker weren't
listening at all, while the account itself stays fully connected (Telegram
still delivers events to this process; the worker just declines to act on
or forward any of them).

Deliberately NOT the same as logout (telegram_adapter.manager.
logout_account): the session, its connection, and all channels/routing/
monitoring config remain completely untouched -- only whether events get
PROCESSED changes. Resuming needs no re-login, no QR, nothing but
POST /telegram/accounts/resume.

Same atomic-write pattern as telegram_monitor_registry.py (write to a temp
file in the same directory, then os.replace()) so a crash or concurrent
read never observes a partially-written file.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List

from worker_logging import log_action

logger = logging.getLogger("telegram_pause_registry")


def _log(message: str, level: int = logging.INFO, **fields: Any) -> None:
    log_action(logger, message, level, **fields)


class PausedAccountsRegistry:
    def __init__(self, state_path: Path) -> None:
        self._state_path = state_path
        self._lock = threading.Lock()
        self._paused: Dict[str, str] = {}  # account_id -> ISO timestamp paused_at
        self._load()

    def _load(self) -> None:
        if not self._state_path.exists():
            self._paused = {}
            return
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8") or "{}")
            self._paused = {str(k): str(v) for k, v in dict(raw.get("paused") or {}).items()}
        except Exception as e:
            _log(
                "pause_registry_load_failed",
                level=logging.ERROR,
                path=str(self._state_path),
                error=f"{type(e).__name__}: {e}",
            )
            self._paused = {}

    def _persist_locked(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"paused": self._paused}, ensure_ascii=False, indent=2)
        fd, tmp_path = tempfile.mkstemp(
            dir=str(self._state_path.parent), prefix=".paused_accounts-", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            os.replace(tmp_path, self._state_path)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def is_paused(self, account_id: str) -> bool:
        with self._lock:
            return str(account_id or "") in self._paused

    def pause(self, account_id: str) -> Dict[str, Any]:
        account_id = str(account_id or "").strip()
        if not account_id:
            raise ValueError("account_id is required")
        with self._lock:
            if account_id not in self._paused:
                self._paused[account_id] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                self._persist_locked()
            paused_at = self._paused[account_id]
        _log("telegram_account_paused", account_id=account_id)
        return {"account_id": account_id, "paused": True, "paused_at": paused_at}

    def resume(self, account_id: str) -> Dict[str, Any]:
        account_id = str(account_id or "").strip()
        with self._lock:
            was_paused = account_id in self._paused
            if was_paused:
                del self._paused[account_id]
                self._persist_locked()
        if was_paused:
            _log("telegram_account_resumed", account_id=account_id)
        return {"account_id": account_id, "paused": False, "was_paused": was_paused}

    def list_paused(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [{"account_id": k, "paused_at": v} for k, v in sorted(self._paused.items())]
