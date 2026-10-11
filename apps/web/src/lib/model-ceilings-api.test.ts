import { describe, it, expect } from 'bun:test';
import type { MemberTierCeilings, TeamTierCeilingPolicy } from '@buildd/shared';
import {
  handleGetCeilings,
  handlePutMemberCeilings,
  handlePutOwnCeilings,
  handlePutTeamCeilings,
  type CeilingsApiDeps,
} from './model-ceilings-api';
import type { TeamScopeCaller } from './permission-registry';

const TEAM = 'team-1';
const ADMIN = { kind: 'user', userId: 'admin-1' } as const;
const MEMBER = { kind: 'user', userId: 'member-1' } as const;
const OUTSIDER = { kind: 'user', userId: 'outsider' } as const;
const KEY = { kind: 'account', accountId: 'acct-1', teamId: TEAM, level: 'admin' } as const;
const FOREIGN_KEY = { kind: 'account', accountId: 'acct-2', teamId: 'team-2', level: 'admin' } as const;

function fake(caller: TeamScopeCaller | null) {
  let policy: TeamTierCeilingPolicy | null = null;
  const members: Record<string, MemberTierCeilings> = {};
  const writes: any[] = [];
  const deps: CeilingsApiDeps = {
    caller: async () => caller,
    isMember: async (u) => u === 'admin-1' || u === 'member-1',
    canManage: async (c) => (c.kind === 'user' ? c.userId === 'admin-1' : c.level === 'admin'),
    loadPolicy: async () => policy,
    loadMember: async (_t, u) => members[u] ?? null,
    listMembers: async () => members,
    writeTeam: async (a) => { writes.push(a); policy = { ...(policy ?? {}), ...a.patch }; return policy!; },
    writeMember: async (a) => {
      writes.push(a);
      if (!['admin-1', 'member-1'].includes(a.userId)) throw Object.assign(new Error('not a member of this team'), { status: 404 });
      members[a.userId] = { ...(members[a.userId] ?? {}), [a.layer]: a.caps };
      return members[a.userId];
    },
  };
  return { deps, writes, setPolicy: (p: TeamTierCeilingPolicy) => { policy = p; }, members };
}

describe('model-tier ceilings API', () => {
  it('an admin disables premium-plus team-wide; a member cannot', async () => {
    const admin = fake(ADMIN);
    const ok = await handlePutTeamCeilings(TEAM, { team: { all: 'premium' } }, admin.deps);
    expect(ok.status).toBe(200);
    expect(admin.writes[0]).toMatchObject({ teamId: TEAM, actorUserId: 'admin-1', patch: { team: { all: 'premium' } } });

    const member = fake(MEMBER);
    expect((await handlePutTeamCeilings(TEAM, { team: { all: 'budget' } }, member.deps)).status).toBe(403);
    expect(member.writes).toHaveLength(0);
  });

  it('rejects unknown tiers, keys and fields instead of saving "no ceiling"', async () => {
    const { deps, writes } = fake(ADMIN);
    expect((await handlePutTeamCeilings(TEAM, { team: { all: 'premum' } }, deps)).status).toBe(400);
    expect((await handlePutTeamCeilings(TEAM, { team: { coding: 'premium' } }, deps)).status).toBe(400);
    expect((await handlePutTeamCeilings(TEAM, { teamCap: 'premium' }, deps)).status).toBe(400);
    expect((await handlePutTeamCeilings(TEAM, { overCapAuto: 'escalate' }, deps)).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('an admin sets a member cap; the member cannot lift it by writing their own', async () => {
    const admin = fake(ADMIN);
    expect((await handlePutMemberCeilings(TEAM, 'member-1', { ceilings: { agent: 'standard' } }, admin.deps)).status).toBe(200);

    // Same store, now as the member: they can only write `self`.
    const asMember: CeilingsApiDeps = { ...admin.deps, caller: async () => MEMBER };
    expect((await handlePutMemberCeilings(TEAM, 'member-1', { ceilings: {} }, asMember)).status).toBe(403);
    expect((await handlePutOwnCeilings(TEAM, { ceilings: { all: 'premium-plus' } }, asMember)).status).toBe(200);
    expect(admin.writes.at(-1)).toMatchObject({ userId: 'member-1', layer: 'self', actorUserId: 'member-1' });

    const view = await (await handleGetCeilings(TEAM, null, asMember)).json();
    expect(view.effective.agent).toMatchObject({ max: 'standard', binding: { source: 'member_admin' } });
    expect(view.me.admin).toEqual({ agent: 'standard' });
    expect(view.members).toBeUndefined();
  });

  it('a member sets a personal maximum lower than the team policy', async () => {
    const { deps, setPolicy } = fake(MEMBER);
    setPolicy({ team: { all: 'premium' } });
    await handlePutOwnCeilings(TEAM, { ceilings: { chat: 'budget' } }, deps);
    const view = await (await handleGetCeilings(TEAM, null, deps)).json();
    expect(view.effective.chat).toMatchObject({ max: 'budget', binding: { source: 'member_self' } });
    expect(view.effective.agent).toMatchObject({ max: 'premium', binding: { source: 'team' } });
    expect(view.effective.chat.explanation).toContain('your personal maximum');
  });

  it('an API key has no personal maximum and is told so; it sees team layers only', async () => {
    const { deps, setPolicy } = fake(KEY);
    setPolicy({ team: { all: 'premium' } });
    expect((await handlePutOwnCeilings(TEAM, { ceilings: { all: 'budget' } }, deps)).status).toBe(403);
    const view = await (await handleGetCeilings(TEAM, null, deps)).json();
    expect(view.me).toBeNull();
    expect(view.effective.agent.identified).toBe(false);
  });

  it('tenant isolation: outsiders and other teams\' keys get 404, a non-member target 404s', async () => {
    expect((await handleGetCeilings(TEAM, null, fake(OUTSIDER).deps)).status).toBe(404);
    expect((await handlePutTeamCeilings(TEAM, { team: { all: 'budget' } }, fake(FOREIGN_KEY).deps)).status).toBe(404);
    expect((await handleGetCeilings(TEAM, null, fake(null).deps)).status).toBe(401);
    expect((await handlePutMemberCeilings(TEAM, 'stranger', { ceilings: { all: 'budget' } }, fake(ADMIN).deps)).status).toBe(404);
  });

  it('a workspace cap from another team is refused by the store (400 passes through)', async () => {
    const { deps } = fake(ADMIN);
    const refusing: CeilingsApiDeps = { ...deps, writeTeam: async () => { throw Object.assign(new Error('workspace ws-x is not in this team'), { status: 400 }); } };
    const res = await handlePutTeamCeilings(TEAM, { workspaces: { 'ws-x': { all: 'budget' } } }, refusing);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('not in this team');
  });
});
