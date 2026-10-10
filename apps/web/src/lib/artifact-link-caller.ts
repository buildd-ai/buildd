import type { NextRequest } from 'next/server';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import type { LinkCaller } from '@/lib/artifact-links';

/** The caller of an artifact-link route: an API key or task token first, else the dashboard session. */
export async function linkCaller(req: NextRequest): Promise<LinkCaller | null> {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (account) return { kind: 'account', account };
  const user = await getCurrentUser();
  return user ? { kind: 'user', userId: user.id } : null;
}
