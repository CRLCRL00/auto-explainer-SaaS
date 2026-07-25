import { logger } from '@/lib/logger';
export async function phaseScript(jobId: string) {
  logger.info({ jobId }, '[stub] script phase');
}