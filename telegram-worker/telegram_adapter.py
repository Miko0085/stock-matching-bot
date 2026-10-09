from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import random
import re
from dataclasses import dataclass, field
from datetime import timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.errors import UserNotParticipantError

from worker_logging import log_action


PROJECT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PROJECT_ROOT.parent

# Load telegram-worker/.env first (new per-worker layout). Fall back to a
# repo-root .env so the existing single .env with real secrets keeps working
# during the migration to per-worker env files. load_dotenv() never raises
# and never overrides variables already set by an earlier call.
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(REPO_ROOT / ".env")

TELEGRAM_API_ID = int(os.getenv("TELEGRAM_API_ID", "0"))
TELEGRAM_API_HASH = os.getenv("TELEGRAM_API_HASH", "")
TELEGRAM_SESSIONS_DIR = Path(
    os.getenv("TELEGRAM_SESSIONS_DIR", str(PROJECT_ROOT / "sessions"))
)
TELEGRAM_DEFAULT_ACCOUNT = os.getenv("TELEGRAM_DEFAULT_ACCOUNT", "").strip()

ACCOUNT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

logger = logging.getLogger("telegram_adapter")


def _log(message: str, level: int = logging.INFO, **fields: Any) -> None:
    log_action(logger, message, level, **fields)


# ============================================================
# ERRORS
#
# Typed exceptions so worker_api.py can map them to precise HTTP status
# codes instead of leaking tracebacks or always returning 500.
# ============================================================

class TelegramWorkerError(Exception):
    """Base class for expected/handled Telegram worker errors."""
    status_code = 500


class ConfigError(TelegramWorkerError):
    """Worker is missing required configuration (API id/hash, etc)."""
    status_code = 500


class InvalidAccountIdError(TelegramWorkerError):
    """account_id failed validation or was required but not supplied."""
    status_code = 400


class AccountNotFoundError(TelegramWorkerError):
    """account_id is well-formed but no matching session exists."""
    status_code = 404


class AccountNotAuthorizedError(TelegramWorkerError):
    """Session file exists but Telegram does not consider it authorized."""
    status_code = 409


class AccountUnavailableError(TelegramWorkerError):
    """Session is known and authorized, but not currently connected."""
    status_code = 503


class InvalidRequestError(TelegramWorkerError):
    """Request payload is missing/invalid fields unrelated to account_id."""
    status_code = 400


def make_hash(*parts: Any) -> str:
    raw = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def normalize_telegram_datetime(dt):
    if not dt:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate_account_id(account_id: str) -> str:
    value = str(account_id or "").strip()
    if not ACCOUNT_ID_RE.fullmatch(value):
        raise InvalidAccountIdError(
            "Invalid account_id. Use 1-64 characters: letters, numbers, underscore or hyphen only."
        )
    return value


def list_session_account_ids() -> List[str]:
    TELEGRAM_SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    return sorted(p.stem for p in TELEGRAM_SESSIONS_DIR.glob("*.session") if p.is_file())


def resolve_account_id(account_id: Optional[str] = None, require_existing: bool = True) -> str:
    """
    Resolve and validate an account_id. Never creates a session and never
    silently substitutes a different account than the one requested:
    TELEGRAM_DEFAULT_ACCOUNT is only consulted when the caller supplies no
    account_id at all — an explicit-but-unknown account_id always raises.
    """
    supplied = str(account_id or "").strip()
    if supplied:
        resolved = validate_account_id(supplied)
    elif TELEGRAM_DEFAULT_ACCOUNT:
        resolved = validate_account_id(TELEGRAM_DEFAULT_ACCOUNT)
    else:
        accounts = list_session_account_ids()
        if len(accounts) == 1:
            resolved = accounts[0]
        elif not accounts:
            raise AccountNotFoundError("No Telegram sessions found. Add an account session first.")
        else:
            raise InvalidAccountIdError(
                "account_id is required because multiple Telegram accounts exist."
            )

    if require_existing and not (TELEGRAM_SESSIONS_DIR / f"{resolved}.session").exists():
        raise AccountNotFoundError(f"Telegram account session not found: {resolved}")
    return resolved


# ============================================================
# PERSISTENT CLIENT MANAGER
#
# One TelegramClient per account_id, created once and kept connected for
# the worker's entire lifetime (started at FastAPI startup, disconnected
# at shutdown) instead of connect()/disconnect() on every HTTP call. A
# problem with one account's client (reconnect, auth loss) is isolated to
# that account's own state and its own background watch task.
# ============================================================

NewMessageHandler = Callable[[str, "events.NewMessage.Event"], Awaitable[None]]


@dataclass
class TelegramAccountState:
    account_id: str
    client: Optional[TelegramClient] = None
    # pending|connecting|connected|disconnected|unauthorized|error
    # "pending" (not "connecting") is the default so a freshly-created
    # state doesn't immediately trip connect_account()'s "already in
    # progress" guard before the first real connection attempt runs.
    status: str = "pending"
    authorized: bool = False
    connected: bool = False
    last_error: Optional[str] = None
    user_id: str = ""
    username: str = ""
    name: str = ""
    handler_attached: bool = False
    watch_task: Optional[asyncio.Task] = field(default=None, repr=False)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


class TelegramClientManager:
    def __init__(self) -> None:
        self._accounts: Dict[str, TelegramAccountState] = {}
        self._on_new_message: Optional[NewMessageHandler] = None

    def set_new_message_handler(self, callback: Optional[NewMessageHandler]) -> None:
        self._on_new_message = callback

    # ------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------

    async def start(self) -> None:
        account_ids = list_session_account_ids()
        if not account_ids:
            _log("telegram_manager_no_sessions", detail="sessions dir is empty at startup")
            return

        results = await asyncio.gather(
            *(self.connect_account(account_id) for account_id in account_ids),
            return_exceptions=True,
        )
        for account_id, result in zip(account_ids, results):
            if isinstance(result, Exception):
                # connect_account() catches its own errors internally and
                # never raises; this is a last-resort safety net only.
                _log(
                    "telegram_manager_start_unexpected_error",
                    level=logging.ERROR,
                    account_id=account_id,
                    error=f"{type(result).__name__}: {result}",
                )

    async def shutdown(self) -> None:
        for state in list(self._accounts.values()):
            if state.watch_task is not None:
                state.watch_task.cancel()
                try:
                    await state.watch_task
                except (asyncio.CancelledError, Exception):
                    pass
                state.watch_task = None
            if state.client is not None:
                try:
                    await state.client.disconnect()
                except Exception as e:
                    _log(
                        "telegram_disconnect_error",
                        level=logging.WARNING,
                        account_id=state.account_id,
                        error=f"{type(e).__name__}: {e}",
                    )
        _log("telegram_manager_shutdown_complete", accounts=len(self._accounts))

    # ------------------------------------------------------------
    # Connect / reconnect
    # ------------------------------------------------------------

    async def connect_account(self, account_id: str) -> TelegramAccountState:
        state = self._accounts.get(account_id)
        if state is None:
            state = TelegramAccountState(account_id=account_id)
            self._accounts[account_id] = state

        async with state.lock:
            if state.status in ("connecting", "connected"):
                return state  # already in progress or already live

            state.status = "connecting"
            state.last_error = None
            state.handler_attached = False

            if not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
                state.status = "error"
                state.last_error = "TELEGRAM_API_ID or TELEGRAM_API_HASH is missing in .env"
                _log("telegram_account_config_error", level=logging.ERROR, account_id=account_id)
                self._schedule_retry(state)
                return state

            try:
                session_path = str(TELEGRAM_SESSIONS_DIR / account_id)
                client = TelegramClient(session_path, TELEGRAM_API_ID, TELEGRAM_API_HASH)
                await client.connect()
                state.client = client

                if not await client.is_user_authorized():
                    state.status = "unauthorized"
                    state.authorized = False
                    state.connected = False
                    _log(
                        "telegram_account_unauthorized",
                        level=logging.WARNING,
                        account_id=account_id,
                        detail=f"run: python telegram_qr_login_account.py {account_id}",
                    )
                    return state

                me = await client.get_me()
                state.authorized = True
                state.connected = True
                state.status = "connected"
                state.user_id = str(getattr(me, "id", "") or "")
                state.username = str(getattr(me, "username", "") or "")
                state.name = " ".join(
                    x for x in [
                        str(getattr(me, "first_name", "") or "").strip(),
                        str(getattr(me, "last_name", "") or "").strip(),
                    ] if x
                )

                self._attach_new_message_handler(state)

                if state.watch_task is None or state.watch_task.done():
                    state.watch_task = asyncio.create_task(self._watch_account(state))

                _log("telegram_account_connected", account_id=account_id, username=state.username)
            except Exception as e:
                state.status = "error"
                state.last_error = f"{type(e).__name__}: {e}"
                state.connected = False
                _log(
                    "telegram_account_connect_failed",
                    level=logging.ERROR,
                    account_id=account_id,
                    error=state.last_error,
                )
                self._schedule_retry(state)

        return state

    def _schedule_retry(self, state: TelegramAccountState, delay: float = 5.0) -> None:
        if state.watch_task is not None and not state.watch_task.done():
            return  # a retry/watch loop is already scheduled/running for this account
        state.watch_task = asyncio.create_task(self._retry_after_error(state, delay))

    async def _retry_after_error(self, state: TelegramAccountState, delay: float) -> None:
        await asyncio.sleep(delay)
        await self.connect_account(state.account_id)

    async def _watch_account(self, state: TelegramAccountState) -> None:
        """
        One long-lived task per account: waits for the client to
        disconnect, then attempts to reconnect with capped exponential
        backoff (never a login attempt — the existing session is reused
        as-is). Exits for good (no further reconnect attempts) the moment
        the session is found to be unauthorized, per account, so a single
        revoked session cannot spin forever nor affect any other account.
        """
        client = state.client
        assert client is not None
        backoff = 3.0

        while True:
            try:
                await client.disconnected
            except asyncio.CancelledError:
                raise
            except Exception:
                pass

            if state.status == "unauthorized":
                return

            state.status = "disconnected"
            state.connected = False
            _log("telegram_account_disconnected", level=logging.WARNING, account_id=state.account_id)

            while True:
                await asyncio.sleep(backoff)
                try:
                    await client.connect()
                    if not await client.is_user_authorized():
                        state.status = "unauthorized"
                        state.authorized = False
                        state.connected = False
                        _log(
                            "telegram_account_unauthorized",
                            level=logging.WARNING,
                            account_id=state.account_id,
                            detail="no longer authorized after reconnect attempt; giving up",
                        )
                        return
                    state.status = "connected"
                    state.connected = True
                    state.last_error = None
                    backoff = 3.0
                    _log("telegram_account_reconnected", account_id=state.account_id)
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    state.last_error = f"{type(e).__name__}: {e}"
                    backoff = min(backoff * 2, 60.0)
                    _log(
                        "telegram_account_reconnect_failed",
                        level=logging.WARNING,
                        account_id=state.account_id,
                        error=state.last_error,
                        next_retry_seconds=backoff,
                    )
            # loop back to `await client.disconnected` to watch for the next drop

    def _attach_new_message_handler(self, state: TelegramAccountState) -> None:
        if state.handler_attached or state.client is None:
            return
        client = state.client
        account_id = state.account_id
        manager = self

        @client.on(events.NewMessage)
        async def _on_new_message(event):  # noqa: ANN001
            await manager._dispatch_new_message(account_id, event)

        state.handler_attached = True

    async def _dispatch_new_message(self, account_id: str, event) -> None:
        if self._on_new_message is None:
            return
        try:
            await self._on_new_message(account_id, event)
        except Exception:
            logger.exception("[%s] error in new-message handler", account_id)

    # ------------------------------------------------------------
    # Access for routes
    # ------------------------------------------------------------

    async def get_client(self, account_id: Optional[str] = None) -> TelegramClient:
        """
        Resolve account_id (format + on-disk existence, same rules as
        before) and return its live, connected TelegramClient. Raises a
        precise TelegramWorkerError subclass otherwise — never falls back
        to a different account.
        """
        resolved = resolve_account_id(account_id)
        state = self._accounts.get(resolved)

        if state is None:
            # Session file exists on disk (resolve_account_id already
            # confirmed that) but the manager hasn't loaded it yet — e.g.
            # it was created by telegram_qr_login_account.py after this
            # worker process started. Connect it now, on demand.
            state = await self.connect_account(resolved)

        if state.status == "unauthorized":
            raise AccountNotAuthorizedError(
                f"Telegram account '{resolved}' is not authorized. "
                f"Run: python telegram_qr_login_account.py {resolved}"
            )
        if not state.connected or state.client is None:
            raise AccountUnavailableError(
                f"Telegram account '{resolved}' is not connected (status: {state.status})."
            )
        return state.client

    async def adopt_authorized_client(self, account_id: str, client: TelegramClient) -> TelegramAccountState:
        """
        Registers an already-connected, already-authorized TelegramClient
        (produced by a fresh QR login in telegram_login.py) as this
        account's live persistent client — the same end state
        connect_account() reaches on its success branch, without repeating
        the connect()/is_user_authorized() calls it already performed.
        """
        state = self._accounts.get(account_id)
        if state is None:
            state = TelegramAccountState(account_id=account_id)
            self._accounts[account_id] = state

        async with state.lock:
            me = await client.get_me()
            state.client = client
            state.authorized = True
            state.connected = True
            state.status = "connected"
            state.last_error = None
            state.user_id = str(getattr(me, "id", "") or "")
            state.username = str(getattr(me, "username", "") or "")
            state.name = " ".join(
                x for x in [
                    str(getattr(me, "first_name", "") or "").strip(),
                    str(getattr(me, "last_name", "") or "").strip(),
                ] if x
            )
            state.handler_attached = False
            self._attach_new_message_handler(state)
            if state.watch_task is None or state.watch_task.done():
                state.watch_task = asyncio.create_task(self._watch_account(state))

        _log("telegram_account_connected", account_id=account_id, username=state.username, via="qr_login")
        return state

    async def logout_account(self, account_id: str) -> None:
        """
        Logs out on Telegram's side — Telethon's client.log_out() both
        invalidates the auth key server-side and deletes the local session
        file, the same as a manual "terminate this session" from Telegram
        settings. Marks the in-memory state so the account shows as
        needing re-auth. Touches no other account, and touches no
        dashboard-side DB row at all: this worker has no DB access
        (transport-only, per MARKET_CONTOURS_AND_SOURCE_ROUTING.md
        section 16), so channels/routing/monitoring config and match
        history are entirely unaffected by a logout here.
        """
        state = self._accounts.get(account_id)
        if state is None or state.client is None or not state.connected:
            raise AccountUnavailableError(f"Telegram account '{account_id}' is not connected.")

        async with state.lock:
            if state.watch_task is not None:
                state.watch_task.cancel()
                try:
                    await state.watch_task
                except (asyncio.CancelledError, Exception):
                    pass
                state.watch_task = None
            try:
                await state.client.log_out()
            except Exception as e:
                _log(
                    "telegram_logout_error",
                    level=logging.WARNING,
                    account_id=account_id,
                    error=f"{type(e).__name__}: {e}",
                )
            state.client = None
            state.connected = False
            state.authorized = False
            state.status = "unauthorized"
            state.handler_attached = False

        _log("telegram_account_logged_out", account_id=account_id)

    def is_client_open(self, account_id: str) -> bool:
        """
        True if this manager currently holds an open TelegramClient for
        account_id (connected & authorized, or connected-but-unauthorized —
        connect_account() sets state.client in both cases). Callers that
        might open a second TelegramClient on the same session file (e.g.
        telegram_login.py starting a QR login) must check this first: two
        TelegramClients on the same SQLite session file at once fails with
        'database is locked', or worse, races on the same auth key.
        """
        state = self._accounts.get(account_id)
        return state is not None and state.client is not None

    def list_accounts(self) -> List[Dict[str, Any]]:
        """Live in-memory status for every known account — no network calls."""
        known = sorted(set(self._accounts.keys()) | set(list_session_account_ids()))
        result: List[Dict[str, Any]] = []
        for account_id in known:
            state = self._accounts.get(account_id)
            if state is None:
                result.append({
                    "account_id": account_id,
                    "session_file": f"{account_id}.session",
                    "status": "not_loaded",
                    "authorized": False,
                    "connected": False,
                    "user_id": "",
                    "username": "",
                    "name": "",
                    "error": "",
                })
                continue
            result.append({
                "account_id": account_id,
                "session_file": f"{account_id}.session",
                "status": state.status,
                "authorized": state.authorized,
                "connected": state.connected,
                "user_id": state.user_id,
                "username": state.username,
                "name": state.name,
                "error": state.last_error or "",
            })
        return result

    def stats(self) -> Dict[str, int]:
        return {
            "persistent_clients": len(self._accounts),
            "connected_clients": sum(1 for s in self._accounts.values() if s.connected),
        }


# Module-level singleton: worker_api.py wires this up at startup/shutdown
# and every route uses it to fetch a persistent, already-connected client.
manager = TelegramClientManager()


# ============================================================
# OPERATIONS ON AN ALREADY-CONNECTED CLIENT
#
# These take a live client (from manager.get_client()) instead of
# managing their own connect/disconnect lifecycle.
# ============================================================

def _telegram_destination_type(dialog) -> str:
    if dialog.is_group:
        return "group"
    if dialog.is_channel:
        return "channel"
    if dialog.is_user:
        return "private"
    return "unknown"


async def _resolve_entity(client: TelegramClient, destination_id: str):
    raw = str(destination_id or "").strip()
    if not raw:
        raise InvalidRequestError("destination_id is required")

    numeric_body = raw[1:] if raw.startswith("-") else raw
    source: Any = int(raw) if numeric_body.isdigit() else raw

    try:
        return await client.get_entity(source)
    except ValueError:
        # Numeric IDs sometimes are not in Telethon's entity cache yet.
        # Fetch dialogs, match the canonical dialog.id, then use that entity.
        if numeric_body.isdigit():
            target = int(raw)
            dialogs = await client.get_dialogs(limit=None)
            for dialog in dialogs:
                if int(dialog.id) == target:
                    return dialog.entity
        raise


async def list_telegram_dialogs(
    client: TelegramClient,
    account_id: str,
    limit: int = 500,
    include_private: bool = True,
    include_groups: bool = True,
    include_channels: bool = True,
) -> List[Dict[str, Any]]:
    dialogs = await client.get_dialogs(limit=limit)
    result: List[Dict[str, Any]] = []
    for dialog in dialogs:
        destination_type = _telegram_destination_type(dialog)
        if destination_type == "private" and not include_private:
            continue
        if destination_type == "group" and not include_groups:
            continue
        if destination_type == "channel" and not include_channels:
            continue
        if destination_type == "unknown":
            continue

        entity = dialog.entity
        result.append({
            "account_id": account_id,
            "name": str(dialog.name or ""),
            "destination_id": str(dialog.id),
            "destination_type": destination_type,
            "username": str(getattr(entity, "username", "") or ""),
            "entity_type": type(entity).__name__,
            "is_private": destination_type == "private",
            "is_group": destination_type == "group",
            "is_channel": destination_type == "channel",
        })
    return result


async def send_telegram_message(
    client: TelegramClient,
    account_id: str,
    request: Dict[str, Any],
) -> Dict[str, Any]:
    destination_id = str(
        request.get("destination_id")
        or request.get("chat_id")
        or request.get("username")
        or ""
    ).strip()
    destination_type = str(request.get("destination_type") or "").strip().lower()
    message = str(request.get("message") or "").strip()
    parse_mode = request.get("parse_mode")
    silent = bool(request.get("silent", False))
    reply_to_message_id = request.get("reply_to_message_id")

    if not destination_id:
        raise InvalidRequestError("destination_id is required")
    if not message:
        raise InvalidRequestError("message is empty")

    entity = await _resolve_entity(client, destination_id)

    kwargs: Dict[str, Any] = {
        "parse_mode": parse_mode or None,
        "silent": silent,
    }
    if reply_to_message_id not in (None, ""):
        try:
            kwargs["reply_to"] = int(reply_to_message_id)
        except Exception:
            kwargs["reply_to"] = reply_to_message_id

    sent = await client.send_message(entity, message, **kwargs)
    entity_name = getattr(entity, "title", "") or getattr(entity, "first_name", "") or ""

    actual_type = destination_type
    if not actual_type:
        cls = type(entity).__name__.lower()
        if "user" in cls:
            actual_type = "private"
        elif "channel" in cls:
            actual_type = "group_or_channel"
        elif "chat" in cls:
            actual_type = "group"
        else:
            actual_type = "unknown"

    return {
        "status": "ok",
        "platform": "telegram",
        "account_id": account_id,
        "destination_id": destination_id,
        "destination_type": actual_type,
        "destination_name": str(entity_name),
        "destination_username": str(getattr(entity, "username", "") or ""),
        "message_id": str(getattr(sent, "id", "") or ""),
        "timestamp": normalize_telegram_datetime(getattr(sent, "date", None)),
        "message": message,
    }


async def poll_telegram_messages(
    client: TelegramClient,
    account_id: str,
    request: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Legacy generic /poll support — uses the persistent client, does not
    connect/disconnect its own."""
    source_platform_id = request.get("source_platform_id") or request.get("source_handle")
    if not source_platform_id:
        raise InvalidRequestError("source_platform_id or source_handle is required for Telegram polling")

    limit = int(request.get("limit") or 30)
    entity = await _resolve_entity(client, str(source_platform_id))
    raw_messages: List[Dict[str, Any]] = []

    async for message in client.iter_messages(entity, limit=limit):
        sender = None
        try:
            sender = await message.get_sender()
        except Exception:
            sender = None

        text = message.message or ""
        sender_id = ""
        sender_username = ""
        sender_name = ""

        if sender:
            sender_id = str(getattr(sender, "id", "") or "")
            sender_username = str(getattr(sender, "username", "") or "")
            first_name = str(getattr(sender, "first_name", "") or "")
            last_name = str(getattr(sender, "last_name", "") or "")
            sender_name = (first_name + " " + last_name).strip()
            if not sender_name:
                sender_name = str(getattr(sender, "title", "") or "")

        source_timestamp = normalize_telegram_datetime(message.date)
        source_message_id = str(message.id)
        source_message_hash = make_hash(
            "telegram",
            account_id,
            request.get("source_key", ""),
            source_message_id,
            source_timestamp,
            sender_id,
            text,
        )

        raw_messages.append({
            "platform": "telegram",
            "account_id": account_id,
            "source_type": request.get("source_type", ""),
            "source_key": request.get("source_key", ""),
            "source_name": request.get("source_name", ""),
            "source_message_id": source_message_id,
            "source_message_hash": source_message_hash,
            "source_timestamp": source_timestamp,
            "source_author_display_name": sender_name,
            "source_author_username": sender_username,
            "source_author_platform_id": sender_id,
            "source_author_phone": "",
            "source_message_text": text,
            "source_message_type": "text" if text else "non_text",
        })

    raw_messages.reverse()
    return raw_messages


async def resolve_telegram_message_by_id(
    client: TelegramClient,
    account_id: str,
    chat_id: str,
    message_id: int,
) -> Optional[Dict[str, Any]]:
    """Exact single-message lookup by numeric id.

    Unlike poll_telegram_messages (which only returns the most recent N
    messages of a chat), this fetches precisely the one message asked
    for -- a resolve can never silently miss a message that has since
    scrolled out of a "last N" window in an active group.
    """
    entity = await _resolve_entity(client, str(chat_id))
    message = await client.get_messages(entity, ids=int(message_id))
    if message is None:
        return None

    sender = None
    try:
        sender = await message.get_sender()
    except Exception:
        sender = None

    sender_id = ""
    sender_username = ""
    sender_name = ""
    if sender:
        sender_id = str(getattr(sender, "id", "") or "")
        sender_username = str(getattr(sender, "username", "") or "")
        first_name = str(getattr(sender, "first_name", "") or "")
        last_name = str(getattr(sender, "last_name", "") or "")
        sender_name = (first_name + " " + last_name).strip()
        if not sender_name:
            sender_name = str(getattr(sender, "title", "") or "")

    return {
        "account_id": account_id,
        "chat_id": str(chat_id),
        "message_id": message.id,
        "text": message.message or "",
        "posted_at": normalize_telegram_datetime(message.date),
        "sender_id": sender_id,
        "sender_username": sender_username,
        "sender_name": sender_name,
    }


# ============================================================
# GROUP MEMBERSHIP / WRITE-PERMISSION AUDIT
#
# Read-only diagnostics: never sends a message, never joins/leaves/mutes
# anything. Reuses the account's existing persistent connection (this
# module's `manager`) instead of opening a second client against the same
# session file. Membership comes from a single get_dialogs() call; only the
# per-group write-permission check (get_permissions) is one request per
# still-joined group, and audit_group_membership() paces those out with a
# randomized delay so a large group list is never hit in a burst.
# ============================================================

def parse_group_list_file(path: Path) -> List[Dict[str, str]]:
    """Parse the tab-separated `chat_id<TAB>name<TAB>username` export format
    used by telegram_groups.txt. Header/blank lines and malformed rows are
    skipped silently; a missing file returns an empty list."""
    groups: List[Dict[str, str]] = []
    if not path.exists():
        return groups
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = line.split("\t")
        chat_id = parts[0].strip()
        if not re.fullmatch(r"-?\d+", chat_id):
            continue  # header/metadata lines (title, "Exported:", "Count:")
        groups.append({
            "chat_id": chat_id,
            "name": parts[1].strip() if len(parts) > 1 else "",
            "username": parts[2].strip() if len(parts) > 2 else "",
        })
    return groups


def _write_status_from_permissions(perms: Any, entity: Any) -> tuple[bool, str]:
    """Best-effort read of whether `perms` (this account's own
    ParticipantPermissions in a chat/channel it is still a member of) can
    currently send text messages there."""
    if perms is None:
        return False, "no participant record returned"
    if perms.is_creator:
        return True, "creator"
    if perms.is_admin:
        return True, "admin"
    if perms.is_banned:
        # Telethon calls a *restricted* participant "banned" too; the actual
        # scope of the restriction is in participant.banned_rights.
        banned_rights = getattr(perms.participant, "banned_rights", None)
        if banned_rights is not None and getattr(banned_rights, "send_messages", False):
            return False, "restricted: sending disabled for this account"
        return True, "restricted, but sending is not explicitly blocked"
    if perms.has_left:
        return False, "left (stale dialog entry)"

    default_banned = getattr(entity, "default_banned_rights", None)
    if default_banned is not None and getattr(default_banned, "send_messages", False):
        return False, "group-wide restriction: only admins can currently send messages"
    if getattr(entity, "broadcast", False):
        return False, "broadcast channel: only admins/owners can post"
    return True, "normal member, no restriction found"


async def audit_group_membership(
    client: TelegramClient,
    groups: List[Dict[str, str]],
    *,
    delay_seconds: float = 3.0,
    jitter_seconds: float = 1.5,
) -> List[Dict[str, Any]]:
    dialogs = await client.get_dialogs(limit=None)
    by_id = {str(d.id): d for d in dialogs}

    results: List[Dict[str, Any]] = []
    for group in groups:
        chat_id = group["chat_id"]
        dialog = by_id.get(chat_id)
        entry: Dict[str, Any] = {
            "chat_id": chat_id,
            "name": group.get("name", ""),
            "username": group.get("username", ""),
        }

        if dialog is None:
            entry.update(
                member=False,
                can_write=False,
                detail="not in the current dialog list (left, removed, kicked, or the group is gone)",
            )
            results.append(entry)
            continue

        entity = dialog.entity
        if dialog.name:
            entry["name"] = str(dialog.name)

        try:
            perms = await client.get_permissions(entity, "me")
            can_write, detail = _write_status_from_permissions(perms, entity)
            entry.update(member=True, can_write=can_write, detail=detail)
        except UserNotParticipantError:
            entry.update(member=False, can_write=False, detail="not a participant (checked via full chat info)")
        except Exception as e:
            entry.update(member=True, can_write=None, detail=f"check failed: {type(e).__name__}: {e}")

        results.append(entry)
        await asyncio.sleep(delay_seconds + random.uniform(0, jitter_seconds))

    return results
