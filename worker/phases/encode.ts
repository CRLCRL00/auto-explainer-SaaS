import { logger } from '@/lib/logger';

export async function phaseEncode(jobId: string) {
  logger.info({ jobId, phase: 'encode' }, '[stub] encode phase');
}
