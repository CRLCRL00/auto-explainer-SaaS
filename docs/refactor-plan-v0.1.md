# auto-explainer-saas refactor plan v0.1

> 版本：v0.1 (2026-07-27)  
> 范围：4 路 GitHub / Web 调研结论 + 综合 Plan agent 设计 + 5 项未决决策拍板  
> 状态：**调研 + 规划已落地，待分阶段实施**

---

## 1. 调研结论摘要（4 路）

| 方向 | 结论 | 推荐 |
|---|---|---|
| 整体 SaaS 替代 | **不替换** — 赛道主流（MoneyPrinterTurbo ★65k）是 Python，与本项目 TS 栈不兼容；同栈小项目（ai-vid-explainer ★120）社区薄弱 | 维持自研 |
| LLM gateway | 自研 70 行 fetch + `base_resp` 解析已经够用；杀鸡用牛刀 | 自研保持 + 加 **OpenRouter fallback** |
| Workflow engine | BullMQ 缺 dashboard + 长任务恢复 + durable 续跑 | **Trigger.dev v4**（Apache-2.0, TS 原生，自带 dashboard） |
| 视频合成管线 | FFmpeg 自研拼接+字幕+TTS 是现状，缺 SaaS 一站式能力 | **Creatomate** SaaS 一站式覆盖；截图层（Playwright/Puppeteer）保留 |

---

## 2. 实施总览（4 个 P）

| 阶段 | 动作 | 风险 | 预估 commit 数 | 新增依赖 | env vars |
|---|---|---|---|---|---|
| **P2** | OpenRouter fallback + 频率计数器（in-memory sliding window + 阈值 fast-fail） | 低 | 1 | 无（复用 `openai@6.49.0`） | `OPENROUTER_API_KEY`、`OPENROUTER_BASE_URL`、`OPENROUTER_FALLBACK_MODEL`（均 optional）|
| **P0 POC** | Creatomate SDK 接通 + 外接 Azure TTS，**保留旧 FFmpeg 路径**（`RUN_CREATOMATE_POC=1` flag 切换） | 中 | 3~4 | `@creatomate/creatomate`、`azure-cognitiveservices-speech` | `CREATOMATE_API_KEY`、`CREATOMATE_BASE_URL`、`AZURE_SPEECH_KEY`、`AZURE_SPEECH_REGION` |
| **P0 全量** | Hard cut：所有视频走 Creatomate + Azure TTS；删 `ffmpeg-static`、`@ffmpeg-installer/ffmpeg`；schema 加 `creatomate_rendering` phase | 中高 | 4~6 | 无新增 | `CREATOMATE_*` 变 required；加 `CREATOMATE_TEMPLATE_ID`、`CREATOMATE_POLL_MS`、`CREATOMATE_POLL_TIMEOUT_MS` |
| **P1** | Trigger.dev v4 替换 BullMQ；自托管加 ClickHouse + trigger-web 两个 service；Nginx + basic auth 暴露 3030 dashboard | 高 | 8~12 | `@trigger.dev/sdk` | `TRIGGER_PROJECT_REF`、`TRIGGER_SECRET_KEY`、`TRIGGER_API_URL`、`RUN_TRIGGER_DEV`（feature flag）|

---

## 3. 推进顺序

```
P2 (半日) → P0 POC (3~5 天) → P0 全量 (1 周) → P1 (2~3 周)
```

**为什么这个顺序：**
- **P2 最先做** — LLM 链路稳了再做 render，避免 P0 期间算力浪费
- **P0 必须先 POC 后全量** — 规避 vendor lock-in 风险
- **P1 改动最大（含 ClickHouse 引入）— 放最后**

---

## 4. 已拍板的 5 项决策（#7~#11）

| # | 决策 | 与 plan 默认的差异 |
|---|---|---|
| #7 | P0 全量视觉 **hard cut**（不并行双版本展示，不分双写） | 同 plan 默认 |
| #8 | Trigger.dev dashboard 用 **Nginx + basic auth** 暴露（不再仅内网） | **激进** — `scripts/deploy.sh` 新增 `auto-explainer-nginx` systemd unit + Nginx 配置（含 htpasswd） |
| #9 | POC 阶段**直接外接 Azure TTS**（不先验证 Creatomate 内置中文） | **激进** — 新增 `azure-cognitiveservices-speech` SDK，`AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` env vars |
| #10 | P2 OpenRouter fallback 加**内置频率计数器** + >5% 阈值 fast-fail（in-memory sliding window） | **新增内部 state** — plan 默认仅日志 |
| #11 | P1 dual-run 期间 **BullMQ 主写 `job_events` + Trigger.dev 仅写 `trigger_runs`**（隔离避免冲突） | 同 plan 默认 |

---

## 5. 风险与未决

### 已识别风险

1. **P0 vendor lock-in** — Creatomate 涨价 / 数据合规变更会让 P0 全量 commit 之后回滚成本变高。缓解：保留 FFmpeg 代码 path 一个 minor 版本（`buildEncodeArgs` 标 deprecated）。
2. **P0 captions 字体差异** — Creatomate 云端模板字体可能与本地 Puppeteer 视觉不一致；POC 阶段需手测。
3. **P0 TTS voice ID 质量** — Azure TTS 中文 voice ID 需 POC 手测确认；不通过则降级 = 只渲染视频不含 TTS。
4. **P1 ClickHouse OOM** — 与 Postgres 共享 host 会争抢。缓解：ClickHouse 独立 service + `deploy.resources.limits.memory: 1G`。
5. **P1 long-task SDK timeout** — Trigger.dev v4 在 `run` 内做 polling 是否触发 SDK default timeout 需 PR1 验证。

### 未决（实施时临时决）

> 5 项已全部拍板；本节用于实施过程中临时出现的紧急议题。

---

## 6. Critical files

实施过程中**最关键**的 6 个文件：

- [worker/phases/encode.ts](../worker/phases/encode.ts) — P0 全量主战场
- [lib/llm.ts](../lib/llm.ts) — P2 唯一改动源（callLlm 顶层 + 频率计数器）
- [worker/pipeline.ts](../worker/pipeline.ts) — P0/P1 都需触碰的编排入口
- [worker/index.ts](../worker/index.ts) — P1 主入口（BullMQ Worker → Trigger.dev task）
- [docker-compose.yml](../docker-compose.yml) — P1 新增 ClickHouse + trigger-web
- [scripts/deploy.sh](../scripts/deploy.sh) — P1 新增 Nginx systemd unit

---

## 7. 实施步骤（按 P 顺序）

### 7.1 P2 详细步骤

1. Read `lib/llm.ts:30-108`, `lib/llm-settings.ts:10-35`, `lib/env.ts:3-11`
2. `lib/llm.ts:30-58` 给 `ResolvedLlmConfig` 加 `openrouterModel?: string`
3. `lib/llm.ts:89-108` `callLlm` 顶层包 `callMinimaxWithFallback(cfg, opts, logger)`：
   - 先 `callMinimax`；捕获 4xx 或 base_resp 4xxx 业务码 → 切 OpenRouter
   - 用现有 `openai` SDK，`baseURL = OPENROUTER_BASE_URL`
   - 写 `logger.warn({ from: 'minimax', to: 'openrouter', err }, 'llm fallback to openrouter')`
4. 新增 `callOpenRouter()` 函数（~50 行，复用 `callOpenAICompat` 的 retry/backoff）
5. 在 `lib/llm.ts` module-level 加 `fallbackStats = { windowMs: 60_000, max: 5, recent: [] as number[] }` sliding window，超过 `max` 在窗口内 → fast-fail 一段时间
6. 更新 `lib/env.ts:3-11`：`OPENROUTER_API_KEY/OPENROUTER_BASE_URL`（optional）
7. 更新 `.env.example`（末尾 +4 行）
8. 新建 `tests/unit/llm-fallback.test.ts`（6 个 case）：
   - 1) callMinimax 抛 1008 → fallback OpenRouter
   - 2) 未配 key → 抛原 error
   - 3) 成功时不 fallback
   - 4) 4xx HTTP 与 base_resp 4xxx 都触发
   - 5) 不污染 settings 文件
   - 6) 计数器超阈值 fast-fail

### 7.2 P0 POC 详细步骤

1. `npm install @creatomate/creatomate azure-cognitiveservices-speech`
2. 更新 `.env.example` 加 CREATOMATE_* + AZURE_SPEECH_*（optional）
3. 新建 `worker/phases/encode-creatomate.ts` (~120 行)
4. 新建 `worker/phases/tts-azure.ts` (~80 行)
5. 更新 `worker/pipeline.ts:24-32` 加 `RUN_CREATOMATE_POC=1` 分流
6. 新建 `tests/unit/encode-creatomate.test.ts` + `tts-azure.test.ts`（mock SDK）
7. 更新 `tests/integration/pipeline-smoke.test.ts` 拆双路（保留 legacy FFmpeg + 加 Creatomate gated）

### 7.3 P0 全量步骤

参见 `docs/refactor-plan-v0.1.md` §7 后续补充。

### 7.4 P1 步骤

参见 `docs/refactor-plan-v0.1.md` §7 后续补充。

---

## 8. 回滚点（每 P 单 commit revert 即生效）

- **P2**：`lib/llm.ts` 改动 + `lib/env.ts` optional 字段 — revert 即回退，env vars 留空等同无 fallback
- **P0 POC**：`RUN_CREATOMATE_POC=0` 默认走旧 FFmpeg；删 `encode-creatomate.ts` + revert commit 即回退
- **P0 全量**：`PHASE_ORDER` 改回 `encoding`，revert 后续 commits 即回退；`buildEncodeArgs` 一个版本保留
- **P1**：`RUN_TRIGGER_DEV=0` 默认走 BullMQ；revert 单 commit 即生效

---

## 9. 引用与源

- Plan agent 综合 plan：subagent transcript `a*` (4 个调研) + `Plan` agent 输出（在 `claude/task-notifications`）
- 关键文档来源：
  - [Trigger.dev self-hosting v4](https://trigger.dev/docs/self-hosting/v4)
  - [Creatomate Node.js SDK](https://github.com/creatomate/creatomate-node)
  - [OpenRouter OpenAI-compatible API](https://openrouter.ai/)
  - [Azure Speech Service](https://learn.microsoft.com/azure/ai-services/speech-service/)

---

## v0.5 follow-up (spec §4) — 2026-07-27 落地进展

plan 写于 4 调研 + 决策当天；之后 5 个 commit (`9248393` `1cac05b` `6d4e096` `978449b` `d13d4fe`) 落地 spec §4 完整范围。新章节补当前状态:

### v0.5 commits (16 → 实际 21, 含 v0.5.1~v0.5.5)

| commit | 范围 | 状态 |
|---|---|---|
| `9248393` | v0.5 retry + QG-render/final + pipeline budget (§4.2) | ✅ 完全 |
| `1cac05b` | v0.5.1 QG-plan / QG-script / QG-html (§4.2 LLM-side) | ✅ Helper 落地, pipeline 集成留 v0.5.6 |
| `6d4e096` | v0.5.2 LLM auto-downgrade anthropic → GPT-4o (§4.3) | ✅ Helper 落地, llm.ts 集成留 v0.5.6 |
| `978449b` | v0.5.4 ffprobe 集成 QG-final 时长 (§4.2) | ✅ 完全 |
| `d13d4fe` | v0.5.5 Human-in-Loop webhook + jobs.human_in_loop_reason (§4.4 骨架) | ✅ 骨架, 完整 web UI 留 v0.6+ |

### spec §4 实施进度表 (2026-07-27 末态)

| §4 块 | 进度 | commit |
|---|---|---|
| §4.2 retry + 撞墙 | ✅ 完全 | `9248393` |
| §4.2 QG-render / QG-final (+ ffprobe) | ✅ 完全 | `9248393` `978449b` |
| §4.2 QG-plan / QG-script / QG-html | ⚠️ Helper 落地, pipeline.ts 集成 pending | `1cac05b` |
| §4.3 LLM fallback (anthropic → GPT-4o) | ⚠️ Helper 落地, llm.ts 集成 pending | `6d4e096` |
| §4.3 TTS auto-downgrade (Azure → Edge) | ❌ 未实施 (留 v0.5.7) | — |
| §4.3 Chrome auto-downgrade (system → headless-shell) | ❌ 未实施 (留 v0.5.7) | — |
| §4.3 LLM 离线 mode (pre-generated prompt) | ❌ 未实施 (留 v0.7+) | — |
| §4.4 HIL webhook notify + jobs.human_in_loop_reason | ✅ 骨架落地 (HTTP webhook) | `d13d4fe` |
| §4.4 Web UI dashboard (React + SSE) | ❌ 未实施 (留 v0.6+) | — |

### Plan §9 引用更新

- 完整实施轨迹 → `git log --oneline` (17 commits: 10 计划内 + 1 multi-frame + 5 v0.5 + 1 chore audit D1)
- 测试: 194/194 unit + integration 全过
- 部署 readiness: 见 audit report commit `5a44957`
