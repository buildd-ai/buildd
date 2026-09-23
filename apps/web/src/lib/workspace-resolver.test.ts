import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

// resolveWorkspace resolves a UUID / repo / name ONLY among the workspaces the
// caller can reach (its teams, plus explicitly linked workspaces). A mocked db
// hides predicates, so every captured WHERE is rendered through PgDialect and
// the scope is asserted on the SQL itself.

const captured: unknown[] = [];
let nextRows: Array<Record<string, unknown> | undefined> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: {
        findFirst: (opts: { where: unknown }) => {
          captured.push(opts.where);
          return Promise.resolve(nextRows.shift());
        },
      },
      accountWorkspaces: { findMany: () => Promise.resolve([{ workspaceId: 'ws-linked-to-key' }]) },
    },
  },
}));

mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async (userId: string) => (userId === 'user-1' ? ['team-of-user'] : []),
}));

const { resolveWorkspace } = await import('./workspace-resolver');

const render = (w: unknown) => new PgDialect().sqlToQuery(w as any);

beforeEach(() => {
  captured.length = 0;
  nextRows = [];
});

describe('resolveWorkspace — scoped to the caller', () => {
  it('filters a UUID lookup by the caller team ids', async () => {
    nextRows = [{ id: '11111111-1111-4111-8111-111111111111', teamId: 'team-a' }];
    await resolveWorkspace('11111111-1111-4111-8111-111111111111', { teamIds: ['team-a'] });
    const q = render(captured[0]);
    expect(q.sql).toContain('"team_id" in');
    expect(q.params).toContain('team-a');
  });

  it('filters every name/repo lookup by the caller scope', async () => {
    nextRows = [undefined, undefined];
    const ws = await resolveWorkspace('some-project', { teamIds: ['team-a'], workspaceIds: ['ws-linked'] });
    expect(ws).toBeNull();
    expect(captured.length).toBe(2);
    for (const w of captured) {
      const q = render(w);
      expect(q.sql).toContain('"team_id" in');
      expect(q.params).toContain('team-a');
      expect(q.params).toContain('ws-linked');
    }
  });

  it('resolves nothing — without querying — for an empty scope', async () => {
    const ws = await resolveWorkspace('some-project', { teamIds: [] });
    expect(ws).toBeNull();
    expect(captured.length).toBe(0);
  });

  it('an API account reaches its own team plus its explicit links', async () => {
    nextRows = [undefined];
    await resolveWorkspace('11111111-1111-4111-8111-111111111111', { account: { id: 'acct-1', teamId: 'team-of-key' } });
    const q = render(captured[0]);
    expect(q.params).toContain('team-of-key');
    expect(q.params).toContain('ws-linked-to-key');
  });

  it('a session user reaches the teams they belong to', async () => {
    nextRows = [undefined];
    await resolveWorkspace('11111111-1111-4111-8111-111111111111', { userId: 'user-1' });
    const q = render(captured[0]);
    expect(q.params).toContain('team-of-user');
  });
});
