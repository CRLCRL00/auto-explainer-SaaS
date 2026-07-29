#!/usr/bin/env bash
set -euo pipefail
# 复用你卡通大富翁的 tarball + atomic symlink 模式

VPS="${VPS:-user@vps-host}"
APP_DIR="/srv/auto-explainer"
RELEASE_DIR="$APP_DIR/releases/v$(date +%Y%m%d%H%M%S)"
CURRENT_LINK="$APP_DIR/current"

echo "📦 Building release…"
cd "$(dirname "$0")/.."
npm ci --omit=dev

echo "🗜️  Creating tarball…"
TAR="/tmp/auto-explainer-v$(date +%Y%m%d%H%M%S).tar.gz"
# Explicitly exclude .env* — security. .gitignore 已控 git, 但 deploy.sh 从
# working tree 读 (不含 git 状态), dev 机器 .env.local 含真 key (OPENROUTER_API_KEY
# / HUMAN_IN_LOOP_WEBHOOK_URL 等) 会被打包 scp 给 VPS — 静默 leak.
tar czf "$TAR" \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=storage/jobs/* \
  --exclude=.env \
  --exclude=.env.local \
  --exclude='.env.local.*' \
  --exclude='.env.*.bak' \
  .

echo "🚀 Uploading to VPS…"
ssh "$VPS" "mkdir -p $APP_DIR/releases $APP_DIR/shared"

scp "$TAR" "$VPS:/tmp/"
ssh "$VPS" "mkdir -p $RELEASE_DIR && tar xzf /tmp/$(basename $TAR) -C $RELEASE_DIR"

echo "🔗 Atomic symlink swap…"
ssh "$VPS" "ln -sfn $RELEASE_DIR $APP_DIR/current.new && mv -Tf $APP_DIR/current.new $APP_DIR/current"

echo "🐳 Starting long-running docker services (trigger-web / clickhouse)…"
# P1 audit D3: 之前 deploy.sh 没 pull/up trigger-web container. Trigger.dev worker
# runtime 在 trigger-web 容器内, 这是 v0.5+ pipeline worker 的实际位置. 没起它
# 等于 trigger.dev task queue 永远无人消费.
#
# 阶段:
#   1. docker compose pull (新 image 拉本地; trigger-web + clickhouse 共 ~1.3GB)
#   2. docker compose up -d --no-deps trigger-web clickhouse (only long-running;
#      postgres / redis 由 VPS systemd 单独管, 不引入 docker compose up 全栈风险)
#   3. 等 trigger-web healthcheck ready (3030/api/v1)
#
# .env (transfer to $APP_DIR/shared/.env.local before first run) 需含:
#   TRIGGER_SECRET_KEY — 留空时用 'trigger-dev-secret-change-me' (dev only)
#   TRIGGER_PROJECT_REF — 触发 web dashboard 注册时给的 project ref
ssh "$VPS" "cd $APP_DIR/current && \
  docker compose --env-file $APP_DIR/shared/.env.local \
    pull trigger-web clickhouse"
ssh "$VPS" "cd $APP_DIR/current && \
  docker compose --env-file $APP_DIR/shared/.env.local \
    up -d --no-deps --remove-orphans trigger-web clickhouse"

echo "🐳 Waiting for trigger-web readiness (3030/api/v1)…"
# 简单 retry + sleep 30s max — healthcheck 自己做(alpine image 没 curl)
for i in $(seq 1 30); do
  if ssh "$VPS" "wget -q -O - http://127.0.0.1:3030/api/v1 > /dev/null 2>&1"; then
    echo "  trigger-web ready after ${i}s"
    break
  fi
  sleep 1
done

echo "🔄 Restarting services…"
# P1 PR3: BullMQ worker 进程不再启; Trigger.dev worker runtime 在 docker-compose trigger-web 容器内
# 通过自管调度. 仅保留 web (Next.js) + nginx (basic auth + 反代 dashboard).
ssh "$VPS" "sudo systemctl restart auto-explainer-web auto-explainer-nginx"

echo "✅ Health check (Next.js web)…"
sleep 3
curl -sf http://127.0.0.1:3000/api/health || (echo "❌ health check failed" && exit 1)

# v0.7 B3: Sync nginx vhost conf + reload. Next.js sets X-Frame-Options /
# X-Content-Type-Options / Referrer-Policy in next.config.mjs, but nginx
# strips upstream headers on proxy_pass by default — we need to re-emit them
# at the nginx layer so they reach the client regardless of Next.js runtime.
# This block:
#   1. Copies docs/nginx-auto-explainer.conf → /etc/nginx/sites-enabled/
#   2. Validates with `sudo nginx -t` (abort deploy if invalid)
#   3. `sudo systemctl reload auto-explainer-nginx` (graceful — doesn't drop
#      existing connections, unlike restart)
#
# Skip with NGINX_RELOAD=0 if you've made manual edits to the on-disk conf
# that you don't want overwritten (e.g. custom server_name).
if [ "${NGINX_RELOAD:-1}" = "1" ]; then
  echo "🔒 Syncing nginx vhost conf + reload (B3 security headers)…"
  ssh "$VPS" "sudo cp /srv/auto-explainer/current/docs/nginx-auto-explainer.conf \
                  /etc/nginx/sites-enabled/auto-explainer.conf && \
              sudo nginx -t && \
              sudo systemctl reload auto-explainer-nginx" || \
    { echo "❌ nginx sync/reload failed — abort deploy"; exit 1; }
fi

# P1 PR3: 二次 health check trigger.dev dashboard (basic auth gated).
# 需要在 deploy host 配 TRIGGER_BASIC_AUTH_USER/PASS env (与 docs/nginx-auto-explainer.conf htpasswd 一致).
if [ -n "${TRIGGER_BASIC_AUTH_USER:-}" ] && [ -n "${TRIGGER_BASIC_AUTH_PASS:-}" ]; then
  echo "✅ Health check (Trigger.dev dashboard)…"
  curl -sf -u "$TRIGGER_BASIC_AUTH_USER:$TRIGGER_BASIC_AUTH_PASS" \
    http://127.0.0.1:3030/api/v1 || (echo "❌ trigger.dev dashboard health check failed" && exit 1)
fi

echo "🧹 Cleanup old releases (keep 3)…"
ssh "$VPS" "cd $APP_DIR/releases && ls -t | tail -n +4 | xargs -r rm -rf"

echo "✅ Done."
