import { logger } from '@/lib/logger';

export async function phaseProbe(jobId: string) {
  logger.info({ jobId, phase: 'probe' }, '[stub] probe phase');
}
