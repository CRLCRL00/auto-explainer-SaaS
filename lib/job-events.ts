import { getDb } from './db';
import { jobEvents } from './schema';

export async function recordEvent(
  jobId: string,
  phase: string,
  event: string,
  payload?: unknown,
) {
  const db = getDb();
  await db.insert(jobEvents).values({
    jobId,
    phase,
    event,
    payload,
  });
}
