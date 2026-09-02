import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const findFirst = {
  teams: mock(() => Promise.resolve(null as any)),
  workspaces: mock(() => Promise.resolve(null as any)),
  users: mock(() => Promise.resolve(null as any)),
};

let ownedTeamRows: Array<{ teamId: string }> = [];
let seededRows: Array<{ id: string }> = [];
const capturedUserUpdate: any[] = [];
const capturedTeamUpdate: any[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teams: { findFirst: (...a: any[]) => findFirst.teams(...(a as [])) },
      workspaces: { findFirst: (...a: any[]) => findFirst.workspaces(...(a as [])) },
      users: { findFirst: (...a: any[]) => findFirst.users(...(a as [])) },
    },
    select: (_cols: any) => ({
      from: (_t: any) => ({
        where: (_c: any) => Promise.resolve(ownedTeamRows),
      }),
    }),
    update: (table: any) => ({
      set: (vals: any) => {
        if (table === 'teams') capturedTeamUpdate.push(vals);
        if (table === 'users') capturedUserUpdate.push(vals);
        return {
          where: (_c: any) => {
            const chain: any = Promise.resolve(undefined);
            chain.returning = () => Promise.resolve(table === 'teams' ? seededRows : []);
            return chain;
          },
        };
      },
    }),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  isNull: (a: any) => ({ type: 'isNull', a }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
}));

mock.module('@buildd/core/db/schema', () => ({
  teams: 'teams',
  users: 'users',
  workspaces: 'workspaces',
  teamMembers: 'teamMembers',
}));

import {
  getTeamTimezone,
  getWorkspaceTimezone,
  getViewerTimezone,
  recordUserTimezone,
} from './team-timezone';

beforeEach(() => {
  findFirst.teams.mockReset();
  findFirst.workspaces.mockReset();
  findFirst.users.mockReset();
  findFirst.teams.mockResolvedValue(null);
  findFirst.workspaces.mockResolvedValue(null);
  findFirst.users.mockResolvedValue(null);
  ownedTeamRows = [];
  seededRows = [];
  capturedUserUpdate.length = 0;
  capturedTeamUpdate.length = 0;
});

describe('getTeamTimezone', () => {
  it('returns the team zone when set', async () => {
    findFirst.teams.mockResolvedValue({ timezone: 'America/New_York' });
    expect(await getTeamTimezone('team-1')).toBe('America/New_York');
  });

  it('falls back to UTC when the team has no zone', async () => {
    findFirst.teams.mockResolvedValue({ timezone: null });
    expect(await getTeamTimezone('team-1')).toBe('UTC');
  });

  it('falls back to UTC when the team row is missing', async () => {
    expect(await getTeamTimezone('nope')).toBe('UTC');
  });

  it('falls back to UTC when a stored zone is no longer valid', async () => {
    findFirst.teams.mockResolvedValue({ timezone: 'Mars/Olympus' });
    expect(await getTeamTimezone('team-1')).toBe('UTC');
  });
});

describe('getWorkspaceTimezone', () => {
  it('resolves through the workspace to its owning team', async () => {
    findFirst.workspaces.mockResolvedValue({ teamId: 'team-9' });
    findFirst.teams.mockResolvedValue({ timezone: 'Europe/Berlin' });
    expect(await getWorkspaceTimezone('ws-1')).toBe('Europe/Berlin');
  });

  it('returns UTC for a null/absent workspace without hitting the teams table', async () => {
    expect(await getWorkspaceTimezone(null)).toBe('UTC');
    expect(findFirst.teams).not.toHaveBeenCalled();
  });

  it('never throws when the lookup fails — the caller is a best-effort renderer', async () => {
    findFirst.workspaces.mockImplementation(() => Promise.reject(new Error('db down')));
    expect(await getWorkspaceTimezone('ws-1')).toBe('UTC');
  });
});

describe('getViewerTimezone', () => {
  it('prefers the viewer own zone over the team zone', async () => {
    findFirst.users.mockResolvedValue({ timezone: 'Asia/Tokyo' });
    findFirst.teams.mockResolvedValue({ timezone: 'America/New_York' });
    expect(await getViewerTimezone('user-1', 'team-1')).toBe('Asia/Tokyo');
  });

  it('falls back to the team zone when the viewer has none', async () => {
    findFirst.users.mockResolvedValue({ timezone: null });
    findFirst.teams.mockResolvedValue({ timezone: 'America/New_York' });
    expect(await getViewerTimezone('user-1', 'team-1')).toBe('America/New_York');
  });

  it('falls back to UTC with no viewer zone and no team', async () => {
    findFirst.users.mockResolvedValue({ timezone: null });
    expect(await getViewerTimezone('user-1')).toBe('UTC');
  });
});

describe('recordUserTimezone', () => {
  it('rejects an invalid zone without writing anything', async () => {
    expect(await recordUserTimezone('user-1', 'Mars/Olympus')).toBeNull();
    expect(capturedUserUpdate).toHaveLength(0);
    expect(capturedTeamUpdate).toHaveLength(0);
  });

  it('stores the zone on the user', async () => {
    const res = await recordUserTimezone('user-1', 'America/Chicago');
    expect(res?.timezone).toBe('America/Chicago');
    expect(capturedUserUpdate[0].timezone).toBe('America/Chicago');
  });

  it('seeds the zone onto teams the user owns that have none', async () => {
    ownedTeamRows = [{ teamId: 'team-1' }, { teamId: 'team-2' }];
    seededRows = [{ id: 'team-1' }];
    const res = await recordUserTimezone('user-1', 'America/Chicago');
    expect(res?.seededTeamIds).toEqual(['team-1']);
    expect(capturedTeamUpdate[0].timezone).toBe('America/Chicago');
  });

  it('does not touch teams when the user owns none', async () => {
    ownedTeamRows = [];
    const res = await recordUserTimezone('user-1', 'America/Chicago');
    expect(res?.seededTeamIds).toEqual([]);
    expect(capturedTeamUpdate).toHaveLength(0);
  });
});
