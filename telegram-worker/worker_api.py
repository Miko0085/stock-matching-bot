r"""
worker_api.py — Telegram multi-account messaging worker.

Purpose:
- Technical HTTP executor for n8n (runs on a separate Worker Server).
- Holds no business logic and makes no business decisions.
- Talks to Telegram via telegram_adapter.py (Telethon, multi-account,
  persistent per-account clients kept connected for the worker's whole
  lifetime — not opened/closed per request).
- Runs a NewMessage listener per account and forwards normalized events
  to an n8n webhook (telegram_events.py) — still pure transport, no AI /
  distress filtering / matching here.
- Also exposes the legacy generic /poll endpoint used by the older n8n
  Data Tables workflow (see RUN_ORDER.md at the repo root), Telegram only.

Endpoints:
- GET  /health                    (no auth)
- POST /poll                      (legacy generic Telegram-only poll)
- GET  /telegram/accounts
- POST /telegram/accounts                      (start a QR login for a new account_id)
- GET  /telegram/qr?account_id=...             (poll QR login status / data URL)
- POST /telegram/accounts/password             (submit 2FA password for a pending login)
- POST /telegram/accounts/logout               (invalidate + delete the local session)
- POST /telegram/accounts/pause                (stop processing this account's events; session stays connected)
- POST /telegram/accounts/resume               (resume processing; no-op if not paused)
- GET  /telegram/dialogs?account_id=...
- GET  /telegram/messages/{message_id}?chat_id=...&account_id=...  (exact single-message resolve, read-only)
- GET  /telegram/destinations?account_id=...
- GET  /telegram/groups/audit?account_id=...   (read-only membership + write-permission check)
- POST /telegram/send
- POST /telegram/bots/create                   (create a bot via @BotFather, returns its token)
- POST /telegram/join                          (join a public/private chat, optionally enable monitoring)
- GET  /telegram/monitored-chats                (dynamic monitor registry, read-only)
- DELETE /telegram/monitored-chats/{chat_id}?account_id=...  (dynamic monitor registry only, never leaves the chat)

All endpoints except /health require header: X-API-Key: <WORKER_API_KEY>

Run:
    cd telegram-worker
    python worker_api.py

Health check:
    curl http://127.0.0.1:8091/health
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from hmac import compare_digest
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from telethon.errors import RPCError


# ============================================================
# ENV / PROJECT ROOT
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PROJECT_ROOT.parent

# Load telegram-worker/.env first (new per-worker layout). Fall back to the
# repo-root .env so the pre-existing single .env with real secrets keeps
# working during migration. load_dotenv() is a no-op (no exception) if the
# file does not exist, and never overrides a variable already set.
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(REPO_ROOT / ".env")

from worker_logging import configure_logging, log_action as _log_action  # noqa: E402

LOGS_DIR = configure_logging(PROJECT_ROOT)
logger = logging.getLogger("telegram_worker")


def log_action(message: str, level: int = logging.INFO, **fields: Any) -> None:
    """Log one action (request, send, poll, auth decision, ...) with structured fields."""
    _log_action(logger, message, level, **fields)


# telegram_adapter.py / telegram_events.py / telegram_debounce.py always
# live next to this file.
import telegram_adapter  # noqa: E402
import telegram_botfather  # noqa: E402
import telegram_debounce  # noqa: E402
import telegram_events  # noqa: E402
import telegram_outbound  # noqa: E402
import telegram_joiner  # noqa: E402
import telegram_login  # noqa: E402
from telegram_adapter import TelegramWorkerError  # noqa: E402
from telegram_monitor_registry import DynamicMonitoredChatsRegistry  # noqa: E402
from telegram_pause_registry import PausedAccountsRegistry  # noqa: E402


WORKER_HOST = os.getenv("WORKER_HOST", "127.0.0.1")
WORKER_PORT = int(os.getenv("WORKER_PORT", "8091"))
WORKER_API_KEY = os.getenv("WORKER_API_KEY", "")

TELEGRAM_API_ID = os.getenv("TELEGRAM_API_ID", "")
TELEGRAM_API_HASH = os.getenv("TELEGRAM_API_HASH", "")
TELEGRAM_SESSIONS_DIR = os.getenv("TELEGRAM_SESSIONS_DIR", str(PROJECT_ROOT / "sessions"))
TELEGRAM_DEFAULT_ACCOUNT = os.getenv("TELEGRAM_DEFAULT_ACCOUNT", "")

# Inbound message forwarding to every monitoring consumer (originally just
# n8n, hence the old N8N_* names -- renamed 2026-10-07 since the real
# consumers today are the matching services (lead-matching-service/
# rf-lead-matching-service/abu-dhabi-lead-matching-service), not n8n; n8n
# itself was retired, see AGENTS.md section 10/ADR-040). All optional — if
# no webhook URL is configured, the NewMessage listener still runs
# (accounts stay connected, events still flow through telegram_events.py)
# but nothing is POSTed anywhere. See telegram_events.py for the delivery/
# monitoring logic.
#
# Both vars accept a COMMA-SEPARATED LIST of destinations, e.g.
#   TELEGRAM_MONITOR_WEBHOOK_URL=https://tunnel.example/webhook/telegram-monitor,http://host.docker.internal:8095/v1/webhooks/telegram
#   TELEGRAM_MONITOR_WEBHOOK_SECRET=secret-a,secret-b
# so the same group-monitoring event can be delivered to more than one
# destination (e.g. several matching-service contours at once), each
# independently retried — see telegram_events.parse_webhook_targets().
# A single value in either var (the original, still-supported shape)
# behaves exactly as before.
TELEGRAM_MONITOR_WEBHOOK_URL = os.getenv("TELEGRAM_MONITOR_WEBHOOK_URL", "").strip()
TELEGRAM_MONITOR_WEBHOOK_SECRET = os.getenv("TELEGRAM_MONITOR_WEBHOOK_SECRET", "")
TELEGRAM_MONITOR_WEBHOOK_TIMEOUT_SECONDS = float(os.getenv("TELEGRAM_MONITOR_WEBHOOK_TIMEOUT_SECONDS", "10"))
TELEGRAM_MONITOR_WEBHOOK_MAX_RETRIES = int(os.getenv("TELEGRAM_MONITOR_WEBHOOK_MAX_RETRIES", "3"))
TELEGRAM_MONITOR_CHAT_IDS = os.getenv("TELEGRAM_MONITOR_CHAT_IDS", "")

# How long a private chat must stay quiet before buffered messages are
# combined and forwarded as one event — a real contact often sends a
# thought as several rapid separate messages. See telegram_debounce.py.
TELEGRAM_REPLY_DEBOUNCE_SECONDS = float(
    os.getenv("TELEGRAM_REPLY_DEBOUNCE_SECONDS", "40")
)

# Once the debounce window above closes, the buffered messages are marked
# read and a "typing…" indicator is shown for this long before the reply
# is actually handed off — simulates the time it takes a person to notice
# and compose a reply, instead of the read receipt and the outbound
# message appearing at the same instant. See telegram_debounce.py.
TELEGRAM_TYPING_SECONDS = float(os.getenv("TELEGRAM_TYPING_SECONDS", "10"))

# Deliberately a SEPARATE destination from TELEGRAM_MONITOR_WEBHOOK_URL above:
# that URL is already live in production for group-post monitoring, and
# its n8n workflow only expects group posts. Debounced private-reply
# events (aggregated, is_private=true) go here instead once configured —
# e.g. ai-qualifier's /api/v1/events/inbound once Phase 7 is deployed.
TELEGRAM_PRIVATE_REPLY_WEBHOOK_URL = os.getenv(
    "TELEGRAM_PRIVATE_REPLY_WEBHOOK_URL", ""
).strip()
TELEGRAM_PRIVATE_REPLY_WEBHOOK_SECRET = os.getenv(
    "TELEGRAM_PRIVATE_REPLY_WEBHOOK_SECRET", ""
)
TELEGRAM_AUTOMATION_STATUS_URL = os.getenv(
    "TELEGRAM_AUTOMATION_STATUS_URL",
    (
        TELEGRAM_PRIVATE_REPLY_WEBHOOK_URL.rsplit("/", 1)[0]
        + "/automation-status"
        if TELEGRAM_PRIVATE_REPLY_WEBHOOK_URL
        else ""
    ),
).strip()


# ============================================================
# INBOUND MESSAGE WIRING (transport layer only — see telegram_events.py)
# ============================================================

MONITOR_STATE_DIR = os.getenv("TELEGRAM_MONITOR_STATE_DIR", str(PROJECT_ROOT / "state"))
MONITOR_STATE_PATH = Path(MONITOR_STATE_DIR) / "monitored_chats.json"
_static_chat_ids = {x.strip() for x in TELEGRAM_MONITOR_CHAT_IDS.split(",") if x.strip()}
monitored_chats = DynamicMonitoredChatsRegistry(MONITOR_STATE_PATH, static_chat_ids=_static_chat_ids)
PAUSE_STATE_PATH = Path(MONITOR_STATE_DIR) / "paused_accounts.json"
paused_accounts = PausedAccountsRegistry(PAUSE_STATE_PATH)
webhook_queue = telegram_events.MultiWebhookDeliveryQueue(
    targets=telegram_events.parse_webhook_targets(TELEGRAM_MONITOR_WEBHOOK_URL, TELEGRAM_MONITOR_WEBHOOK_SECRET),
    timeout_seconds=TELEGRAM_MONITOR_WEBHOOK_TIMEOUT_SECONDS,
    max_retries=TELEGRAM_MONITOR_WEBHOOK_MAX_RETRIES,
)
private_reply_webhook_queue = telegram_events.WebhookDeliveryQueue(
    url=TELEGRAM_PRIVATE_REPLY_WEBHOOK_URL,
    secret=TELEGRAM_PRIVATE_REPLY_WEBHOOK_SECRET,
    timeout_seconds=TELEGRAM_MONITOR_WEBHOOK_TIMEOUT_SECONDS,
    max_retries=TELEGRAM_MONITOR_WEBHOOK_MAX_RETRIES,
)
outbound_tracker = telegram_outbound.AutomatedOutboundTracker()
automation_status_probe = telegram_events.AutomationStatusProbe(
    url=TELEGRAM_AUTOMATION_STATUS_URL,
    secret=TELEGRAM_PRIVATE_REPLY_WEBHOOK_SECRET,
)


async def _enqueue_aggregated_reply(payload: Dict[str, Any]) -> None:
    private_reply_webhook_queue.enqueue(payload)


# Only worth buffering/showing "typing…" if there's somewhere to deliver
# the aggregated event to afterward.
reply_debouncer = (
    telegram_debounce.ReplyDebouncer(
        get_client=telegram_adapter.manager.get_client,
        on_flush=_enqueue_aggregated_reply,
        should_signal=automation_status_probe.is_active,
        delay_seconds=TELEGRAM_REPLY_DEBOUNCE_SECONDS,
        typing_seconds=TELEGRAM_TYPING_SECONDS,
    )
    if private_reply_webhook_queue.enabled
    else None
)
_on_new_message = telegram_events.make_new_message_handler(
    monitored_chats,
    webhook_queue,
    reply_debouncer,
    outbound_tracker,
    private_reply_webhook_queue,
    paused_accounts.is_paused,
)


# ============================================================
# APP LIFESPAN
#
# Persistent Telegram clients are started once at process startup and
# disconnected once at shutdown — never per-request. Sessions on disk are
# never touched by startup/shutdown, only read.
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    log_action(
        "worker_starting",
        project_root=str(PROJECT_ROOT),
        host=WORKER_HOST,
        port=WORKER_PORT,
        telegram_sessions_dir=TELEGRAM_SESSIONS_DIR,
        telegram_default_account=TELEGRAM_DEFAULT_ACCOUNT,
        worker_api_key_configured=bool(WORKER_API_KEY),
        webhook_enabled=webhook_queue.enabled,
        webhook_target_count=webhook_queue.target_count,
        monitored_chats_configured=monitored_chats.configured_count,
        private_reply_webhook_enabled=private_reply_webhook_queue.enabled,
        reply_debounce_enabled=reply_debouncer is not None,
        reply_debounce_seconds=TELEGRAM_REPLY_DEBOUNCE_SECONDS,
        reply_typing_seconds=TELEGRAM_TYPING_SECONDS,
        automation_status_probe_enabled=automation_status_probe.enabled,
        logs_dir=str(LOGS_DIR),
    )

    telegram_adapter.manager.set_new_message_handler(_on_new_message)
    await webhook_queue.start()
    await private_reply_webhook_queue.start()
    await automation_status_probe.start()
    await telegram_adapter.manager.start()

    yield

    log_action("worker_shutting_down")
    await telegram_adapter.manager.shutdown()
    await webhook_queue.stop()
    await private_reply_webhook_queue.stop()
    await automation_status_probe.stop()


app = FastAPI(
    title="Telegram Messaging Worker",
    version="0.3.0",
    description=(
        "Multi-account Telegram worker (Telethon, persistent clients) for n8n, "
        "with an inbound NewMessage -> n8n webhook listener and a legacy "
        "generic /poll endpoint."
    ),
    lifespan=lifespan,
)


# ============================================================
# API KEY AUTH
# ============================================================

@app.middleware("http")
async def api_key_auth(request: Request, call_next):
    # Keep health open for simple container/orchestrator monitoring.
    if request.url.path == "/health":
        return await call_next(request)

    if not WORKER_API_KEY:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "error": "WORKER_API_KEY is not configured"},
        )

    provided = request.headers.get("X-API-Key", "")
    # Never log `provided` or WORKER_API_KEY. Constant-time comparison to
    # avoid leaking key length/prefix via response-time side channels.
    if not compare_digest(provided, WORKER_API_KEY):
        return JSONResponse(
            status_code=401,
            content={"status": "error", "error": "Unauthorized"},
        )

    return await call_next(request)


# ============================================================
# ACTION / REQUEST LOGGING
#
# Registered after api_key_auth, so in Starlette's middleware stack it
# wraps OUTSIDE it and sees every request — including ones api_key_auth
# rejects with 401/503 — with the final status code. Every HTTP call in
# or out of this worker ends up as one JSON line in logs/telegram-worker.log.
# ============================================================

@app.middleware("http")
async def request_logging(request: Request, call_next):
    started = time.monotonic()
    response = await call_next(request)
    duration_ms = round((time.monotonic() - started) * 1000, 1)
    log_action(
        "http_request",
        method=request.method,
        path=request.url.path,
        query=str(request.url.query or ""),
        status_code=response.status_code,
        duration_ms=duration_ms,
        client=request.client.host if request.client else "",
    )
    return response


# ============================================================
# MODELS
# ============================================================

Platform = Literal["telegram", "whatsapp"]


class PollRequest(BaseModel):
    platform: Platform
    account_id: Optional[str] = None
    source_type: Optional[str] = ""
    source_key: str
    source_name: Optional[str] = ""
    source_handle: Optional[str] = ""
    source_platform_id: Optional[str] = ""
    last_seen_message_id: Optional[str] = ""
    last_seen_timestamp: Optional[str] = ""
    limit: int = Field(default=30, ge=1, le=200)


class PollResponse(BaseModel):
    status: Literal["ok", "error"] = "ok"
    platform: Optional[str] = ""
    account_id: Optional[str] = ""
    source_key: Optional[str] = ""
    messages: List[Dict[str, Any]] = Field(default_factory=list)
    new_last_seen_message_id: Optional[str] = ""
    new_last_seen_timestamp: Optional[str] = ""
    error: Optional[str] = ""


class TelegramSendRequest(BaseModel):
    account_id: Optional[str] = None
    destination_id: str
    destination_type: Optional[str] = None
    message: str = Field(min_length=1)
    parse_mode: Optional[str] = None
    silent: bool = False
    reply_to_message_id: Optional[str] = None


class TelegramAccountLoginRequest(BaseModel):
    account_id: str = Field(min_length=1)


class TelegramLoginPasswordRequest(BaseModel):
    account_id: str = Field(min_length=1)
    password: str = Field(min_length=1)


class TelegramAccountLogoutRequest(BaseModel):
    account_id: str = Field(min_length=1)


class TelegramAccountPauseRequest(BaseModel):
    account_id: str = Field(min_length=1)


class TelegramCreateBotRequest(BaseModel):
    account_id: str = Field(min_length=1)
    display_name: str = Field(min_length=1, max_length=64)
    username_base: str = Field(min_length=1, max_length=64)


class TelegramJoinRequest(BaseModel):
    account_id: str
    target: str = Field(min_length=1)
    monitor: bool = True
    # Optional operator-supplied market route (DUBAI/RF/SAUDI/ABU_DHABI/BOTH/
    # AUTO/NONE). This worker stays transport-only
    # (MARKET_CONTOURS_AND_SOURCE_ROUTING.md section 16 -- no DB access, no
    # business rules) -- it only VALIDATES and ECHOES this value back in the
    # response so a caller with DB access (the dashboard's Sources page, or
    # a future control-plane script) can register it into
    # ingest.source_routes. Never silently assumed when omitted -- see
    # join_target()'s docstring. SAUDI was previously missing from this list
    # (a pre-existing gap, fixed 2026-10-05 alongside adding ABU_DHABI) even
    # though migration 0024 already allows it at the DB level.
    route_mode: Optional[Literal["DUBAI", "RF", "SAUDI", "ABU_DHABI", "BOTH", "AUTO", "NONE"]] = None


# ============================================================
# HELPERS
# ============================================================

def now_utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def make_message_hash(*parts: Any) -> str:
    raw = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def safe_int(value: Any) -> Optional[int]:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except Exception:
        return None


def normalize_message(raw: Dict[str, Any], req: PollRequest) -> Dict[str, Any]:
    """
    Приводит сообщение от любого adapter к единому формату для n8n.

    Адаптер может вернуть как уже нормализованные поля:
    - source_message_id
    - source_message_text
    - source_author_display_name

    Так и простые поля:
    - id
    - text
    - date
    - author
    """

    message_id = str(
        raw.get("source_message_id")
        or raw.get("message_id")
        or raw.get("id")
        or ""
    ).strip()

    text = (
        raw.get("source_message_text")
        or raw.get("text")
        or raw.get("message")
        or ""
    )

    timestamp = (
        raw.get("source_timestamp")
        or raw.get("timestamp")
        or raw.get("date")
        or ""
    )

    author_display_name = (
        raw.get("source_author_display_name")
        or raw.get("author_display_name")
        or raw.get("author")
        or raw.get("sender_name")
        or ""
    )

    author_username = (
        raw.get("source_author_username")
        or raw.get("username")
        or raw.get("sender_username")
        or ""
    )

    author_platform_id = str(
        raw.get("source_author_platform_id")
        or raw.get("author_platform_id")
        or raw.get("sender_id")
        or raw.get("user_id")
        or ""
    )

    author_phone = (
        raw.get("source_author_phone")
        or raw.get("phone")
        or raw.get("sender_phone")
        or ""
    )

    source_message_type = (
        raw.get("source_message_type")
        or raw.get("message_type")
        or "text"
    )

    if not message_id:
        message_id = make_message_hash(
            req.platform,
            getattr(req, "account_id", "") or raw.get("account_id") or "",
            req.source_key,
            timestamp,
            author_display_name,
            text,
        )[:24]

    source_message_hash = str(
        raw.get("source_message_hash")
        or make_message_hash(
            req.platform,
            getattr(req, "account_id", "") or raw.get("account_id") or "",
            req.source_key,
            message_id,
            timestamp,
            author_display_name,
            text,
        )
    )

    return {
        "platform": req.platform,
        "account_id": str(getattr(req, "account_id", "") or raw.get("account_id") or ""),
        "source_type": req.source_type or "",
        "source_key": req.source_key,
        "source_name": req.source_name or "",
        "source_message_id": message_id,
        "source_message_hash": source_message_hash,
        "source_timestamp": str(timestamp or ""),
        "source_author_display_name": str(author_display_name or ""),
        "source_author_username": str(author_username or ""),
        "source_author_platform_id": str(author_platform_id or ""),
        "source_author_phone": str(author_phone or ""),
        "source_message_text": str(text or ""),
        "source_message_type": str(source_message_type or "text"),
    }


def filter_new_messages(messages: List[Dict[str, Any]], req: PollRequest) -> List[Dict[str, Any]]:
    """
    Worker делает мягкую фильтрацию по last_seen_message_id, если message_id числовой.
    Но главная дедупликация всё равно должна быть в n8n:
    platform + source_key + source_message_id
    fallback: platform + source_key + source_message_hash
    """

    if not messages:
        return []

    last_seen_id = safe_int(req.last_seen_message_id)

    if last_seen_id is None:
        return messages[: req.limit]

    filtered = []
    for m in messages:
        mid = safe_int(m.get("source_message_id"))
        if mid is None:
            filtered.append(m)
        elif mid > last_seen_id:
            filtered.append(m)

    return filtered[: req.limit]


def calc_new_cursor(messages: List[Dict[str, Any]], req: PollRequest) -> Dict[str, str]:
    if not messages:
        return {
            "new_last_seen_message_id": req.last_seen_message_id or "",
            "new_last_seen_timestamp": req.last_seen_timestamp or "",
        }

    def msg_sort_key(m: Dict[str, Any]) -> int:
        return safe_int(m.get("source_message_id")) or 0

    latest = sorted(messages, key=msg_sort_key)[-1]

    return {
        "new_last_seen_message_id": str(latest.get("source_message_id") or ""),
        "new_last_seen_timestamp": str(latest.get("source_timestamp") or ""),
    }


def short_error(e: Exception) -> str:
    """Client-facing error string: exception type + message, no traceback."""
    return f"{type(e).__name__}: {e}"


# Telethon's RPCError subclasses each carry a `.code` matching Telegram's
# own error grouping (400/401/403/404/406/420/500 — see telethon.errors).
# These are Telegram *rejecting* the request for a specific, legitimate
# reason (banned from posting, write-forbidden, flood limit, ...), not a
# bug in this worker, so they should never surface as a generic 500.
_RPC_CODE_TO_HTTP: Dict[int, int] = {
    400: 400,
    401: 401,
    403: 403,
    404: 404,
    406: 406,
    420: 429,  # flood wait -> Too Many Requests
    500: 502,  # error on Telegram's side, not ours
}


def telegram_error_to_http(e: Exception, action: str, **fields: Any) -> HTTPException:
    """
    Map a telegram_adapter error to a precise HTTP status code without
    leaking a traceback, and log the action either way.

    - TelegramWorkerError (bad/unknown account_id, not authorized, not
      currently connected, ...): mapped via its own status_code.
    - Telethon RPCError (Telegram itself rejected the request — banned in
      channel, write forbidden, flood wait, ...): mapped via e.code, with
      the real reason in the response body. Still not a traceback, just
      Telegram's own short error name/message.
    - Anything else: an actual unexpected bug -> generic 500, full
      traceback written to server logs only.
    """
    if isinstance(e, TelegramWorkerError):
        log_action(
            action,
            level=logging.WARNING,
            result="rejected",
            status_code=e.status_code,
            error=str(e),
            **fields,
        )
        return HTTPException(status_code=e.status_code, detail=str(e))

    if isinstance(e, RPCError):
        status_code = _RPC_CODE_TO_HTTP.get(e.code, 502)
        message = short_error(e)
        seconds = getattr(e, "seconds", None)
        if seconds:
            message += f" (retry after {seconds}s)"
        log_action(
            action,
            level=logging.WARNING,
            result="rejected_by_telegram",
            status_code=status_code,
            error=message,
            **fields,
        )
        return HTTPException(status_code=status_code, detail=message)

    log_action(action, level=logging.ERROR, result="error", status_code=500, error=short_error(e), **fields)
    logger.exception("Unhandled error in Telegram route: %s", action)
    return HTTPException(status_code=500, detail="Internal server error")


# ============================================================
# ADAPTER IMPORTS (legacy generic /poll only)
# ============================================================

async def poll_telegram(req: PollRequest) -> List[Dict[str, Any]]:
    resolved_account = telegram_adapter.resolve_account_id(req.account_id)
    client = await telegram_adapter.manager.get_client(resolved_account)
    result = await telegram_adapter.poll_telegram_messages(client, resolved_account, req.model_dump())
    if not isinstance(result, list):
        raise TypeError("telegram_adapter.poll_telegram_messages must return list[dict]")
    return result


# ============================================================
# ROUTES
# ============================================================

@app.get("/health")
async def health() -> Dict[str, Any]:
    stats = telegram_adapter.manager.stats()
    return {
        "status": "ok",
        "service": "telegram_messaging_worker",
        "version": "0.3.0",
        "time_utc": now_utc_iso(),
        "persistent_clients": stats["persistent_clients"],
        "connected_clients": stats["connected_clients"],
        "webhook_delivery_enabled": webhook_queue.enabled,
        "webhook_delivery_target_count": webhook_queue.target_count,
        "private_reply_webhook_enabled": private_reply_webhook_queue.enabled,
        "reply_debounce_enabled": reply_debouncer is not None,
        "reply_debounce_seconds": TELEGRAM_REPLY_DEBOUNCE_SECONDS,
        "reply_typing_seconds": TELEGRAM_TYPING_SECONDS,
        "automation_status_probe_enabled": automation_status_probe.enabled,
        "env": {
            "telegram_api_id_set": bool(TELEGRAM_API_ID),
            "telegram_api_hash_set": bool(TELEGRAM_API_HASH),
            "telegram_default_account": TELEGRAM_DEFAULT_ACCOUNT,
            "worker_host": WORKER_HOST,
            "worker_port": WORKER_PORT,
        },
    }


@app.post("/poll", response_model=PollResponse)
async def poll(req: PollRequest) -> PollResponse:
    log_action(
        "poll_requested",
        platform=req.platform,
        account_id=req.account_id or "",
        source_key=req.source_key,
        limit=req.limit,
    )
    try:
        if req.platform == "telegram":
            raw_messages = await poll_telegram(req)
        else:
            error = f"Unsupported platform: {req.platform}"
            if req.platform == "whatsapp":
                error = (
                    "WhatsApp polling via /poll has been removed (the legacy "
                    "Playwright-based reader is gone). Use the whatsapp-worker "
                    "Baileys service on port 8092 instead."
                )
            return PollResponse(
                status="error",
                platform=req.platform,
                account_id=req.account_id or "",
                source_key=req.source_key,
                messages=[],
                error=error,
            )

        normalized = [normalize_message(m, req) for m in raw_messages]
        new_messages = filter_new_messages(normalized, req)
        cursor = calc_new_cursor(new_messages, req)

        resolved_response_account = (
            req.account_id
            or (new_messages[0].get("account_id") if new_messages else "")
            or ""
        )

        log_action(
            "poll_completed",
            platform=req.platform,
            account_id=resolved_response_account,
            source_key=req.source_key,
            result="ok",
            message_count=len(new_messages),
        )

        return PollResponse(
            status="ok",
            platform=req.platform,
            account_id=resolved_response_account,
            source_key=req.source_key,
            messages=new_messages,
            new_last_seen_message_id=cursor["new_last_seen_message_id"],
            new_last_seen_timestamp=cursor["new_last_seen_timestamp"],
            error="",
        )

    except Exception as e:
        log_action(
            "poll_completed",
            level=logging.ERROR,
            platform=req.platform,
            account_id=req.account_id or "",
            source_key=req.source_key,
            result="error",
            error=short_error(e),
        )
        logger.exception("Unhandled error in /poll")
        return PollResponse(
            status="error",
            platform=req.platform,
            account_id=req.account_id or "",
            source_key=req.source_key,
            messages=[],
            new_last_seen_message_id=req.last_seen_message_id or "",
            new_last_seen_timestamp=req.last_seen_timestamp or "",
            error=short_error(e),
        )


# ============================================================
# TELEGRAM MULTI-ACCOUNT ROUTES
# ============================================================

@app.get("/telegram/accounts")
async def telegram_accounts() -> Dict[str, Any]:
    try:
        accounts = telegram_adapter.manager.list_accounts()
        for account in accounts:
            account["paused"] = paused_accounts.is_paused(account["account_id"])
        log_action("telegram_accounts_listed", result="ok", count=len(accounts))
        return {"status": "ok", "count": len(accounts), "accounts": accounts, "error": ""}
    except Exception as e:
        raise telegram_error_to_http(e, "telegram_accounts_listed")


@app.post("/telegram/accounts/pause")
async def telegram_pause_account(req: TelegramAccountPauseRequest) -> Dict[str, Any]:
    """
    Stops this account's inbound events from being processed/forwarded at
    all (no webhook delivery, no private-reply debounce) while leaving the
    Telegram session fully connected -- distinct from logout, which
    invalidates the session itself. Effective on the very next inbound
    event, no restart needed. Persisted (state/paused_accounts.json), so it
    survives a worker restart.
    """
    account_id = telegram_adapter.validate_account_id(req.account_id)
    result = paused_accounts.pause(account_id)
    log_action("telegram_pause_requested", account_id=account_id)
    return {"status": "ok", **result}


@app.post("/telegram/accounts/resume")
async def telegram_resume_account(req: TelegramAccountPauseRequest) -> Dict[str, Any]:
    """Resumes normal event processing for a paused account. A no-op
    (still returns 200) if the account wasn't paused."""
    account_id = telegram_adapter.validate_account_id(req.account_id)
    result = paused_accounts.resume(account_id)
    log_action("telegram_resume_requested", account_id=account_id, was_paused=result["was_paused"])
    return {"status": "ok", **result}


@app.post("/telegram/accounts")
async def telegram_start_login(req: TelegramAccountLoginRequest) -> Dict[str, Any]:
    """
    Starts (or returns the already-in-progress) QR login for a NEW
    account_id — the HTTP-reachable equivalent of running
    `python telegram_qr_login_account.py <account_id>` by hand. Poll
    GET /telegram/qr?account_id=... for the QR code and outcome.
    """
    account_id = telegram_adapter.validate_account_id(req.account_id)
    log_action("telegram_login_start_requested", account_id=account_id)
    try:
        pending = await telegram_login.manager.start(
            account_id,
            api_id=telegram_adapter.TELEGRAM_API_ID,
            api_hash=telegram_adapter.TELEGRAM_API_HASH,
            sessions_dir=telegram_adapter.TELEGRAM_SESSIONS_DIR,
            is_account_loaded=telegram_adapter.manager.is_client_open,
        )
    except telegram_login.LoginStateError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise telegram_error_to_http(e, "telegram_login_start_completed", account_id=account_id)

    log_action("telegram_login_start_completed", result="ok", account_id=account_id, login_status=pending.status)
    return {"status": "ok", "account_id": account_id, "login_status": pending.status}


@app.get("/telegram/qr")
async def telegram_qr(account_id: str) -> Dict[str, Any]:
    """
    Poll the outcome of a pending QR login. The moment this observes
    'connected', the fresh client is handed off to the persistent
    TelegramClientManager (adopt_authorized_client) so the account starts
    receiving events immediately, with no worker restart.
    """
    account_id = telegram_adapter.validate_account_id(account_id)
    pending = telegram_login.manager.get(account_id)
    if pending is None:
        raise HTTPException(
            status_code=404,
            detail=f"No pending Telegram login for '{account_id}'. Start one with POST /telegram/accounts.",
        )

    connected = telegram_login.manager.pop_connected(account_id)
    if connected is not None:
        state = await telegram_adapter.manager.adopt_authorized_client(account_id, connected.client)
        log_action("telegram_login_completed", result="ok", account_id=account_id, username=state.username)
        return {
            "status": "ok",
            "account_id": account_id,
            "login_status": "connected",
            "qr_data_url": None,
            "user_id": state.user_id,
            "username": state.username,
            "name": state.name,
            "error": None,
        }

    qr_data_url = None
    if pending.status == "waiting_for_scan" and pending.qr_url:
        qr_data_url = telegram_login.qr_url_to_data_url(pending.qr_url)

    return {
        "status": "ok",
        "account_id": account_id,
        "login_status": pending.status,
        "qr_data_url": qr_data_url,
        "error": pending.error,
    }


@app.post("/telegram/accounts/password")
async def telegram_login_password(req: TelegramLoginPasswordRequest) -> Dict[str, Any]:
    """Submits a 2FA password for a login currently in 'needs_password'."""
    account_id = telegram_adapter.validate_account_id(req.account_id)
    log_action("telegram_login_password_submitted", account_id=account_id)
    try:
        pending = await telegram_login.manager.submit_password(account_id, req.password)
    except telegram_login.LoginStateError as e:
        raise HTTPException(status_code=409, detail=str(e))

    if pending.status == "connected":
        connected = telegram_login.manager.pop_connected(account_id)
        state = await telegram_adapter.manager.adopt_authorized_client(account_id, connected.client)
        log_action("telegram_login_completed", result="ok", account_id=account_id, username=state.username, via="password")
        return {"status": "ok", "account_id": account_id, "login_status": "connected", "username": state.username}

    log_action(
        "telegram_login_password_result",
        result="retry" if pending.error else "pending",
        account_id=account_id,
    )
    return {"status": "ok", "account_id": account_id, "login_status": pending.status, "error": pending.error}


@app.post("/telegram/accounts/logout")
async def telegram_logout(req: TelegramAccountLogoutRequest) -> Dict[str, Any]:
    """
    Logs out this account on Telegram's side (invalidates + deletes the
    local session, Telethon's official log_out()). Does not touch any
    other account, and does not touch dashboard-side channels/routing/
    monitoring/match-history rows — this worker has no DB access at all.
    """
    account_id = telegram_adapter.validate_account_id(req.account_id)
    log_action("telegram_logout_requested", account_id=account_id)
    try:
        await telegram_adapter.manager.logout_account(account_id)
    except Exception as e:
        raise telegram_error_to_http(e, "telegram_logout_completed", account_id=account_id)
    log_action("telegram_logout_completed", result="ok", account_id=account_id)
    return {
        "status": "ok",
        "account_id": account_id,
        "message": "Logged out — session invalidated on Telegram. Channels, routing, monitoring config, and match history are unaffected.",
    }


@app.get("/telegram/dialogs")
async def telegram_dialogs(
    account_id: Optional[str] = None,
    limit: int = 500,
    include_private: bool = True,
    include_groups: bool = True,
    include_channels: bool = True,
) -> Dict[str, Any]:
    try:
        resolved_account = telegram_adapter.resolve_account_id(account_id)
        client = await telegram_adapter.manager.get_client(resolved_account)
        dialogs = await telegram_adapter.list_telegram_dialogs(
            client,
            resolved_account,
            limit=max(1, min(limit, 2000)),
            include_private=include_private,
            include_groups=include_groups,
            include_channels=include_channels,
        )
        log_action(
            "telegram_dialogs_listed",
            result="ok",
            account_id=resolved_account,
            count=len(dialogs),
        )
        return {
            "status": "ok",
            "account_id": resolved_account,
            "count": len(dialogs),
            "dialogs": dialogs,
            "error": "",
        }
    except Exception as e:
        raise telegram_error_to_http(e, "telegram_dialogs_listed", account_id=account_id or "")


@app.get("/telegram/messages/{message_id}")
async def get_telegram_message(
    message_id: int,
    chat_id: str,
    account_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Exact single-message resolve -- read-only, used by n8n to look up the
    numeric Telegram sender id of one specific message_id (e.g. a lead
    normalized by an upstream monitoring service that doesn't carry the
    numeric author id itself). Never sends anything."""
    try:
        resolved_account = telegram_adapter.resolve_account_id(account_id)
        client = await telegram_adapter.manager.get_client(resolved_account)
        result = await telegram_adapter.resolve_telegram_message_by_id(
            client, resolved_account, chat_id, message_id
        )
    except Exception as e:
        raise telegram_error_to_http(
            e,
            "telegram_message_resolve_failed",
            account_id=account_id or "",
            chat_id=chat_id,
            message_id=message_id,
        )

    log_action(
        "telegram_message_resolve_completed",
        result="ok" if result is not None else "not_found",
        account_id=resolved_account,
        chat_id=chat_id,
        message_id=message_id,
    )
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Message {message_id} not found in chat {chat_id}",
        )
    return {"status": "ok", **result}


@app.get("/telegram/destinations")
async def telegram_destinations(
    account_id: Optional[str] = None,
    limit: int = 500,
    include_private: bool = True,
    include_groups: bool = True,
    include_channels: bool = True,
) -> Dict[str, Any]:
    return await telegram_dialogs(
        account_id=account_id,
        limit=limit,
        include_private=include_private,
        include_groups=include_groups,
        include_channels=include_channels,
    )


GROUPS_FILE_DEFAULT = "telegram_groups.txt"


@app.get("/telegram/groups/audit")
async def telegram_groups_audit(
    account_id: Optional[str] = None,
    delay_seconds: float = 3.0,
    file: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Read-only diagnostics for a `chat_id<TAB>name<TAB>username` group export
    (default: telegram_groups.txt next to this file): for each group, report
    whether this account is still a member and, if so, whether it currently
    has permission to send messages there. Never sends a message and never
    joins/leaves/mutes anything.

    One Telegram request per still-joined group, paced out with a randomized
    delay (`delay_seconds`, clamped to 1.5-30s) — deliberately slow instead
    of a burst, so this cannot look like automated bulk scanning.
    """
    source_name = (file or GROUPS_FILE_DEFAULT).strip()
    if not source_name or "/" in source_name or "\\" in source_name or ".." in source_name:
        raise HTTPException(status_code=400, detail="invalid file name")
    source_path = PROJECT_ROOT / source_name
    groups = telegram_adapter.parse_group_list_file(source_path)
    if not groups:
        raise HTTPException(status_code=404, detail=f"No groups parsed from {source_name}")

    delay = max(1.5, min(delay_seconds, 30.0))
    log_action(
        "telegram_groups_audit_started",
        account_id=account_id or "",
        file=source_name,
        group_count=len(groups),
        delay_seconds=delay,
    )
    try:
        resolved_account = telegram_adapter.resolve_account_id(account_id)
        client = await telegram_adapter.manager.get_client(resolved_account)
        results = await telegram_adapter.audit_group_membership(
            client, groups, delay_seconds=delay
        )

        summary = {
            "can_write": sum(1 for r in results if r["member"] and r["can_write"] is True),
            "cannot_write": sum(1 for r in results if r["member"] and r["can_write"] is False),
            "unknown": sum(1 for r in results if r["member"] and r["can_write"] is None),
            "not_member": sum(1 for r in results if not r["member"]),
        }
        log_action(
            "telegram_groups_audit_completed",
            result="ok",
            account_id=resolved_account,
            total=len(results),
            **summary,
        )
        return {
            "status": "ok",
            "account_id": resolved_account,
            "file": source_name,
            "total": len(results),
            "summary": summary,
            "results": results,
        }
    except Exception as e:
        raise telegram_error_to_http(
            e, "telegram_groups_audit_completed", account_id=account_id or ""
        )


@app.post("/telegram/send")
async def telegram_send(req: TelegramSendRequest) -> Dict[str, Any]:
    # Log the send attempt itself before we know the outcome, and the
    # message length only — never the message text — to keep the action
    # log useful for audit/debugging without becoming a chat-content log.
    log_action(
        "telegram_send_requested",
        account_id=req.account_id or "",
        destination_id=req.destination_id,
        destination_type=req.destination_type or "",
        message_length=len(req.message),
        has_reply_to=bool(req.reply_to_message_id),
    )
    try:
        resolved_account = telegram_adapter.resolve_account_id(req.account_id)
        client = await telegram_adapter.manager.get_client(resolved_account)
        automation_token = outbound_tracker.prepare(
            resolved_account, req.destination_id, req.message
        )
        try:
            result = await telegram_adapter.send_telegram_message(
                client, resolved_account, req.model_dump()
            )
        except Exception:
            outbound_tracker.cancel(automation_token)
            raise
        log_action(
            "telegram_send_completed",
            result="ok",
            account_id=result.get("account_id", req.account_id or ""),
            destination_id=req.destination_id,
            destination_type=result.get("destination_type", ""),
            message_id=result.get("message_id", ""),
        )
        return result
    except Exception as e:
        raise telegram_error_to_http(
            e,
            "telegram_send_completed",
            account_id=req.account_id or "",
            destination_id=req.destination_id,
        )


@app.post("/telegram/bots/create")
async def telegram_create_bot(req: TelegramCreateBotRequest) -> Dict[str, Any]:
    """Create a bot via @BotFather using the account's persistent client.

    Returns the bot token to the caller (which records it); the token is
    never written to the action log.
    """
    log_action(
        "telegram_create_bot_requested",
        account_id=req.account_id,
        username_base=req.username_base,
    )
    try:
        resolved_account = telegram_adapter.resolve_account_id(req.account_id)
        client = await telegram_adapter.manager.get_client(resolved_account)
        result = await telegram_botfather.create_bot(client, req.display_name, req.username_base)
        log_action(
            "telegram_create_bot_completed",
            result="ok",
            account_id=resolved_account,
            bot_username=result["bot_username"],
        )
        return {"status": "ok", "account_id": resolved_account, **result}
    except telegram_botfather.BotLimitReachedError as e:
        log_action("telegram_create_bot_completed", level=logging.WARNING, result="limit", error=str(e)[:200])
        raise HTTPException(status_code=429, detail=f"BotFather limit: {str(e)[:200]}")
    except telegram_botfather.BotCreationError as e:
        log_action("telegram_create_bot_completed", level=logging.WARNING, result="rejected", error=str(e)[:200])
        raise HTTPException(status_code=422, detail=str(e)[:300])
    except Exception as e:
        raise telegram_error_to_http(e, "telegram_create_bot_completed", account_id=req.account_id)


@app.post("/telegram/join")
async def telegram_join(req: TelegramJoinRequest) -> Dict[str, Any]:
    """
    Joins exactly one operator-supplied Telegram target (public username or
    private invite link) using the account's existing persistent, already-
    connected Telethon client (telegram_adapter.manager.get_client()) --
    never opens a second client/session for this. No search, no discovery:
    only the target explicitly given here is ever joined.

    When `monitor=true` and the join/already-member outcome succeeds, the
    chat_id is immediately added to the dynamic monitor registry
    (state/monitored_chats.json) -- effective on the very next inbound
    message, with no .env edit and no worker restart.

    `route_mode` (DUBAI/RF/BOTH/AUTO/NONE), if supplied, is validated and
    echoed back unchanged -- it is never stored or acted on by this
    worker. Registering it into the source catalog (ingest.source_routes)
    is the caller's responsibility (e.g. the dashboard Sources page).
    """
    log_action("telegram_join_requested", account_id=req.account_id, target=req.target, monitor=req.monitor)
    try:
        resolved_account = telegram_adapter.resolve_account_id(req.account_id)
        client = await telegram_adapter.manager.get_client(resolved_account)
    except Exception as e:
        raise telegram_error_to_http(e, "telegram_join_completed", account_id=req.account_id, target=req.target)

    result = await telegram_joiner.join_target(client, resolved_account, req.target, monitor=req.monitor)

    if result.get("monitoring_enabled") and result.get("chat_id"):
        monitored_chats.add(
            resolved_account,
            result["chat_id"],
            title=result.get("title") or "",
            username=result.get("username") or "",
        )

    # Echoed back verbatim, never defaulted/guessed here -- this worker has
    # no DB access and makes no routing decision itself (transport-only,
    # per MARKET_CONTOURS_AND_SOURCE_ROUTING.md section 16). A caller with
    # DB access (dashboard Sources page, or a future control-plane script)
    # is responsible for actually upserting this into ingest.source_routes.
    result["route_mode"] = req.route_mode

    log_action(
        "telegram_join_completed",
        result=result.get("status"),
        account_id=resolved_account,
        target=req.target,
        chat_id=result.get("chat_id"),
        monitoring_enabled=result.get("monitoring_enabled"),
        route_mode=req.route_mode,
    )

    if result.get("status") == "flood_wait":
        return JSONResponse(status_code=429, content=result)
    return result


@app.get("/telegram/monitored-chats")
async def telegram_monitored_chats() -> Dict[str, Any]:
    """Read-only: the dynamically-added half of the monitor allowlist (the
    static TELEGRAM_MONITOR_CHAT_IDS half is env-only and intentionally
    not editable at runtime). Never includes any credential material."""
    dynamic = monitored_chats.list_dynamic()
    return {
        "status": "ok",
        "static_chat_id_count": len(_static_chat_ids),
        "dynamic_count": len(dynamic),
        "dynamic_chats": dynamic,
    }


@app.delete("/telegram/monitored-chats/{chat_id}")
async def telegram_monitored_chats_delete(
    chat_id: str,
    account_id: str = Query(..., description="Required (AUDIT item #3): monitoring is scoped per (account_id, chat_id), never chat_id alone."),
) -> Dict[str, Any]:
    """Removes an (account_id, chat_id) pair from the DYNAMIC registry only
    -- a chat_id that came from the static TELEGRAM_MONITOR_CHAT_IDS env
    var is unaffected (that half is only ever changed by editing .env and
    restarting). Never leaves the chat automatically -- disabling
    monitoring and leaving a group are deliberately separate operator
    actions. `account_id` is required so removing one account's monitoring
    of a chat_id can never affect another account's independent entry for
    the same chat_id."""
    removed = monitored_chats.remove(account_id, chat_id)
    log_action("telegram_monitor_chat_removed", account_id=account_id, chat_id=chat_id, removed=removed)
    if not removed:
        raise HTTPException(status_code=404, detail=f"(account_id={account_id}, chat_id={chat_id}) is not in the dynamic monitor registry")
    return {"status": "ok", "account_id": account_id, "chat_id": chat_id, "removed": True}


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    uvicorn.run(
        "worker_api:app",
        host=WORKER_HOST,
        port=WORKER_PORT,
        reload=False,
        log_level="info",
    )
