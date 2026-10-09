"""
Tests for the new /telegram/accounts (POST), /telegram/qr, and
/telegram/accounts/{password,logout} route handlers in worker_api.py.

These call the route coroutine functions directly (FastAPI's @app.post/@app.get
decorators register the function without wrapping it, so it stays a plain
callable) instead of going through TestClient/lifespan — this avoids
triggering telegram_adapter.manager.start(), which would try to reconnect
whatever real session files happen to be on disk. Nothing here performs a
real Telegram login or network call.

Run:
    cd telegram-worker
    python -m unittest test_worker_api_login_routes.py -v
"""

from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

import telegram_login
import worker_api


class FakePendingLogin:
    def __init__(self, status, qr_url="", error=None, client=None):
        self.status = status
        self.qr_url = qr_url
        self.error = error
        self.client = client or MagicMock()


class StartLoginRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_login_returns_status(self):
        pending = FakePendingLogin("waiting_for_scan")
        with patch.object(telegram_login.manager, "start", AsyncMock(return_value=pending)):
            result = await worker_api.telegram_start_login(
                worker_api.TelegramAccountLoginRequest(account_id="tg_new")
            )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["login_status"], "waiting_for_scan")

    async def test_start_login_already_authorized_returns_409(self):
        with patch.object(
            telegram_login.manager, "start",
            AsyncMock(side_effect=telegram_login.LoginStateError("already authorized")),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await worker_api.telegram_start_login(
                    worker_api.TelegramAccountLoginRequest(account_id="tg_existing")
                )
        self.assertEqual(ctx.exception.status_code, 409)

    async def test_start_login_rejects_invalid_account_id(self):
        with self.assertRaises(Exception):
            await worker_api.telegram_start_login(
                worker_api.TelegramAccountLoginRequest(account_id="bad id with spaces")
            )


class QrPollRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_qr_poll_returns_404_when_no_pending_login(self):
        with patch.object(telegram_login.manager, "get", return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                await worker_api.telegram_qr("tg_unknown")
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_qr_poll_returns_qr_data_url_while_waiting(self):
        pending = FakePendingLogin("waiting_for_scan", qr_url="tg://login?token=abc")
        with patch.object(telegram_login.manager, "get", return_value=pending), \
             patch.object(telegram_login.manager, "pop_connected", return_value=None):
            result = await worker_api.telegram_qr("tg_waiting")
        self.assertEqual(result["login_status"], "waiting_for_scan")
        self.assertTrue(result["qr_data_url"].startswith("data:image/png;base64,"))

    async def test_qr_poll_adopts_client_once_connected(self):
        fake_client = MagicMock()
        pending = FakePendingLogin("connected", client=fake_client)
        adopted_state = MagicMock(username="new_user", user_id="7", name="New User")

        with patch.object(telegram_login.manager, "get", return_value=pending), \
             patch.object(telegram_login.manager, "pop_connected", return_value=pending), \
             patch.object(worker_api.telegram_adapter.manager, "adopt_authorized_client",
                           AsyncMock(return_value=adopted_state)) as adopt_mock:
            result = await worker_api.telegram_qr("tg_connected")

        adopt_mock.assert_awaited_once_with("tg_connected", fake_client)
        self.assertEqual(result["login_status"], "connected")
        self.assertEqual(result["username"], "new_user")


class PasswordRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_password_wrong_keeps_needs_password(self):
        pending = FakePendingLogin("needs_password", error="Incorrect 2FA password. Try again.")
        with patch.object(telegram_login.manager, "submit_password", AsyncMock(return_value=pending)):
            result = await worker_api.telegram_login_password(
                worker_api.TelegramLoginPasswordRequest(account_id="tg_2fa", password="wrong")
            )
        self.assertEqual(result["login_status"], "needs_password")
        self.assertIn("Incorrect", result["error"])

    async def test_password_correct_adopts_client(self):
        fake_client = MagicMock()
        pending = FakePendingLogin("connected", client=fake_client)
        adopted_state = MagicMock(username="ok_user")

        with patch.object(telegram_login.manager, "submit_password", AsyncMock(return_value=pending)), \
             patch.object(telegram_login.manager, "pop_connected", return_value=pending), \
             patch.object(worker_api.telegram_adapter.manager, "adopt_authorized_client",
                           AsyncMock(return_value=adopted_state)):
            result = await worker_api.telegram_login_password(
                worker_api.TelegramLoginPasswordRequest(account_id="tg_2fa", password="right")
            )
        self.assertEqual(result["login_status"], "connected")
        self.assertEqual(result["username"], "ok_user")

    async def test_password_without_pending_login_returns_409(self):
        with patch.object(
            telegram_login.manager, "submit_password",
            AsyncMock(side_effect=telegram_login.LoginStateError("no pending login")),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await worker_api.telegram_login_password(
                    worker_api.TelegramLoginPasswordRequest(account_id="tg_none", password="x")
                )
        self.assertEqual(ctx.exception.status_code, 409)


class LogoutRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_logout_success(self):
        with patch.object(worker_api.telegram_adapter.manager, "logout_account", AsyncMock()) as logout_mock:
            result = await worker_api.telegram_logout(
                worker_api.TelegramAccountLogoutRequest(account_id="tg_main")
            )
        logout_mock.assert_awaited_once_with("tg_main")
        self.assertEqual(result["status"], "ok")
        self.assertIn("unaffected", result["message"])

    async def test_logout_not_connected_raises_http_error(self):
        with patch.object(
            worker_api.telegram_adapter.manager, "logout_account",
            AsyncMock(side_effect=worker_api.telegram_adapter.AccountUnavailableError("not connected")),
        ):
            with self.assertRaises(HTTPException):
                await worker_api.telegram_logout(
                    worker_api.TelegramAccountLogoutRequest(account_id="tg_gone")
                )


if __name__ == "__main__":
    unittest.main()
