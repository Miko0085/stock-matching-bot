FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Production JS files only. .env and sessions/ are intentionally not
# copied into the image — secrets come from env_file/environment at
# deploy time, and sessions/ is a mounted volume, not baked-in state.
COPY server.js wa_events.js wa_debounce.js wa_webhook.js wa_outbound_tracking.js wa_pause_registry.js ./

EXPOSE 8092

CMD ["node", "server.js"]
