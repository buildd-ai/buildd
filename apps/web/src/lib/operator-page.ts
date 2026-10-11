import { notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth-helpers';
import { isPlatformOperator } from '@/lib/platform-operator';

/**
 * The first line of a page that moved to the private admin app: the platform
 * owner still reaches it here; everyone else gets a 404, as if the page did
 * not exist. Returns the signed-in operator.
 */
export async function requirePlatformOperator() {
  const user = await getCurrentUser();
  if (!user || !isPlatformOperator(user)) notFound();
  return user;
}
