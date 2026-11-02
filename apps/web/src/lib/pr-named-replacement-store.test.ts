import { describe, it, expect, beforeEach, mock } from 'bun:test';

/** The named-replacement writer: one guarded UPDATE, a refresh nudge, never a throw. */

let updates: Array<{ set: any; where: any }> = [];
let returned: any[] = [];
let failUpdate = false;
const triggered: Array<[string, string, any]> = [];

mock.module('drizzle-orm', () => ({
  and: (...c: any[]) => ({ and: c }),
  or: (...c: any[]) => ({ or: c }),
  eq: (f: any, v: any) => ({ eq: [f, v] }),
  ne: (f: any, v: any) => ({ ne: [f, v] }),
  isNull: (f: any) => ({ isNull: f }),
}));
mock.module('@buildd/core/db/schema', () => ({
  workers: {
    id: 'workers.id', mergedAt: 'workers.mergedAt', namedReplacementPrNumber: 'workers.namedReplacementPrNumber',
    workspaceId: 'workers.workspaceId', taskId: 'workers.taskId',
  },
}));
mock.module('@/lib/repo-scope', () => ({
  workerOwnsPr: (repo: string, n: number) => ({ workerOwnsPr: [repo, n] }),
  prUrlFor: (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`,
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: async (ch: string, ev: string, data: any) => { triggered.push([ch, ev, data]); },
  channels: { workerActivity: (id: string) => `worker-${id}-activity`, workspaceActivity: (id: string) => `workspace-${id}-activity`, workspace: (id: string) => `workspace-${id}` },
  events: { WORKER_PROGRESS: 'worker:progress' },
}));
mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (set: any) => ({
        where: (where: any) => {
          updates.push({ set, where });
          return { returning: () => (failUpdate ? Promise.reject(new Error('db down')) : Promise.resolve(returned)) };
        },
      }),
    }),
  },
}));

const { recordNamedReplacement, linkNamedReplacement } = await import('./pr-named-replacement-store');

beforeEach(() => {
  updates = [];
  returned = [];
  failUpdate = false;
  triggered.length = 0;
});

describe('recordNamedReplacement', () => {
  it('writes both columns on the unmerged worker owning the closed PR, and nudges its workspace', async () => {
    returned = [{ id: 'w-1', workspaceId: 'ws-1', taskId: 't-1' }];
    const n = await recordNamedReplacement({ repoFullName: 'org/repo', closedPrNumber: 10, replacementPrNumber: 12 });
    expect(n).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({
      namedReplacementPrNumber: 12,
      namedReplacementPrUrl: 'https://github.com/org/repo/pull/12',
    });
    const where = JSON.stringify(updates[0].where);
    expect(where).toContain('"workerOwnsPr":["org/repo",10]');
    expect(where).toContain('"isNull":"workers.mergedAt"');
    // A repeated name (every `edited` event) is a no-op write.
    expect(where).toContain('"ne":["workers.namedReplacementPrNumber",12]');
    expect(triggered).toEqual([['workspace-ws-1-activity', 'worker:progress', { taskId: 't-1' }]]);
  });

  it('a PR naming itself writes nothing', async () => {
    expect(await recordNamedReplacement({ repoFullName: 'org/repo', closedPrNumber: 10, replacementPrNumber: 10 })).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('a non-positive or non-integer number writes nothing', async () => {
    expect(await recordNamedReplacement({ repoFullName: 'org/repo', closedPrNumber: 0, replacementPrNumber: 4 })).toBe(0);
    expect(await recordNamedReplacement({ repoFullName: 'org/repo', closedPrNumber: 3, replacementPrNumber: 1.5 })).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('no matching worker: 0 rows and no nudge', async () => {
    expect(await recordNamedReplacement({ repoFullName: 'org/repo', closedPrNumber: 10, replacementPrNumber: 12 })).toBe(0);
    expect(triggered).toHaveLength(0);
  });

  it('never throws: a failed write logs and returns 0', async () => {
    failUpdate = true;
    expect(await recordNamedReplacement({ repoFullName: 'org/repo', closedPrNumber: 10, replacementPrNumber: 12 })).toBe(0);
  });
});

describe('linkNamedReplacement', () => {
  it('writes the worker by id, only while its PR is unmerged, and nudges', async () => {
    returned = [{ id: 'w-1', workspaceId: 'ws-1', taskId: 't-1' }];
    const res = await linkNamedReplacement({ workerId: 'w-1', repoFullName: 'org/repo', prNumber: 15 });
    expect(res).toEqual({ updated: true, url: 'https://github.com/org/repo/pull/15' });
    const where = JSON.stringify(updates[0].where);
    expect(where).toContain('"eq":["workers.id","w-1"]');
    expect(where).toContain('"isNull":"workers.mergedAt"');
    expect(triggered).toHaveLength(1);
  });

  it('no row (merged in the meantime) is updated: false', async () => {
    const res = await linkNamedReplacement({ workerId: 'w-1', repoFullName: 'org/repo', prNumber: 15 });
    expect(res.updated).toBe(false);
    expect(triggered).toHaveLength(0);
  });
});
