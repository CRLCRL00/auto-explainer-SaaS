// P0 全量: 在所有 test file imports 模块评估之前, 注入 process.env stub
// (ESM 模块 strict top-down 强制 imports hoist, 文件级 plain stmt 跑不到 imports 之前).
//
// 这里设的 env 会被 envSchema.safeParse() 接受, 避免 CREATOMATE_API_KEY 等
// required 字段在 module-level getEnv() (lib/logger.ts 等) 抛 'Required' 错.
//
// ⚠️ DATABASE_URL / REDIS_URL 必须与 tests/integration/*.test.ts 的
// beforeAll 设的 "真实" URL 一致 (postgres@.../aesaas), 否则 ??= 会
// 误导 tests/integration 跳 beforeAll 设值, 走 setupFiles 的 fallback.
//
// 注意: 这个 setup 是 **default 值**, 各 test file 仍可在 beforeAll/beforeEach 里
// 单独覆盖 — ??= 语义保护"已有值不重设".
process.env.DATABASE_URL ??= 'postgres://postgres@127.0.0.1:5432/aesaas';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-env-test-1234567890';
process.env.CREATOMATE_API_KEY ??= 'creato-env-test-1234567890';
process.env.BASIC_AUTH_USER ??= 'admin';
process.env.BASIC_AUTH_PASS ??= 'changeme';
