import pino from 'pino';
import { getEnv } from './env';

const env = getEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
});