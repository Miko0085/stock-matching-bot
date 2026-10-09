"""Tests for telegram_botfather.create_bot with a fake BotFather conversation.

Run:
    cd telegram-worker
    python -m unittest test_telegram_botfather.py -v
"""

from __future__ import annotations

import unittest
from types import SimpleNamespace

import telegram_botfather as bf

TOKEN = "1234567890:AAH" + "x" * 32


class FakeConv:
    def __init__(self, replies):
        self.replies = list(replies)
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def send_message(self, text):
        self.sent.append(text)

    async def get_response(self):
        return SimpleNamespace(raw_text=self.replies.pop(0))


class FakeClient:
    def __init__(self, replies):
        self.conv = FakeConv(replies)

    def conversation(self, *_a, **_k):
        return self.conv


class CreateBotTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_first_username(self):
        client = FakeClient(["cancelled", "Alright, a new bot.", "Good. Now username", f"Done! Token: {TOKEN}"])
        result = await bf.create_bot(client, "Ivan | Nika Estate", "Ivan Petrov")
        self.assertEqual(result["token"], TOKEN)
        self.assertEqual(result["bot_username"], "Ivan_Petrov_nika_bot")
        self.assertEqual(client.conv.sent[:3], ["/cancel", "/newbot", "Ivan | Nika Estate"])

    async def test_taken_username_retries_with_suffix(self):
        client = FakeClient(["c", "n", "u", "Sorry, this username is already taken.", f"Done {TOKEN}"])
        result = await bf.create_bot(client, "A", "Anna")
        self.assertEqual(len(client.conv.sent), 5)
        self.assertTrue(result["bot_username"].endswith("_bot"))
        self.assertNotEqual(result["bot_username"], "Anna_nika_bot")

    async def test_limit_raises(self):
        client = FakeClient(["c", "Too many attempts, please try again later."])
        with self.assertRaises(bf.BotLimitReachedError):
            await bf.create_bot(client, "A", "Anna")

    async def test_all_usernames_rejected(self):
        client = FakeClient(["c", "n", "u"] + ["Sorry, this username is invalid."] * 4)
        with self.assertRaises(bf.BotCreationError):
            await bf.create_bot(client, "A", "Anna")

    def test_username_candidates_are_valid(self):
        for name in ["Иван", "Ivan Petrov", "a" * 80]:
            for cand in bf.build_username_candidates(name):
                self.assertTrue(bf.USERNAME_RE.fullmatch(cand), cand)
                self.assertLessEqual(len(cand), 32)


if __name__ == "__main__":
    unittest.main()
