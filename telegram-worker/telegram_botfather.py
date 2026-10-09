r"""
telegram_botfather.py — creates a Telegram bot by driving @BotFather with an
already-authorized Telethon user client (there is no official API for bot
creation).

Transport-only, like the rest of telegram-worker: no DB access, no business
rules. The caller (tools/telegram_create_broker_bots.py) decides which bots
to create and where the resulting token is recorded.

Flow: /cancel -> /newbot -> <display name> -> <username> -> token in reply.
A taken/invalid username is retried with a numeric suffix.
"""

from __future__ import annotations

import re
import secrets
from typing import Any, List, Optional

BOTFATHER = "BotFather"
TOKEN_RE = re.compile(r"\b(\d{6,12}:[A-Za-z0-9_-]{30,})\b")
USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,29}_?[Bb]ot$")
RESPONSE_TIMEOUT = 30


class BotCreationError(Exception):
    """BotFather refused or answered with something we cannot interpret."""


class BotLimitReachedError(BotCreationError):
    """Account hit BotFather's per-account bot cap / too-many-attempts."""


def slugify(text: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", text.strip()).strip("_")
    return slug or "broker"


def build_username_candidates(base: str, attempts: int = 4) -> List[str]:
    """Valid bot usernames (must end in 'bot', 5-32 chars) for a base name."""
    slug = slugify(base)
    candidates = [f"{slug[:20]}_nika_bot"]
    for _ in range(attempts - 1):
        candidates.append(f"{slug[:14]}_nika_{secrets.token_hex(2)}_bot")
    return [c for c in candidates if USERNAME_RE.fullmatch(c)]


def _classify(text: str) -> str:
    low = text.lower()
    if TOKEN_RE.search(text):
        return "token"
    if "too many attempts" in low or "too many bots" in low or "limit" in low:
        return "limit"
    if "already taken" in low or "is taken" in low or "occupied" in low:
        return "taken"
    if "invalid" in low or "must end in" in low:
        return "invalid"
    return "other"


async def create_bot(client: Any, display_name: str, username_base: str) -> dict:
    """Create one bot. Returns {bot_username, token, display_name}."""
    candidates = build_username_candidates(username_base)
    if not candidates:
        raise BotCreationError(f"cannot build a valid bot username from {username_base!r}")

    async with client.conversation(BOTFATHER, timeout=RESPONSE_TIMEOUT, total_timeout=180) as conv:
        await conv.send_message("/cancel")
        await conv.get_response()

        await conv.send_message("/newbot")
        reply = await conv.get_response()
        if _classify(reply.raw_text) == "limit":
            raise BotLimitReachedError(reply.raw_text)

        await conv.send_message(display_name)
        reply = await conv.get_response()
        if _classify(reply.raw_text) == "limit":
            raise BotLimitReachedError(reply.raw_text)

        last_text = reply.raw_text
        for username in candidates:
            await conv.send_message(username)
            reply = await conv.get_response()
            last_text = reply.raw_text
            kind = _classify(last_text)
            if kind == "token":
                return {
                    "bot_username": username,
                    "token": TOKEN_RE.search(last_text).group(1),
                    "display_name": display_name,
                }
            if kind == "limit":
                raise BotLimitReachedError(last_text)
            # taken/invalid/other -> try the next candidate

        raise BotCreationError(f"no username accepted by BotFather; last reply: {last_text[:200]}")
