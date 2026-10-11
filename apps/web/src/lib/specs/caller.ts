import type { NextRequest } from 'next/server';
import { authenticateTaskScopedCaller } from '@/lib/task-token-auth';
import { getCurrentUser } from '@/lib/auth-helpers';
import type { SpecCaller } from './store';

/** An API key or task token (an agent) first, else the dashboard session (a person). */
export async function specCaller(req: NextRequest): Promise<SpecCaller | null> {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '') || null;
  const account = await authenticateTaskScopedCaller(apiKey, req);
  if (account) return { kind: 'account', account };
  const user = await getCurrentUser();
  return user ? { kind: 'user', userId: user.id } : null;
}
