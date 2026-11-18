# ============================================================
# department-service: MỘT image dùng chung cho mọi phòng ban.
# Phòng ban nào do biến môi trường DEPT_CODE (+ DATABASE_URL, MINIO_*) quyết định.
# ============================================================

# ---------------- Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY packages/database/package*.json ./packages/database/
COPY packages/common/package*.json ./packages/common/
COPY services/department-service/package*.json ./services/department-service/
RUN npm ci --no-audit

# Prisma client + biên dịch @dms/database (không dựa vào dist có sẵn trên máy dev)
COPY packages/database ./packages/database
RUN npm run prisma:generate
RUN npm run build --workspace=@dms/database

COPY packages/common ./packages/common
RUN npm run build --workspace=@dms/common

COPY services/department-service ./services/department-service
RUN npm run build --workspace=@dms/department-service

# ---------------- Stage 2: runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN apk add --no-cache openssl libc6-compat curl
USER node

COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
# package.json của workspace cần có để require('@dms/...') tìm đúng "main"
COPY --chown=node:node --from=builder /app/packages/database/package.json ./packages/database/package.json
COPY --chown=node:node --from=builder /app/packages/database/dist ./packages/database/dist
COPY --chown=node:node --from=builder /app/packages/database/prisma ./packages/database/prisma
COPY --chown=node:node --from=builder /app/packages/common/package.json ./packages/common/package.json
COPY --chown=node:node --from=builder /app/packages/common/dist ./packages/common/dist
COPY --chown=node:node --from=builder /app/services/department-service/package.json ./services/department-service/package.json
COPY --chown=node:node --from=builder /app/services/department-service/dist ./services/department-service/dist

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -f http://localhost:3000/health || exit 1

# -r tracing.js: OpenTelemetry phải được nạp TRƯỚC ứng dụng (chỉ hoạt động khi có OTEL_EXPORTER_OTLP_ENDPOINT)
CMD ["node", "-r", "./packages/common/dist/tracing.js", "services/department-service/dist/main.js"]
