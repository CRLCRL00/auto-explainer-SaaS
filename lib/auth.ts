import { timingSafeEqual } from 'crypto';

export interface BasicAuthConfig {
  user: string;
  pass: string;
}

// HTTP authentication scheme 大小写不敏感（RFC 7235 §2.1）。
// Basic Auth token 用 **第一个** colon 分隔 user/pass — 密码可包含冒号。
function decodeBasic(headerValue: string): { user: string; pass: string } | null {
  const match = /^([A-Za-z0-9]+)\s+(.+)$/.exec(headerValue.trim());
  if (!match) return null;
  const [, scheme, token] = match;
  if (scheme.toLowerCase() !== 'basic') return null;

  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx < 0) return null;
  return { user: decoded.slice(0, colonIdx), pass: decoded.slice(colonIdx + 1) };
}

export function createBasicAuthMiddleware(cfg: BasicAuthConfig) {
  // UTF-8 Buffer 长度先比对，避免 Unicode 凭据绕过字符串长度检查后崩在 timingSafeEqual
  const expectedUser = Buffer.from(cfg.user, 'utf8');
  const expectedPass = Buffer.from(cfg.pass, 'utf8');

  return (req: Request): string | null => {
    const header = req.headers.get('authorization');
    if (!header) return null;

    const parsed = decodeBasic(header);
    if (!parsed) return null;

    const actualUser = Buffer.from(parsed.user, 'utf8');
    const actualPass = Buffer.from(parsed.pass, 'utf8');

    // Buffer 长度优先（避免 timingSafeEqual 抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH）
    if (actualUser.length !== expectedUser.length) return null;
    if (actualPass.length !== expectedPass.length) return null;

    const userOk = timingSafeEqual(actualUser, expectedUser);
    const passOk = timingSafeEqual(actualPass, expectedPass);
    return userOk && passOk ? cfg.user : null;
  };
}

export function unauthorizedResponse(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="auto-explainer"' },
  });
}
