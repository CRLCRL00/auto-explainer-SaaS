import { logger } from '@/lib/logger';

export async function phaseOutline(jobId: string) {
  logger.info({ jobId, phase: 'outline' }, '[stub] outline phase');
}
