import { cache } from 'react';
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { users } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  /** Zone detected from this user's browser; null until `<TimezoneSync />` reports one. */
  timezone: string | null;
};

/**
 * Get the current authenticated user from the database.
 * Returns null if not authenticated.
 *
 * Cached per-request via React cache() so layout + page share the same result —
 * this is imported by the protected layout and by every page it renders, and
 * each call is otherwise a fresh `users` round trip. Nothing in the request
 * lifecycle writes to the session user before reading it back (the one
 * `users` write, PUT /api/me/timezone, happens after its only read), so the
 * value is per-request idempotent.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Dev mode - allow masquerading as real user via DEV_USER_EMAIL env var
  if (process.env.NODE_ENV === 'development') {
    // If DEV_USER_EMAIL is set, authenticate as that real user from the database
    if (process.env.DEV_USER_EMAIL) {
      const realUser = await db.query.users.findFirst({
        where: eq(users.email, process.env.DEV_USER_EMAIL),
      });
      if (realUser) {
        return {
          id: realUser.id,

          email: realUser.email,
          name: realUser.name,
          image: realUser.image,
          timezone: realUser.timezone,
        };
      }
      console.warn(`[auth-helpers] DEV_USER_EMAIL=${process.env.DEV_USER_EMAIL} not found in database, falling back to mock user`);
    }

    // Fallback to mock user
    return {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'dev@localhost',
      name: 'Dev User',
      image: null,
      timezone: null,
    };
  }

  let session;
  try {
    session = await auth();
  } catch {
    return null;
  }
  if (!session?.user?.id) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    timezone: user.timezone,
  };
});

/** The API key account a request authenticated as — its own identity, never a user's. */
export type ApiKeyPrincipal = {
  id: string;
  name: string;
  teamId: string;
  level: 'trigger' | 'worker' | 'admin';
};

export type RequestPrincipal =
  | { kind: 'session'; user: CurrentUser }
  | { kind: 'api_key'; account: ApiKeyPrincipal };

/**
 * Resolve who is making a request: a signed-in user (session), or an API key
 * account. An API key resolves to its own account and level only — it does not
 * act as any user of its team, so user-scoped checks (team role, membership)
 * never apply to it. Routes decide what a key may do from `account.teamId` and
 * `account.level`.
 */
export async function getRequestPrincipal(req: NextRequest): Promise<RequestPrincipal | null> {
  const sessionUser = await getCurrentUser();
  if (sessionUser) return { kind: 'session', user: sessionUser };

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (!account) return null;

  return {
    kind: 'api_key',
    account: {
      id: account.id,
      name: account.name,
      teamId: account.teamId,
      level: account.level as ApiKeyPrincipal['level'],
    },
  };
}

export const SESSION_REQUIRED_MESSAGE =
  'Team administration requires a signed-in session; API keys cannot perform this action.';

/**
 * For session-only operations (team creation/deletion, membership and role
 * changes, invitations, ownership). Returns the signed-in user, or a response
 * to send: 401 when unauthenticated, 403 when the caller is an API key.
 */
export async function requireSessionUser(
  req: NextRequest,
): Promise<{ user: CurrentUser; response?: undefined } | { user?: undefined; response: Response }> {
  const principal = await getRequestPrincipal(req);
  if (!principal) {
    return { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (principal.kind !== 'session') {
    return { response: Response.json({ error: SESSION_REQUIRED_MESSAGE }, { status: 403 }) };
  }
  return { user: principal.user };
}

/**
 * Require authentication - redirects to sign in if not authenticated.
 * Use this in server components.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Unauthorized');
  }
  return user;
}
