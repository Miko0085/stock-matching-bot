"""
Unit tests for telegram_login.py — the QR-based login/logout flow.

Uses a fake TelegramClient/qr_login object throughout: no real network
call, no real Telegram account, per the project rule that automated tests
must never perform a real Telegram login.

Run:
    cd telegram-worker
    python -m unittest test_telegram_login.py -v
"""

from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from telethon.errors import PasswordHashInvalidError, SessionPasswordNeededError

import telegram_login


class FakeQrLogin:
    def __init__(self, url: str = "tg://login?token=fake", outcome: str = "success"):
        self.url = url
        self._outcome = outcome  # success | password | timeout | error

    async def wait(self, timeout: float):
        if self._outcome == "success":
            return True
        if self._outcome == "password":
            raise SessionPasswordNeededError(request=None)
        if self._outcome == "timeout":
            raise asyncio.TimeoutError()
        raise RuntimeError("boom")


class FakeClient:
    def __init__(self, session_path, api_id, api_hash, *, authorized: bool = False, qr_outcome: str = "success"):
        self.session_path = session_path
        self.connected = False
        self.disconnected = False
        self._authorized = authorized
        self._qr_outcome = qr_outcome
        self.signed_in_password = None
        self.sign_in_should_fail = False

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.disconnected = True

    async def is_user_authorized(self):
        return self._authorized

    async def qr_login(self):
        return FakeQrLogin(outcome=self._qr_outcome)

    async def sign_in(self, password: str):
        if self.sign_in_should_fail:
            raise PasswordHashInvalidError(request=None)
        self.signed_in_password = password

    async def get_me(self):
        me = MagicMock()
        me.id = 123
        me.username = "test_user"
        me.first_name = "Test"
        me.last_name = "User"
        return me


class TelegramLoginManagerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.manager = telegram_login.TelegramLoginManager()
        self.sessions_dir = Path("/tmp/fake-sessions")

    async def _start(self, account_id="tg_new", qr_outcome="success", authorized=False, is_account_loaded=None):
        fake_client = FakeClient(None, 1, "hash", authorized=authorized, qr_outcome=qr_outcome)
        with patch.object(telegram_login, "TelegramClient", return_value=fake_client) as ctor:
            pending = await self.manager.start(
                account_id,
                api_id=1,
                api_hash="hash",
                sessions_dir=self.sessions_dir,
                is_account_loaded=is_account_loaded or (lambda _aid: False),
            )
        return pending, fake_client, ctor

    async def test_start_returns_waiting_for_scan_with_qr_url(self):
        pending, client, _ = await self._start()
        self.assertEqual(pending.status, "waiting_for_scan")
        self.assertTrue(pending.qr_url.startswith("tg://"))
        self.assertTrue(client.connected)

    async def test_start_rejects_already_authorized_account(self):
        with self.assertRaises(telegram_login.LoginStateError):
            await self._start(authorized=True)

    async def test_start_is_idempotent_while_in_progress(self):
        pending1, client1, _ = await self._start(account_id="tg_dup")
        fake_client2 = FakeClient(None, 1, "hash")
        with patch.object(telegram_login, "TelegramClient", return_value=fake_client2):
            pending2 = await self.manager.start(
                "tg_dup", api_id=1, api_hash="hash", sessions_dir=self.sessions_dir,
                is_account_loaded=lambda _aid: False,
            )
        self.assertIs(pending1, pending2)  # second client was never opened

    async def test_start_rejects_when_account_already_loaded_by_persistent_manager(self):
        # Regression test: a real smoke test against the restarted worker
        # found that starting a login for an account the persistent
        # TelegramClientManager already has open opens a SECOND
        # TelegramClient on the same SQLite session file, which fails with
        # "database is locked" (or worse, could race on the same auth key).
        # is_account_loaded() must be consulted BEFORE any TelegramClient is
        # constructed at all.
        with patch.object(telegram_login, "TelegramClient") as ctor:
            with self.assertRaises(telegram_login.LoginStateError):
                await self.manager.start(
                    "tg_main",
                    api_id=1,
                    api_hash="hash",
                    sessions_dir=self.sessions_dir,
                    is_account_loaded=lambda aid: aid == "tg_main",
                )
            ctor.assert_not_called()

    async def test_successful_scan_reaches_connected(self):
        pending, _client, _ctor = await self._start(account_id="tg_ok")
        await pending.task
        self.assertEqual(pending.status, "connected")

    async def test_pop_connected_only_returns_once(self):
        pending, _client, _ctor = await self._start(account_id="tg_pop")
        await pending.task
        first = self.manager.pop_connected("tg_pop")
        second = self.manager.pop_connected("tg_pop")
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertIsNone(self.manager.get("tg_pop"))

    async def test_needs_password_then_submit_success(self):
        pending, client, _ = await self._start(account_id="tg_2fa", qr_outcome="password")
        await pending.task
        self.assertEqual(pending.status, "needs_password")

        result = await self.manager.submit_password("tg_2fa", "correct-horse")
        self.assertEqual(result.status, "connected")
        self.assertEqual(client.signed_in_password, "correct-horse")

    async def test_submit_password_wrong_keeps_needs_password(self):
        pending, client, _ = await self._start(account_id="tg_2fa_wrong", qr_outcome="password")
        await pending.task
        client.sign_in_should_fail = True

        result = await self.manager.submit_password("tg_2fa_wrong", "bad-password")
        self.assertEqual(result.status, "needs_password")
        self.assertIn("Incorrect", result.error)

    async def test_submit_password_without_pending_login_raises(self):
        with self.assertRaises(telegram_login.LoginStateError):
            await self.manager.submit_password("does_not_exist", "x")

    async def test_timeout_marks_expired_and_disconnects(self):
        pending, client, _ = await self._start(account_id="tg_timeout", qr_outcome="timeout")
        await pending.task
        self.assertEqual(pending.status, "expired")
        self.assertTrue(client.disconnected)

    async def test_unexpected_error_marks_error_status(self):
        pending, client, _ = await self._start(account_id="tg_err", qr_outcome="error")
        await pending.task
        self.assertEqual(pending.status, "error")
        self.assertIn("boom", pending.error)
        self.assertTrue(client.disconnected)


class QrDataUrlTests(unittest.TestCase):
    def test_qr_url_to_data_url_produces_png_data_uri(self):
        data_url = telegram_login.qr_url_to_data_url("tg://login?token=abc")
        self.assertTrue(data_url.startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
