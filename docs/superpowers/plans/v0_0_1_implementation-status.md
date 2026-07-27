# auto-explainer-saas v0.0.1 implementation status (2026-07-27)

> Source-of-truth: `[2026-07-25-auto-explainer-saas-v0_0_1.md](./2026-07-25-auto-explainer-saas-v0_0_1.md)`.
> 这是 plan session 输出的"实施计划"快照。**实际仓库已远超这些内容** — 此处仅标出哪些 lines 已经 obsolete。

## 哪些 lines 已 obsolete

| 段 | lines | obsolete 原因 |
|---|---|---|
| §1 实施思路 | 1-100 | 思路不变. 但 §4 "用什么" 引用 `ai-explainer-tiktok` 现已 hard cut 到 Creatomate SaaS (PR0 commit `b405c46` `675b96d`) |
| §2 LLM dispatch | 100-150 | 概述部分还是有效. **§2.4 minimax endpoint path detail 仍有效** (PR0 commit `b478472` 进一步包装) |
| §3 render pipeline | 150-250 | **大幅改动**: 旧 `phaseEncode.ts` (FFmpeg 自研) 现仅 thin wrapper re-export `phaseEncodeCreatomate` (multi-frame); `ffmpeg-static` 已卸 (`ffprobe-static` 取而代之) |
| §3.2 BullMQ / bull-board | 250-280 | **整段 obsolete**: BullMQ + bull-board + worker/index.ts + tests/helpers/queue.ts 已全部删除 (commit `9c92f70`). 现用 Trigger.dev v4 (`trigger/jobs.ts` task handler) |
| §4 spec §4 蓝图 | 280-450 | 仍 valid. 但实施进度比 plan 当时推进得多 — 完整状态见 `docs/refactor-plan-v0.1.md` 的 "v0.5 follow-up" 段 (新加的章节, plan commit 后追加) |
| §5 spec 决策 | 450-500 | 仍 valid. 5 决策 (#7~#11) 没变更. 但 16 commits 已落 + plan 一致 |
| §7 commit plan | 整个 | 16 commits 已超过 plan 设计的 commit 数. 改用 `git log --oneline` 当 truth |

## 哪些 lines 仍有效

- §4 spec §4.1 总原则 — 仍适用
- §4 spec §4.2 retry + 撞墙语义 — commit `9248393` 完整实施
- §4 spec §4.4 4 trigger 列出 — commit `d13d4fe` 提供 webhook 通知骨架
- §5 决策表 — 5 决策仍是 v0.1 锚

## 不 obsolete 也不 "在仓库中存在" 的

- §3 提到的 `worker/index.ts` (BullMQ Worker) — **已删** (PR4 commit `9c92f70`)
- §3 提到的 `tests/helpers/queue.ts` — **已删** (PR4 commit `9c92f70`)
- §3 提到的 `lib/queue.ts` (`getJobQueue().add`) — **已删** (`app/api/jobs/route.ts:60` 现在调用 `triggerJob`)
- §3 提到的 `npm run worker` — **已删** (package.json scripts 移除)
- §2 提到的 `tests/integration/pipeline-smoke.test.ts` 双路 (legacy FFmpeg + Creatomate) 仍有 — 但"legacy FFmpeg" 已不再 spawn ffmpeg
- §2 提到的 v0.0.1 v0.5 boundary — 已不只是 v0.0.1; 现已 ~v0.5.5 (semver 不严格, version bump 在 package.json `0.0.1` 仍 — D3 commit plan bump 到 `0.5.5` 或 `0.1.0`)

## 现 truth-source

| 信息类型 | 真实源 |
|---|---|
| 仓库 commit 历史 | `git log --oneline -20` (现 19 commits) |
| 仓库状态 | `D:\claude-code-data\projects\d-------\memory\project-auto-explainer-saas.md` (跟 commit 同步) |
| plan v0.1 实施轨迹 | `docs/refactor-plan-v0.1.md` |
| spec §4 follow-up 进度 | `docs/refactor-plan-v0.1.md` "v0.5 follow-up" 段 (新加) |
| 部署 readiness | audit commit `5a44957` + memory |

## 何时更新本 doc

每当有破坏 plan 中描述的 commit 时 (例如重构 worker / 改 LLM dispatch / 换 SDK)，
本 status doc 应在 commit message 列出 "see docs/superpowers/plans/v0_0_1_implementation-status.md for obsoleted sections"。
EOF
echo "wrote implementation-status"