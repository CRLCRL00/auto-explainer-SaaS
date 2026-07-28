/** @type {import('next').NextConfig} */
const nextConfig = {
  // output: 'standalone' 让 `next build` 生成 `.next/standalone/` 目录 — 包含
  // Node.js 服务器 + 必要 deps (not 全部), 与源码文件一起可打成小 image.
  // 用户长期计划 (long-term D7): 加 Dockerfile + container deploy. 现在开
  // standalone output, dev 跑 `next dev` 不变 (`output` 只影响 build).
  output: 'standalone',
  // React 18 strict mode 在 dev/prod 都开 — 副作用模式让 component 渲染 2 次
  // 才能 catch bugs (e.g., effect cleanup leak). Next 14 默认 false, 推荐 true.
  reactStrictMode: true,
  // 关 X-Powered-By: Next.js — header 信息泄露 (暴露框架版本).
  poweredByHeader: false,
  // 安全 headers (最低集). CSP 留给 reverse proxy (nginx) 加; Next.js app 层
  // 加 X-Frame-Options / X-Content-Type-Options / Referrer-Policy.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // Strict-Transport-Security 当 nginx 后面终止 TLS 时应加 HSTS;
          // 这里保守不写 (proxy 端加更准确, 避免 dev http://localhost 也进 HSTS).
        ],
      },
    ];
  },
  experimental: { serverActions: { bodySizeLimit: '50mb' } },
};
export default nextConfig;