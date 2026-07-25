import { logger } from '@/lib/logger';

export async function phaseRecord(jobId: string) {
  logger.info({ jobId, phase: 'record' }, '[stub] record phase');
}
