# content-worker: tiến trình Node thuần (không cần @dms/common, không cần Prisma)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY packages/database/package*.json ./packages/database/
COPY packages/common/package*.json ./packages/common/
COPY services/content-worker/package*.json ./services/content-worker/
RUN npm ci --no-audit --workspace=@dms/content-worker --include-workspace-root=false
COPY services/content-worker ./services/content-worker
RUN npm run build --workspace=@dms/content-worker

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3010
RUN apk add --no-cache curl
USER node
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/services/content-worker/package.json ./services/content-worker/package.json
COPY --chown=node:node --from=builder /app/services/content-worker/dist ./services/content-worker/dist
EXPOSE 3010
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD curl -f http://localhost:3010/health || exit 1
CMD ["node", "services/content-worker/dist/main.js"]
