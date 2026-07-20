# Atrium — all-in-one image: app server, SPA, SQLite, uploads.
# Requires Docker BuildKit; no build args needed.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Application code (no build step).
COPY server/ server/
COPY public/ public/

# Data directory: SQLite database + uploaded files. Mount a volume here.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 \
    ATRIUM_DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health > /dev/null || exit 1

CMD ["node", "server/index.js"]
