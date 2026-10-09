"""
Tests for the new POST /telegram/accounts/pause and
POST /telegram/accounts/resume route handlers in worker_api.py, and for the
"paused" flag merged into GET /telegram/accounts.

Calls the route coroutine functions directly (same approach as
test_worker_api_login_routes.py) rather than through TestClient/lifespan.

Run:
    cd telegram-worker
    python -m unittest test_worker_api_pause_routes.py -v
"""

from __future__ import annotations

import unittest
from unittest.mock import patch

import worker_api


class PauseRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_pause_then_resume_round_trip(self):
        pause_result = await worker_api.telegram_pause_account(
            worker_api.TelegramAccountPauseRequest(account_id="tg_route_test")
        )
        self.assertEqual(pause_result["status"], "ok")
        self.assertTrue(pause_result["paused"])
        self.assertTrue(worker_api.paused_accounts.is_paused("tg_route_test"))

        resume_result = await worker_api.telegram_resume_account(
            worker_api.TelegramAccountPauseRequest(account_id="tg_route_test")
        )
        self.assertEqual(resume_result["status"], "ok")
        self.assertFalse(resume_result["paused"])
        self.assertTrue(resume_result["was_paused"])
        self.assertFalse(worker_api.paused_accounts.is_paused("tg_route_test"))

    async def test_resume_when_not_paused_is_a_no_op(self):
        result = await worker_api.telegram_resume_account(
            worker_api.TelegramAccountPauseRequest(account_id="tg_never_paused_route_test")
        )
        self.assertFalse(result["was_paused"])

    async def test_pause_rejects_invalid_account_id(self):
        with self.assertRaises(Exception):
            await worker_api.telegram_pause_account(
                worker_api.TelegramAccountPauseRequest(account_id="bad id with spaces")
            )

    async def test_telegram_accounts_route_merges_paused_flag(self):
        with patch.object(
            worker_api.telegram_adapter.manager, "list_accounts",
            return_value=[{"account_id": "tg_main", "status": "connected"}],
        ), patch.object(worker_api.paused_accounts, "is_paused", return_value=True) as is_paused_mock:
            result = await worker_api.telegram_accounts()

        is_paused_mock.assert_called_once_with("tg_main")
        self.assertEqual(result["accounts"][0]["paused"], True)


if __name__ == "__main__":
    unittest.main()
