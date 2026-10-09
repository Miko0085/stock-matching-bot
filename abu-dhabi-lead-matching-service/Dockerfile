# Abu Dhabi Lead Matching Service — independent contour, built BY ANALOGY
# with dubai-lead-matching-service (same AED/field-model semantics), no
# code shared at runtime with Dubai or RF beyond thin schema-parameterized
# wrappers and genuinely market-agnostic shared root infra.
#
# Reuses parent infra (src/db/*, src/core/*) via plain relative require()
# calls, same pattern as dubai-lead-matching-service/rf-lead-matching-
# service -- so the Docker BUILD CONTEXT must be the PARENT directory:
#
#   docker build -f abu-dhabi-lead-matching-service/Dockerfile -t nika-abu-dhabi-lead-matching-service .
#   docker run --rm -p 8097:8097 --env-file abu-dhabi-lead-matching-service/.env nika-abu-dhabi-lead-matching-service

FROM node:20-alpine
WORKDIR /app

# src/db/pool.js require()s 'pg' relative to its OWN location, resolved by
# walking up from /app/src/db/ -- so 'pg'/'dotenv' must also be installed
# at /app/node_modules, not only inside abu-dhabi-lead-matching-service/
# node_modules.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY abu-dhabi-lead-matching-service/package.json abu-dhabi-lead-matching-service/package-lock.json* ./abu-dhabi-lead-matching-service/
RUN cd abu-dhabi-lead-matching-service && npm install --omit=dev

COPY src/db ./src/db
COPY src/core ./src/core
COPY abu-dhabi-lead-matching-service ./abu-dhabi-lead-matching-service

WORKDIR /app/abu-dhabi-lead-matching-service

ENV NODE_ENV=production
ENV ABU_DHABI_MATCHER_HOST=0.0.0.0
ENV ABU_DHABI_MATCHER_PORT=8097

EXPOSE 8097

# Build-time import smoke test (same discipline as telegram-worker's P0.4
# fix): fails the image build itself if a required file/module is missing,
# instead of failing silently at container start.
RUN node -e "require('./src/api/server.js')"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ABU_DHABI_MATCHER_PORT||8097)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
