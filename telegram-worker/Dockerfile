FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Only the production Telegram files. .env is intentionally not copied
# into the image — secrets come from env_file/environment at deploy
# time, and sessions/ and logs/ are mounted volumes, not baked-in state.
COPY worker_api.py telegram_adapter.py telegram_events.py telegram_debounce.py telegram_outbound.py telegram_joiner.py telegram_login.py telegram_monitor_registry.py telegram_pause_registry.py worker_logging.py telegram_qr_login_account.py telegram_botfather.py ./

EXPOSE 8091

# Build/start smoke test (P0.4 release blocker): worker_api.py imports
# telegram_joiner, telegram_login, telegram_monitor_registry, and
# telegram_pause_registry -- if any is missing from the COPY line above,
# the process fails on import before it ever binds the port. Importing
# here (module load only, no event loop, no network) fails the image
# BUILD itself instead of failing silently at container start time.
RUN python -c "import worker_api"

CMD ["python", "worker_api.py"]
