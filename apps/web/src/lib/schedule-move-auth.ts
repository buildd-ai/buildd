/**
 * Who is moving a schedule and where they may create tasks: a person reaches a
 * workspace through its team, an API key through its account links
 * (`verifyAccountWorkspaceAccess`). Shared by the schedule PATCH and the
 * proposal decision so both ask the same question (I-26).
 */
import { verifyAccountWorkspaceAccess, verifyWorkspaceAccess } from './team-access';
import type { MoveActor } from './schedule-move';

type Mover =
  | { kind: 'user'; userId: string }
  | { kind: 'account'; accountId: string; account: Parameters<typeof verifyAccountWorkspaceAccess>[0] };

export function moverOf(auth: Mover): { actor: MoveActor; canCreateIn: (workspaceId: string) => Promise<boolean> } {
  if (auth.kind === 'user') {
    return {
      actor: { userId: auth.userId, accountId: null },
      canCreateIn: async (ws) => !!(await verifyWorkspaceAccess(auth.userId, ws)),
    };
  }
  return {
    actor: { userId: null, accountId: auth.accountId },
    canCreateIn: (ws) => verifyAccountWorkspaceAccess(auth.account, ws),
  };
}
