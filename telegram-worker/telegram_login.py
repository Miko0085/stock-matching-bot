r"""
telegram_login.py — QR-based Telegram account login/logout, exposed over
HTTP by worker_api.py.

This is the HTTP-reachable replacement for the previously offline-only
telegram_qr_login_account.py script. The underlying flow is unchanged
(Telethon's client.qr_login(), SessionPasswordNeededError for 2FA) — only
how it's triggered and observed changes, from a terminal prompt to HTTP
start/poll/submit-password calls, mirroring whatsapp-worker's existing
POST /whatsapp/accounts + GET /whatsapp/qr + POST /whatsapp/accounts/logout
pattern so both providers behave the same way from the dashboard's point of
view.

Never logs or stores: the QR image bytes beyond the current pending
attempt, the 2FA password, or any session file content. The only
long-lived secret this module ever touches (the Telethon session file) is
written by Telethon itself on disk, exactly as it already is for the
existing manual/env-account flow.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import qrcode
from telethon import TelegramClient
from telethon.errors import PasswordHashInvalidError, SessionPasswordNeededError

logger = logging.getLogger("telegram_worker")

# How long a QR code stays worth polling before this module gives up and
# marks the attempt "expired" (the operator can just start a new one).
QR_LOGIN_TIMEOUT_SECONDS = 90.0

# Terminal-state (connected/expired/error) pending entries are pruned after
# this long so a login attempt that nobody ever polled again doesn't leak
# forever — a fresh POST /telegram/accounts for the same account_id always
# starts clean regardless of this TTL.
PENDING_TTL_SECONDS = 300.0


class LoginError(Exception):
    pass


class LoginStateError(LoginError):
    """Wrong-state call for the given account_id, e.g. submitting a
    password when no login is waiting for one, or starting a login for an
    account that is already authorized."""


@dataclass
class PendingLogin:
    account_id: str
    client: TelegramClient
    status: str  # waiting_for_scan | needs_password | connected | expired | error
    qr_url: str = ""
    error: Optional[str] = None
    updated_at: float = field(default_factory=time.monotonic)
    task: Optional[asyncio.Task] = field(default=None, repr=False)
    qr_login: Any = field(default=None, repr=False)


class TelegramLoginManager:
    """Holds in-progress QR logins only — never a connected account's
    long-lived client. Once a login reaches 'connected', the caller
    (worker_api.py) must pop_connected() it and hand the client off to
    telegram_adapter.manager (the real, persistent owner of live clients)
    in the same request that observes the success."""

    def __init__(self) -> None:
        self._pending: Dict[str, PendingLogin] = {}

    def _prune_expired(self) -> None:
        now = time.monotonic()
        stale = [
            account_id
            for account_id, pending in self._pending.items()
            if pending.status in ("expired", "error") and now - pending.updated_at > PENDING_TTL_SECONDS
        ]
        for account_id in stale:
            del self._pending[account_id]

    def get(self, account_id: str) -> Optional[PendingLogin]:
        self._prune_expired()
        return self._pending.get(account_id)

    async def start(
        self,
        account_id: str,
        *,
        api_id: int,
        api_hash: str,
        sessions_dir: Path,
        is_account_loaded: Callable[[str], bool],
    ) -> PendingLogin:
        self._prune_expired()
        existing = self._pending.get(account_id)
        if existing is not None and existing.status in ("waiting_for_scan", "needs_password"):
            return existing  # already in progress — never open a second client

        # Critical: never open a second TelegramClient on a session file the
        # persistent TelegramClientManager already has open for this
        # account_id — two clients on the same SQLite session file at once
        # fails with "database is locked" (confirmed against a real
        # connected account during smoke testing) and could otherwise race
        # on the same auth key.
        if is_account_loaded(account_id):
            raise LoginStateError(
                f"Telegram account '{account_id}' is already loaded by this worker. Log it out first to re-login."
            )

        session_path = str(sessions_dir / account_id)
        client = TelegramClient(session_path, api_id, api_hash)
        await client.connect()

        if await client.is_user_authorized():
            await client.disconnect()
            raise LoginStateError(
                f"Telegram account '{account_id}' is already authorized. Log it out first to re-login."
            )

        pending = PendingLogin(account_id=account_id, client=client, status="waiting_for_scan")
        self._pending[account_id] = pending

        qr_login = await client.qr_login()
        pending.qr_login = qr_login
        pending.qr_url = qr_login.url
        pending.updated_at = time.monotonic()

        pending.task = asyncio.create_task(self._wait_for_result(pending))
        return pending

    async def _wait_for_result(self, pending: PendingLogin) -> None:
        try:
            await pending.qr_login.wait(timeout=QR_LOGIN_TIMEOUT_SECONDS)
            pending.status = "connected"
        except SessionPasswordNeededError:
            pending.status = "needs_password"
        except asyncio.TimeoutError:
            pending.status = "expired"
            try:
                await pending.client.disconnect()
            except Exception:
                pass
        except Exception as e:  # pragma: no cover — defensive, mirrors connect_account()
            pending.status = "error"
            pending.error = f"{type(e).__name__}: {e}"
            try:
                await pending.client.disconnect()
            except Exception:
                pass
        finally:
            pending.updated_at = time.monotonic()

    async def submit_password(self, account_id: str, password: str) -> PendingLogin:
        pending = self._pending.get(account_id)
        if pending is None or pending.status != "needs_password":
            raise LoginStateError(f"No pending Telegram login awaiting a password for '{account_id}'.")
        try:
            await pending.client.sign_in(password=password)
            pending.status = "connected"
            pending.error = None
        except PasswordHashInvalidError:
            pending.error = "Incorrect 2FA password. Try again."
        finally:
            pending.updated_at = time.monotonic()
        return pending

    def pop_connected(self, account_id: str) -> Optional[PendingLogin]:
        """Remove and return a pending entry once (and only once) it has
        reached 'connected', so the caller can adopt its live client into
        the real client manager exactly one time."""
        pending = self._pending.get(account_id)
        if pending is not None and pending.status == "connected":
            del self._pending[account_id]
            return pending
        return None


def qr_url_to_data_url(url: str) -> str:
    """Same idea as whatsapp-worker's qrToDataURL: never return session
    credentials, only a renderable image of the transient pairing URL."""
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


manager = TelegramLoginManager()
