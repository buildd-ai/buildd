import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every query-builder call returns the same chainable; awaiting it yields the next scripted result.
const script: unknown[][] = [];
const inserted: unknown[] = [];
const chain: any = new Proxy(function () {}, {
  get(_t, prop) {
    if (prop === 'then') return (res: (v: unknown) => void) => res(script.shift() ?? []);
    if (prop === 'values') return (v: unknown) => { inserted.push(v); return chain; };
    return () => chain;
  },
  apply: () => chain,
});
vi.mock('@buildd/core/db', () => ({ db: { select: () => chain, insert: () => chain, update: () => chain } }));
vi.mock('./caller-cache', () => ({ clearCallerCache: vi.fn(), callerDep: { workspaceSchedules: (id: string) => id } }));

import { noteScheduleRefusal } from './schedule-move';

const HOME = 'home', OTHER = 'other', SCHEDULE = 's1';
const account = { teamId: 'team', taskScope: { taskId: 't1', workspaceId: HOME } };

beforeEach(() => { script.length = 0; inserted.length = 0; });

/** Reads in order: task, schedule, target workspace, [insert refusal], last keep, count, [open proposal, refusals, replace, insert]. */
const reads = (count: number, extra: unknown[][] = []) => [
  [{ scheduleId: SCHEDULE }], [{ id: SCHEDULE, workspaceId: HOME }], [{ teamId: 'team' }],
  [], // refusal insert
  [], // last keep
  [{ n: count }],
  ...extra,
];

describe('noteScheduleRefusal (I-29)', () => {
  it('the first refusal on a workspace proposes nothing', async () => {
    script.push(...reads(1));
    await noteScheduleRefusal(account, OTHER, 'analytics:read');
    expect(inserted.filter((v: any) => v.status === 'open')).toHaveLength(0);
  });

  it('a second refused run proposes the move itself, as an auto proposal a person must accept', async () => {
    script.push(...reads(2, [
      [], // no open proposal
      [{ taskId: 't1', capability: 'analytics:read', createdAt: new Date() }, { taskId: 't0', capability: 'analytics:read', createdAt: new Date() }],
      [], // replace older open
      [{ id: 'p1' }], // insert returning
    ]));
    await noteScheduleRefusal(account, OTHER, 'analytics:read');
    const proposal: any = inserted.find((v: any) => v.status === 'open');
    expect(proposal).toMatchObject({ scheduleId: SCHEDULE, fromWorkspaceId: HOME, toWorkspaceId: OTHER, origin: 'auto', status: 'open' });
    expect(proposal.evidence.refusals).toHaveLength(2);
  });

  it('does not repeat a proposal that is already open for that workspace', async () => {
    script.push(...reads(3, [[{ id: 'p1', toWorkspaceId: OTHER, status: 'open' }]]));
    await noteScheduleRefusal(account, OTHER, 'analytics:read');
    expect(inserted.filter((v: any) => v.status === 'open')).toHaveLength(0);
  });

  it('ignores a task no schedule spawned, a refusal in its own workspace, and another team', async () => {
    script.push([{ scheduleId: null }]);
    await noteScheduleRefusal(account, OTHER, 'analytics:read');
    await noteScheduleRefusal(account, HOME, 'analytics:read');
    script.length = 0;
    script.push([{ scheduleId: SCHEDULE }], [{ id: SCHEDULE, workspaceId: HOME }], [{ teamId: 'team-2' }]);
    await noteScheduleRefusal(account, OTHER, 'analytics:read');
    expect(inserted).toHaveLength(0);
  });

  it('never throws', async () => {
    script.length = 0;
    const bad: any = { teamId: 'team', get taskScope() { throw new Error('boom'); } };
    await expect(noteScheduleRefusal(bad, OTHER, 'tasks:create')).resolves.toBeUndefined();
  });
});
