#!/usr/bin/env python3
"""Autonomous Telegram group/channel joiner with resumable state and
FloodWait-safe pacing.

The original tools/telegram_join_chats.py source was lost (only a
compiled .pyc remained); this is a schema-compatible rebuild, reverse
engineered from the state files it had already produced:

    telegram-worker/state/join_targets.txt    -- one https://t.me/... URL per line
    telegram-worker/state/join_state.json     -- {normalized_target: last-attempt-record}
    telegram-worker/state/join_progress.jsonl -- append-only log, one line per attempt

It resumes exactly where the previous run stopped: targets already
recorded as "joined", "rejected_by_telegram", or a permanent "error"
(bad/nonexistent username) are skipped; targets that previously hit
"flood_wait" or were never attempted are retried.

WHY IT USED TO STOP: the previous run's last recorded entry was a
FloodWaitError requiring a 904s wait, and the process simply exited
there instead of waiting it out. There is no way to bypass Telegram's
flood limit -- it is enforced server-side regardless of what the client
does -- so "autonomous" here means "sleep for exactly as long as
Telegram says, then keep going," never "ignore the limit."

SAFETY: do not run this while the telegram-worker Docker container is
also actively using the same session file (sessions/tg_main.session) --
Telethon/SQLite may hit a locked session database, or the two processes
may interfere with each other's connection. Stop the worker container
first, or point SESSION_PATH at a copy of the session file.

Usage:
    python3 tools/telegram_join_chats.py
    python3 tools/telegram_join_chats.py --delay 90 --max-flood-retries 5
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from telethon import TelegramClient
from telethon.errors import (
    ChannelPrivateError,
    FloodWaitError,
    InviteHashExpiredError,
    InviteHashInvalidError,
    InviteRequestSentError,
    UserAlreadyParticipantError,
    UsernameInvalidError,
    UsernameNotOccupiedError,
)
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.messages import ImportChatInviteRequest

ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "telegram-worker"
ENV_PATH = WORKER_DIR / ".env"
SESSION_PATH = WORKER_DIR / "sessions" / "tg_main"  # Telethon appends .session
STATE_DIR = WORKER_DIR / "state"
TARGETS_FILE = STATE_DIR / "join_targets.txt"
STATE_FILE = STATE_DIR / "join_state.json"
PROGRESS_FILE = STATE_DIR / "join_progress.jsonl"
ACCOUNT_ID = "tg_main"

# Statuses that mean "never try this target again."
TERMINAL_STATUSES = {"joined", "rejected_by_telegram", "error"}

INVITE_HASH_RE = re.compile(r"t\.me/(?:joinchat/|\+)([A-Za-z0-9_-]+)")
USERNAME_RE = re.compile(r"t\.me/([A-Za-z0-9_]+)")


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


def normalize_target(url: str):
    """Returns (kind, key, value) where kind is 'invite' or 'username'."""
    m = INVITE_HASH_RE.search(url)
    if m:
        return "invite", url, m.group(1)
    m = USERNAME_RE.search(url)
    if m:
        return "username", f"@{m.group(1)}", m.group(1)
    return "unknown", url, None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_targets() -> list:
    if not TARGETS_FILE.exists():
        print(f"FATAL: targets file not found: {TARGETS_FILE}", file=sys.stderr)
        sys.exit(1)
    lines = [l.strip() for l in TARGETS_FILE.read_text(encoding="utf-8").splitlines()]
    return [l for l in lines if l and not l.startswith("#")]


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"targets": {}, "updated_at": None}
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def save_state(state: dict) -> None:
    state["updated_at"] = now_iso()
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def append_progress(record: dict) -> None:
    with PROGRESS_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def record_attempt(state: dict, normalized_target: str, target: str, **fields) -> dict:
    record = {
        "timestamp": now_iso(),
        "account_id": ACCOUNT_ID,
        "target": target,
        "normalized_target": normalized_target,
        "status": None,
        "chat_id": None,
        "title": None,
        "retry_after_seconds": None,
        "error": None,
        "http_status": None,
    }
    record.update(fields)
    state["targets"][normalized_target] = record
    save_state(state)
    append_progress(record)
    return record


async def attempt_join(client: TelegramClient, target_url: str):
    """Returns a result dict shape matching record_attempt's fields (minus timestamp/target)."""
    kind, key, value = normalize_target(target_url)
    if kind == "unknown":
        return key, {"status": "error", "http_status": None, "error": f"unrecognized target format: {target_url}"}

    try:
        if kind == "invite":
            updates = await client(ImportChatInviteRequest(value))
        else:
            updates = await client(JoinChannelRequest(value))
        chat = updates.chats[0] if getattr(updates, "chats", None) else None
        chat_id = f"-100{chat.id}" if chat is not None else None
        title = getattr(chat, "title", None)
        return key, {"status": "joined", "http_status": 200, "chat_id": chat_id, "title": title}

    except UserAlreadyParticipantError:
        return key, {"status": "joined", "http_status": 200, "error": "already a participant"}

    except InviteRequestSentError as e:
        return key, {"status": "rejected_by_telegram", "http_status": 200, "error": f"InviteRequestSentError: {e}"}

    except (UsernameNotOccupiedError, UsernameInvalidError) as e:
        return key, {"status": "error", "http_status": 404, "error": f"{type(e).__name__}: {e}"}

    except (ChannelPrivateError, InviteHashExpiredError, InviteHashInvalidError) as e:
        return key, {"status": "error", "http_status": 403, "error": f"{type(e).__name__}: {e}"}

    except FloodWaitError as e:
        return key, {"status": "flood_wait", "http_status": 429, "retry_after_seconds": e.seconds, "error": f"A wait of {e.seconds} seconds is required (caused by JoinChannelRequest)"}

    except Exception as e:  # noqa: BLE001 -- deliberately broad: one bad target must never kill the whole autonomous run
        return key, {"status": "error", "http_status": None, "error": f"{type(e).__name__}: {e}"}


async def main_async(delay_seconds: float, max_flood_retries: int) -> None:
    env = load_env(ENV_PATH)
    api_id = env.get("TELEGRAM_API_ID")
    api_hash = env.get("TELEGRAM_API_HASH")
    if not api_id or not api_hash:
        print(f"FATAL: TELEGRAM_API_ID/TELEGRAM_API_HASH not found in {ENV_PATH}", file=sys.stderr)
        sys.exit(1)

    targets = load_targets()
    state = load_state()

    pending = []
    for url in targets:
        _, key, _ = normalize_target(url)
        existing = state["targets"].get(key)
        if existing and existing.get("status") in TERMINAL_STATUSES:
            continue
        pending.append(url)

    print(f"{len(targets)} total targets, {len(targets) - len(pending)} already terminal, {len(pending)} to process.")
    if not pending:
        print("Nothing to do.")
        return

    client = TelegramClient(str(SESSION_PATH), int(api_id), api_hash)
    await client.start()
    print(f"Connected as session '{ACCOUNT_ID}'.")

    processed = 0
    for target_url in pending:
        flood_retries = 0
        while True:
            key, result = await attempt_join(client, target_url)
            record = record_attempt(state, key, target_url, **result)
            status = record["status"]

            if status == "flood_wait":
                wait_s = record["retry_after_seconds"] + 5
                flood_retries += 1
                print(f"[{key}] FLOOD_WAIT: sleeping {wait_s}s (attempt {flood_retries}/{max_flood_retries}) ...")
                if flood_retries > max_flood_retries:
                    print(f"[{key}] giving up after {max_flood_retries} flood waits this run -- will retry on next run.")
                    break
                await asyncio.sleep(wait_s)
                continue  # retry the SAME target -- flood wait is account-wide, not per-target

            if status == "joined":
                print(f"[{key}] joined -- {record.get('title') or record.get('chat_id')}")
            elif status == "rejected_by_telegram":
                print(f"[{key}] join request sent, pending approval (private chat).")
            else:
                print(f"[{key}] {status}: {record.get('error')}")
            break

        processed += 1
        print(f"progress: {processed}/{len(pending)} processed this run")
        await asyncio.sleep(delay_seconds)

    await client.disconnect()
    print("Done -- all pending targets processed for this run.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--delay", type=float, default=75.0, help="Polite delay in seconds between join attempts (default: 75)")
    parser.add_argument("--max-flood-retries", type=int, default=5, help="Max consecutive FloodWait retries per target before moving on (default: 5)")
    args = parser.parse_args()

    try:
        asyncio.run(main_async(args.delay, args.max_flood_retries))
    except KeyboardInterrupt:
        print("\nInterrupted -- state already saved after every attempt, safe to re-run to resume.")


if __name__ == "__main__":
    main()
