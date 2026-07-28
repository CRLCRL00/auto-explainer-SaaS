// v0.5+ doc: tests/integration/nginx-config-validate.test.ts
//
// audit P1 #6: docs/nginx-auto-explainer.conf 是 template, 部署到 VPS 后才能验
// nginx -t. 这个 test 在 CI 阶段静态检查配置语法 (不依赖真 nginx binary).
//
// 我们没有 nginx 命令 (deployment-side 工具), 所以仅做静态校验:
//   - 所有 'auth_basic' 必须有 'auth_basic_user_file'
//   - 所有 'proxy_pass' 必须指 127.0.0.1 (loopback; 不直接 expose dashboard 到 internet)
//   - 文件非空 / 含 server block
//
// 真 nginx -t 留给 deploy 阶段 (docs + ops runs `nginx -t` after scp).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('docs/nginx-auto-explainer.conf (v0.5+ audit P1)', () => {
  const NGINX_CONF_PATH = join(process.cwd(), 'docs', 'nginx-auto-explainer.conf');
  let content: string;

  it('1. file exists and non-empty', () => {
    content = readFileSync(NGINX_CONF_PATH, 'utf8');
    expect(content.length).toBeGreaterThan(50);
  });

  it('2. has at least one server block', () => {
    expect(content).toMatch(/^server\s*\{/m);
  });

  it('3. auth_basic always paired with auth_basic_user_file', () => {
    content = readFileSync(NGINX_CONF_PATH, 'utf8');
    const authBasics = content.match(/^\s*auth_basic\s+"[^"]+";/gm) ?? [];
    const authUserFiles = content.match(/^\s*auth_basic_user_file\s+[^;]+;/gm) ?? [];
    expect(authBasics.length).toBe(authUserFiles.length);
    expect(authBasics.length).toBeGreaterThan(0);
  });

  it('4. proxy_pass targets only loopback (no public-IP abuse)', () => {
    content = readFileSync(NGINX_CONF_PATH, 'utf8');
    const proxyPassLines = content.match(/^\s*proxy_pass\s+[^;]+;/gm) ?? [];
    expect(proxyPassLines.length).toBeGreaterThan(0);
    // proxy_pass 可以是直指 loopback ('http://127.0.0.1:PORT') 或指向 upstream
    // ('http://<name>' where <name> 在文件别处定义指向 loopback). 后者是
    // 更现代的写法 — abstract 的好处是改 IP 只改 upstream 不动每个 location.
    const upstreamBlocks = content.match(/upstream\s+(\w+)\s*\{[^}]+\}/g) ?? [];
    for (const line of proxyPassLines) {
      const directLoopback = line.match(/(127\.0\.0\.1|localhost)/);
      if (directLoopback) continue;
      // 否则必须指向一个 upstream block
      const refMatch = line.match(/proxy_pass\s+https?:\/\/(\S+);/);
      expect(refMatch).not.toBeNull();
      const upstreamName = refMatch![1].trim();
      const upstreamDef = upstreamBlocks.find((b) => b.startsWith(`upstream ${upstreamName}`));
      expect(upstreamDef).toBeDefined();
      expect(upstreamDef).toMatch(/(127\.0\.0\.1|localhost)/);
    }
  });

  it('5. expose docs notes ops to run nginx -t after deploy', () => {
    content = readFileSync(NGINX_CONF_PATH, 'utf8');
    expect(content).toMatch(/nginx -t/);
  });
});
