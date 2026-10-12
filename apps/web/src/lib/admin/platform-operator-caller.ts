/**
 * Whether the caller behind a request is a buildd platform operator, whatever
 * credential it came with. The one answer for the platform machinery that
 * routes outside `/api/admin/*` also serve (experiments, the raw decision
 * ledger): a team role never makes anyone an operator.
 *
 *  - A session: the signed-in person is in `BUILDD_OPERATOR_USER_EMAILS`
 *    (platform-operator.ts).
 *  - An OAuth bearer (MCP over OAuth): the person the token was issued to is,
 *    the same list. Its account is the team's shared session account, so the
 *    account id says nothing about who is asking and is not read.
 *  - A `bld_` key, or a per-task token it minted: an admin-level credential
 *    whose account is in `BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS`
 *    (platform-admin.ts). A team admin key is never one.
 *
 * Both lists unset: nobody is an operator (fails closed).
 */
import { eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { users } from '@buildd/core/db/schema';
import { isPlatformOperator } from '@/lib/platform-operator';
import { isPlatformAdminAccount } from '@/lib/platform-admin';

export interface OperatorCandidateAccount {
  id: string;
  level?: string | null;
  /** Set on an OAuth bearer's account: the person the token was issued to. */
  oauthUserId?: string | null;
}

/** Whether the person with this user id is a platform operator. */
export async function isPlatformOperatorUserId(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { email: true } });
  return isPlatformOperator(user);
}

export async function isPlatformOperatorAccount(account: OperatorCandidateAccount): Promise<boolean> {
  if (account.oauthUserId) return isPlatformOperatorUserId(account.oauthUserId);
  return account.level === 'admin' && isPlatformAdminAccount(account.id);
}

/** A presented bearer wins over a cookie session, as every route here authenticates. */
export async function isPlatformOperatorCaller(caller: {
  user?: { email?: string | null } | null;
  account?: OperatorCandidateAccount | null;
}): Promise<boolean> {
  if (caller.account) return isPlatformOperatorAccount(caller.account);
  return isPlatformOperator(caller.user);
}
