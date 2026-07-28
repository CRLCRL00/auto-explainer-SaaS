# auto-explainer-saas — 使用指南

> 配套文档:
> - [README.md](../README.md) — Quick start + 系统架构概述
> - [docs/refactor-plan-v0.1.md](./refactor-plan-v0.1.md) — 实施计划与决策
> - [docs/nginx-auto-explainer.conf](./nginx-auto-explainer.conf) — Nginx 反代 + basic auth 配置模板

本文档覆盖 README 未详细写的部分: API 调用 / 完整部署顺序 / ops 任务 / env vars 对照。

---

## 1. 本地开发 (5 分钟启动)

按顺序执行 — dev 模式会自动加载 `.env.local`。

```bash
# 1. 装依赖
npm ci

# 2. 拷贝 + 填 .env.local (REQUIRED fields: 见 §8)
cp .env.example .env.local
$EDITOR .env.local

# 3. 起 PostgreSQL + Redis + ClickHouse + Trigger.dev web (5 services)
docker compose up -d

# 4. apply 数据库 migration
npm run db:migrate

# 5. 起 Next.js (page router, port 3000)
npm run dev
```

可选: 在另一终端起 Trigger.dev worker 本地 runtime (`npx trigger.dev dev`) — 真实消费任务。

Open `http://localhost:3000` 用 `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` (`.env.local` 里) HTTP basic 登入。

> **确认**: 5 services 全 healthy 后, `docker compose ps` 应该显示 0/5 unhealthy。

---

## 2. 提交一个 explainer job (POST `/api/jobs`)

```bash
# 准备好 BASIC_AUTH_USER/PASS + topic
TOPIC="RAG 检索增强生成的技术原理"
USER=$(grep ^BASIC_AUTH_USER .env.local | cut -d= -f2)
PASS=$(grep ^BASIC_AUTH_PASS .env.local | cut -d= -f2)

curl -u "$USER:$PASS" \
  -H 'Content-Type: application/json' \
  -d "{\"inputType\": \"text\", \"topic\": \"$TOPIC\"}" \
  http://localhost:3000/api/jobs
# → 201 { "jobId": "<uuid>" }
```

`inputType` 当前仅支持 `"text"`；topic 限 1~500 字符；JSON body ≤ 10KB（防 OOM）。

后台工作流（自动化，无需人工）：
1. POST 返回后立即 enqueue 到 Trigger.dev（lib/trigger.ts + lib/llm.ts）
2. Trigger.dev worker runtime 拉 task → 调 `runPipeline(jobId)` ([worker/pipeline.ts](../worker/pipeline.ts))
3. 7 个 phase 顺序跑 + retry + QG 检查 (见 §5)

---

## 3. 下载完成的视频 (GET `/api/jobs/[id]/download/[kind]`)

```bash
curl -u "$USER:$PASS" -o video.mp4 \
  http://localhost:3000/api/jobs/<jobId>/download/mp4
```

输出:
- `200` + mp4 bytes (若 `jobs.status='done'`)
- `400` 不支持的 `kind` (v0.0.1 仅 `mp4`)
- `404` job 不存在 or 还没渲染好

文件名: `video-<jobId 前 8 字符>.mp4`。

---

## 4. 生产部署完整顺序

按 commit `3bd5171` audit + deploy.sh 编排:

```bash
# === A. 在 VPS 上一次性的安装 (非 deploy 脚本内, 手工跑一次) ===

# A1. Clone
sudo mkdir -p /srv/auto-explainer/{releases,shared}
sudo chown $USER:$USER /srv/auto-explainer
git clone https://github.com/your-org/auto-explainer-saas.git /srv/auto-explainer

# A2. systemd unit (Next.js)
sudo tee /etc/systemd/system/auto-explainer-web.service <<EOF
[Unit]
Description=auto-explainer-saas web
After=network.target
[Service]
Type=simple
WorkingDirectory=/srv/auto-explainer/current
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
Restart=on-failure
EnvironmentFile=/srv/auto-explainer/shared/.env.local
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now auto-explainer-web

# A3. systemd unit (Nginx — 推荐单独 systemd 不放 Docker)
sudo tee /etc/systemd/system/auto-explainer-nginx.service <<EOF
[Unit]
Description=auto-explainer-saas nginx
After=network.target
[Service]
# P1 audit W6: Type=notify 现代 systemd 模式 (vs 之前 Type=forking + 'daemon on;'
# — forking 模式在某些 systemd 版本下 systemctl status 报 'deactivating' 状态).
# 要求 nginx 编译时带 --with-notify (Debian/Ubuntu 默认 ✓) + /etc/nginx/nginx.conf
# 里有 'daemon off;' 让 master 留前台, sd_notify 通知 systemd 已 ready.
Type=notify
ExecStart=/usr/sbin/nginx -g 'daemon off;'
ExecReload=/usr/sbin/nginx -s reload
ExecStop=/usr/sbin/nginx -s quit
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now auto-explainer-nginx

# A4. Nginx 配置 (basic auth + 反代 trigger-web dashboard)
sudo cp /srv/auto-explainer/current/docs/nginx-auto-explainer.conf /etc/nginx/sites-available/auto-explainer.conf
# 编辑本机 htpasswd path 后:
sudo htpasswd -c /etc/nginx/.htpasswd your-admin
sudo ln -sf /etc/nginx/sites-available/auto-explainer.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload auto-explainer-nginx

# A5. /srv/auto-explainer/shared/.env.local (production secrets):
sudo tee /srv/auto-explainer/shared/.env.local <<EOF
DATABASE_URL=postgres://postgres:PASSWORD@postgres:5432/aesaas
REDIS_URL=redis://redis:6379
ANTHROPIC_API_KEY=sk-ant-prod-...
CREATOMATE_API_KEY=ckey_prod_...
AZURE_SPEECH_KEY=  # 可选, 留空无 TTS
AZURE_SPEECH_REGION=eastasia
BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=<生成强密码, 放 secret store>
HUMAN_IN_LOOP_WEBHOOK_URL=  # 可选; 配了撞墙时 POST owner
TRIGGER_SECRET_KEY=<32+ char random>
TRIGGER_PROJECT_REF=<从 trigger.dev 后台拿>
NODE_ENV=production
LOG_LEVEL=info
EOF
sudo chmod 600 /srv/auto-explainer/shared/.env.local

# === B. 每次 deploy 跑 (Bash from dev machine) ===

VPS="user@vps-host" bash scripts/deploy.sh
```

`deploy.sh` 顺序:
1. `npm ci --omit=dev` (本地 build)
2. 打包 tarball (排除 node_modules + .next + storage/jobs/*)
3. scp 到 VPS
4. 原子 symlink swap
5. **`docker compose pull trigger-web clickhouse`** + `up -d --no-deps`  ← audit D3 加
6. 等 trigger-web 3030 ready (30s 超时)
7. `systemctl restart auto-explainer-web auto-explainer-nginx`
8. 健康检查: `curl http://127.0.0.1:3000/api/health` + (若配 webhook) trigger-web 3030

---

## 5. Database Ops

```bash
# apply migrations 到 prod DB
DATABASE_URL=postgres://... npm run db:migrate

# 查最近 10 个 jobs 状态
psql $DATABASE_URL -c "SELECT id, status, phase, human_in_loop_reason, last_error, created_at FROM jobs ORDER BY created_at DESC LIMIT 10;"

# 查撞墙的 jobs (需要人介入)
psql $DATABASE_URL -c "SELECT id, phase, human_in_loop_reason, attempts, last_error FROM jobs WHERE human_in_loop_reason IS NOT NULL ORDER BY updated_at DESC LIMIT 20;"

# 查 Trigger.dev runs 状态
psql $DATABASE_URL -c "SELECT job_id, run_id, status, started_at, finished_at FROM trigger_runs ORDER BY created_at DESC LIMIT 20;"

# 清 stale failed jobs (>30d 前 + status=failed)
psql $DATABASE_URL -c "DELETE FROM jobs WHERE status='failed' AND updated_at < NOW() - INTERVAL '30 days';"

# 注: human_in_loop_reason 列自动由 drizzle/0006_human_in_loop_reason.sql
# 应用 (现 IF NOT EXISTS 守卫, 重跑 no-op). 不需手动 ALTER; 跑 `npm run db:migrate`
# 即可.
```

---

## 6. Trigger.dev Dashboard 操作

Dashboard: `http://<your-host>:3030/api/v1`（Nginx basic auth 保护，参考 [docs/nginx-auto-explainer.conf](./nginx-auto-explainer.conf) 配置）。

- **查看 runs**: 主面板会列出最近触发；点击 run ID 看 task payload / logs / 状态
- **Replay 撞墙的 run**: 选 `failed` run → "Replay" 按钮 (deploy 新 code 后常用)
- **Re-trigger**: `Replay` 重跑同一 payload；想换 topic 需新 POST `/api/jobs`

---

## 7. Human-in-Loop 通知 (撞墙时)

`lib/notify.ts` 在 `RetryWallHitError` (撞墙) 时调 webhook，让 owner 端 (Slack/Discord/dispatch) 接收。

Payload shape (POST 到 `HUMAN_IN_LOOP_WEBHOOK_URL`):
```json
{
  "jobId": "<uuid>",
  "phaseName": "creatomate_rendering",
  "attempts": 2,
  "reason": "qg-final",
  "suggestedActions": ["retry", "reverse-or-replace"],
  "lastError": { "message": "ffprobe low fps", "stack": "..." },
  "timestamp": "2026-07-27T12:34:56.000Z"
}
```

Slack 简易 Hook 配置: 在 Slack incoming webhook URL 配置前, 跑个 Node 中转把 JSON 翻译成 Slack Block Kit。reference:
```js
// server/dispatch.js
export default async (req, res) => {
  const p = req.body;
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: `🚧 Job ${p.jobId} 撞墙 — ${p.phaseName}` }},
                 { type: 'section', text: { type: 'mrkdwn', text: `phase: ${p.phaseName}\nattempts: ${p.attempts}\nreason: ${p.reason}\nerror: ${p.lastError.message}` } }];
  await fetch(process.env.SLACK_WEBHOOK_URL, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ blocks }) });
  res.status(204).end();
};
```
部署到 Vercel/Cloudflare worker, URL 填入 `HUMAN_IN_LOOP_WEBHOOK_URL`。

未配 webhook 时: `human_in_loop_reason` 列仍写到 jobs 表 (`column: human_in_loop_reason varchar(64)`); 查表见 §5。

---

## 8. Env vars 完整对照

### Required (lib/env.ts schema validation 必填)
| Key | 说明 |
|---|---|
| `DATABASE_URL` | postgres://postgres:PASS@HOST:5432/aesaas |
| `REDIS_URL` | redis://HOST:6379 |
| `ANTHROPIC_API_KEY` | Claude API key (sk-ant-...) |
| `CREATOMATE_API_KEY` | Creatomate SaaS API key |
| `BASIC_AUTH_USER` | `/api/jobs` HTTP basic 用户 |
| `BASIC_AUTH_PASS` | `/api/jobs` HTTP basic 密码 |

### Optional (有 default 或完全可选)
| Key | Default | 说明 |
|---|---|---|
| `CREATOMATE_BASE_URL` | (default `https://api.creatomate.com/v2` 测试用) | override only |
| `CREATOMATE_TEMPLATE_ID` | `creatomate-builtin-30s-5beats` | 自定义模板 ID (P0 全量前在 Creatomate 后台建) |
| `CREATOMATE_POLL_MS` | `3000` | SDK polling 间隔 |
| `CREATOMATE_POLL_TIMEOUT_MS` | `600000` | SDK polling 超时 (10 min) |
| `AZURE_SPEECH_KEY` | — | 配齐即合成中文 TTS audio track |
| `AZURE_SPEECH_REGION` | — | `eastasia` / `westus3` etc |
| `TRIGGER_PROJECT_REF` | — | 从 trigger.dev 后台拿 |
| `TRIGGER_SECRET_KEY` | — | ≥ 10 char (auto-generate: `openssl rand -hex 16`) |
| `TRIGGER_API_URL` | — | `http://trigger-web:3030` |
| `TRIGGER_DEPLOYMENT` | `self-hosted` | |
| `RUN_TRIGGER_DEV` | `1` | `0` 是 no-op stub (现 wall hit) |
| `OPENROUTER_API_KEY` | — | P2 fallback: minimax 4xx 业务码 → OpenRouter |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | |
| `OPENROUTER_FALLBACK_MODEL` | `minimax/MiniMax-M3` | |
| `HUMAN_IN_LOOP_WEBHOOK_URL` | — | 撞墙时 POST owner (Slack/Discord) |
| `NODE_ENV` | `development` | 生产置 `production` |
| `LOG_LEVEL` | `info` | pino log level |

---

## 9. 常见故障排查

### 9.1 POST `/api/jobs` 返 500

| 可能原因 | 检查 |
|---|---|
| Trigger.dev env 未齐 | `grep -E '^(TRIGGER_|RUN_TRIGGER_DEV)' .env.local` 4 个字段都在 |
| Trigger-web container 还没起 | `docker compose ps trigger-web` → 看是否 healthy |
| `trigger_runs` 表未 migrate | `psql $DATABASE_URL -c "\d trigger_runs"` 应存在; 否则 `npm run db:migrate` |
| `triggerdev` 数据库未创 | `psql $DATABASE_URL -c "\l"` 应包含 triggerdev; 否则跑 `scripts/init-trigger-db.sql` (D1 commit) |

### 9.2 撞墙 (phase retry 2 次后 retry helper 抛 RetryWallHitError)

1. 查 `jobs.human_in_loop_reason` 看 phase + attempts
2. 检查 `jobs.lastError` JSON 拿完整 message+stack
3. 查 `lib/notify.ts` 是否配了 webhook (无配置则只入库不发送)
4. 修代码后 Replay run in Trigger.dev dashboard

### 9.3 Render 视频 size 太小 (< 10KB)

QG-final (lib/pipeline/qg-checks.ts) 抛 `[non-retryable] qg-final: mp4 size=X < 10000`.
查 trigger-web logs / Creatomate dashboard → render 通常 5-50 MB. 若是 → 检查 `CREATOMATE_API_KEY` 是否过期。

### 9.4 ffmpeg / ffprobe 缺失警告

`fgprobe-static` 在 npm install 时已 bundled `bin/<platform>/<arch>/ffprobe`. prod Linux 容器路径:
`node_modules/ffprobe-static/bin/linux/x64/ffprobe`. 若路径不对, QG-final 会 graceful skip 仅打 warn log (duration 检查不跑) — 不阻断流程。

### 9.5 CI Test 失败

`.github/workflows/ci.yml` 跑 `npm test -- --reporter=verbose` (注意 `--` 分隔传 vitest CLI flag). 查 GitHub Actions log 找具体失败 phase。修代码后 push, 自动 rerun。

---

## 10. 多本地开发 + Simulator

如果想在不动 VPS 的情况下模拟完整流程, 用本地 Trigger.dev CLI:
```bash
# 另一终端 — Trigger.dev worker runtime
npx trigger.dev dev

# 它会监 task trigger, 拉本仓库 processVideoJob 定义
# POST 一个 job, 看 local task panel (http://localhost:3030/api/v1, Basic auth)
```
注意: `npx trigger.dev dev` 只在本地启 SDK runtime, 调 trigger.dev cloud (cloud mode)。Self-hosted prod 仍跑 docker compose `trigger-web`.

---

## 11. 升级路径

`package.json` 当前 version `0.5.5`. 升级时:
1. pull 仓库
2. `npm ci` (lockfile 同步)
3. `npm run db:migrate` (apply 新 migration)
4. `bash scripts/deploy.sh` 走 VPS
5. audit report 中 `docs/superpowers/plans/v0_0_1_implementation-status.md` 看是否被 commit message 标 stale section。

---

## 12. References

- 决策 (5 决策: P0 hard cut / Nginx basic auth / Azure TTS / Sliding window / dual-run): [docs/refactor-plan-v0.1.md §4](./refactor-plan-v0.1.md)
- spec §4 蓝图 + retry/QG/auto-downgrade/HIL 决策上下文: [docs/superpowers/specs/2026-07-25-auto-explainer-saas-design.md](./superpowers/specs/2026-07-25-auto-explainer-saas-design.md)
- 仓库 commit history: `git log --oneline -20`
