// v0.5.5 Human-in-Loop webhook 通知 (spec §4.4 — 4 trigger 自动化部分).
//
// 设计: 撞墙 (RetryWallHitError) 时若部署侧配 HUMAN_IN_LOOP_WEBHOOK_URL,
//   POST 一份简短的 JSON 给 owner。owner 端 (Slack/Discord/dispatch 等) 接收
//   后做 decision tree ('再试一次' / '换方向' / '回退 v(N-1)') — full control
//   plane dashboard 留 v0.6+ 实施 (本次不做 web UI)。
//
// payload shape:
//   {
//     jobId, phaseName, attempts,
//     reason: 'qg-plan' | 'qg-render' | 'infra-anthropic' | ...,
//     suggestedActions: ['retry', 'reverse', 'replace-template'],
//     lastError: { message, stack? },
//     timestamp
//   }

export interface HumanInLoopPayload {
  jobId: string;
  phaseName: string;
  attempts: number;
  reason: string;
  suggestedActions: string[];
  lastError: { message: string; stack?: string };
  timestamp: string; // ISO
}

export async function notifyHumanInLoop(
  webhookUrl: string | undefined,
  payload: HumanInLoopPayload,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!webhookUrl) {
    // env 未配置 — graceful skip, 不抛 (HUMAN_IN_LOOP 是 prompt 不是 wall).
    return { ok: false, error: 'no webhook configured' };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000), // 5s timeout — 不阻塞 pipeline
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Build payload from a RetryWallHitError + jobId. */
export function buildHILPayload(
  jobId: string,
  err: { phaseName: string; attempts: number; lastError: unknown },
): HumanInLoopPayload {
  const inner = err.lastError;
  const lastError =
    inner instanceof Error
      ? { message: inner.message, stack: inner.stack }
      : { message: String(inner) };
  return {
    jobId,
    phaseName: err.phaseName,
    attempts: err.attempts,
    reason: classifyReason(err.phaseName),
    suggestedActions: ['retry', 'reverse-or-replace'],
    lastError,
    timestamp: new Date().toISOString(),
  };
}

/** Map phase name → high-level reason for owner dashboard. */
function classifyReason(phaseName: string): string {
  if (phaseName.startsWith('planning') || phaseName === 'script_ready') return 'qg-plan-or-script';
  if (phaseName === 'html_ready' || phaseName === 'probing') return 'qg-html-or-probe';
  if (phaseName === 'recording_done') return 'qg-render';
  if (phaseName === 'creatomate_rendering') return 'qg-final';
  return 'infra-or-other';
}
