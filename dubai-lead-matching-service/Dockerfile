# Lead Matching Service — standalone, no n8n runtime dependency (TZ 119-120).
# Does not bundle or start a PostgreSQL server -- DATABASE_URL always points
# at the existing shared `matching` schema (TZ 64), never a container-local DB.
#
# IMPORTANT: this service reuses src/core, src/db, and scripts/lib directly
# from the parent nika-matching-pilot-starter project (TZ 33/66), via plain
# relative `require('../../src/core/...')` calls -- so the Docker BUILD
# CONTEXT must be the PARENT directory, not this one, and the image
# preserves the exact same relative nesting the real repo has. Build from
# the nika-matching-pilot-starter/ directory:
#
#   docker build -f lead-matching-service/Dockerfile -t nika-lead-matching-service .
#   docker run --rm -p 8095:8095 --env-file lead-matching-service/.env nika-lead-matching-service

FROM node:20-alpine
WORKDIR /app

# The reused src/db/*.js and src/core/*.js files `require('pg')`/
# `require('dotenv')` relative to THEIR OWN location (/app/src/db/...),
# which Node resolves by walking up from there -- so those two deps must
# also be installed at /app/node_modules, not only inside
# lead-matching-service/node_modules, or the reused modules fail to
# resolve them at runtime (found the hard way: a container that built
# clean but crashed on boot with MODULE_NOT_FOUND for 'pg').
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY lead-matching-service/package.json lead-matching-service/package-lock.json* ./lead-matching-service/
RUN cd lead-matching-service && npm install --omit=dev

# Only the pieces this service actually reuses -- not the whole
# nika-matching-pilot-starter tree (no n8n workflow templates, no
# dashboard, no scripts unrelated to this service).
COPY src ./src
COPY scripts/lib ./scripts/lib
COPY sql ./sql
COPY lead-matching-service ./lead-matching-service

WORKDIR /app/lead-matching-service

ENV NODE_ENV=production
ENV MATCHER_HOST=0.0.0.0
ENV MATCHER_PORT=8095

EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MATCHER_PORT||8095)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
