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

## Render pipeline (P0 POC in flight)

[worker/phases/encode-creatomate.ts](worker/phases/encode-creatomate.ts) wraps
the Creatomate SaaS API for short-video assembly (1080×1920 / 30s / mp4 +
zh-CN TTS via Azure Cognitive Services Speech). Enable the POC by setting
`RUN_CREATOMATE_POC=1` — when unset, the legacy FFmpeg path
([worker/phases/encode.ts](worker/phases/encode.ts)) still runs unchanged.

| Toggle                              | Effect                                  |
|-------------------------------------|-----------------------------------------|
| `RUN_CREATOMATE_POC=0` (default)    | FFmpeg render via local `ffmpeg-static` |
| `RUN_CREATOMATE_POC=1`              | Creatomate SaaS render + Azure TTS      |

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
