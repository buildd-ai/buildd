import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { users } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

export type CurrentUser = {
  id: string;
  googleId: string | null;
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
          googleId: realUser.googleId,
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
      googleId: 'dev-google-id',
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
    googleId: user.googleId,
    email: user.email,
    name: user.name,
    image: user.image,
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
