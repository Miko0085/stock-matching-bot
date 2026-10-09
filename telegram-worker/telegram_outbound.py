"""Classify outgoing Telegram messages as API automation or human takeover.

The authenticated /telegram/send route registers an intent *before* calling
Telethon.  The account's NewMessage update then consumes that intent.  Any
other outgoing private message came from a connected Telegram client and is
therefore a manual operator intervention.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class _PendingSend:
    token: str
    account_id: str
    destination_id: str
    text: str
    expires_at: float


class AutomatedOutboundTracker:
    def __init__(self, ttl_seconds: float = 15.0) -> None:
        self._ttl_seconds = ttl_seconds
        self._pending: list[_PendingSend] = []

    def prepare(self, account_id: str, destination_id: str, text: str) -> str:
        self._prune()
        token = uuid.uuid4().hex
        self._pending.append(
            _PendingSend(
                token=token,
                account_id=str(account_id),
                destination_id=str(destination_id),
                text=text,
                expires_at=time.monotonic() + self._ttl_seconds,
            )
        )
        return token

    def cancel(self, token: str) -> None:
        self._pending = [item for item in self._pending if item.token != token]

    def consume(self, account_id: str, destination_id: str, text: str) -> bool:
        self._prune()
        account_id = str(account_id)
        destination_id = str(destination_id)
        exact = next(
            (
                item
                for item in self._pending
                if item.account_id == account_id
                and item.destination_id == destination_id
                and item.text == text
            ),
            None,
        )
        if exact is not None:
            self.cancel(exact.token)
            return True

        # Telegram can receive a username at /send but emit the resolved
        # numeric chat id. Fall back only when there is exactly one pending
        # send with the same account and text, avoiding broad text-only
        # suppression across concurrent conversations.
        candidates = [
            item
            for item in self._pending
            if item.account_id == account_id and item.text == text
        ]
        if len(candidates) == 1:
            self.cancel(candidates[0].token)
            return True
        return False

    def _prune(self) -> None:
        now = time.monotonic()
        self._pending = [item for item in self._pending if item.expires_at > now]
