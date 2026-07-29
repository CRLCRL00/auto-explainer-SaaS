import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { getEnv } from '@/lib/env';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';
import { logger } from '@/lib/logger';

/**
 * v0.7: GET /api/admin/jobs/[id]/events — Server-Sent Events stream
 *
 * Streams live job state updates to the admin dashboard so user doesn't have
 * to poll every 3s. Protocol:
 *
 *   event: state
 *   data: { id, status, phase, attempts, humanInLoopReason, lastError, ... }
 *
 *   : keepalive comment every 25s (prevents proxy buffering / browser timeout)
 *
 * Implementation:
 *   - Polls DB every 2s
 *   - Sends update only when state changes (delta-encoded via JSON.stringify===comparison)
 *   - Closes connection when client goes away (`req.signal.aborted`)
 *   - Auth: basic auth in prod (nginx primary + endpoint defense-in-depth)
 *
 * Why not Trigger.dev SSE / WebSocket:
 *   - Trigger.dev's UI uses proprietary protocol — we'd have to embed their SDK
 *   - SSE is in-spec HTTP — works through any proxy that allows text/event-stream
 *   - Polling DB at 2s is fine for low-volume admin (1 connection per open browser tab)
 */

interface JobSnapshot {
  id: string;
  status: string;
  phase: string;
  attempts: number;
  humanInLoopReason: string | null;
  lastError: { message?: string } | null;
  finishedAt: string | null;
  startedAt: string | null;
  updatedAt: string;
}

const POLL_INTERVAL_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 25_000;

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  // Auth (prod basic auth; nginx also enforces)
  if (process.env.NODE_ENV === 'production') {
    const env = getEnv();
    const authed = createBasicAuthMiddleware({ user: env.BASIC_AUTH_USER, pass: env.BASIC_AUTH_PASS })(req);
    if (!authed) return unauthorizedResponse();
  }

  const db = getDb();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastJson: string = '';

      async function pushSnapshot(): Promise<void> {
        if (closed) return;
        try {
          const [job] = await db
            .select({
              id: jobs.id,
              status: jobs.status,
              phase: jobs.phase,
              attempts: jobs.attempts,
              humanInLoopReason: jobs.humanInLoopReason,
              lastError: jobs.lastError,
              finishedAt: jobs.finishedAt,
              startedAt: jobs.startedAt,
              updatedAt: jobs.updatedAt,
            })
            .from(jobs)
            .where(eq(jobs.id, params.id))
            .limit(1);
          if (!job) {
            controller.enqueue(encoder.encode(`event: not_found\ndata: {}\n\n`));
            controller.close();
            closed = true;
            return;
          }
          const snap: JobSnapshot = {
            id: job.id,
            status: job.status,
            phase: job.phase,
            attempts: job.attempts,
            humanInLoopReason: job.humanInLoopReason,
            lastError: job.lastError as { message?: string } | null,
            finishedAt: job.finishedAt?.toISOString() ?? null,
            startedAt: job.startedAt?.toISOString() ?? null,
            updatedAt: job.updatedAt.toISOString(),
          };
          const json = JSON.stringify(snap);
          if (json !== lastJson) {
            controller.enqueue(encoder.encode(`event: state\ndata: ${json}\n\n`));
            lastJson = json;
          } else {
            // No change — send comment to keep connection alive
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'SSE push snapshot error',
          );
        }
      }

      // Initial push (immediate) + periodic poll
      await pushSnapshot();
      const pollTimer = setInterval(pushSnapshot, POLL_INTERVAL_MS);

      // Hard keepalive for long-idle proxies (in addition to comment on no-change)
      const keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ka ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, KEEPALIVE_INTERVAL_MS);

      // Clean up on client disconnect
      const onAbort = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(keepaliveTimer);
        try {
          controller.close();
        } catch {
          // already closed — ignore
        }
      };
      req.signal.addEventListener('abort', onAbort);
    },
    cancel() {
      // Fallback cancel (older browsers / non-AbortSignal)
      // — interval cleared in onAbort above; nothing else to do here.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  });
}
