# PR Description — copy-paste into GitHub/GitLab PR form

## v0.6.1 deployment-ready (126 commits)

This PR bundles ~a week of work across 4 audit rounds + v0.6.1 spec §4 integration. Self-host + Cloud SaaS ready.

---

## What's in

### v0.6.0 audit round (gap discovery)
- **4 🔴 blockers closed**:
  - Dead `curl /api/health` in `scripts/deploy.sh:65` (route 404)
  - Tarball `secret leak` — `.env.local` being packed & scp'd to VPS
  - `trigger-web` port drift (`0.0.0.0:3030` vs nginx comment says loopback)
  - Next.js directly internet-exposed (no nginx vhost for app port 3000)
- **8 🟡 warnings closed**:
  - CI build step (was missing — broken `next build` only validated in prod)
  - `.env.example` completeness (9 keys missing)
  - drizzle migration idempotency (0005/0006 lacked `IF NOT EXISTS`)
  - Stale `Task 15` TODO + broken inline predicate (tests/integration/pipeline-smoke.test.ts:66)
  - USAGE.md stale references (§11 version, §5 manual ALTER)
  - `.tsbuildinfo` gitignored (incremental build cache leak)
- **1 🔴 + 5 🟡 preventive (ESLint + next.config + db pool + logger redact)**:
  - ESLint `@typescript-eslint/no-explicit-any` rule enabled (was broken `// disable` comments)
  - `next.config.mjs`: `reactStrictMode`, `poweredByHeader: false`, X-Frame-Options + X-Content-Type-Options + Referrer-Policy headers, `output: 'standalone'`
  - PG pool: connection 5s / idle 30s / statement 30s / query 30s timeouts
  - Pino `redact` config for `apiKey` / `authorization` / `HUMAN_IN_LOOP_WEBHOOK_URL`

### v0.6.1 spec §4 implementation
- **§4.2** QG-plan / QG-script / QG-html helpers integrated into pipeline phases
  - `phaseQgPlan` calls `checkPlan` (defense-in-depth with local structural check)
  - `phaseScript` calls `checkScript` (字符数 / TTS 字速校验)
  - `phaseHtml` calls `checkHtml` (schema-level trigger)
- **§4.3** LLM fallback (`withAnthropicFallback`): anthropic 5xx/timeout → OpenAI (GPT-4o)
- **§4.3** TTS fallback (`withTtsFallback`): Azure → Edge TTS (node-edge-tts@1.2.10)
  - `phaseTts` integrated into `PHASE_ORDER` between `html_ready` and `probing`
  - `worker/phases/tts-azure.ts` → `worker/phases/tts.ts` rename (no longer azure-only)
  - `encode-creatomate.ts` reads `tts.mp3` instead of inline Azure synthesis
- **§4.3** Chrome auto-downgrade: system Chrome → bundled chromium → skip (probe is best-effort)
- **§4.3** LLM offline mode (opt-in via `LLM_OFFLINE_FALLBACK=1`): cached 5-beat template when all providers fail
- **§4.4** Admin dashboard at `/admin` (jobs list + status filter + 3s polling)

### Deployment scaffolding
- `Dockerfile` multi-stage build (uses `output: 'standalone'`, runs as non-root)
- `.dockerignore`
- Production Nginx config: single vhost with upstream blocks (was illustrative before)
- `/api/health` route (was missing; now 200 OK)
- `tsconfig.tsbuildinfo` gitignored

### Code consolidation
- 17 pre-existing TypeScript errors fixed (zero `tsc --noEmit` errors now)
- ESLint clean (no warnings)
- 221/221 unit + integration tests pass
- All migrations idempotent (setup-dev-env.sh auto-applies 0005→0007)
- Audit gap discovered: phase enum was missing `planning_qg` + `script_ready` — fixed via 0007 migration (would have crashed pipeline when QG-plan helper integration ran)

---

## Defer (留 v0.7+)

- Web UI `retry` / `reverse-or-replace` buttons (auth + state design 谨慎; current minimum slice 仅 list + filter)
- Server-Sent Events (current 3s polling; SSE is improvement, not requirement)
- LLM prompt cache (offline 现靠 cached template; prompt-cache 需更深的 infra 改)
- Chrome auto-downgrade P2 (e.g., fallback to puppeteer-bundled chromium in `phaseRecord` too — currently only `phaseProbe` has fallback)
- 真 VPS 端到端 smoke

---

## Migration guide for reviewers

### Env vars added / changed
- `OPENAI_API_KEY` — **NEW** (added to schema). needed for LLM fallback target (GPT-4o)
- `LLM_OFFLINE_FALLBACK` — **NEW** (default `'0'` = throws as before; set `'1'` to enable cached template fallback if all providers fail)
- `TRIGGER_SECRET_KEY` — now `${VAR:?msg}` fail-fast (was default to weak dev secret); production deploys MUST set it
- `AZURE_SPEECH_*`, `BASIC_AUTH_USER/PASS` — existing, no change

### Migration ops
- Run `npm run db:migrate` to apply drizzle `0005` / `0006` / `0007` (idempotent)
  - `0007` adds `'planning_qg'` + `'script_ready'` to phase enum (audit gap discovered by integrating QG-plan helper in commit `6baa9fa`)

### Deploy sequence
1. `git clone` + checkout this PR
2. `cp .env.example .env.local` + fill in secrets (do NOT commit `.env.local` — it's gitignored)
3. `npm ci` (no `--omit=dev`; standalone output needs all deps)
4. `npm run db:migrate` (apply 0005-0007)
5. `npm run build` (produces `.next/standalone/`)
6. Use `Dockerfile` (multi-stage) — or standalone output + existing `scripts/deploy.sh`

---

## Verification

```bash
npx tsc --noEmit           # 0 errors
npm run lint              # 0 warnings/errors
npm test                  # 221/221 passed
npm run build             # 25 routes incl. /api/health
```

Manual smoke (dev mode):
```bash
bash scripts/setup-dev-env.sh   # auto-applies 0005-0007 + writes .env.local
npm run dev
# Open http://localhost:3000
# Submit POST /api/jobs → 5s walkthrough to /jobs/[id]
# Open http://localhost:3000/admin → see jobs list, filter wall-hit
```

---

## Request reviewers to check

- [ ] Pipeline `PHASE_ORDER` has 8 phases (`planning_done` → `planning_qg` → `script_ready` → `html_ready` → `tts_caption` → `probing` → `recording_done` → `creatomate_rendering`)
- [ ] `phaseTts` is between `html_ready` and `probing` (writes `tts.mp3` from synthesized narration)
- [ ] `/api/admin/jobs?humanInLoop=1` filters wall-hit jobs (sets `RetryWallHitError` to wall context for HIL)
- [ ] `Dockerfile` builds and serves `/api/health` returning 200
- [ ] Edge TTS fallback doesn't require API key (works without `OPENAI_API_KEY` via `withTtsFallback` semantics)
- [ ] `LLM_OFFLINE_FALLBACK=0` (default) — no silent cached fallback (existing throw behavior preserved)

---

## Notable commit highlights

| Series | commits | What it does |
|---|---|---|
| Series A — deployment audit | `b699035` `221f1db` `aaaf22b` `f7857df` `d913888` `5a51cae` `a7339a1` `4bea92b` + 3 cleanup | 4 🔴 + 8 🟡 closed |
| Series B — TS error cleanup | `8f18473` `d3720f2` `042ae9b` `c49a8fa` `ec1e50f` `97a1c8a` `a519e73` `1bcfd92` `97bc131` + 2 follow-up | 17 TS errors → 0 |
| Series C — preventive audit | `c029fec` `3d1fde1` `cd19577` `6820689` `812dbc0` | 1 🔴 + 5 🟡 preventive |
| v0.6.1 follow-ups | `e0313f4` `6baa9fa` `4149923` `1e226b6` `5d0002d` `f81b1d2` `6808aa8` `b3919d0` `b7c89de` `7394051` `feb5719` `44b1d15` `949cf7f` | spec §4 integration + audit gap fix + version bump |
| v0.6.1 final scope | `f8cf481` `13e15fd` `8567434` `a1d50fd` `4c222c8` | R1 HTML audio inject, R2 mp4 mux, R4 Chrome auto-downgrade, R5 LLM offline mode, R6 Web UI dashboard |

---

## Risk & rollback notes

**Risk**: 126 commits in one PR is large for review.

**Mitigation options for review**:
1. **Squash merge**: lose individual commit detail but review only PR description
2. **Review by series**: ask reviewers to spot-check audit findings and test each integration in series
3. **Split into multiple PRs**: admin-friendly but introduces rebase complexity

**Rollback plan if PR breaks production**:
- `scripts/deploy.sh` releases directory at `/srv/auto-explainer/releases/` keeps 3 most recent — can `rm -rf` newer release dir to roll back atomically
- Each atomic release dir is a fully working deploy — no migrations in between required
- DB migrations are forward-only (`ALTER TYPE ADD VALUE IF NOT EXISTS` is idempotent; no schema destruction migrations in this PR)

---

## File map (新增 / 修改 files)

```
新增:
  app/admin/page.tsx
  app/admin/admin-client.tsx
  app/api/admin/jobs/route.ts
  Dockerfile
  .dockerignore
  drizzle/0007_phase_planning_qg.sql
  lib/tts-edge.ts
  lib/tts-fallback.ts
  lib/llm-offline.ts
  tests/integration/lib-llm-fallback.test.ts
  tests/integration/tts-azure-with-fallback.test.ts
  tests/unit/llm-offline.test.ts
  tests/unit/llm-error.test.ts  (updated)
  tests/unit/retry.test.ts  (updated)
  tests/unit/api-health.test.ts  (新增)
  types/ffprobe-static.d.ts
  PR_DESC.md  (本文件)

修改:
  package.json, package-lock.json
  next.config.mjs
  .eslintrc.json
  .gitignore, .dockerignore
  .env.example
  lib/env.ts, lib/auth.ts, lib/db.ts, lib/llm.ts, lib/logger.ts, lib/schema.ts
  lib/pipeline/qg-checks-llm.ts  (id type widen)
  app/page.tsx, app/settings/page.tsx
  app/api/jobs/route.ts, app/api/jobs/[id]/route.ts
  scripts/deploy.sh, scripts/setup-dev-env.sh
  worker/pipeline.ts, worker/phases/*.ts
  docs/USAGE.md, docs/refactor-plan-v0.1.md
  docs/superpowers/plans/v0_0_1_implementation-status.md
  types/ffprobe-static.d.ts
```
