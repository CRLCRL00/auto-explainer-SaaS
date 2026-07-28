// v0.6.1 R5: LLM offline mode (spec §4.3).
//
// 3-tier provider priority (callLlm 主路径):
//   1. Anthropic (主) ─┐
//   2. OpenAI GPT-4o   ─┤─ 都 catch 后 fallback here
//   3. minimax         ─┤
//   4. openai-compatible ┘
//
// 选 4 个 provider 全 fail + 配齐 fallback 全失败时: 用 pre-canned cached template
// (deterministic, 5-beat outline + script narration). 这不是 GPT-style 输出,
// 但能让 pipeline 不 'LLM 撞墙 完全 stop' — 兜底 spec §4.3 'LLM offline mode'
// 要求 (pre-generated prompt template fallback).
//
// 两函数:
//   - cachedPlan(topic): 5-beat outline JSON
//   - cachedScript(plan): 5-beat script JSON
//
// 设计选择:
//   - 不 parse topic 内部 — 简单 slug + 模板填. 不能给 'RAG' 风格输出但能跑.
//   - beat narration 用 topic 字面 + 中文模板, 不依赖 LLM 调用.
//   - 仅当 system prompt 真失败 catch 时调用. 不替代正常 flow.
//   - 返回 JSON 字符串 (同 callLlm 输出 shape).

function sanitizeTopic(topic: string): string {
  // Escape 闭引/<>& " 控制 + 截 60 char. 防 XSS-style input 破 schema.
  return topic
    .replace(/[<>&"']/g, '')
    .slice(0, 60)
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Cached 5-beat outline (plan) for given topic.
 *
 * 模板:
 *   b1 — 钩子 (反常识)
 *   b2 — 定义
 *   b3 — 数字对比
 *   b4 — 真实例子
 *   b5 — 收尾 (关键词 + 本质)
 *
 * 返回 JSON string — caller (phaseOutline) 走 parseAssistantJson 解析.
 */
export function cachedPlan(topic: string): string {
  const safe = sanitizeTopic(topic);
  const fallback = safe || 'Auto-Explainer';
  return JSON.stringify(
    {
      title: truncate(fallback, 30) || 'Auto-Explainer',
      topic: fallback,
      beats: [
        {
          id: 'b1',
          title: '钩子',
          summary: `${fallback} 的反常识切入点`,
          duration_sec: 6,
          visual_hint: 'big number 醒目色高对比',
        },
        {
          id: 'b2',
          title: '定义',
          summary: `${fallback} 的核心定义`,
          duration_sec: 6,
          visual_hint: '关键词高亮 + icon',
        },
        {
          id: 'b3',
          title: '数字',
          summary: `${fallback} 三个数字对比`,
          duration_sec: 6,
          visual_hint: '柱状图动效',
        },
        {
          id: 'b4',
          title: '例子',
          summary: `${fallback} 真实场景举例`,
          duration_sec: 6,
          visual_hint: 'icon + 标签',
        },
        {
          id: 'b5',
          title: '收尾',
          summary: `${fallback} 一句话本质`,
          duration_sec: 6,
          visual_hint: '关键词 + tagline',
        },
      ],
    },
    null,
    2,
  );
}

/**
 * Cached 5-beat script (narration/caption/tts_text) for given plan + topic.
 *
 * 输入可以是 plan 字符串 (JSON) 或已 parsed 对象; 解析失败 → 用纯 topic fallback.
 * 每 beat narration 长 20-30 中文字符 (template word count 与真 LLM 相近).
 */
export function cachedScript(planOrString: string | unknown, topic: string): string {
  let title = sanitizeTopic(topic) || 'Auto-Explainer';
  let beats: Array<{ id: string; title: string; summary: string }> = [];
  if (typeof planOrString === 'string') {
    try {
      const parsed = JSON.parse(planOrString) as {
        title?: string;
        beats?: Array<{ id: string; title: string; summary: string }>;
      };
      if (parsed.title) title = parsed.title;
      beats = parsed.beats ?? [];
    } catch {
      // ignore — fallback to defaults below
    }
  } else if (planOrString && typeof planOrString === 'object') {
    const parsed = planOrString as {
      title?: string;
      beats?: Array<{ id: string; title: string; summary: string }>;
    };
    if (parsed.title) title = parsed.title;
    beats = parsed.beats ?? [];
  }

  // 缺 beats (plan 不存在 / 解析失败) → 5 beat 默认
  if (beats.length < 3 || beats.length > 12) {
    beats = [
      { id: 'b1', title: '钩子', summary: `${title} 反常识切入` },
      { id: 'b2', title: '定义', summary: `${title} 核心定义` },
      { id: 'b3', title: '数字', summary: `${title} 数字对比` },
      { id: 'b4', title: '例子', summary: `${title} 真实例子` },
      { id: 'b5', title: '收尾', summary: `${title} 一句话本质` },
    ];
  }

  const scriptBeats = beats.map((b) => ({
    id: b.id,
    title: b.title,
    summary: b.summary,
    duration_sec: 6,
    visual_hint: `${b.title} 视觉示意`,
    narration: `接下来我们聊 ${b.title} — ${b.summary}.`,
    caption: truncate(`${b.title} 关键点`, 20),
    tts_text: `接下来我们聊${b.title},${b.summary}`,
  }));

  return JSON.stringify(
    {
      title,
      topic: title,
      beats: scriptBeats,
    },
    null,
    2,
  );
}

/**
 * 检测 system prompt 是否为 plan 生成 (vs script 生成 vs 通用).
 * 用字符串匹配 — 系统 prompt 在 outline.ts / script.ts 都声明 'beats' / 'narration'.
 */
export function detectLlmRole(system: string | undefined): 'plan' | 'script' | 'generic' {
  if (!system) return 'generic';
  if (system.includes('narration') || system.includes('caption')) return 'script';
  if (system.includes('beats') || system.includes('visual_hint')) return 'plan';
  return 'generic';
}
