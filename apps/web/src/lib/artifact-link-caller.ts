import type { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth-helpers';
import type { LinkCaller } from '@/lib/artifact-links';

/**
 * The caller of an artifact-link route: the account the route authenticated
 * (an API key or a per-task token, whose `taskScope` the links library
 * enforces), else the dashboard session.
 */
export async function linkCaller(
  account: Extract<LinkCaller, { kind: 'account' }>['account'] | null,
  taskScope: { workspaceId: string } | null,
): Promise<LinkCaller | null> {
  if (account) return { kind: 'account', account, taskScope };
  const user = await getCurrentUser();
  return user ? { kind: 'user', userId: user.id } : null;
}

export const bearerOf = (req: NextRequest): string | null => req.headers.get('authorization')?.replace('Bearer ', '') || null;
