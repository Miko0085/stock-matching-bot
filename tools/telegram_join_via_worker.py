#!/usr/bin/env python3
"""Autonomous Telegram group/channel joiner for a given account_id, driven
through the already-running telegram-worker's HTTP API instead of opening
a second Telethon client on that account's session file.

Why not open a second client directly (like the older
tools/telegram_join_chats.py does for tg_main): telegram-worker holds a
persistent, already-connected TelegramClient per account for the whole
time it's running. Opening a second client on the same .session file
concurrently hits "database is locked" (confirmed live, see
docs/CHANNEL_ACCOUNT_MANAGEMENT.md) or worse, races on the same auth key.
Going through POST /telegram/join instead reuses that one already-open
client -- safe to run at any time, no need to stop the worker.

State is scoped per account_id, so running this for a second account never
touches the first account's progress:
    telegram-worker/state/join_state.<account_id>.json
    telegram-worker/state/join_progress.<account_id>.jsonl

Resumable: targets already recorded as "joined", "already_member",
"rejected_by_telegram", "invalid_target", or "error" are skipped on the
next run; only "flood_wait" or never-attempted targets are retried.

Honors the worker's channels_limit_reached signal (Telegram's account-wide
"too many channels/supergroups" cap) as a hard stop for the whole run --
retrying other targets would just keep failing the same way.

Usage:
    python3 tools/telegram_join_via_worker.py --account-id nikaestate_ae
    python3 tools/telegram_join_via_worker.py --account-id nikaestate_ae --delay 90 --max-flood-retries 5
    python3 tools/telegram_join_via_worker.py --account-id nikaestate_ae --targets-file path/to/list.txt
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "telegram-worker"
STATE_DIR = WORKER_DIR / "state"
DEFAULT_TARGETS_FILE = STATE_DIR / "join_targets.txt"

# Statuses that mean "never try this target again for this account."
TERMINAL_STATUSES = {"joined", "already_member", "rejected_by_telegram", "invalid_target", "error"}


def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


def resolve_api_key() -> str:
    # Same dual-fallback as the worker itself: per-worker .env first, then
    # the repo-root .env.
    env = load_env(WORKER_DIR / ".env")
    key = env.get("WORKER_API_KEY")
    if not key:
        env = load_env(ROOT / ".env")
        key = env.get("WORKER_API_KEY")
    if not key:
        print("FATAL: WORKER_API_KEY not found in telegram-worker/.env or repo-root .env", file=sys.stderr)
        sys.exit(1)
    return key


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_targets(path: Path) -> list:
    if not path.exists():
        print(f"FATAL: targets file not found: {path}", file=sys.stderr)
        sys.exit(1)
    lines = [l.strip() for l in path.read_text(encoding="utf-8").splitlines()]
    return [l for l in lines if l and not l.startswith("#")]


def load_state(state_file: Path) -> dict:
    if not state_file.exists():
        return {"targets": {}, "updated_at": None}
    return json.loads(state_file.read_text(encoding="utf-8"))


def save_state(state_file: Path, state: dict) -> None:
    state["updated_at"] = now_iso()
    state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def append_progress(progress_file: Path, record: dict) -> None:
    with progress_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# join_target() (telegram_joiner.py) only ever produces these statuses. A
# response that doesn't carry one of them -- a connection failure, or a
# FastAPI HTTPException body like {"detail": "..."} from an account that's
# not connected / a bad API key -- is a WORKER/ACCOUNT-level problem, not a
# verdict on this specific target, and must never be recorded as if it were
# one (see the _worker_error handling in main_loop).
KNOWN_JOIN_STATUSES = {
    "joined", "already_member", "invalid_target", "flood_wait",
    "channels_limit_reached", "rejected_by_telegram", "error",
}


def call_join(worker_url: str, api_key: str, account_id: str, target: str, monitor: bool) -> dict:
    try:
        resp = requests.post(
            f"{worker_url}/telegram/join",
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            json={"account_id": account_id, "target": target, "monitor": monitor},
            timeout=30,
        )
    except requests.RequestException as e:
        return {"_worker_error": True, "error": f"HTTP request failed: {e}"}

    try:
        body = resp.json()
    except ValueError:
        return {"_worker_error": True, "error": f"non-JSON response (HTTP {resp.status_code}): {resp.text[:200]}"}

    if not isinstance(body, dict) or body.get("status") not in KNOWN_JOIN_STATUSES:
        # e.g. {"detail": "..."} from an HTTPException: account not
        # connected, wrong/missing API key, worker mid-restart, etc.
        return {"_worker_error": True, "error": body.get("detail") if isinstance(body, dict) else str(body), "http_status": resp.status_code}

    body.setdefault("http_status", resp.status_code)
    return body


MAX_WORKER_ERROR_RETRIES = 8
WORKER_ERROR_BACKOFF_SECONDS = 20.0


def main_loop(account_id: str, targets_file: Path, worker_url: str, delay_seconds: float, max_flood_retries: int, monitor: bool) -> None:
    api_key = resolve_api_key()
    state_file = STATE_DIR / f"join_state.{account_id}.json"
    progress_file = STATE_DIR / f"join_progress.{account_id}.jsonl"

    targets = load_targets(targets_file)
    state = load_state(state_file)

    pending = [t for t in targets if state["targets"].get(t, {}).get("status") not in TERMINAL_STATUSES]

    print(f"account_id={account_id}: {len(targets)} total targets, {len(targets) - len(pending)} already terminal, {len(pending)} to process.")
    if not pending:
        print("Nothing to do.")
        return

    processed = 0
    for target in pending:
        flood_retries = 0
        worker_error_retries = 0
        while True:
            try:
                result = call_join(worker_url, api_key, account_id, target, monitor)
            except Exception as e:  # noqa: BLE001 -- an unforeseen bug here must never kill an unattended multi-hour run
                result = {"_worker_error": True, "error": f"unexpected {type(e).__name__}: {e}"}

            # Worker/account-level problem (connection refused, worker
            # mid-restart, account logged out, bad API key, ...) -- NOT a
            # verdict on this target. Never write it to state (that would
            # wrongly mark this and, if left unchecked, every remaining
            # target as permanently failed). Back off and retry the same
            # target; if it doesn't clear up, stop the whole run cleanly
            # (nothing is lost -- re-running resumes exactly here).
            if result.get("_worker_error"):
                worker_error_retries += 1
                print(f"[{target}] WORKER/ACCOUNT ERROR ({worker_error_retries}/{MAX_WORKER_ERROR_RETRIES}): {result.get('error')}")
                if worker_error_retries > MAX_WORKER_ERROR_RETRIES:
                    print(
                        "Too many consecutive worker/account errors -- stopping here without marking "
                        "any target as failed. Check that telegram-worker is running, WORKER_API_KEY is "
                        f"correct, and account_id={account_id} is still connected, then re-run this same "
                        "command to resume exactly where it left off."
                    )
                    return
                time.sleep(WORKER_ERROR_BACKOFF_SECONDS)
                continue  # retry the SAME target, no state write

            worker_error_retries = 0
            status = result.get("status", "error")
            record = {
                "timestamp": now_iso(),
                "account_id": account_id,
                "target": target,
                "status": status,
                "chat_id": result.get("chat_id"),
                "title": result.get("title"),
                "retry_after_seconds": result.get("retry_after_seconds"),
                "error": result.get("error"),
                "http_status": result.get("http_status"),
            }
            try:
                state["targets"][target] = record
                save_state(state_file, state)
                append_progress(progress_file, record)
            except OSError as e:
                # Transient disk/file-lock hiccup (e.g. antivirus scanning
                # the file) -- log and keep going rather than aborting the
                # whole run; the in-memory `state` dict still has this
                # result, so a later successful write this run will catch
                # it up, and worst case a re-run just retries this target.
                print(f"[{target}] WARNING: failed to persist state ({e}); continuing anyway.")

            if status == "channels_limit_reached":
                print(f"[{target}] CHANNELS_LIMIT_REACHED -- stopping the whole run (account-wide cap, retrying other targets would just fail the same way).")
                return

            if status == "flood_wait":
                wait_s = (record["retry_after_seconds"] or 30) + 5
                flood_retries += 1
                print(f"[{target}] FLOOD_WAIT: sleeping {wait_s}s (attempt {flood_retries}/{max_flood_retries}) ...")
                if flood_retries > max_flood_retries:
                    print(f"[{target}] giving up after {max_flood_retries} flood waits this run -- will retry on next run.")
                    break
                time.sleep(wait_s)
                continue  # retry the SAME target -- flood wait is account-wide, not per-target

            if status in ("joined", "already_member"):
                print(f"[{target}] {status} -- {record.get('title') or record.get('chat_id') or ''}")
            else:
                print(f"[{target}] {status}: {record.get('error')}")
            break

        processed += 1
        print(f"progress: {processed}/{len(pending)} processed this run")
        time.sleep(delay_seconds)

    print("Done -- all pending targets processed for this run.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--account-id", required=True, help="telegram-worker account_id to join with (e.g. nikaestate_ae)")
    parser.add_argument("--targets-file", type=Path, default=DEFAULT_TARGETS_FILE, help=f"one https://t.me/... target per line (default: {DEFAULT_TARGETS_FILE})")
    parser.add_argument("--worker-url", default="http://localhost:8091", help="telegram-worker base URL (default: http://localhost:8091)")
    parser.add_argument("--delay", type=float, default=75.0, help="polite delay in seconds between join attempts (default: 75)")
    parser.add_argument("--max-flood-retries", type=int, default=5, help="max consecutive FloodWait retries per target before moving on (default: 5)")
    parser.add_argument("--monitor", action="store_true", help="also register each successfully-joined chat in the worker's dynamic monitor registry (default: off -- join only, review/enable monitoring separately on /sources)")
    args = parser.parse_args()

    try:
        main_loop(args.account_id, args.targets_file, args.worker_url, args.delay, args.max_flood_retries, args.monitor)
    except KeyboardInterrupt:
        print("\nInterrupted -- state already saved after every attempt, safe to re-run to resume.")
    except Exception as e:  # noqa: BLE001 -- last-resort safety net: exit with a clear message, never a bare traceback, for an unattended run
        print(f"\nUnexpected error, stopping: {type(e).__name__}: {e}")
        print("State up to the last successfully processed target is already saved -- safe to re-run to resume.")
        sys.exit(1)


if __name__ == "__main__":
    main()
