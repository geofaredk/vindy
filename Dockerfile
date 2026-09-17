# Vindy — weather map for Denmark (DMI, EUMETNET OPERA, EUMETSAT)
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=5173 \
    CACHE_DIR=/data/cache \
    TZ=Europe/Copenhagen

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Model indexes, decoded fields, isobars, fronts and radar images are cached here.
RUN mkdir -p /data/cache && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 5173

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/meta" > /dev/null || exit 1

CMD ["node", "server/index.js"]
