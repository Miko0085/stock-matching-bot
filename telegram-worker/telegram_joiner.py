"""
telegram_joiner.py — target parsing + join logic for an ALREADY-CONNECTED
Telethon client (obtained from telegram_adapter.manager.get_client()).

This module deliberately does not create, own, or manage a TelegramClient
or a `.session` file itself -- that stays the exclusive responsibility of
telegram_adapter.TelegramClientManager. Every function here takes a live
client as an argument.

Only targets explicitly supplied by the operator are ever joined -- there
is no search, no discovery, no scraping of Telegram for groups/channels.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Optional

from telethon import TelegramClient, utils
from telethon.errors import (
    ChannelInvalidError,
    ChannelPrivateError,
    ChannelsTooMuchError,
    ChatAdminRequiredError,
    FloodWaitError,
    InviteHashExpiredError,
    InviteHashInvalidError,
    InviteRequestSentError,
    RPCError,
    UserAlreadyParticipantError,
    UsernameInvalidError,
    UsernameNotOccupiedError,
)
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.messages import CheckChatInviteRequest, ImportChatInviteRequest
from telethon.tl.types import ChatInviteAlready


USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")


class InvalidTargetError(Exception):
    """Raised by parse_target() for a syntactically unsupported target."""


@dataclass(frozen=True)
class ParsedTarget:
    kind: str  # "username" | "invite"
    value: str  # bare username (no @) or bare invite hash (no leading +)
    normalized: str  # canonical display form


def _strip_domain(raw: str) -> Optional[str]:
    """Returns the path after the t.me domain, or None if `raw` isn't a
    t.me URL at all (so the caller can fall through to bare-username
    handling)."""
    match = re.match(r"^(?:https?://)?t\.me/(.+)$", raw, re.IGNORECASE)
    if not match:
        return None
    return match.group(1)


def parse_target(raw: str) -> ParsedTarget:
    """
    Supported inputs (per the operator, never inferred/guessed):
      @username
      username
      https://t.me/username | http://t.me/username | t.me/username
      https://t.me/+INVITE_HASH | t.me/+INVITE_HASH
      https://t.me/joinchat/INVITE_HASH

    Rejected (raises InvalidTargetError): internal-only t.me/c/... links
    (numeric-channel-id links that only resolve for existing members --
    there is no username or invite hash to act on), and anything else
    that doesn't match a supported shape.
    """
    value = (raw or "").strip()
    if not value:
        raise InvalidTargetError("empty target")

    value = value.rstrip("/")

    path = _strip_domain(value)
    if path is not None:
        path = path.split("?")[0].strip("/")
        if not path:
            raise InvalidTargetError(f"unsupported target: {raw!r}")

        if path.lower().startswith("c/"):
            raise InvalidTargetError(
                f"unsupported target: {raw!r} (t.me/c/... internal links only resolve for existing members)"
            )

        if path.startswith("joinchat/"):
            invite_hash = path[len("joinchat/"):]
            if not invite_hash:
                raise InvalidTargetError(f"unsupported target: {raw!r}")
            return ParsedTarget(kind="invite", value=invite_hash, normalized=f"https://t.me/+{invite_hash}")

        if path.startswith("+"):
            invite_hash = path[1:]
            if not invite_hash:
                raise InvalidTargetError(f"unsupported target: {raw!r}")
            return ParsedTarget(kind="invite", value=invite_hash, normalized=f"https://t.me/+{invite_hash}")

        username = path
        if not USERNAME_RE.match(username):
            raise InvalidTargetError(f"unsupported target: {raw!r} (not a valid username)")
        return ParsedTarget(kind="username", value=username, normalized=f"@{username}")

    # No t.me domain -- either "@username" or a bare "username".
    username = value[1:] if value.startswith("@") else value
    if not USERNAME_RE.match(username):
        raise InvalidTargetError(f"unsupported target: {raw!r} (not a valid username or t.me link)")
    return ParsedTarget(kind="username", value=username, normalized=f"@{username}")


def _entity_summary(entity: Any) -> Dict[str, Any]:
    entity_type = type(entity).__name__
    # P0.5 release blocker: a raw entity's own `.id` is NOT the canonical
    # "marked" ID used everywhere else in this codebase (event.chat_id,
    # the monitor registry, the source catalog) -- for a channel/
    # supergroup it is the bare numeric ID (e.g. 1234567890) while every
    # other consumer expects -100<id> (e.g. -1001234567890), and a basic
    # (non-super) group is marked as -<id>. telethon.utils.get_peer_id()
    # computes the exact same canonical form Telethon itself uses for
    # `event.chat_id`, so identity is consistent everywhere a chat_id is
    # stored, looked up, or compared.
    try:
        canonical_chat_id = str(utils.get_peer_id(entity))
    except Exception:
        canonical_chat_id = str(getattr(entity, "id", "") or "")

    return {
        "chat_id": canonical_chat_id,
        "title": str(getattr(entity, "title", "") or getattr(entity, "first_name", "") or ""),
        "username": str(getattr(entity, "username", "") or "") or None,
        "is_group": entity_type in ("Chat", "ChatFull") or (entity_type == "Channel" and bool(getattr(entity, "megagroup", False))),
        "is_channel": entity_type == "Channel" and not bool(getattr(entity, "megagroup", False)),
    }


async def join_target(
    client: TelegramClient,
    account_id: str,
    raw_target: str,
    *,
    monitor: bool = True,
) -> Dict[str, Any]:
    """
    Joins exactly one operator-supplied target using an already-connected
    client. Never connects/disconnects the client itself. Returns a plain
    dict shaped for the HTTP route / CLI to consume directly -- never
    raises for an expected outcome (invalid target, already a member,
    flood wait, Telegram rejection); only a genuinely unexpected error
    propagates as "error".
    """
    base: Dict[str, Any] = {
        "account_id": account_id,
        "input": raw_target,
        "normalized_target": None,
        "status": "error",
        "chat_id": None,
        "title": None,
        "username": None,
        "is_group": None,
        "is_channel": None,
        "already_member": False,
        "monitoring_enabled": False,
    }

    try:
        parsed = parse_target(raw_target)
    except InvalidTargetError as e:
        base["status"] = "invalid_target"
        base["error"] = str(e)
        return base

    base["normalized_target"] = parsed.normalized

    try:
        if parsed.kind == "username":
            return await _join_public(client, base, parsed, monitor)
        return await _join_private_invite(client, base, parsed, monitor)
    except FloodWaitError as e:
        base["status"] = "flood_wait"
        base["retry_after_seconds"] = int(e.seconds)
        base["error"] = str(e)
        return base
    except ChannelsTooMuchError as e:
        # Bulk-join hard stop (AUTO_JOIN spec item #8): "You have joined
        # too many channels/supergroups." Distinct from an ordinary
        # rejected_by_telegram -- this is an ACCOUNT-WIDE capacity limit,
        # not a problem with this one target, so retrying it (or any other
        # target) will keep failing the same way until the operator
        # manually leaves some existing groups. Callers (worker_api.py's
        # /telegram/join, and the bulk CLI) must stop the whole batch on
        # this status, never just skip-and-continue.
        base["status"] = "channels_limit_reached"
        base["error"] = f"{type(e).__name__}: {e}"
        return base
    except (ChannelPrivateError, ChannelInvalidError, ChatAdminRequiredError) as e:
        base["status"] = "rejected_by_telegram"
        base["error"] = f"{type(e).__name__}: {e}"
        return base
    except RPCError as e:
        base["status"] = "rejected_by_telegram"
        base["error"] = f"{type(e).__name__}: {e}"
        return base
    except Exception as e:  # noqa: BLE001 -- last-resort, mapped to "error" not a 500 traceback leak
        base["status"] = "error"
        base["error"] = f"{type(e).__name__}: {e}"
        return base


async def _join_public(client: TelegramClient, base: Dict[str, Any], parsed: ParsedTarget, monitor: bool) -> Dict[str, Any]:
    try:
        entity = await client.get_entity(parsed.value)
    except UsernameInvalidError:
        base["status"] = "invalid_target"
        base["error"] = "invalid username"
        return base
    except UsernameNotOccupiedError:
        base["status"] = "invalid_target"
        base["error"] = "username not found"
        return base

    try:
        await client(JoinChannelRequest(entity))
        base["status"] = "joined"
    except UserAlreadyParticipantError:
        base["status"] = "already_member"
        base["already_member"] = True

    summary = _entity_summary(entity)
    base.update(summary)
    base["monitoring_enabled"] = bool(monitor and base["status"] in ("joined", "already_member"))
    return base


async def _join_private_invite(client: TelegramClient, base: Dict[str, Any], parsed: ParsedTarget, monitor: bool) -> Dict[str, Any]:
    try:
        updates = await client(ImportChatInviteRequest(parsed.value))
    except UserAlreadyParticipantError:
        # P0.6 release blocker: ImportChatInviteRequest raising "already a
        # participant" tells us nothing about WHICH chat that is -- without
        # resolving it, chat_id stayed null while monitoring_enabled was
        # reported true, which the registry/source catalog can't act on.
        # CheckChatInviteRequest on the same hash returns ChatInviteAlready
        # (carrying the real `.chat` entity) precisely when the invite is
        # valid and we're already a member of it.
        base["status"] = "already_member"
        base["already_member"] = True
        try:
            preview = await client(CheckChatInviteRequest(parsed.value))
            if isinstance(preview, ChatInviteAlready):
                base.update(_entity_summary(preview.chat))
        except Exception:
            pass  # best-effort resolution; already_member status stands either way
        base["monitoring_enabled"] = bool(monitor and base.get("chat_id"))
        return base
    except InviteHashExpiredError:
        base["status"] = "invite_expired"
        return base
    except InviteHashInvalidError:
        base["status"] = "invite_invalid"
        return base
    except InviteRequestSentError:
        base["status"] = "join_request_sent"
        return base

    base["status"] = "joined"
    chats = getattr(updates, "chats", None) or []
    if chats:
        base.update(_entity_summary(chats[0]))
    base["monitoring_enabled"] = bool(monitor)
    return base
