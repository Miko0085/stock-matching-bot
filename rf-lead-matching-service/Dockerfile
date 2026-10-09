# RF Lead Matching Service — independent contour skeleton, no n8n runtime
# dependency, no UAE (lead-matching-service) code reused. Domain matching
# is NOT_IMPLEMENTED until an RF stock contract is approved (see README.md).
#
# Reuses only parent infra (src/db/pool.js, src/db/migrate.js) via plain
# relative require() calls, same pattern as lead-matching-service -- so the
# Docker BUILD CONTEXT must be the PARENT directory:
#
#   docker build -f rf-lead-matching-service/Dockerfile -t nika-rf-lead-matching-service .
#   docker run --rm -p 8096:8096 --env-file rf-lead-matching-service/.env nika-rf-lead-matching-service

FROM node:20-alpine
WORKDIR /app

# Same reasoning as lead-matching-service/Dockerfile: src/db/pool.js
# require()s 'pg' relative to its OWN location, resolved by walking up
# from /app/src/db/ -- so 'pg'/'dotenv' must also be installed at
# /app/node_modules, not only inside rf-lead-matching-service/node_modules.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY rf-lead-matching-service/package.json rf-lead-matching-service/package-lock.json* ./rf-lead-matching-service/
RUN cd rf-lead-matching-service && npm install --omit=dev

COPY src/db ./src/db
COPY rf-lead-matching-service ./rf-lead-matching-service

WORKDIR /app/rf-lead-matching-service

ENV NODE_ENV=production
ENV RF_MATCHER_HOST=0.0.0.0
ENV RF_MATCHER_PORT=8096

EXPOSE 8096

# Build-time import smoke test (same discipline as telegram-worker's P0.4
# fix): fails the image build itself if a required file/module is missing,
# instead of failing silently at container start.
RUN node -e "require('./src/api/server.js')"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RF_MATCHER_PORT||8096)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
