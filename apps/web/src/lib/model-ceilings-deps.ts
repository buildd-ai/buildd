/** DB-backed deps for the model-tier ceilings API (lib/model-ceilings-api.ts). */
import type { NextRequest } from 'next/server';
import {
  listMemberTierCeilings,
  writeMemberTierCeilings,
  writeTeamTierCeilings,
} from '@buildd/core/model-tier-ceiling-store';
import { db } from '@buildd/core/db';
import { teams, teamMembers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { getRequestPrincipal } from './auth-helpers';
import { can } from './permissions';
import { getUserTeamRole } from './team-access';
import type { CeilingsApiDeps } from './model-ceilings-api';

export function ceilingsDeps(req: NextRequest): CeilingsApiDeps {
  return {
    caller: async () => {
      const p = await getRequestPrincipal(req);
      if (!p) return null;
      return p.kind === 'session'
        ? { kind: 'user', userId: p.user.id }
        : { kind: 'account', accountId: p.account.id, teamId: p.account.teamId, level: p.account.level };
    },
    isMember: async (userId, teamId) => (await getUserTeamRole(userId, teamId)) !== null,
    canManage: (caller, teamId) => can(caller, 'manage_model_tiers', teamId),
    loadPolicy: async (teamId) => (await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { modelTierCeilings: true } }))?.modelTierCeilings ?? null,
    loadMember: async (teamId, userId) => (await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
      columns: { modelTierCeilings: true },
    }))?.modelTierCeilings ?? null,
    listMembers: listMemberTierCeilings,
    writeTeam: writeTeamTierCeilings,
    writeMember: writeMemberTierCeilings,
  };
}

