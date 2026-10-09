"""
Unit tests for the is_paused short-circuit added to
telegram_events.make_new_message_handler().

Run:
    cd telegram-worker
    python -m unittest test_telegram_events_pause.py -v
"""

from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

import telegram_events
from telegram_events import MonitoredChatsProvider, make_new_message_handler


class AlwaysMonitored(MonitoredChatsProvider):
    def is_monitored(self, account_id: str, chat_id: str) -> bool:
        return True


class FakeWebhookQueue:
    def __init__(self):
        self.enqueued = []

    def enqueue(self, payload):
        self.enqueued.append(payload)


GROUP_PAYLOAD = {
    "chat_id": "-1001144748083",
    "message_id": "1",
    "text": "hi",
    "is_group": True,
    "is_channel": False,
    "is_private": False,
}


class MakeNewMessageHandlerPauseTests(unittest.IsolatedAsyncioTestCase):
    async def test_paused_account_never_builds_or_forwards_the_event(self):
        webhook_queue = FakeWebhookQueue()
        handler = make_new_message_handler(
            AlwaysMonitored(), webhook_queue, is_paused=lambda account_id: True
        )

        with patch.object(telegram_events, "build_message_event", AsyncMock(return_value=GROUP_PAYLOAD)) as build_mock:
            await handler("tg_main", object())

        build_mock.assert_not_called()
        self.assertEqual(webhook_queue.enqueued, [])

    async def test_pause_only_affects_the_named_account_not_others(self):
        webhook_queue = FakeWebhookQueue()
        handler = make_new_message_handler(
            AlwaysMonitored(), webhook_queue, is_paused=lambda account_id: account_id == "tg_main"
        )

        with patch.object(telegram_events, "build_message_event", AsyncMock(return_value=GROUP_PAYLOAD)):
            await handler("nikaestate_ae", object())

        self.assertEqual(len(webhook_queue.enqueued), 1)

    async def test_not_paused_forwards_a_monitored_group_message_normally(self):
        webhook_queue = FakeWebhookQueue()
        handler = make_new_message_handler(
            AlwaysMonitored(), webhook_queue, is_paused=lambda account_id: False
        )

        with patch.object(telegram_events, "build_message_event", AsyncMock(return_value=GROUP_PAYLOAD)):
            await handler("tg_main", object())

        self.assertEqual(len(webhook_queue.enqueued), 1)
        self.assertEqual(webhook_queue.enqueued[0], GROUP_PAYLOAD)

    async def test_omitting_is_paused_entirely_preserves_old_behavior(self):
        # Backward compatibility: existing callers of make_new_message_handler
        # (before this feature) never pass is_paused at all.
        webhook_queue = FakeWebhookQueue()
        handler = make_new_message_handler(AlwaysMonitored(), webhook_queue)

        with patch.object(telegram_events, "build_message_event", AsyncMock(return_value=GROUP_PAYLOAD)):
            await handler("tg_main", object())

        self.assertEqual(len(webhook_queue.enqueued), 1)


if __name__ == "__main__":
    unittest.main()
