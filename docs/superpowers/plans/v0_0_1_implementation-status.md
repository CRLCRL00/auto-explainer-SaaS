# auto-explainer-saas v0.6.0 implementation status (2026-07-28)

> Source-of-truth: `git log --oneline -50`. This doc snapshots "what's obsolete in the original v0.0.1 plan" + "what commits landed in v0.5 / v0.6 series."
> Created in audit D2; refreshed 2026-07-28 after v0.6.0 triple-series (audit + ts-fix + preventive).

## v0.0.1 plan §1–§7 哪些 lines 已 obsolete

| 段 | lines | obsolete 原因 |
|---|---|---|
| §1 实施思路 | 1-100 | 思路不变. 但 §4 "用什么" 引用 `ai-explainer-tiktok` 现已 hard cut 到 Creatomate SaaS (PR0 commit `b405c46` `675b96d`) |
| §2 LLM dispatch | 100-150 | 概述部分还是有效. **§2.4 minimax endpoint path detail 仍有效** (PR0 commit `b478472` 进一步包装). v0.6+ T9 加 `'minimax'` 到 settings page Provider union |
| §3 render pipeline | 150-250 | **大幅改动**: 旧 `phaseEncode.ts` (FFmpeg 自研) 现仅 thin wrapper re-export `phaseEncodeCreatomate` (multi-frame); `ffmpeg-static` 已卸 (`ffprobe-static` 取而代之). v0.6.0 T8 加 `ffprobe-static.d.ts` ambient declaration |
| §3.2 BullMQ / bull-board | 250-280 | **整段 obsolete**: BullMQ + bull-board + worker/index.ts + tests/helpers/queue.ts 已全部删除 (commit `9c92f70`). 现用 Trigger.dev v4.5 (`trigger/jobs.ts` task handler, destructure `{ ctx }` 适配 v4 SDK API) |
| §4 spec §4 蓝图 | 280-450 | 仍 valid. 但实施进度比 plan 当时推进得多 — 见下方 v0.6.0 实施轨迹 |
| §5 spec 决策 | 450-500 | 仍 valid. 5 决策 (#7~#11) 没变更. |
| §7 commit plan | 整个 | 21 commit (v0.0.1 plan) → 现 ~50 commit (含 v0.5.x + v0.6.0 triple-series). 改用 `git log --oneline` 当 truth |

## v0.5.x 系列 (16 commits 增量, 2026-07-27)

| commit | 范围 |
|---|---|
| `9248393` | v0.5 retry + QG-render/final + pipeline budget (§4.2 完整) |
| `1cac05b` | v0.5.1 QG-plan / QG-script / QG-html (§4.2 LLM-side) — Helper 落地, pipeline 集成留 v0.5.6 |
| `6d4e096` | v0.5.2 LLM auto-downgrade anthropic → GPT-4o (§4.3) — Helper 落地, llm.ts 集成留 v0.5.6 |
| `978449b` | v0.5.4 ffprobe 集成 QG-final 时长 (§4.2) — 完全 |
| `d13d4fe` | v0.5.5 Human-in-Loop webhook + jobs.human_in_loop_reason (§4.4 骨架) |

## v0.6.0 triple-series (30 commits 增量, 2026-07-28)

总共三个 audit round 在 v0.6.0 milestone 落地:

### Series A — deployment audit (11 commits, `b699035`–`76d53ba`)

C1–C8 关闭了 `scripts/deploy.sh:65 /api/health 不存在` 这种死锁级 bug，还有 tar secret leak、nginx app vhost、trigger-web loopback bind、CI build step 缺失、.env.example 不全、drizzle migration 非 idempotent、stale Task 15 TODO、USAGE.md 多处 stale。

3 个 cleanup commits：`0552e1e` finalize d988a83 walk-through test, `76d53ba` gitignore probe scripts, `6a2d7e2` fix nginx test for upstream blocks (我 C3 commit 引入 regression 修)。

### Series B — TypeScript error cleanup (11 commits, `8f18473`–`e10ddb7`)

C4 加 `npm run build` 后让 17 pre-existing TS errors 从 hidden debt 升级为 CI red。T1–T9 三个一组：(T1) trigger/jobs.ts SDK v4.5 ctx destructure；(T2) tts-azure.ts ResultReason；(T3) api-jobs NODE_ENV readonly；(T4) settings-page LlmSettings type；(T5) outline/script MockInstance type；(T6) vi.clearAllMocks() async wrap (8 errors 一组改 5 文件)；(T7) OPENAI_API_KEY env schema；(T8) ffprobe-static ambient declaration；(T9) app/settings/page.tsx Provider type 补 'minimax'。

T1 + T2 各衍生 follow-up commit（`67fecab` trigger-task test wrap + `e10ddb7` tts-azure revert+String cast）。

### Series C — preventive audit (5 commits, `c029fec`–`812dbc0`)

ESLint 找 `.ts` 弹 "rule not found" 红 + 其他没被前两轮 audit 看到的安全 / reliability 缺口：ESLint enable `@typescript-eslint/no-explicit-any`；next.config reactStrictMode + poweredByHeader:false + 安全 headers + output: 'standalone'；lib/db connection/idle/statement/query timeout；lib/logger pino redact apiKey/HUMAN_IN_LOOP_WEBHOOK_URL + authorization header。

PR2 折了 PR6 (删 noop webpack)，共 5 commit。

## spec §4 实施进度 (2026-07-28 末态)

| §4 块 | 进度 | commit |
|---|---|---|
| §4.2 retry + 撞墙 | ✅ 完全 | `9248393` |
| §4.2 QG-render / QG-final (+ ffprobe) | ✅ 完全 | `9248393` `978449b` |
| §4.2 QG-plan / QG-script / QG-html | ⚠️ Helper 落地, pipeline.ts 集成 pending | `1cac05b` |
| §4.3 LLM fallback (anthropic → GPT-4o) | ⚠️ Helper 落地, llm.ts 集成 pending | `6d4e096` |
| §4.3 TTS auto-downgrade (Azure → Edge) | ❌ 未实施 | — |
| §4.3 Chrome auto-downgrade | ❌ 未实施 | — |
| §4.3 LLM offline mode | ❌ 未实施 (留 v0.7+) | — |
| §4.4 HIL webhook notify + jobs.human_in_loop_reason | ✅ 骨架 | `d13d4fe` |
| §4.4 Web UI dashboard (React + SSE) | ❌ 未实施 (留 v0.6.1+) | — |

## v0.6.0 closure 状态总结

```
tsc --noEmit        → 0 errors
npm run lint        → ✔ No warnings or errors
npm test            → 203/203 ✓
npm run build       → ✓ (含 /api/health, /api/jobs, /api/jobs/[id] 等 25 routes)
git status          → working tree clean
version             → 0.6.0 (从 0.5.5 bump)
```

剩余未做 (留 v0.6.1+ 或更后):
- Web UI dashboard (spec §4.4 React + SSE)
- LLM fallback helper 集成到 llm.ts (§4.3 LLM-side)
- QG-plan / script / html 集成到 pipeline.ts (§4.2 LLM-side)
- TTS Edge fallback (§4.3)
- Dockerfile (long-term 项目, PR3 加 standalone output 已铺路)
- Push to remote + PR

## 现 truth-source

| 信息类型 | 真实源 |
|---|---|
| 仓库 commit 历史 | `git log --oneline -50` |
| 仓库状态 (commit / tests / lint / tsc / version) | `git status` + `npm test` + `npx tsc --noEmit` + `npm run lint` + `cat package.json \| grep version` |
| plan v0.0.1 实施轨迹 (obsoleted 段) | 本文件 (`v0_0_1_implementation-status.md`) |
| 部署 readiness | `memory/project-auto-explainer-saas.md` (§ 关键非显性事实 + 部署 readiness 段) |
| spec §4 follow-up 进度 | 上方 "spec §4 实施进度" 表 |

## 何时更新本 doc

每当有破坏 plan v0.0.1 中描述的 commit 时 (例如重构 worker / 改 LLM dispatch / 换 SDK / security hardening)，本 status doc + memory file 同步刷新。
