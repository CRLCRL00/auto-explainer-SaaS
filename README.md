# auto-explainer-saas

> One-shot AI explainer video generator. LLM writes script → headless browser
> records screen → FFmpeg / **Creatomate SaaS** encodes to mp4 → served as
> auto-explainer short videos.

## v0.0.1 alpha — current state

Stack: Next.js 14 (page router) + BullMQ (Redis) + Drizzle ORM (Postgres) +
Playwright + Puppeteer + FFmpeg / Creatomate + Anthropic SDK + OpenAI SDK
(via miniMax / OpenRouter) + Zod.

See [docs/refactor-plan-v0.1.md](docs/refactor-plan-v0.1.md) for the
in-progress Trigger.dev v4 + Creatomate + OpenRouter migration track.

## Quick start

```bash
npm ci
cp .env.example .env.local       # fill in real keys
docker compose up -d              # postgres + redis
npm run db:migrate
npm run dev                       # http://localhost:3000
npm run worker                    # in another terminal — BullMQ worker (legacy)
```

Authenticated by HTTP basic; see `.env.local` for `BASIC_AUTH_USER` /
`BASIC_AUTH_PASS`.

## Worker / Queue

Trigger.dev v4 is the only enqueue / consumer engine since PR4. BullMQ has
been fully removed (`lib/queue.ts` + `worker/index.ts` deleted, npm deps
uninstalled, dual-run fallback code dropped).

| Engine         | Enqueue path                          | Consumer                                              | Status |
|----------------|---------------------------------------|--------------------------------------------------------|--------|
| **Trigger.dev v4** | `lib/trigger.ts` → `tasks.trigger()` | `trigger/jobs.ts` task handler (in-container `triggerdotdev/trigger.dev` runtime) | **default and only** since PR4 |

### Trigger.dev v4

- Local dev: `npx trigger.dev dev`
- Self-hosted prod: `docker compose up -d trigger-web` (PR1 added the service
  with PostgreSQL + Redis + ClickHouse dependencies).
- Dashboard access: Nginx + basic auth at port 3030. See
  [docs/nginx-auto-explainer.conf](docs/nginx-auto-explainer.conf) for the
  reference config (decision #8 captured in refactor plan).
- Task definitions live in [trigger/jobs.ts](trigger/jobs.ts). Adding a new
  task: add a `task({ id: '...', run: async (payload, ctx) => { ... } })`
  export; the SDK picks it up on next dev restart / redeploy.
- `RUN_TRIGGER_DEV=0` is reserved as an escape hatch — currently a no-op
  stub (route will throw on every enqueue). Don't set it; flip the
  docker-compose stack instead if you really need to take Trigger.dev offline.

## Render pipeline (P0 全量: Creatomate 是默认路径)

[worker/phases/encode-creatomate.ts](worker/phases/encode-creatomate.ts) 是
唯一的 render 实现 — 调用 Creatomate SaaS 组装 (1080×1920 / 30s / mp4). 默认**多
帧 composition** 而非单帧静态图:

- frames 是 Puppeteer record (~30fps/32s ~900 PNG)
- 上传前**抽帧到 30 张**: 头尾帧保留, 中间均匀. 每张 Image 设 `time + duration`
  形成视频感 (每秒一帧)
- 字幕按 beat 时段切 (`time + duration = beatDuration`)
- 中文配音按 `AZURE_SPEECH_KEY` 配齐可选

**P0 全量 hard cut 状态**:

- 不再有 `RUN_CREATOMATE_POC` flag
- 不再有 FFmpeg 依赖 (`ffmpeg-static` / `@ffmpeg-installer/ffmpeg` 已卸)
- [worker/phases/encode.ts](worker/phases/encode.ts) 是 thin wrapper re-export +
  `@deprecated buildEncodeArgs` (1 版本后删)

部署侧: `CREATOMATE_TEMPLATE_ID` 必须在 Creatomate 后台先建好 30s 5-beat 模板 (或
`RUN_CREATOMATE_TEMPLATE_ID` 设成内置默认 `creatomate-builtin-30s-5beats`).

## LLM provider dispatch

[lib/llm.ts](lib/llm.ts) dispatches based on `provider`:

- `anthropic` → `@anthropic-ai/sdk` (Claude)
- `openai-compatible` → `openai` SDK with custom baseURL
- `minimax` (MiniMax-M3) → direct `fetch` to `/v1/text/chatcompletion_v2`
  (path not the OpenAI SDK standard, so the SDK can't be reused here)

P2 fallback (since 342a1b9): when `minimax` returns a non-retryable error,
`callMinimaxWithFallback` automatically retries the same call via OpenRouter
(OpenAI-compatible, configured by `OPENROUTER_API_KEY`). Sliding window
rate-limit (5 fallbacks / 60s) prevents tight loops.

## Tests

| Layer            | Command                  | What it covers                    |
|------------------|--------------------------|-----------------------------------|
| Unit             | `npm test -- tests/unit` | LLM, queue helpers, phases, ops   |
| Integration      | `npm test`               | API routes, settings page         |

Integration tests that require real services (Redis / Postgres / Anthropic)
are gated by env (`RUN_SLOW_TESTS=1` + real keys) and skip otherwise — never
fail the suite.

## Deploy

`scripts/deploy.sh` is the tarball + atomic-symlink deploy used by both
`auto-explainer-web` (Next.js systemd unit) and `auto-explainer-nginx`
(reference config in `docs/`). After PR3 the BullMQ unit is gone; deployment
unit list is **web + nginx**. Trigger.dev worker runtime is part of the
docker-compose stack via the `trigger-web` container — no separate systemd
unit needed.

## Misc

- Refactor plan: [docs/refactor-plan-v0.1.md](docs/refactor-plan-v0.1.md)
- Stack / vendor choices: see plan §1–§3
- Outstanding decisions: see plan §4 (5 decisions captured 2026-07-27)
