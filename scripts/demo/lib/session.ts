/**
 * Mint an Auth.js session cookie for a seeded demo user, signed with the
 * throwaway DEMO_AUTH_SECRET that serve.sh gives the local server. The cookie is
 * only valid against that local stack.
 */
import { createRequire } from 'module';
import { resolve } from 'path';

const DEMO_AUTH_SECRET = process.env.DEMO_AUTH_SECRET ?? 'buildd-demo-local-auth-secret-not-real-0000';
export const SESSION_COOKIE = 'authjs.session-token';

// next-auth lives in apps/web's dependency tree, not the repo root's.
const requireFromWeb = createRequire(resolve(import.meta.dir, '../../../apps/web/package.json'));

export async function mintSessionToken(user: { id: string; email: string; name?: string | null }): Promise<string> {
  const { encode } = requireFromWeb('next-auth/jwt') as typeof import('next-auth/jwt');
  return encode({
    secret: DEMO_AUTH_SECRET,
    salt: SESSION_COOKIE,
    maxAge: 60 * 60 * 24,
    token: { sub: user.id, userId: user.id, email: user.email, name: user.name ?? undefined },
  });
}
