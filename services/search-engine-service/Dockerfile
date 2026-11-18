# ============================================================
# search-engine-service: Search Gateway + Registry + Index Projector + Share
# (không dùng Prisma nên không cần @dms/database)
# ============================================================

# ---------------- Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY packages/database/package*.json ./packages/database/
COPY packages/common/package*.json ./packages/common/
COPY services/search-engine-service/package*.json ./services/search-engine-service/
RUN npm ci --no-audit

COPY packages/common ./packages/common
RUN npm run build --workspace=@dms/common

COPY services/search-engine-service ./services/search-engine-service
RUN npm run build --workspace=@dms/search-engine-service

# ---------------- Stage 2: runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3003
RUN apk add --no-cache openssl libc6-compat curl
USER node

COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages/common/package.json ./packages/common/package.json
COPY --chown=node:node --from=builder /app/packages/common/dist ./packages/common/dist
COPY --chown=node:node --from=builder /app/services/search-engine-service/package.json ./services/search-engine-service/package.json
COPY --chown=node:node --from=builder /app/services/search-engine-service/dist ./services/search-engine-service/dist

EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -f http://localhost:3003/health || exit 1

# -r tracing.js: OpenTelemetry phải được nạp TRƯỚC ứng dụng (chỉ hoạt động khi có OTEL_EXPORTER_OTLP_ENDPOINT)
CMD ["node", "-r", "./packages/common/dist/tracing.js", "services/search-engine-service/dist/main.js"]
