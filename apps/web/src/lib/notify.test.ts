import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

/**
 * notifyTeamOf: a tenant alert raised about a workspace, mission or task is
 * delivered on the channel of the team that owns it, and nowhere else.
 */

const workspaceTeams: Record<string, string> = { 'ws-a': 'team-a', 'ws-b': 'team-b' };
const missionTeams: Record<string, string> = { 'm-a': 'team-a' };
const taskWorkspaces: Record<string, string> = { 't-b': 'ws-b' };
const channels: Record<string, { appToken: string; userKey: string }> = {
  'team-a': { appToken: 'app-a', userKey: 'user-a' },
  'team-b': { appToken: 'app-b', userKey: 'user-b' },
};

let lastWhere: { table: string; key: string } | null = null;

function keyFrom(where: unknown): string {
  // Tests pass the predicate builder output straight through: see mock of drizzle below.
  return (where as { value: string }).value;
}

mock.module('drizzle-orm', () => ({
  eq: (_col: unknown, value: string) => ({ value }),
  and: (...parts: Array<{ value?: string }>) => ({ value: parts.find(p => p?.value)?.value }),
  isNull: () => ({}),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: async ({ where }: { where: unknown }) => {
          const id = keyFrom(where);
          lastWhere = { table: 'workspaces', key: id };
          return workspaceTeams[id] ? { teamId: workspaceTeams[id] } : undefined;
        },
      },
      missions: {
        findFirst: async ({ where }: { where: unknown }) => {
          const id = keyFrom(where);
          return missionTeams[id] ? { teamId: missionTeams[id] } : undefined;
        },
      },
      tasks: {
        findFirst: async ({ where }: { where: unknown }) => {
          const id = keyFrom(where);
          return taskWorkspaces[id] ? { workspaceId: taskWorkspaces[id] } : undefined;
        },
      },
      secrets: {
        findMany: async ({ where }: { where: unknown }) => {
          const teamId = keyFrom(where);
          const ch = channels[teamId];
          return ch ? [{ purpose: 'pushover', encryptedValue: JSON.stringify(ch) }] : [];
        },
      },
      notificationPreferences: { findFirst: async () => undefined },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  secrets: { teamId: 'teamId', accountId: 'accountId', workspaceId: 'workspaceId', userId: 'userId' },
  notificationPreferences: { teamId: 'teamId' },
  workspaces: { id: 'id' },
  missions: { id: 'id' },
  tasks: { id: 'id' },
}));

mock.module('@buildd/core/secrets', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
}));

// The escalation gate's push check (lib/escalation-notify.ts): PR 9 is Buildd's.
const pageChecks: Array<{ workspaceId: string; prNumber: number }> = [];
mock.module('./escalation-notify', () => ({
  loadEscalationVerdicts: async (s: { workspaceId: string; prNumber: number }) => { pageChecks.push(s); return [{ owner: s.prNumber === 9 ? 'buildd' : 'person', reason: 'x' }]; },
  verdictsAllowPage: (v: Array<{ owner: string }>) => !v.every(x => x.owner === 'buildd'),
  planEscalationPage: () => ({ action: 'send' }),
}));

const { notifyTeamOf } = await import('./notify');

const sent: Array<{ token: string; user: string; title: string; priority: number }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent.length = 0;
  pageChecks.length = 0;
  lastWhere = null;
  process.env.PUSHOVER_USER = 'operator-user';
  process.env.PUSHOVER_TOKEN = 'operator-app';
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return new Response('{}');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PUSHOVER_USER;
  delete process.env.PUSHOVER_TOKEN;
});

describe('notifyTeamOf', () => {
  it('delivers a workspace alert on that workspace team channel, never the operator app', async () => {
    await notifyTeamOf({ workspaceId: 'ws-a' }, 'needsAttention', { title: 'PR waiting', message: 'm' });
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe('app-a');
    expect(sent[0].user).toBe('user-a');
    expect(lastWhere).toEqual({ table: 'workspaces', key: 'ws-a' });
  });

  it('resolves a mission to its team', async () => {
    await notifyTeamOf({ missionId: 'm-a' }, 'needsAttention', { title: 't', message: 'm' });
    expect(sent.map(s => s.token)).toEqual(['app-a']);
  });

  it('resolves a task through its workspace', async () => {
    await notifyTeamOf({ taskId: 't-b' }, 'needsAttention', { title: 't', message: 'm' });
    expect(sent.map(s => s.token)).toEqual(['app-b']);
  });

  it('uses an explicit teamId without a lookup', async () => {
    await notifyTeamOf({ teamId: 'team-b', workspaceId: 'ws-a' }, 'needsAttention', { title: 't', message: 'm' });
    expect(sent.map(s => s.token)).toEqual(['app-b']);
    expect(lastWhere).toBeNull();
  });

  it('sends nothing when the owner cannot be resolved (no fallback to the operator app)', async () => {
    await notifyTeamOf({ workspaceId: 'ws-missing' }, 'needsAttention', { title: 't', message: 'm' });
    await notifyTeamOf({}, 'needsAttention', { title: 't', message: 'm' });
    expect(sent).toEqual([]);
  });

  it('keeps the payload priority', async () => {
    await notifyTeamOf({ workspaceId: 'ws-a' }, 'needsAttention', { title: 't', message: 'm', priority: 1 });
    expect(sent[0].priority).toBe(1);
  });

  it('a PR escalation Buildd owns does not page; one a person owns does', async () => {
    await notifyTeamOf({ workspaceId: 'ws-a', prNumber: 9 }, 'needsAttention', { title: 'PR #9 escalated', message: 'm' });
    expect(sent).toEqual([]);
    await notifyTeamOf({ workspaceId: 'ws-a', prNumber: 10 }, 'needsAttention', { title: 'PR #10 escalated', message: 'm' });
    expect(sent.map(s => s.token)).toEqual(['app-a']);
  });

  it('a task-addressed PR escalation is checked against the task workspace', async () => {
    await notifyTeamOf({ taskId: 't-b', prNumber: 9 }, 'needsAttention', { title: 't', message: 'm' });
    expect(pageChecks).toEqual([{ workspaceId: 'ws-b', prNumber: 9 }]);
    expect(sent).toEqual([]);
  });

  it('an alert with no PR number is not gated', async () => {
    await notifyTeamOf({ workspaceId: 'ws-a' }, 'needsAttention', { title: 't', message: 'm' });
    expect(pageChecks).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});
