import { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { teamMembers, users } from '@buildd/core/db/schema';
import { eq, and } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

/**
 * Get the current authenticated user from the database.
 * Returns null if not authenticated.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
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
        };
      }
      console.warn(`[auth-helpers] DEV_USER_EMAIL=${process.env.DEV_USER_EMAIL} not found in database, falling back to mock user`);
    }

    // Fallback to mock user
    return {
      id: 'dev-user-id',
      email: 'dev@localhost',
      name: 'Dev User',
      image: null,
    };
  }

  const session = await auth();
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
  };
}

/**
 * Resolve the current user from a request, supporting both session and API key auth.
 * For API key auth, resolves the user via account → team → owner member.
 */
export async function getUserFromRequest(req: NextRequest): Promise<CurrentUser | null> {
  // Try session auth first
  const sessionUser = await getCurrentUser();
  if (sessionUser) return sessionUser;

  // Try API key auth
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;
  const account = await authenticateApiKey(apiKey);
  if (!account) return null;

  // Find the owner of the account's team
  const ownerMembership = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, account.teamId),
      eq(teamMembers.role, 'owner')
    ),
    with: { user: true },
  });

  if (!ownerMembership?.user) return null;

  const u = ownerMembership.user;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    image: u.image,
  };
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
