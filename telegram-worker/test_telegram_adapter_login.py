"""
Unit tests for the QR-login integration points added to
telegram_adapter.TelegramClientManager: adopt_authorized_client() and
logout_account(). Uses a fake TelegramClient — no real network call, no
real Telegram account.

Run:
    cd telegram-worker
    python -m unittest test_telegram_adapter_login.py -v
"""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import MagicMock

import telegram_adapter


class FakeClient:
    def __init__(self):
        self.disconnect_called = False
        self.log_out_called = False
        self._disconnected_future: asyncio.Future = asyncio.get_event_loop().create_future()

    async def get_me(self):
        me = MagicMock()
        me.id = 42
        me.username = "adopted_user"
        me.first_name = "Adopted"
        me.last_name = "User"
        return me

    def on(self, _event):
        def decorator(fn):
            return fn
        return decorator

    @property
    def disconnected(self):
        return self._disconnected_future

    async def disconnect(self):
        self.disconnect_called = True
        if not self._disconnected_future.done():
            self._disconnected_future.set_result(True)

    async def log_out(self):
        self.log_out_called = True


class AdoptAndLogoutTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        # Any watch_task left running from a test must be cancelled so it
        # doesn't leak into the next test / warn about a pending task.
        for state in list(self.manager._accounts.values()):
            if state.watch_task is not None and not state.watch_task.done():
                state.watch_task.cancel()
                try:
                    await state.watch_task
                except (asyncio.CancelledError, Exception):
                    pass

    async def test_adopt_authorized_client_marks_connected(self):
        self.manager = telegram_adapter.TelegramClientManager()
        client = FakeClient()

        state = await self.manager.adopt_authorized_client("tg_new", client)

        self.assertEqual(state.status, "connected")
        self.assertTrue(state.authorized)
        self.assertTrue(state.connected)
        self.assertEqual(state.username, "adopted_user")
        self.assertEqual(state.user_id, "42")
        self.assertIs(state.client, client)
        self.assertIsNotNone(state.watch_task)

    async def test_adopt_authorized_client_is_visible_via_list_accounts(self):
        self.manager = telegram_adapter.TelegramClientManager()
        await self.manager.adopt_authorized_client("tg_visible", FakeClient())

        accounts = self.manager.list_accounts()
        matching = [a for a in accounts if a["account_id"] == "tg_visible"]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["status"], "connected")

    async def test_logout_account_invalidates_session_and_updates_state(self):
        self.manager = telegram_adapter.TelegramClientManager()
        client = FakeClient()
        await self.manager.adopt_authorized_client("tg_logout", client)

        await self.manager.logout_account("tg_logout")

        self.assertTrue(client.log_out_called)
        state = self.manager._accounts["tg_logout"]
        self.assertEqual(state.status, "unauthorized")
        self.assertFalse(state.connected)
        self.assertFalse(state.authorized)
        self.assertIsNone(state.client)
        self.assertIsNone(state.watch_task)

    async def test_logout_account_never_touches_other_accounts(self):
        self.manager = telegram_adapter.TelegramClientManager()
        other_client = FakeClient()
        await self.manager.adopt_authorized_client("tg_other", other_client)
        target_client = FakeClient()
        await self.manager.adopt_authorized_client("tg_target", target_client)

        await self.manager.logout_account("tg_target")

        self.assertFalse(other_client.log_out_called)
        other_state = self.manager._accounts["tg_other"]
        self.assertEqual(other_state.status, "connected")
        self.assertTrue(other_state.connected)

    async def test_logout_account_raises_for_unknown_account(self):
        self.manager = telegram_adapter.TelegramClientManager()
        with self.assertRaises(telegram_adapter.AccountUnavailableError):
            await self.manager.logout_account("does_not_exist")


if __name__ == "__main__":
    unittest.main()
