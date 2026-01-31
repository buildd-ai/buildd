import { auth } from '@/auth';
import { db } from '@buildd/core/db';
import { users } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

export type CurrentUser = {
  id: string;
  googleId: string;
  email: string;
  name: string | null;
  image: string | null;
};

/**
 * Get the current authenticated user from the database.
 * Returns null if not authenticated.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  // Dev mode returns mock user
  if (process.env.NODE_ENV === 'development') {
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
