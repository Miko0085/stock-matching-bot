#!/usr/bin/env python3
"""Create one Telegram notification bot per broker via the running
telegram-worker (POST /telegram/bots/create -> @BotFather) and record every
result in ONE markdown list.

Only for the notification bots (docs/TELEGRAM_BOT_AND_USER_MANAGEMENT.md);
tokens are stored in plain text by project decision. The default output file
lives in telegram-worker/state/ which is gitignored -- do not move it into
a tracked path.

Resumable: brokers already present in the md list are skipped. Sleeps
between creations to avoid flood waits. A flood-wait 429 (BotFather's
"too many attempts, try again in N seconds") is retried automatically
after that exact wait, up to --max-retries times per broker; a 429 with
no parseable wait time (a hard per-account cap, e.g. "too many bots")
is not retryable and stops the whole run.

Brokers come from Joker CRM (brokers with a JOKER external identity):
    node scripts/export-joker-brokers.js            # writes state/joker_brokers.txt (id|name)
    python3 tools/telegram_create_broker_bots.py --account-id nikaestate_ae
Input lines are `id|name`; a bare name line is also accepted (id = name).
The broker id is part of the bot username so Cyrillic / duplicate names
never collide.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

RETRY_AFTER_RE = re.compile(r"try again in (\d+) seconds", re.IGNORECASE)

ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "telegram-worker"
DEFAULT_OUTPUT = WORKER_DIR / "state" / "broker_bots.md"
DEFAULT_INPUT = WORKER_DIR / "state" / "joker_brokers.txt"
DEFAULT_WORKER_URL = "http://127.0.0.1:8091"
MD_HEADER = (
    "# Telegram-боты брокеров\n\n"
    "| ID | Брокер | Бот | Токен | Создан (UTC) |\n"
    "|---|---|---|---|---|\n"
)


def load_env(path: Path) -> dict:
    env = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    return env


def resolve_api_key() -> str:
    key = load_env(WORKER_DIR / ".env").get("WORKER_API_KEY") or load_env(ROOT / ".env").get("WORKER_API_KEY")
    if not key:
        sys.exit("FATAL: WORKER_API_KEY not found in telegram-worker/.env or repo-root .env")
    return key


_TRANSLIT = dict(zip(
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t",
     "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"],
))


def translit(text: str) -> str:
    return "".join(_TRANSLIT.get(ch, ch) for ch in text.lower())


def parse_retry_after_seconds(text: str) -> float | None:
    """Extract BotFather's own flood-wait duration, e.g. "...try again in
    209 seconds." Returns None when the 429 carries no wait time (a hard
    per-account cap, not a transient flood wait) -- that case is not
    retryable."""
    m = RETRY_AFTER_RE.search(text or "")
    return float(m.group(1)) if m else None


def parse_broker_line(line: str):
    """`id|name` -> (id, name); bare name -> (name, name). Blank -> None."""
    line = line.strip()
    if not line:
        return None
    if "|" in line:
        bid, _, name = line.partition("|")
        return bid.strip(), name.strip() or bid.strip()
    return line, line


def read_done_brokers(md_path: Path) -> set:
    """Broker ids already recorded in the md list (first column)."""
    done = set()
    if md_path.exists():
        for line in md_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("|") and not line.startswith("|---") and not line.startswith("| ID"):
                cells = [c.strip() for c in line.strip("|").split("|")]
                if cells and cells[0]:
                    done.add(cells[0])
    return done


def append_row(md_path: Path, broker_id: str, broker: str, bot_username: str, token: str) -> None:
    md_path.parent.mkdir(parents=True, exist_ok=True)
    if not md_path.exists():
        md_path.write_text(MD_HEADER, encoding="utf-8")
    created = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    safe_broker = broker.replace("|", "/")
    with md_path.open("a", encoding="utf-8") as fh:
        fh.write(f"| {broker_id} | {safe_broker} | @{bot_username} | `{token}` | {created} |\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--account-id", required=True, help="telegram-worker account that owns the bots")
    ap.add_argument("--brokers-file", type=Path, default=DEFAULT_INPUT,
                    help="`id|name` per line (default: output of scripts/export-joker-brokers.js)")
    ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    ap.add_argument("--worker-url", default=DEFAULT_WORKER_URL)
    ap.add_argument("--max", type=int, default=20, dest="max_bots",
                    help="max bots to create this run (BotFather caps ~20 per account)")
    ap.add_argument("--delay", type=float, default=45.0, help="seconds between creations")
    ap.add_argument("--max-retries", type=int, default=5,
                    help="max flood-wait retries per broker before giving up on it")
    args = ap.parse_args()

    if not args.brokers_file.exists():
        sys.exit(f"{args.brokers_file} not found -- run: node scripts/export-joker-brokers.js")
    parsed = [parse_broker_line(l) for l in args.brokers_file.read_text(encoding="utf-8").splitlines()]
    brokers = list(dict.fromkeys(p for p in parsed if p))
    if not brokers:
        sys.exit("No Joker brokers found in the input file")

    done = read_done_brokers(args.output)
    todo = [b for b in brokers if b[0] not in done]
    todo = todo[: args.max_bots]
    print(f"{len(brokers)} brokers, {len(brokers) - len(todo)} done or deferred, {len(todo)} to create this run")

    headers = {"X-API-Key": resolve_api_key()}
    created = 0
    for i, (broker_id, broker) in enumerate(todo):
        for attempt in range(1, args.max_retries + 1):
            resp = requests.post(
                f"{args.worker_url}/telegram/bots/create",
                headers=headers,
                json={
                    "account_id": args.account_id,
                    "display_name": f"{broker} | Nika Estate",
                    "username_base": f"{translit(broker)} {broker_id}" if broker != broker_id else broker,
                },
                timeout=240,
            )
            if resp.status_code != 429:
                break
            wait_s = parse_retry_after_seconds(resp.text)
            if wait_s is None:
                print(f"STOP [{broker_id}] {broker}: BotFather hard limit (not a flood wait): {resp.text[:200]}")
                print(f"Created {created}. List: {args.output}")
                return 0
            wait_s += 10  # safety margin -- BotFather's own countdown is to the second
            print(f"WAIT [{broker_id}] {broker}: flood wait, retrying in {wait_s:.0f}s (attempt {attempt}/{args.max_retries})")
            time.sleep(wait_s)
        else:
            print(f"FAIL [{broker_id}] {broker}: still flood-waited after {args.max_retries} retries, skipping")
            continue

        if resp.status_code == 200:
            data = resp.json()
            append_row(args.output, broker_id, broker, data["bot_username"], data["token"])
            created += 1
            print(f"OK   [{broker_id}] {broker} -> @{data['bot_username']}")
        else:
            print(f"FAIL [{broker_id}] {broker}: HTTP {resp.status_code} {resp.text[:200]}")
        if i < len(todo) - 1:
            time.sleep(args.delay)

    print(f"Created {created}. List: {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
