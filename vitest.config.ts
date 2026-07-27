import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    // P0 全量: setupFiles 在所有 test file 导入模块评估之前注入 process.env stub,
    // 避免 lib/env.ts 的 CREATOMATE_API_KEY 等 required 字段漏设导致 module-level
    // getEnv() (lib/logger.ts / lib/db.ts 等) 抛 'Required' 错。
    setupFiles: ['./tests/setup.ts'],
  },
});
