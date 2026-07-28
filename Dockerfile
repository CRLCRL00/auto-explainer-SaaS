# auto-explainer-saas Dockerfile (v0.6.1 long-term)
#
# Multi-stage build leveraging Next.js `output: 'standalone'` (PR3 commit cd19577):
#   - Stage deps     : install full deps (含 dev, 供 build 阶段)
#   - Stage builder  : `npm run build` 产 .next/standalone (server + 必要 deps) + .next/static
#   - Stage runner   : alpine + 上面产物 + non-root user, 最瘦镜像 (≈ 150MB vs full image 1GB+)
#
# Build:    docker build -t aesaas:0.6.0 .
# Run:      docker run --rm -p 3000:3000 \
#             -e DATABASE_URL=postgres://... \
#             -e ANTHROPIC_API_KEY=... \
#             -e CREATOMATE_API_KEY=... \
#             -e BASIC_AUTH_USER=admin \
#             -e BASIC_AUTH_PASS=changeme \
#             aesaas:0.6.0
#
# 重要: trigger-web / clickhouse / postgres / redis 仍走 docker-compose.yml
# (These are long-running services, not 'deployable app'). Docker here 只 cover
# Next.js 部分 (port 3000). docker-compose up + docker run aesaas 并存.

# ─────────────────────────────────────────────────────────────────
# Stage 1 — deps
# 安装全部 deps (dev + prod). 这一层只 cache npm install, 不重复 build.
# ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# alpine 缺 python3 / make / g++ — pg native 需要. Build tools 后清理.
#   - libpq-dev: pg 客户端 native 依赖 (虽不强制, 某些 path 用)
#   - linux-headers: native module 头文件
RUN apk add --no-cache libc6-compat python3 make g++ linux-headers

COPY package.json package-lock.json* ./
RUN npm ci --include=dev


# ─────────────────────────────────────────────────────────────────
# Stage 2 — builder
# 跑 `next build` (含 standalone output). 留在这一层, 不进 runtime image.
# ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 在 build 前必要的 env keys — 让 schema validation (lib/env.ts) 不抛错.
# 真实值在 runtime 通过 docker run -e 覆盖. 这里只为 build-time stub.
ARG NEXT_PUBLIC_BASIC_AUTH_USER=admin
ARG NEXT_PUBLIC_BASIC_AUTH_PASS=changeme
ENV NEXT_PUBLIC_BASIC_AUTH_USER=$NEXT_PUBLIC_BASIC_AUTH_USER
ENV NEXT_PUBLIC_BASIC_AUTH_PASS=$NEXT_PUBLIC_BASIC_AUTH_PASS
ENV DATABASE_URL=postgres://postgres:postgres@localhost:5432/aesaas
ENV REDIS_URL=redis://localhost:6379
ENV ANTHROPIC_API_KEY=sk-ant-build-placeholder
ENV CREATOMATE_API_KEY=creato-build-placeholder
ENV BASIC_AUTH_USER=admin
ENV BASIC_AUTH_PASS=changeme
ENV TRIGGER_PROJECT_REF=proj_build
ENV TRIGGER_SECRET_KEY=trigger-build-placeholder-key-1
ENV TRIGGER_API_URL=http://localhost:3030

RUN npm run build


# ─────────────────────────────────────────────────────────────────
# Stage 3 — runner
# 最小 image: alpine + 仅 standalone 输出 + static assets.
# ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# non-root user (nextjs UID 1001)
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# 复制 standalone bundle (含 server.js + minimal node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# 复制静态资源 (.next/static)
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# public 目录 (用户头像, favicon 等 — 当前项目暂空, 未来扩展)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# health check — 配合 docker compose / k8s liveness probe.
# deploy.sh:65 之前 fail 是 /api/health 不存在 (audit B1 fixed). 现在 route 存在,
# health check 返 200.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/api/health > /dev/null || exit 1

CMD ["node", "server.js"]
