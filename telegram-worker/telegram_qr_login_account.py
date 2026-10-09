from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import qrcode
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

PROJECT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PROJECT_ROOT.parent

# Same dual-fallback env loading as worker_api.py / telegram_adapter.py.
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(REPO_ROOT / ".env")

# Reuse telegram_adapter's account_id validation so the login tool and the
# HTTP API can never disagree about what a valid account_id looks like.
from telegram_adapter import validate_account_id  # noqa: E402

API_ID = int(os.getenv("TELEGRAM_API_ID", "0"))
API_HASH = os.getenv("TELEGRAM_API_HASH", "")
SESSIONS_DIR = Path(os.getenv("TELEGRAM_SESSIONS_DIR", str(PROJECT_ROOT / "sessions")))


def print_qr(url: str) -> None:
    qr = qrcode.QRCode(border=2)
    qr.add_data(url)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    print()
    for row in matrix:
        print("".join("██" if cell else "  " for cell in row))
    print()


async def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python telegram_qr_login_account.py <account_id>")

    try:
        account_id = validate_account_id(sys.argv[1])
    except Exception as e:
        raise SystemExit(str(e))

    if not API_ID or not API_HASH:
        raise SystemExit("TELEGRAM_API_ID / TELEGRAM_API_HASH are missing")

    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    session_base = SESSIONS_DIR / account_id
    client = TelegramClient(str(session_base), API_ID, API_HASH)
    await client.connect()

    try:
        if await client.is_user_authorized():
            me = await client.get_me()
            print(f"Already authorized: {account_id} -> @{getattr(me, 'username', '') or ''} ({getattr(me, 'id', '')})")
            return

        print(f"Creating Telegram session for account_id={account_id}")
        qr_login = await client.qr_login()
        print_qr(qr_login.url)
        print("Telegram -> Settings -> Devices -> Link Desktop Device")

        try:
            await qr_login.wait()
        except SessionPasswordNeededError:
            password = input("2FA password: ")
            await client.sign_in(password=password)

        me = await client.get_me()
        print(f"Authorized OK: {account_id} -> @{getattr(me, 'username', '') or ''} ({getattr(me, 'id', '')})")
        print(f"Session: {session_base}.session")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
