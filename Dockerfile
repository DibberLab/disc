# better-sqlite3 is a native module, so it gets compiled in a build stage and
# only the built node_modules is carried into the runtime image.
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_FILE=/data/disc.sqlite

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# The bind mount replaces this at runtime, so the HOST directory also has to be
# owned by uid 1000 — see docs/DEPLOY.md, this is the usual first-boot failure.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
