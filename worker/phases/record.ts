import { logger } from '@/lib/logger';
export async function phaseRecord(jobId: string) {
  logger.info({ jobId }, '[stub] record phase');
}