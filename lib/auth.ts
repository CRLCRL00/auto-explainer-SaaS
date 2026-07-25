import { timingSafeEqual } from 'crypto';

export interface BasicAuthConfig {
  user: string;
  pass: string;
}

export function createBasicAuthMiddleware(cfg: BasicAuthConfig) {
  return (req: Request): string | null => {
    const header = req.headers.get('authorization');
    if (!header?.startsWith('Basic ')) return null;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const [user, pass] = decoded.split(':');
    if (!user || !pass) return null;
    if (user.length !== cfg.user.length || pass.length !== cfg.pass.length) return null;
    const userOk = timingSafeEqual(Buffer.from(user), Buffer.from(cfg.user));
    const passOk = timingSafeEqual(Buffer.from(pass), Buffer.from(cfg.pass));
    return userOk && passOk ? user : null;
  };
}

export function unauthorizedResponse(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="auto-explainer"' },
  });
}
