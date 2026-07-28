import pino from 'pino';
import { getEnv } from './env';

const env = getEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
  // audit preventive PR5: secrets 防护 — pino redact 配置把所有 '...' 类的
  // apiKey / Authorization header / webhook URL 在输出前替换为 '[Redacted]'.
  // 匹配 root + nest 路径, 防 worker pipeline 上传到 web logger 时无意
  // 暴露 owner secret. dev 也能 redacted — log 不需真值.
  redact: {
    paths: [
      'apiKey',                  // lib/llm-settings & lib/notify payload
      '*.apiKey',                // 任一 nest 对象的 apiKey 字段
      'authorization',           // HTTP auth header
      'headers.authorization',
      'HUMAN_IN_LOOP_WEBHOOK_URL',
      'webhookUrl',
    ],
    censor: '[Redacted]',
    remove: false,               // 保留 key 名, 仅换 value — log 结构清晰
  },
  // normalize Error 序列: stack 默认完整 — 长, 加 \`error.stack\` redacted
  // 太重. 这里保持 default (full stack) 因为 error trace 是 debugging core.
});