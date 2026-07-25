# Auto-Explainer SaaS · 产品设计 Spec

> **状态**：Brainstorming 完成，进入 Spec 复核阶段
> **作者**：CRL + AI（via `superpowers:brainstorming` skill）
> **日期**：2026-07-25
> **Stakeholder**：CRL
> **范围**：v0.0.1 (内部 alpha) → v2 全部（具体见 §7.5）
> **决策日志**：见附录 A（7 题答案 + 6 节确认）

---

## §0 Executive Summary

本 spec 描述把 `D:\项目\数据库\` 下沉淀的方法论 + 12 个视频项目 + 通用模式 60+ 项工程模式，**产品化**为一个公开 SaaS 的完整设计。

**产品定位**（最终命名待 Stakeholder 敲定，本 spec 暂用 `Auto-Explainer SaaS`）：
- 用户提交 **topic 文本 / URL / 文档** → **15-25 分钟** 后收到 **6 件套**：HTML / mp4 / voiceover / SRT / PPT / RETROSPECTIVE.md
- 核心差异化 = 直追手工质量（不开 "PPT 动画风" 后门）+ 把通用模式.md 的撞墙拐点方法论自动化内化

**期望商业模型**：
- Free (¥0 / 3 jobs) → Basic (¥39/月 / 30 jobs) → Pro (¥99/月 / 120 jobs) → PayGo (¥4/job)
- 国内支付 v1.5 接入微信/支付宝

**期望交付节奏**：
- v0.0.1（内部 alpha）：1-2 周
- v0.5（闭环 beta）：3-5 周
- v1.0（公网 launch）：6-7 周

---

## §1 系统架构总览

### 1.1 三层拓扑

```
┌─────────────────────────────────────────────────────────┐
│              Edge (Cloudflare)                           │
│   - TLS 终止 + DDoS + WAF                                │
│   - 静态资源缓存 (HTML/字体/JS)                            │
│   - 视频文件 CDN 代理 (MinIO → CF Workers)               │
└──────────────────────┬──────────────────────────────────┘
                       │
   ┌───────────────────┴────────────────────┐
   │  控制面 (VPS, 4C/8GB, NVMe)            │
   │  ├── Next.js 14 (App Router)           │
   │  ├── Postgres 16 (用户 / 账单 / 任务)  │
   │  ├── Redis 7 + BullMQ                 │
   │  ├── MinIO (S3 兼容, 资产存储)          │
   │  └── 控制 API (任务派发 / 状态查询)     │
   └───────────────────┬────────────────────┘
                       │ 任务推流 (BullMQ)
   ┌───────────────────┴────────────────────┐
   │  Worker 池 (弹性, Railway / Fly.io)    │
   │  ├── TypeScript Worker                 │
   │  │   ├── LLM 编排 (Claude API)         │
   │  │   ├── HTML 渲染模板引擎              │
   │  │   ├── Chromium 录制 (puppeteer-core)│
   │  │   ├── ffmpeg 编码                   │
   │  │   ├── TTS 编排 (OpenAI TTS-1)        │
   │  │   └── PPT 生成 (pptxgenjs)           │
   │  └── 健康检查 + 心跳上报                │
   └───────────────────────────────────────┘
                       │
   ┌───────────────────┴────────────────────┐
   │  外部 API                              │
   │  ├── Claude API (Sonnet 4.5)           │
   │  ├── OpenAI TTS API                    │
   │  ├── Stripe Billing                    │
   │  └── 微信支付 / 支付宝 (国内, v1.5)    │
   └───────────────────────────────────────┘
```

### 1.2 数据流一次概览

```
User submit (text/URL/Doc)
  ↓
[VPS]    鉴权 + 配额检查
         写入 jobs 表, 状态: pending
         BullMQ enqueue task
  ↓
[VPS]    推送给 cloud worker (能力最强)
  ↓
[Worker] 输入规整
         ├── URL → cheerio 抓取 → cheerio strip → MD
         ├── Doc → pdf-parse / md / txt → MD
         └── text → 直接 MD
  ↓
[Worker] LLM 阶段
         ├── OutlinePlanner → 7 节 outline
         ├── ScriptWriter → 每节 voiceover + 视觉提示
         └── QualityGate-v1 (plan + script 各 2 次重写机会)
  ↓
[Worker] HTML 阶段
         ├── TemplateSelector (通用模式 §27 决策树)
         ├── HtmlRenderer → assets/{id}/video.html
         └── ProbeChecker (改完 JS 必跑, 你 §方法论 2)
  ↓
[Worker] 录制阶段
         ├── Recorder (puppeteer-core + CDP / Playwright + page.video)
         ├── FpsCalculator (mtime 实算, 你 §54)
         └── frames/*.png + meta
  ↓
[Worker] 编码阶段
         ├── TtsService (7 段 → mp3 + time stamps)
         ├── SubtitleBurner (SRT 24pt 黑描边, 你 §4)
         ├── Encoder (ffmpeg H.264 + AAC + 烧字幕)
         └── output video.mp4
  ↓
[Worker] 增值阶段
         ├── CaptionAligner → voiceover.srt
         ├── PptBuilder (pptxgenjs + 6 色锚点)
         ├── RetrospectiveWriter (LLM 总结本次任务)
         └── 输出 6 件套
  ↓
[Worker] 上传 → MinIO, 状态: done
  ↓
[VPS]    webhook → 用户通知 (邮件 / 站内 / 微信)
         用户进入 dashboard 下载
```

### 1.3 关键设计抉择

| 决策 | 选择 | 理由 |
|---|---|---|
| Worker runtime | Node.js 20 | 你 12 个视频项目全在 Node |
| 浏览器 | 系统 Chrome + puppeteer-core（通用模式 §39） | 零下载 Chromium |
| TTS 提供方 | OpenAI TTS-1 (primary) + Edge TTS (fallback) | 主推高质量 / fallback 成本低 |
| LLM | Claude Sonnet 4.5 | 内容质量顶配；MVP 用户少可承受 |
| 对象存储 | MinIO 自托管 (主) + Cloudflare R2 (异地备份) | VPS 内网快 / R2 当 CDN |
| 队列 | BullMQ | 你已有 Redis 经验 |
| 监控 | 控制面板自带 (轻量) + Grafana (后期) | v1 不引入重型 |
| 部署 | tarball + atomic symlink | 你卡通大富翁复用肌肉 |

### 1.4 非目标（v1 不做）

- ❌ 用户自定义模板上传（v2）
- ❌ 多语言 i18n 先中文（v1.5）
- ❌ 协作 / 团队功能（v2）
- ❌ AI avatar / 数字人讲解（差异化路线，不要做）
- ❌ 实时多人编辑 HTML（永远不做）

---

## §2 核心组件 & 职责

按"任务生命周期阶段"组织 —— 每个组件单一职责。

| 阶段 | 组件 | 职责一句话 | 关键 IO | 关键依赖 | 失败模式 |
|---|---|---|---|---|---|
| **接入** | `AuthService` | 用户登录、配额 | session + plan tier | NextAuth + Postgres | token 过期 |
| | `JobIntake` | 接收 topic/URL/doc，落库 | text/URL/file → `jobs` 行 | Postgres + BullMQ | quota 超限 / 文件超限 |
| | `InputNormalizer` | URL/Doc 规整为 Markdown | URL/Doc → MD | cheerio / pdf-parse | 来源 403 / PDF 加密 |
| **规划** | `OutlinePlanner` | LLM 生成 7 段 outline | MD → plan.json | Claude API | API 配额 / JSON 不合规 |
| | `ScriptWriter` | 每段 voiceover + 视觉提示 | plan.json → script.md | Claude API | 输出超 4096 字符 |
| | `QualityGate-v1` | 撞墙拐点智能判定（详见 §4） | plan + script → ok/regen | Claude API | 判定不一致 |
| **构建** | `TemplateSelector` | 按受众/时长/风格选模板 | plan → template_id | 通用模式 §27 | 无匹配 |
| | `HtmlRenderer` | 模板注入 → 单文件 HTML | plan + template → html | 12 个 template 文件 | ID 缺失 / 字符溢出 |
| | `ProbeChecker` | 改完 HTML 跑 console 验证（§方法论 2） | html → {ok, errors} | Playwright + Chromium | 黑屏 / ERR |
| **录制** | `Recorder` | CDP screencast / Playwright video | html → frames | puppeteer-core / Playwright | TIMEOUT / OOM |
| | `FpsCalculator` | mtime 计算真实 fps（§54） | frames → realFps | fs.statSync | 帧间隔为 0 |
| **合成** | `Encoder` | 帧 + SRT + 音频 → mp4 | frames + srt + mp3 → mp4 | ffmpeg-static | codec 不兼容 |
| | `SubtitleBurner` | 烧 SRT 到视频 | srt → burn args | ffmpeg libass | 中文 wrap 失败 |
| | `TtsService` | 7 段口播 → MP3 + 时间戳 | script → mp3 + json | OpenAI TTS-1 / Edge | TTS 配额 / 服务宕 |
| **增值** | `PptBuilder` | data-driven PPT | plan → pptx | pptxgenjs | 字体缺失 |
| | `CaptionAligner` | TTS + 视频 → srt | mp3 + mp4 → srt | SRT 库 | 偏移错位 |
| | `RetrospectiveWriter` | LLM 总结本次任务 | job meta → RETROSPECTIVE.md | Claude API | 内容雷同 |
| **交付** | `StorageService` | MinIO 上传 + presigned URL | local files → s3 URLs | MinIO SDK | bucket 满 / 网络 |
| | `Notifier` | 邮件 / 微信 / 站内 | job done → 3 渠道 | Resend / Server酱 | 邮件 bounce |
| **横切** | `BillingService` | Stripe + 配额 | event → quota delta | Stripe SDK / Webhook | 支付失败 |
| | `Observability` | 日志 + 指标 + 链路 | event → log/metric | pino + prom-client | log 丢失 |

### 2.1 组件间接口契约

- 每个组件吃/吐 **JSON schema**（Zod 校验），便于单独替换
- Worker 不允许直接读写 Postgres（统一走 `JobIntake`）
- LLM 调用集中在 `OutlinePlanner` / `ScriptWriter` / `RetrospectiveWriter`（不在 Worker 里散开）
- 文件系统只在 Worker 内部（控制面只能通过 presigned URL）

### 2.2 复用既有资产

- 通用模式 §27 决策树 → `TemplateSelector`
- 通用模式 §23.2 / §39 → `Recorder`
- 通用模式 §54 → `FpsCalculator`
- 通用模式 §4 → `SubtitleBurner`
- 12 个视频项目的 `record.js` / `encode.js` / `tts.ps1` → Worker 第一版代码直接迁移

---

## §3 任务生命周期 & 数据流

### 3.1 作业状态机

```
        ┌──────────────────────────────────────────────────────────┐
        │                                                          │
        ▼                                                          │
   ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    │
   │ pending │───▶│ planning │───▶│ planning │───▶│ building │    │
   └─────────┘    │   (×2)   │    │   _done  │    │  (×1)   │     │
        ▲         └─────┬────┘    └─────┬────┘    └─────┬────┘     │
        │               │err            │              │           │
        │               ▼               ▼              ▼           │
        │         ┌─────────┐    ┌──────────┐    ┌──────────┐      │
        │         │ failed  │    │ html_    │    │ probing  │──┐   │
        │         │ retry?  │    │  ready   │    │  (×1)    │  │   │
        │         └────┬────┘    └─────┬────┘    └─────┬────┘  │   │
        │              │              │              │        │   │
        │              │no            ▼              ▼ok      ▼err │
        │              ▼        ┌──────────┐    ┌──────────┐       │
        │       ┌──────────┐    │recording │───▶│recording │       │
        │       │ dead     │    │  (×1)    │    │  _done   │       │
        │       └──────────┘    └─────┬────┘    └─────┬────┘       │
        │                            │                │             │
        │                            ▼                ▼             │
        │                       ┌──────────┐    ┌──────────┐        │
        │                       │encoding  │───▶│tts +     │        │
        │                       │  (×1)    │    │ caption  │        │
        │                       └─────┬────┘    └─────┬────┘        │
        │                             ▼                ▼             │
        │                       ┌──────────┐    ┌──────────┐        │
        │                       │ ppt +    │───▶│finalize  │        │
        │                       │ retro    │    │ upload   │        │
        │                       └─────┬────┘    └─────┬────┘        │
        │                             ▼               ▼             │
        │                       ┌─────────────────────────┐        │
        └───────────────────────│         done            │◀───────┘
                                └─────────────────────────┘
                                  │
                                  ▼ 用户下载 / 通知
```

**retry 策略**：每个节点右上角 (×N) 是最大重试次数。planning 给 2 次（LLM 偶发不合格），其它都给 1 次。超过进入 `failed → dead`，触发人工调研 webhook。

### 3.2 数据持久化（Postgres schema 摘要）

```sql
users (id, email, plan_id, quota_used, created_at)
plans (id, name, monthly_quota, price_cents, features jsonb)
jobs (
  id, user_id, status, phase, attempts,
  input_type, input_payload,
  plan_id, template_id, design_tokens,
  total_cost_cents, started_at, finished_at, last_error jsonb
)
job_artifacts (
  job_id, kind, storage_path,
  size_bytes, sha256, created_at
)
job_events (job_id, phase, event, payload jsonb, at)
usage_records (user_id, job_id, kind, units, cost_cents, at)
quota_periods (user_id, period_start, used, cap)
```

worker 上**只存中间帧**（`/tmp/job-{id}/frames/`），job 完成立即清理。

### 3.3 单阶段数据流（"录制"为例）

```ts
// Recorder 拿到的入参
{
  jobId: string,
  htmlPath: string,
  recordingProfile: 'cdp-60fps' | 'playwright-25fps',
  targetDurationMs: number,
  viewport: { w: 1920, h: 1080 },
  designTokens: {...}
}

// 出参（写到 Postgres + 上传 MinIO）
{
  phase: 'recording_done',
  frameCount: 1234,
  realFps: 18.3,
  frameDirZipHash: 'sha256:...',
  durationOk: true|false           // ±5s 内算 ok
}
```

如果 `durationOk = false`：自动调整 `targetDurationMs` 重排 html 时间轴一次，再 retry 一次。

### 3.4 跨组件幂等性

| 风险 | 幂等机制 |
|---|---|
| BullMQ 重投同一个 task | task 用 `jobId + phase` 作 Redis dedup key |
| LLM 输出重复 | 短缓存 (24h) + content hash |
| ffmpeg 重复跑 | 检测 `frames.zip` 已经存在则 skip |
| 用户点两次"提交" | 客户端 button disable + server-side intent dedup |

### 3.5 端到端时长预算（直追手工质量前提下）

| 阶段 | 预计时长（占大头） |
|---|---|
| LLM planning | 30-90s |
| HTML 渲染 | 10-30s |
| Probe 检查 | 10-20s |
| Recording (60fps×2-3min) | 3-7min |
| Encoding + subtitle burn | 1-3min |
| TTS（7 段 OpenAI TTS） | 30-90s |
| PPT + caption + retro | 30-60s |
| Upload + finalize | 30-60s |
| **总计** | **8-20 分钟** |

> 不达 "25-40 分钟手动" 因为：模板预热 + ffmpeg 静态调用已优化；但 Chromium 录制物理上无法绕开。

---

## §4 "撞墙拐点"智能化内化

> **核心差异化**：把 `D:\项目\数据库\通用模式.md` 的方法论产品化。

### 4.1 总原则（直接引用你的方法论）

> 出自 `通用模式.md` Part V 撞墙判断决策树：
> - 同一方向最多 3 版（v1/v2/v3）
> - v3 不行 = **回退 + 选择性吸收**，不是 v4 推倒重来
> - 推倒重来只在用户明确说"换方向"时

→ 这条铁律写在 LLM orchestrator 的 **system prompt 头三条**。

### 4.2 QualityGate-v1 决策框架

每个"输出节点"（plan / script / html / encoded video）都过一道 QualityGate：

| Gate | 输入 | 判定维度 | 不通过时 |
|---|---|---|---|
| `QG-plan` | OutlinePlanner 输出 | 7 节完整 / 各节时长加和 ≈ 目标 / 受众清晰 | 自动重写 1 次；仍不过 → 反问用户 |
| `QG-script` | ScriptWriter 输出 | 中文字数 ≈ 时长 × 字速 / 钩子段有"反常识" | 自动重写 1 次；仍不过 → 反问用户 |
| `QG-html` | HtmlRenderer + ProbeChecker 输出 | console ERR = 0 / probe-check OK / 关键 class 正确 | 改 ID 缺失 / 改 JS 语法；仍不过 → 换模板 |
| `QG-render` | Recorder 输出 | realFps ≥ 12 / 帧数稳定 / chrome 未崩 | 切 Playwright 25fps 重试 1 次 |
| `QG-final` | Encoder 输出 | ffmpeg exit 0 / stream 数正确 / 时长误差 ±3s | 转码参数调整 1 次；仍不过 → `failed` |

**LLM 决策流程**（含撞墙拐点）：
```
QG-X fails
  └─ attempt < maxAttempts?
       ├─ yes → 改一类变量（语序 / 模板 / 编码参数）
       └─ no  → 已撞墙
                ├─ 用户决策（human-in-loop）：
                │   ├─ "再试一次"   → 重置 attempts + 新种子
                │   ├─ "换方向"     → 推倒重来
                │   └─ "回退 v(N-1)" → 选 QG 通过的那版 + 加新元素
                └─ 否则挂起 + webhook
```

### 4.3 自动降级链（环境/工具异常）

> 出自方法论 #6「环境约束 → 最简方案」+ §39「系统 Chrome 零下载」

| 触发条件 | 第一选择 | 降级链 |
|---|---|---|
| Chromium 下载失败 | 系统 Chrome | → chrome-headless-shell → Playwright bundled Chromium |
| TTS API 不可用 | OpenAI TTS-1 | → Edge TTS → Web Speech API（fallback，低质） |
| Claude API 5xx | 重试 + 指数退避 | → GPT-4o → 预生成 prompt template（离线） |
| ffmpeg-static 装不上 | `@ffmpeg-installer/ffmpeg` | → 系统 ffmpeg → Playwright webm 直出 |
| BullMQ worker 全卡 | 控制面直派 Node 子进程 | （告警） |
| LLM 调用超出 90s | 切小模型（Haiku 4.5） | 计划阶段加速够用 |

每条降级都在控制面 dashboard 可见，**用户不被"魔法"挡住**。

### 4.4 Human-in-Loop 触发器（噪音阈值）

只在 4 个时机打断用户：
1. QG plan/script 二次重写仍不过
2. 输入是 URL/Doc，但解析失败 / 内容极少 / 大段被反爬挡
3. 用户主动勾选 "我想要审批 HTML 草稿再录"
4. 配额异常（单 job 预估成本 > 配置阈值的 80%）

每个触发器都附带**2-4 个明确选项**（按 §方法论 1「哪点不懂必问」精神），不让用户写长文字。

### 4.5 Anti-Patterns 代码级守卫

把 `通用模式.md` §15 「Anti-Patterns」表转化为 **CI 规则 / code-review checklist**：

| 反模式 | 自动化检测 |
|---|---|
| 直接覆盖原文件无备份 | Worker 写文件前检测 `.bak` 是否存在 |
| 第三方包过期（edge-tts 旧包 403） | `npm audit` + 包 last-publish 检查 |
| JS 语法错误 = 全黑屏 | ProbeChecker 必跑（§20.1） |
| opacity:0 ≠ display:none 段切换 | html 主分支 grep `.show { opacity:1 }` 关联 `.seg { opacity:0 }` |
| 截图循环 vs JS sleep 两套 wall clock | FpsCalculator 必启 |
| 用户"再优化"直接动手（**§方法论 1 反例**） | LLM prompt 强制先列卡点再改 |

### 4.6 LLM agent system prompt 头三条

```
1. 撞墙拐点：同一方向最多 3 版；v3 不行回退 + 选择性吸收，不推倒重来。
2. 第 2 次输出不合规必向系统申请询问，不准直接装 OK 提交。
3. 任何改 html 的 JS 后必跑 probe-console，没 [无 ERR] 不准进入下一阶段。
```

这三条进 `OutlinePlanner` / `ScriptWriter` / `RetrospectiveWriter` / `HtmlRenderer-fix` 四个 LLM 节点的 system prompt。

---

## §5 错误处理 & 容灾

### 5.1 错误分类 & 应对策略

| 类别 | 例子 | 默认动作 | 备注 |
|---|---|---|---|
| **transient** | Claude API 5xx / 网络抖动 | retry × N + 指数退避 | BullMQ attempts 配置 |
| **rate_limit** | OpenAI 429 / Stripe 限频 | 退避 + 出 waitlist | 同时降级（§4.3） |
| **permanent** | URL 404 / PDF 加密 / 输入超长 | fail-fast → 用户友好错误 | 不浪费 retry |
| **quality** | QG-X 不通过 | 走 §4 QualityGate 流程 | 不要"撒谎"通过 |
| **resource** | 内存爆 / Chromium OOM / 磁盘满 | 优雅降级（§4.3）+ 控制面告警 | v1 上限 6 worker |
| **user_error** | quota 耗尽 / 输入非法 | 入队前 reject，返回 plan upgrade 链接 | 不消耗资源 |
| **security** | URL 钓鱼 / DDoS / SQL 注入 | Cloudflare WAF 拦 + alert | 控制面记录 |

### 5.2 重试策略（细粒度）

```ts
const RETRY_POLICY = {
  planning:      { attempts: 2, backoffMs: [0, 5000] },
  html_render:   { attempts: 1, backoffMs: [0] },
  recording:     { attempts: 1, backoffMs: [0] },
  encoding:      { attempts: 2, backoffMs: [0, 30000] },
  tts:           { attempts: 3, backoffMs: [0, 5000, 15000] },
  upload:        { attempts: 5, backoffMs: [0, 2000, 8000, 30000, 60000] },
};
```

**原则**：
- 高价值阶段（planning）允许多次
- 物理过程（recording）失败一次就降级
- I/O 类（upload）多 retry + 长退避

### 5.3 资源上限

| 资源 | 上限 | 实现 |
|---|---|---|
| 单 user 并发 jobs | 3 | JobIntake 检查 |
| 单 job LLM token | 100k | 计费 + 提前终止 |
| 单 job TTS 字符 | 3000 (≈ 4 分钟口播) | TtsService 截断 |
| 单 job 渲染时长 | 60 min wall | Recorder 超时硬杀 |
| 单 VPS worker 池 | 6 槽 | BullMQ concurrency |
| 单 VPS 内存总用 | 28 GB / 32 GB | Prometheus alert 80% |
| 用户资产 TTL | 免费 7 天 / Basic 90 天 / Pro 永久 | cron 清理 + Stripe webhook |

### 5.4 用户资产回收（你 § Part I #11: 不删无同意）

> Don't Delete Without Consent — 用户规则。

- 资产在 TTL 前 **3 天**邮件提醒
- 用户可一键"保留"延 30 天
- 删除前只软删（`deleted_at`），7 天可恢复
- 7 天后真删 + 异步通知

### 5.5 用户上传文件保护（你 § Part I #1: Lag-by-one）

```
storage/users/{uid}/uploads/{file}             # 当前版本
storage/users/{uid}/uploads/{file}.bak         # 上一版本 (lag-by-one)
```

Worker 改写前自动备份；上游若 corruption，有回滚点。

### 5.6 观测性（v1 轻量，v1.5 加 OTel）

| 类别 | v1 工具 | 看什么 |
|---|---|---|
| 日志 | pino + Loki / 简单文件 | 结构化 json + traceId |
| 指标 | prom-client + Grafana Cloud free | job 成功率 / 各阶段时长 / worker 利用率 / 队列深度 |
| 链路 | console.log traceId 占位 | v1.5 上 OTel |
| 告警 | Grafana alert → 邮件 | worker memory > 80% / LLM 5xx > 5% / queue depth > 100 |

**控制面 dashboard** 自带 4 个图表：job 队列深度 / 今日成功率 / 平均渲染时长 / 各阶段失败 top5。

### 5.7 灾备演练（季度）

- 关掉 Claude API → 系统降级到 GPT-4o，**不挂**
- 强制重启 control plane → workers 仍能完成当前 task，状态不回丢
- 删掉 Redis → BullMQ 重连恢复，jobs 表兜底
- 充值不足 Stripe → 自动 degrade 到 free tier（graceful）

---

## §6 多租户 / 计费 / 安全

### 6.1 多租户隔离策略（v1 选**逻辑隔离**）

| 维度 | 方案 | 代价/收益 |
|---|---|---|
| 数据库 | 共享 Postgres + `user_id` 索引 + RLS | 简单可控，必要时可迁物理隔离 |
| 对象存储 | `bucket/{user_id}/...` 强前缀 | presigned URL 自动限定 |
| Workers | 共享 worker 池 + per-user 并发上限 | 入队前检查 |
| 队列 | BullMQ 不区分用户，全局竞争 + 调度加权（付费优先） | 不每 user 一队列 |

**Ready for 物理隔离**：单 Postgres → 多 schema；worker 池加 user 标签。

### 6.2 计费模型

| 层级 | 价格 | 月配额 | 输出规格 | 资产 TTL | 备注 |
|---|---|---|---|---|---|
| **Free** | ¥0 | 3 jobs | 720p / 60s | 7 天 | 视频含 30s 自动尾巴水印 + "by xxx.com" |
| **Basic** | ¥39 / 月 | 30 jobs | 1080p / 180s | 90 天 | 可去水印 |
| **Pro** | ¥99 / 月 | 120 jobs | 1080p / 5min | 永久 | 含 voice cloning beta |
| **PayGo** | ¥4 / job | — | 按用量 | 按 setting | 用量超出后计 |

**双重计价**（不浪费原则）：
- 包月给配额；超出走 pay-as-you-go
- 用户能在 dashboard 看到"本月预计费用"

**国内支付**：v1.5 接微信支付 + 支付宝（v1 仅 Stripe）。

### 6.3 鉴权 & 身份

```
NextAuth.js (App Router adapter)
├── Email / 密码（bcrypt）
├── Google OAuth
├── 微信 OAuth（v1.5）
└── Magic Link（v2）

Session: JWT in httpOnly cookie
Password rules: ≥ 10 字符 + zxcvbn
MFA: v2
```

### 6.4 安全清单

| 类别 | 措施 | 工具 |
|---|---|---|
| TLS / CDN | 全站 HTTPS | Cloudflare |
| WAF | OWASP top 10 + custom 规则 | Cloudflare WAF |
| DDoS | 默认 CF 防护 | Cloudflare |
| Rate limit | 60 req/min/user，10 req/min/anonymous IP | middleware |
| 输入验证 | topic < 500 字符 / 文件 < 50MB / URL 白名单 | Zod schema |
| 文件隔离 | MinIO bucket 私有 + presigned URL 临时 | MinIO SDK |
| XSS | React 默认转义 + DOMPurify on Markdown | |
| CSRF | NextAuth 内置 | |
| SQL 注入 | Drizzle ORM 参数化 | |
| Secrets | Doppler / `.env` + Vault（v1.5） | |
| 审计 | `audit_logs` 表 | |

### 6.5 合规 & 内容

- 用户一键导出全部资产（zip）
- 删除请求：用户删账户 → 7 天后 hard delete；保留发票 5 年（仅账单）
- 内容审核：过一道**关键词黑名单**（开源列表，本地匹配）
- AI 输出痕迹：视频附 "本视频由 AI 生成" 透明标识（v1.5 法规要求）
- 隐私：URL/Doc 抓取结果保留 90 天后自动清理，不训练任何模型

### 6.6 角色 & 权限

| 角色 | 权限 |
|---|---|
| `user` | 自己 jobs、billing、assets |
| `support` | 只读 user + 主动 refund |
| `admin` | 全权 + 修改 plan 配额 |

3 角色够 v1。多团队协作 v2 加。

---

## §7 测试策略 + 阶段性交付

### 7.1 测试金字塔

```
                       ╱╲
                      ╱  ╲          E2E (5%)
                     ╱    ╲         浏览器级（Playwright）
                    ╱──────╲
                   ╱        ╲       集成 (25%)
                  ╱          ╲      多组件联合 / golden 流水线
                 ╱────────────╲
                ╱              ╲     单元 (70%)
               ╱                ╲    纯函数 + zod schema + 算法
              ╱──────────────────╲
```

| 层级 | 工具 | 数量预估 | 跑时 |
|---|---|---|---|
| 单元 | vitest | 800-1200 | < 1 min |
| 集成 | vitest + node:test（pipeline） | 100-200 | 5-10 min |
| E2E | Playwright | 30-50 | 15-30 min |

### 7.2 关键测试场景

**单元层（必须 100% 覆盖）**：
- QualityGate 5 个判定逻辑
- FpsCalculator (mtime → realFps)
- SubtitleBurner 参数构造
- TemplateSelector 决策树
- Billing meter (cents 精度)
- Zod schema 边界（500 字限制 / 文件大小）

**集成层（golden 测试）**：
- 5 个 golden topic → 完整 6 件套，每件比对 hash + 抽样视觉差异
  1. "RAG 工作原理" - 60s 教学
  2. "Python 列表推导式" - 30s 抖音
  3. "Embedding 是什么" - 60s 教学
  4. "Transformer 自注意力" - 180s 长片
  5. "为什么方波可以做傅里叶" - 60s 教学
- Fixture：每录都与 fixture 比对，首屏 + 末屏 + 中间 3 个时间点

**E2E 层**：
- 新用户注册 → 登录 → 提交第一个 topic → 20 分钟后收到 6 件套
- 失败注入：故意 disable Claude API → 系统降级 + 用户通知
- 并发：5 用户同时提交 → 队列不阻塞

### 7.3 Mock / 夹具设计原则（来自你的方法论）

> § Polyfill Pattern for Node Tests: 全局 polyfill localStorage / fetch，避免依赖真实外部。

应用到本项目：
- LLM fixture：5 个 golden topic 对应 canned plan.json / script.md
- TTS fixture：本地 eSpeak-ng 或预录 mp3（断网测）
- MinIO fixture：本地 fs 模拟（docker-compose 起 minio 容器）
- Browser fixture：Docker image 锁 Chromium 版本
- 网络夹具：MSW / nock 对 LLM / TTS API 打桩

**环境一致性**：`docker-compose.test.yml` 起 Postgres + Redis + MinIO + Workers，CI 与本地一致。

### 7.4 CI / CD

```
PR push
  ├── lint + type-check (5s)
  ├── unit (< 1min)          ← 主要门禁
  └── integration (5-10min, parallel)

merge to main
  ├── build docker image
  ├── e2e (15-30min)
  └── deploy to staging

release tag
  └── deploy to prod (canary 5% → 30% → 100%)
```

**Canary 规则**：
- 错误率 ≥ 5% → 自动回滚
- 用户投诉 webhook 触达 ≥ 3/小时 → 自动暂停发布

### 7.5 阶段性交付

#### v0.0.1 - 内部 alpha（**第 1-2 周**）
- ✅ 单 VPS 控制面 + 1 worker
- ✅ 文本输入单一
- ✅ 1 模板（30s 抖音 few-shot）
- ✅ 无 auth（HTTP basic auth）
- ✅ 无 bill
- **验收**：你能从浏览器提交 "RAG 原理" → 拿到一份勉强能看的 mp4
- **不**对任何人开，自己用

#### v0.5 - 闭环 beta（**第 3-5 周**）
- ✅ Auth + quota 上线（mock billing）
- ✅ 3 模板（30s / 60s / 180s 各 1）
- ✅ URL + Doc 输入
- ✅ QG 全跑 + 撞墙拐点逻辑
- **验收**：5 个 golden topic 全过；3 个陌生人注册能用；quality gate 命中 ≥ 1 次且正确处理

#### v1.0 - 公开 launch（**第 6-7 周**）
- ✅ Stripe 计费上线（先 Stripe 测试模式）
- ✅ 全部 anti-pattern 守卫上线
- ✅ 灾备 4 路径演练通过
- ✅ Landing page + onboarding
- **验收**：公网发布；首 10 个付费用户能流畅使用

#### v1.5（**第 8-10 周，可选**）
- 微信/支付宝计费
- i18n（中英双语）
- 多人 review 流程
- Pro plan voice cloning beta

#### v2
- 自定义模板上传
- Team workspaces
- API 给企业用户

### 7.6 验收指标

| 阶段 | 关键指标 | 门槛 |
|---|---|---|
| v0.0.1 | 1 golden topic 全成 | 通过 |
| v0.5 | 5/5 golden topic 通过，QG 撞墙处理正确 | 通过 |
| v1.0 | 99% 任务在 30min 内 done，月活 10 个付费用户 | 4 周内达到 |
| 6 个月 | 月活 100 付费 / 月留存 ≥ 60% / NPS ≥ 30 | 否决性指标 |

---

## 附录 A: 决策记录（brainstorming 7 题答案）

| # | 维度 | 选项 | 选择 |
|---|---|---|---|
| Q1 | 范围 | (A) 1 个能力 MVP / (B) 整套管线 / (C) 方法论沉淀 / (D) 其他 | **B**（整套视频管线自动化产品） |
| Q2 | 谁用 | (A) 仅自己 / (B) 小团队 / (C) 公开 SaaS / (D) 其他 | **C**（公开 SaaS） |
| Q3 | MVP 路径 | (α) 一键全自动 / (β) 模板+表单 / (γ) 上传HTML / (δ) 两段式 | **α** |
| Q4 | 输入形态 | (i) 单文本 / (ii) 短表单 / (iii) 描述 + 提取 / (iv) 多源 | **iv**（URL/Doc/文本） |
| Q5 | 质量锚点 | (α) 直追手工 / (β) SaaS 够用 / (γ) 效率优先 / (δ) 商量 | **α** |
| Q6 | 架构 | (A) 单 VPS / (B) 控制面 + 弹性 / (C) 全云原生 | **B** |
| Q7 | 项目切片 | (1) MVP / (2) 全量 1 spec / (3) 减一档 SKU | **2** |
| §1-§7 7 节设计 | — | 全部 OK | **全部 ✅** |

## 附录 B: 关键参考资料（`D:\项目\数据库\` 自有素材）

| 节 | 引用资产 | 用途 |
|---|---|---|
| §2.2 / §4 | `通用模式.md` §23.2 puppeteer-core | Recorder 实现 |
| §2.2 / §3.3 | `通用模式.md` §54 动态 fps | FpsCalculator |
| §2.2 / §5 | `通用模式.md` §4 字幕烧入 | SubtitleBurner |
| §2.2 | `通用模式.md` §39 系统 Chrome | Recorder 浏览器路径 |
| §2.2 | `通用模式.md` §27 决策树 | TemplateSelector |
| §2.2 / §4.5 | `通用模式.md` §15 Anti-Patterns | CI 规则 |
| §4 全节 | `通用模式.md` Part V 撞墙判断 | LLM prompt 头三条 |
| §4.5 | `通用模式.md` §方法论 1-6 | Anti-patterns 检测 |
| §6.4 | `通用模式.md` §Part I #1 Lag-by-one | 文件上传保护 |
| §6.4 / §5.4 | `通用模式.md` §Part I #11 不删无同意 | 资产回收 |
| §6.1 | `通用模式.md` §Part I #5 atomic symlink | 部署策略 |
| §2.2 | 12 个视频项目的 `record.js` / `encode.js` / `tts.ps1` | Worker 第一版代码直接迁移 |

## 附录 C: Open Questions（implementation 阶段补）

- [ ] 项目最终命名（v0.0.1 前敲定）
- [ ] crlcrl.com 的子域名分配（auto-explainer.crlcrl.com ?）
- [ ] TTS 长期 cost 模型：是否自托管（F5-TTS / CosyVoice）
- [ ] 国内 ICP 备案 / 等保合规（公网发布前）
- [ ] Stripe Webhook 集成测试
- [ ] 微信/支付宝 SDK 选型
- [ ] A/B testing 框架（v1.5）

---

**End of spec.**
