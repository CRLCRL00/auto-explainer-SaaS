// TODO(Task 11): 实现真正的 pipeline runner。
// 当前为占位 stub —— 让 worker 入口 (Task 10) 能编译并空转。
// 不要在此实现 pipeline 逻辑，交由 Task 11 落地。
import { logger } from '@/lib/logger';

export async function runPipeline(jobId: string): Promise<void> {
  logger.warn({ jobId }, 'runPipeline stub called — pipeline not implemented yet (Task 11)');
}
