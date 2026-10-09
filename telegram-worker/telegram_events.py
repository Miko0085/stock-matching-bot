"""
telegram_events.py — inbound message normalization, monitored-chat
filtering, and outbound webhook delivery to n8n.

This module holds NO Telethon client/session logic (that stays in
telegram_adapter.py) and NO business logic (matching, AI parsing,
distress filtering, ...). It is purely transport: turn a Telethon
NewMessage event into a normalized JSON payload, decide whether that
chat is currently monitored, and deliver the payload to n8n over HTTP
without ever blocking the Telethon event loop.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple

import httpx

from worker_logging import log_action

logger = logging.getLogger("telegram_events")


def _log(message: str, level: int = logging.INFO, **fields: Any) -> None:
    log_action(logger, message, level, **fields)


# ============================================================
# NORMALIZED EVENT PAYLOAD
# ============================================================

def normalize_telegram_datetime(dt) -> str:
    from datetime import timezone

    if not dt:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


async def build_message_event(account_id: str, event) -> Dict[str, Any]:
    """
    Build the normalized payload for one Telethon NewMessage event.

    Every field is fetched defensively: if a lookup fails (deleted
    account, uncached entity, etc.) that field falls back to "" / null
    instead of raising — a listener that crashes on one malformed event
    would silently stop receiving all future messages for that account,
    which is worse than one incomplete payload.

    chat_id / sender_id / message_id are the real Telethon identifiers
    (the same ones /telegram/dialogs and /telegram/send already use),
    never rewritten into a display-only string.
    """
    message = event.message

    chat_id = ""
    try:
        if event.chat_id is not None:
            chat_id = str(event.chat_id)
    except Exception:
        chat_id = ""

    sender_id = ""
    try:
        if event.sender_id is not None:
            sender_id = str(event.sender_id)
    except Exception:
        sender_id = ""

    chat_name = ""
    chat_username = ""
    try:
        chat = await event.get_chat()
        chat_name = str(getattr(chat, "title", None) or getattr(chat, "first_name", None) or "")
        chat_username = str(getattr(chat, "username", "") or "")
    except Exception:
        pass

    sender_name = ""
    sender_username = ""
    try:
        sender = await event.get_sender()
        first = str(getattr(sender, "first_name", "") or "")
        last = str(getattr(sender, "last_name", "") or "")
        sender_name = (first + " " + last).strip() or str(getattr(sender, "title", "") or "")
        sender_username = str(getattr(sender, "username", "") or "")
    except Exception:
        pass

    posted_at = ""
    try:
        posted_at = normalize_telegram_datetime(message.date)
    except Exception:
        pass

    message_id = None
    try:
        message_id = message.id
    except Exception:
        pass

    text = ""
    try:
        text = message.message or ""
    except Exception:
        pass

    # A voice note has no text at all (unlike a caption on a photo/video,
    # which .message already covers) -- without this, ai-qualifier's
    # "inbound text must not be empty" guard silently drops the reply
    # (found live: a contact who replies with voice gets no response).
    # message.voice is Telethon's dedicated voice-note attribute, distinct
    # from .audio (a shared music file, which is not a reply and is left
    # untranscribed on purpose).
    voice_audio_base64 = None
    voice_mime_type = None
    if not text:
        try:
            if message.voice is not None:
                audio_bytes = await message.download_media(bytes)
                if audio_bytes:
                    voice_audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
                    voice_mime_type = "audio/ogg"
        except Exception:
            _log(
                "telegram_voice_download_failed",
                level=logging.WARNING,
                message_id=getattr(message, "id", None),
            )

    is_group = False
    is_channel = False
    is_private = False
    try:
        is_group = bool(event.is_group)
        is_channel = bool(event.is_channel)
        is_private = bool(event.is_private)
    except Exception:
        pass

    return {
        "event": "message.new",
        "provider": "telegram",
        "account_id": account_id,
        "chat_id": chat_id,
        "chat_name": chat_name,
        "chat_username": chat_username,
        "message_id": message_id,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "sender_username": sender_username,
        "text": text,
        "voice_audio_base64": voice_audio_base64,
        "voice_mime_type": voice_mime_type,
        "posted_at": posted_at,
        "is_group": is_group,
        "is_channel": is_channel,
        "is_private": is_private,
    }


# ============================================================
# MONITORED CHATS
#
# Env-backed for now (TELEGRAM_MONITOR_CHAT_IDS), but deliberately kept
# behind a small interface so a later phase can swap in a
# Postgres/n8n-backed provider without touching the listener or the
# webhook delivery code at all — only this class changes.
# ============================================================

class MonitoredChatsProvider:
    def is_monitored(self, account_id: str, chat_id: str) -> bool:  # pragma: no cover - interface
        raise NotImplementedError


class EnvMonitoredChatsProvider(MonitoredChatsProvider):
    """
    TELEGRAM_MONITOR_CHAT_IDS=-1001111111111,-1002222222222

    Empty/unset => nothing is forwarded to n8n by default. This is a
    deliberate safety default: without an explicit allowlist, a listener
    could otherwise forward every private conversation on the account.

    AUDIT item #3 / compatibility limitation: this static, env-based
    allowlist is legacy/bootstrap only (AGENTS.md section 0) and has no
    per-account concept -- a chat_id listed here is treated as monitored
    regardless of which account sees it. `account_id` is accepted only so
    this class satisfies the same MonitoredChatsProvider interface as the
    DYNAMIC registry (telegram_monitor_registry.py), which IS fully
    account-scoped; this class's own scoping limitation is intentionally
    NOT extended to weaken that one.
    """

    def __init__(self, raw_value: Optional[str] = None) -> None:
        raw = raw_value if raw_value is not None else os.getenv("TELEGRAM_MONITOR_CHAT_IDS", "")
        self._chat_ids: Set[str] = {x.strip() for x in raw.split(",") if x.strip()}

    @property
    def configured_count(self) -> int:
        return len(self._chat_ids)

    def is_monitored(self, account_id: str, chat_id: str) -> bool:
        if not self._chat_ids:
            return False
        return str(chat_id) in self._chat_ids


class AutomationStatusProbe:
    """Fail-closed preflight before Telegram read/typing side effects."""

    def __init__(self, url: str, secret: str, timeout_seconds: float = 5.0) -> None:
        self.url = (url or "").strip()
        self.secret = secret or ""
        self.timeout_seconds = timeout_seconds
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    async def start(self) -> None:
        if self.enabled:
            self._client = httpx.AsyncClient(timeout=self.timeout_seconds)

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def is_active(self, payload: Dict[str, Any]) -> bool:
        meta = {
            "account_id": payload.get("account_id", ""),
            "chat_id": payload.get("chat_id", ""),
            "message_id": payload.get("message_id"),
        }
        if not self.enabled or self._client is None:
            _log("telegram_automation_status_unavailable", level=logging.WARNING, **meta)
            return False

        headers = {"Content-Type": "application/json"}
        if self.secret:
            headers["X-Webhook-Secret"] = self.secret
        try:
            response = await self._client.post(self.url, json=payload, headers=headers)
            if response.status_code >= 300:
                _log(
                    "telegram_automation_status_rejected",
                    level=logging.WARNING,
                    status_code=response.status_code,
                    **meta,
                )
                return False
            active = response.json().get("automation_active") is True
            _log("telegram_automation_status_resolved", automation_active=active, **meta)
            return active
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _log(
                "telegram_automation_status_failed",
                level=logging.WARNING,
                error=f"{type(e).__name__}: {e}",
                **meta,
            )
            return False


# ============================================================
# WEBHOOK DELIVERY
#
# A bounded asyncio.Queue + one background consumer task. The Telethon
# event handler only ever calls enqueue() (a fast, non-blocking, sync
# call) — the actual HTTP POST, timeout and retries happen in the
# consumer, so a slow/unreachable n8n can never stall message reception.
# ============================================================

class WebhookDeliveryQueue:
    def __init__(
        self,
        url: str,
        secret: str,
        timeout_seconds: float = 10.0,
        max_retries: int = 3,
        max_queue_size: int = 1000,
    ) -> None:
        self.url = (url or "").strip()
        self.secret = secret or ""
        self.timeout_seconds = timeout_seconds
        self.max_retries = max(1, max_retries)
        self._queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=max_queue_size)
        self._client: Optional[httpx.AsyncClient] = None
        self._task: Optional[asyncio.Task] = None

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    async def start(self) -> None:
        if not self.enabled:
            _log("webhook_delivery_disabled", detail="TELEGRAM_MONITOR_WEBHOOK_URL is not set")
            return
        self._client = httpx.AsyncClient(timeout=self.timeout_seconds)
        self._task = asyncio.create_task(self._consume())
        _log("webhook_delivery_started", timeout_seconds=self.timeout_seconds, max_retries=self.max_retries)

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def enqueue(self, payload: Dict[str, Any]) -> None:
        """Fire-and-forget. Never awaits, never raises into the caller."""
        if not self.enabled:
            return
        try:
            self._queue.put_nowait(payload)
        except asyncio.QueueFull:
            _log(
                "webhook_queue_full_dropped_event",
                level=logging.WARNING,
                account_id=payload.get("account_id", ""),
                chat_id=payload.get("chat_id", ""),
                message_id=payload.get("message_id"),
            )

    async def _consume(self) -> None:
        while True:
            payload = await self._queue.get()
            try:
                await self._deliver_with_retries(payload)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unexpected error delivering webhook event")

    async def _deliver_with_retries(self, payload: Dict[str, Any]) -> None:
        # Note: never log payload["text"] here — only metadata. The
        # message text itself is fine to include in the webhook body,
        # just not in the worker's own log file.
        meta = {
            "account_id": payload.get("account_id", ""),
            "chat_id": payload.get("chat_id", ""),
            "message_id": payload.get("message_id"),
            "text_length": len(payload.get("text") or ""),
        }

        headers = {"Content-Type": "application/json"}
        if self.secret:
            headers["X-Webhook-Secret"] = self.secret

        assert self._client is not None
        attempt = 0
        while attempt < self.max_retries:
            attempt += 1
            try:
                response = await self._client.post(self.url, json=payload, headers=headers)
                if response.status_code < 300:
                    _log("webhook_delivered", attempt=attempt, status_code=response.status_code, **meta)
                    return
                _log(
                    "webhook_delivery_rejected",
                    level=logging.WARNING,
                    attempt=attempt,
                    status_code=response.status_code,
                    **meta,
                )
            except Exception as e:
                _log(
                    "webhook_delivery_error",
                    level=logging.WARNING,
                    attempt=attempt,
                    error=f"{type(e).__name__}: {e}",
                    **meta,
                )

            if attempt < self.max_retries:
                await asyncio.sleep(min(2 ** attempt, 10))

        # Bounded retries only — never an infinite retry loop. A permanently
        # unreachable target drops events (logged), it never blocks the
        # Telethon listener or backs up memory forever.
        _log("webhook_delivery_gave_up", level=logging.ERROR, attempts=attempt, **meta)


def parse_webhook_targets(urls_raw: str, secrets_raw: str) -> List[Tuple[str, str]]:
    """
    Comma-separated URLs, e.g.:
      TELEGRAM_MONITOR_WEBHOOK_URL=https://a.example/webhook/x,https://b.example/webhook/y
      TELEGRAM_MONITOR_WEBHOOK_SECRET=secret-a,secret-b

    Secrets pair with URLs by position. If exactly one secret is given but
    several URLs, that one secret is reused for all of them (the common
    case: same shared secret, multiple destinations). If secrets run out
    before URLs do, the remaining targets get no secret header at all
    (matches the pre-existing single-target behaviour when
    TELEGRAM_MONITOR_WEBHOOK_SECRET was empty).
    """
    urls = [u.strip() for u in (urls_raw or "").split(",") if u.strip()]
    secrets = [s.strip() for s in (secrets_raw or "").split(",")] if secrets_raw else []

    if len(secrets) == 1 and len(urls) > 1:
        secrets = secrets * len(urls)
    while len(secrets) < len(urls):
        secrets.append("")

    return list(zip(urls, secrets))


class MultiWebhookDeliveryQueue:
    """
    Fans one event out to N independent webhook destinations (e.g. a local
    n8n instance behind a Cloudflare tunnel AND a separate production n8n
    instance). Each destination is its own WebhookDeliveryQueue — its own
    queue, its own consumer task, its own bounded retry loop — so a slow
    or permanently-down destination can never delay or block delivery to
    the others, and can never block the Telethon event loop either.

    Exposes the same enabled/start/stop/enqueue interface as
    WebhookDeliveryQueue, so it's a drop-in replacement wherever a single
    queue was used before.
    """

    def __init__(
        self,
        targets: List[Tuple[str, str]],
        timeout_seconds: float = 10.0,
        max_retries: int = 3,
        max_queue_size: int = 1000,
    ) -> None:
        self._queues: List[WebhookDeliveryQueue] = [
            WebhookDeliveryQueue(
                url=url,
                secret=secret,
                timeout_seconds=timeout_seconds,
                max_retries=max_retries,
                max_queue_size=max_queue_size,
            )
            for url, secret in targets
            if url
        ]

    @property
    def enabled(self) -> bool:
        return any(q.enabled for q in self._queues)

    @property
    def target_count(self) -> int:
        return len(self._queues)

    async def start(self) -> None:
        if not self._queues:
            _log("webhook_delivery_disabled", detail="no webhook targets configured")
            return
        for q in self._queues:
            await q.start()

    async def stop(self) -> None:
        for q in self._queues:
            await q.stop()

    def enqueue(self, payload: Dict[str, Any]) -> None:
        for q in self._queues:
            q.enqueue(payload)


# ============================================================
# WIRING HELPER
#
# Composes the pieces above into the single callback that
# telegram_adapter.TelegramClientManager invokes for every NewMessage
# event. Kept here (not in worker_api.py) so the transport-layer wiring
# lives next to the pieces it wires together.
# ============================================================

def make_new_message_handler(
    monitored_chats: MonitoredChatsProvider,
    webhook_queue: WebhookDeliveryQueue,
    reply_debouncer: "Any | None" = None,
    outbound_tracker: "Any | None" = None,
    manual_outbound_queue: "Any | None" = None,
    is_paused: "Callable[[str], bool] | None" = None,
) -> Callable[[str, Any], Awaitable[None]]:
    """`reply_debouncer` (a telegram_debounce.ReplyDebouncer, kept as `Any`
    here to avoid a hard import dependency in this transport-only module)
    handles private 1:1 messages separately from monitored group posts: a
    contact's reply is very often 3-4 rapid separate messages, which would
    otherwise be forwarded (and answered) as separate, confusing turns.
    Group posts are still forwarded immediately, unchanged -- a single
    post isn't a multi-message burst the way a live reply is.

    `is_paused` (telegram_pause_registry.PausedAccountsRegistry.is_paused)
    is checked FIRST, before even building the event payload: a paused
    account's events are never forwarded, never debounced, never tracked as
    automated/manual outbound -- the handler is a pure no-op for it, as if
    this worker weren't listening at all, while the underlying connection
    stays fully alive.
    """

    async def handler(account_id: str, event) -> None:
        if is_paused is not None and is_paused(account_id):
            _log("telegram_message_skipped_paused", account_id=account_id)
            return

        payload = await build_message_event(account_id, event)

        is_outgoing = bool(
            getattr(event, "out", False)
            or getattr(getattr(event, "message", None), "out", False)
        )
        if is_outgoing:
            if not payload["is_private"]:
                return
            automated = bool(
                outbound_tracker is not None
                and outbound_tracker.consume(
                    account_id, payload["chat_id"], payload["text"] or ""
                )
            )
            if automated:
                _log(
                    "telegram_automated_outbound_observed",
                    account_id=account_id,
                    chat_id=payload["chat_id"],
                    message_id=payload["message_id"],
                )
                return
            if reply_debouncer is not None:
                reply_debouncer.cancel_chat(account_id, payload["chat_id"])
            payload["event"] = "message.manual_outbound"
            _log(
                "telegram_manual_outbound_observed",
                account_id=account_id,
                chat_id=payload["chat_id"],
                message_id=payload["message_id"],
            )
            if manual_outbound_queue is not None:
                manual_outbound_queue.enqueue(payload)
            return

        _log(
            "telegram_message_received",
            account_id=account_id,
            chat_id=payload["chat_id"],
            message_id=payload["message_id"],
            is_group=payload["is_group"],
            is_channel=payload["is_channel"],
            is_private=payload["is_private"],
            text_length=len(payload["text"] or ""),
        )

        if payload["is_private"]:
            if reply_debouncer is not None:
                await reply_debouncer.handle_private_message(
                    account_id, payload["chat_id"], payload
                )
            else:
                # Safe default, unchanged from before this feature existed:
                # private messages are never forwarded unless a debouncer
                # is configured (ENABLE_EVENTS_INBOUND-gated on the
                # ai-qualifier side).
                _log(
                    "telegram_message_not_forwarded",
                    account_id=account_id,
                    chat_id=payload["chat_id"],
                    reason="private_reply_debounce_not_configured",
                )
            return

        if not monitored_chats.is_monitored(account_id, payload["chat_id"]):
            _log(
                "telegram_message_not_forwarded",
                account_id=account_id,
                chat_id=payload["chat_id"],
                reason="chat_not_in_monitor_list",
            )
            return

        webhook_queue.enqueue(payload)

    return handler
