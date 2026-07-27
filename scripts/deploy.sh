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
tar czf "$TAR" --exclude=node_modules --exclude=.next --exclude=storage/jobs/* .

echo "🚀 Uploading to VPS…"
ssh "$VPS" "mkdir -p $APP_DIR/releases $APP_DIR/shared"

scp "$TAR" "$VPS:/tmp/"
ssh "$VPS" "mkdir -p $RELEASE_DIR && tar xzf /tmp/$(basename $TAR) -C $RELEASE_DIR"

echo "🔗 Atomic symlink swap…"
ssh "$VPS" "ln -sfn $RELEASE_DIR $APP_DIR/current.new && mv -Tf $APP_DIR/current.new $APP_DIR/current"

echo "🔄 Restarting services…"
# P1 PR3: BullMQ worker 进程不再启; Trigger.dev worker runtime 在 docker-compose trigger-web 容器内
# 通过自管调度. 仅保留 web (Next.js) + nginx (basic auth + 反代 dashboard).
ssh "$VPS" "sudo systemctl restart auto-explainer-web auto-explainer-nginx"

echo "✅ Health check (Next.js web)…"
sleep 3
curl -sf http://127.0.0.1:3000/api/health || (echo "❌ health check failed" && exit 1)

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
