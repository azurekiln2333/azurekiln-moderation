FROM node:24.15.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/client/package.json ./packages/client/package.json
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 MODERATION_DB_PATH=/app/var/moderation.sqlite
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY migrations ./migrations
COPY data ./data
COPY scripts ./scripts
COPY public ./public
COPY packages/client/package.json packages/client/index.js packages/client/index.cjs ./packages/client/
RUN mkdir -p /app/var && chown node:node /app/var
USER node
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "--input-type=module", "-e", "try { const r = await fetch('http://127.0.0.1:4310/healthz', {signal: AbortSignal.timeout(3000)}); const b = await r.json(); process.exit(r.ok && b.status === 'ok' ? 0 : 1); } catch { process.exit(1); }"]
CMD ["node", "src/server.js"]
