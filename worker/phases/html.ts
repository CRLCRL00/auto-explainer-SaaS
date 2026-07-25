import { logger } from '@/lib/logger';

export async function phaseHtml(jobId: string) {
  logger.info({ jobId, phase: 'html' }, '[stub] html phase');
}
