"""
telegram_debounce.py -- reply-burst aggregation for private chats.

Real contacts often send a thought as several separate rapid messages.
Without this, each fragment would be forwarded -- and answered -- as its
own turn, fragmenting the conversation. Messages are buffered per
(account_id, chat_id) and the debounce window resets on every new
message; once the window closes without a new message, replying is
staged in two deliberately visible steps that mimic how a person actually
reads and answers a chat:

  1. The buffered messages are marked read (the contact sees the second
     checkmark) only once the pause has genuinely happened -- not the
     instant the first message arrives, which would look like the bot was
     already staring at the screen mid-burst.
  2. A "typing..." indicator is then shown for a fixed `typing_seconds`
     window before the aggregated event is handed off to `on_flush` --
     simulating the time it takes to compose a reply.

A new message arriving at any point (including during the read/typing
step) cancels the in-progress flush and restarts the whole cycle, exactly
like the debounce window itself.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Tuple

from telegram_adapter import _resolve_entity
from worker_logging import log_action

logger = logging.getLogger("telegram_debounce")


def _log(message, level=logging.INFO, **fields):
    log_action(logger, message, level, **fields)


OnFlush = Callable[[Dict[str, Any]], Awaitable[None]]
ShouldSignal = Callable[[Dict[str, Any]], Awaitable[bool]]
DEFAULT_DEBOUNCE_SECONDS = 40.0
DEFAULT_TYPING_SECONDS = 10.0


@dataclass
class _PendingBuffer:
    payloads: List[Dict[str, Any]] = field(default_factory=list)
    flush_task: "asyncio.Task | None" = None


class ReplyDebouncer:
    def __init__(
        self,
        get_client,
        on_flush: OnFlush,
        should_signal: ShouldSignal | None = None,
        delay_seconds: float = DEFAULT_DEBOUNCE_SECONDS,
        typing_seconds: float = DEFAULT_TYPING_SECONDS,
    ) -> None:
        self._get_client = get_client
        self._on_flush = on_flush
        self._should_signal = should_signal
        self._delay_seconds = delay_seconds
        self._typing_seconds = typing_seconds
        self._buffers: Dict[Tuple[str, str], _PendingBuffer] = {}

    async def handle_private_message(
        self, account_id: str, chat_id: str, payload: Dict[str, Any]
    ) -> None:
        key = (account_id, chat_id)
        buffer = self._buffers.get(key)
        if buffer is None:
            buffer = _PendingBuffer()
            self._buffers[key] = buffer
        buffer.payloads.append(payload)
        if buffer.flush_task is not None and not buffer.flush_task.done():
            buffer.flush_task.cancel()
        buffer.flush_task = asyncio.create_task(self._settle_and_flush(key))
        _log(
            "telegram_reply_buffered",
            account_id=account_id,
            chat_id=chat_id,
            buffered_count=len(buffer.payloads),
        )

    def cancel_chat(self, account_id: str, chat_id: str) -> bool:
        """Drop a pending automated reply after a human takes over the chat."""

        key = (account_id, chat_id)
        buffer = self._buffers.pop(key, None)
        if buffer is None:
            return False
        if buffer.flush_task is not None and not buffer.flush_task.done():
            buffer.flush_task.cancel()
        _log(
            "telegram_reply_cancelled_for_human_takeover",
            account_id=account_id,
            chat_id=chat_id,
            buffered_count=len(buffer.payloads),
        )
        return True

    async def _settle_and_flush(self, key: Tuple[str, str]) -> None:
        account_id, chat_id = key
        try:
            await asyncio.sleep(self._delay_seconds)
        except asyncio.CancelledError:
            return

        buffer = self._buffers.get(key)
        if buffer is None or not buffer.payloads:
            return
        aggregated = _aggregate(buffer.payloads)

        # The backend owns the persisted HUMAN/BOT state. Ask it before
        # producing any externally visible read receipt or typing signal.
        # Regardless of the answer, the event is still flushed afterward:
        # HUMAN-mode messages must be retained in the transcript.
        signal_allowed = True
        if self._should_signal is not None:
            try:
                signal_allowed = await self._should_signal(aggregated)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                signal_allowed = False
                _log(
                    "telegram_automation_status_failed_closed",
                    level=logging.WARNING,
                    account_id=account_id,
                    chat_id=chat_id,
                    error=f"{type(e).__name__}: {e}",
                )

        if not signal_allowed:
            current = self._buffers.pop(key, None)
            if current is None or not current.payloads:
                return
            aggregated = _aggregate(current.payloads)
            _log(
                "telegram_read_typing_suppressed",
                account_id=account_id,
                chat_id=chat_id,
                aggregated_count=len(current.payloads),
            )
            try:
                await self._on_flush(aggregated)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unexpected error flushing debounced reply for %s", key)
            return

        # A bare chat_id string/int only resolves directly if Telethon has
        # already cached that peer (e.g. from a recent get_dialogs call);
        # a numeric id alone otherwise raises "Cannot find any entity" --
        # _resolve_entity falls back to scanning dialogs for it, same as
        # the existing /telegram/send endpoint already does.
        entity = None
        try:
            client = await self._get_client(account_id)
            entity = await _resolve_entity(client, chat_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _log(
                "telegram_entity_resolution_failed",
                level=logging.WARNING,
                account_id=account_id,
                chat_id=chat_id,
                error=f"{type(e).__name__}: {e}",
            )

        if entity is not None:
            try:
                await client.send_read_acknowledge(entity)
                _log("telegram_reply_marked_read", account_id=account_id, chat_id=chat_id)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                _log(
                    "telegram_read_ack_failed",
                    level=logging.WARNING,
                    account_id=account_id,
                    chat_id=chat_id,
                    error=f"{type(e).__name__}: {e}",
                )

            try:
                async with client.action(entity, "typing"):
                    await asyncio.sleep(self._typing_seconds)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                _log(
                    "telegram_typing_indicator_failed",
                    level=logging.WARNING,
                    account_id=account_id,
                    chat_id=chat_id,
                    error=f"{type(e).__name__}: {e}",
                )
        else:
            # Entity couldn't be resolved -- skip the read/typing
            # simulation, but keep the same overall compose delay so the
            # reply doesn't arrive noticeably earlier just because the
            # cosmetic part failed.
            try:
                await asyncio.sleep(self._typing_seconds)
            except asyncio.CancelledError:
                return

        buffer = self._buffers.pop(key, None)
        if buffer is None or not buffer.payloads:
            return
        aggregated = _aggregate(buffer.payloads)
        _log(
            "telegram_reply_flushed",
            account_id=account_id,
            chat_id=chat_id,
            aggregated_count=len(buffer.payloads),
        )
        try:
            await self._on_flush(aggregated)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Unexpected error flushing debounced reply for %s", key)


def _aggregate(payloads: List[Dict[str, Any]]) -> Dict[str, Any]:
    last = payloads[-1]
    combined = dict(last)
    combined["text"] = "\n".join(p.get("text") or "" for p in payloads if p.get("text"))
    combined["aggregated_message_ids"] = [p.get("message_id") for p in payloads]
    combined["aggregated_count"] = len(payloads)
    return combined
