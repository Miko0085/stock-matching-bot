"""
Unit tests for telegram_pause_registry.PausedAccountsRegistry.

Run:
    cd telegram-worker
    python -m unittest test_telegram_pause_registry.py -v
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from telegram_pause_registry import PausedAccountsRegistry


class PausedAccountsRegistryTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.state_path = Path(self._tmpdir.name) / "paused_accounts.json"

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_starts_empty_when_no_state_file_exists(self):
        registry = PausedAccountsRegistry(self.state_path)
        self.assertFalse(registry.is_paused("tg_main"))
        self.assertEqual(registry.list_paused(), [])

    def test_pause_then_is_paused_true(self):
        registry = PausedAccountsRegistry(self.state_path)
        result = registry.pause("tg_main")
        self.assertTrue(registry.is_paused("tg_main"))
        self.assertEqual(result["account_id"], "tg_main")
        self.assertTrue(result["paused"])
        self.assertIsNotNone(result["paused_at"])

    def test_pause_never_affects_a_different_account(self):
        registry = PausedAccountsRegistry(self.state_path)
        registry.pause("tg_main")
        self.assertFalse(registry.is_paused("nikaestate_ae"))

    def test_resume_clears_the_pause(self):
        registry = PausedAccountsRegistry(self.state_path)
        registry.pause("tg_main")
        result = registry.resume("tg_main")
        self.assertFalse(registry.is_paused("tg_main"))
        self.assertTrue(result["was_paused"])
        self.assertFalse(result["paused"])

    def test_resume_on_a_non_paused_account_is_a_harmless_no_op(self):
        registry = PausedAccountsRegistry(self.state_path)
        result = registry.resume("tg_never_paused")
        self.assertFalse(result["was_paused"])

    def test_pause_is_idempotent_and_keeps_the_original_paused_at(self):
        registry = PausedAccountsRegistry(self.state_path)
        first = registry.pause("tg_main")
        second = registry.pause("tg_main")
        self.assertEqual(first["paused_at"], second["paused_at"])

    def test_pause_requires_a_non_empty_account_id(self):
        registry = PausedAccountsRegistry(self.state_path)
        with self.assertRaises(ValueError):
            registry.pause("")

    def test_state_persists_to_disk_and_reloads_in_a_new_instance(self):
        registry1 = PausedAccountsRegistry(self.state_path)
        registry1.pause("tg_main")

        self.assertTrue(self.state_path.exists())
        on_disk = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertIn("tg_main", on_disk["paused"])

        registry2 = PausedAccountsRegistry(self.state_path)  # fresh instance, same file
        self.assertTrue(registry2.is_paused("tg_main"))

    def test_list_paused_reflects_multiple_accounts_sorted(self):
        registry = PausedAccountsRegistry(self.state_path)
        registry.pause("tg_second")
        registry.pause("tg_first")
        listed = registry.list_paused()
        self.assertEqual([e["account_id"] for e in listed], ["tg_first", "tg_second"])

    def test_a_missing_or_corrupt_state_file_starts_empty_instead_of_crashing(self):
        self.state_path.write_text("not valid json{{{", encoding="utf-8")
        registry = PausedAccountsRegistry(self.state_path)
        self.assertFalse(registry.is_paused("tg_main"))


if __name__ == "__main__":
    unittest.main()
