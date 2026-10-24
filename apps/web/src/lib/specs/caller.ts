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

/**
 * The caller of a confirm endpoint (a spec approval, an inbox Approve, a
 * retire or restore): a person's dashboard session and nothing else (Living
 * Spec b7fc9316 R-4, R-13). A request carrying any Authorization header is
 * refused before it is read, whether the bearer is valid or not, so a token in
 * a model's hands never reaches one, even riding along with a browser cookie.
 */
export async function dashboardCaller(req: NextRequest): Promise<{ ok: true; caller: Extract<SpecCaller, { kind: 'user' }> } | { ok: false; status: 401 | 403; error: string }> {
  if (req.headers.get('authorization')) return { ok: false, status: 403, error: 'Confirm it on buildd.dev, signed in, with a click. A session token, API key or agent run cannot.' };
  const user = await getCurrentUser();
  return user ? { ok: true, caller: { kind: 'user', userId: user.id } } : { ok: false, status: 401, error: 'Unauthorized' };
}
