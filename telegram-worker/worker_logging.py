"""
Shared logging setup for telegram-worker's modules (worker_api,
telegram_adapter, telegram_events).

configure_logging() attaches the console + rotating-JSON-file handlers to
the ROOT logger exactly once. Every module then just does
`logging.getLogger(__name__)` and calls log_action() — since all loggers
propagate to root by default, everything ends up in the same
logs/telegram-worker.log with the same JSON shape, with no per-module
setup duplication and no circular imports between the modules.
"""

from __future__ import annotations

import json
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

_configured = False


class JsonLogFormatter(logging.Formatter):
    """One JSON object per line: easy to grep/parse for an action audit trail."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra_fields = getattr(record, "extra_fields", None)
        if extra_fields:
            payload.update(extra_fields)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(project_root: Path) -> Path:
    """
    Idempotent: safe to call from more than one module. Returns the
    resolved logs directory (LOG_DIR env var, defaulting to
    <project_root>/logs).
    """
    global _configured

    logs_dir = Path(os.getenv("LOG_DIR", str(project_root / "logs")))
    logs_dir.mkdir(parents=True, exist_ok=True)

    if _configured:
        return logs_dir

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))

    # Rotates at ~5MB, keeps 5 backups, so logs/ never grows unbounded even
    # under long-running "log every action" traffic.
    file_handler = RotatingFileHandler(
        logs_dir / "telegram-worker.log", maxBytes=5_000_000, backupCount=5, encoding="utf-8"
    )
    file_handler.setFormatter(JsonLogFormatter())

    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), handlers=[console_handler, file_handler])
    _configured = True
    return logs_dir


def log_action(logger: logging.Logger, message: str, level: int = logging.INFO, **fields: Any) -> None:
    """Log one structured action. `fields` become extra JSON keys in the log line."""
    logger.log(level, message, extra={"extra_fields": fields})
