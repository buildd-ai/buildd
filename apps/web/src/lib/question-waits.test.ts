/**
 * Living Spec 1b257609 revision 2 (Agent questions say what each answer sets
 * in motion): AC-1 to AC-8 and AC-10, through the loader with an in-memory
 * store and the card's words in packages/core/question-waits.ts. AC-9 is
 * scripts/question-waits-single-source.test.ts; AC-11 is
 * packages/core/__tests__/question-waits.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { isTerminalTaskStatus } from '@buildd/shared';
import { affectedCriteria, expiryOf, loadQuestionWaits, type DependentRow, type LaneRow, type MissionRow, type QuestionWaitsIo, type SpecRow } from './question-waits';
import { NOTHING_WAITS, partsText, waitsFooter, waitsSummary, type QuestionWaits } from '@buildd/core/question-waits';
import type { DependencyHolder } from './task-dependency-reach';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), C = id(3), D = id(4), H = id(5), M = id(10), M2 = id(11), SPEC = id(20), REV = id(21);
const W1 = 'ws-1', W2 = 'ws-2', WHIDDEN = 'ws-hidden';
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

interface World {
  tasks: Array<DependentRow & { status: string; context?: unknown; pathManifest?: string[] | null; deliveryId?: string | null }>;
  missions: MissionRow[];
  spec?: SpecRow;
  lanes?: LaneRow[];
  worker?: { runner: string; updatedAt: Date; waitingFor: unknown } | null;
  /** Workspaces the viewer cannot see. */
  hidden?: string[];
  workspaceNames?: Record<string, string>;
}

function io(w: World): QuestionWaitsIo {
  const open = (t: World['tasks'][number]) => !isTerminalTaskStatus(t.status);
  return {
    async loadTask(tid) {
      const t = w.tasks.find(x => x.id === tid);
      return t ? { id: t.id, title: t.title, workspaceId: t.workspaceId, teamId: 'team', missionId: t.missionId, deliveryId: t.deliveryId ?? null, context: t.context ?? null, pathManifest: t.pathManifest ?? null } : null;
    },
    async loadLaneWaits() { return w.lanes ?? []; },
    async loadWaitingWorker() { return w.worker ?? null; },
    async loadDependents(ids) { return w.tasks.filter(t => open(t) && t.dependsOn.some(d => ids.includes(d))); },
    async loadStatuses(ids) { return w.tasks.filter(t => ids.includes(t.id)).map(t => ({ id: t.id, status: t.status })); },
    async loadMissions(ids) { return w.missions.filter(m => ids.includes(m.id)); },
    async loadSpec() { return w.spec ?? null; },
    async resolve(scope, ids) {
      const out = new Map<string, DependencyHolder>();
      for (const tid of ids) {
        const t = w.tasks.find(x => x.id === tid)!;
        const hidden = (w.hidden ?? []).includes(t.workspaceId);
        out.set(tid, hidden
          ? { id: tid, hidden: true, title: null, workspaceId: null, workspaceName: null }
          : { id: tid, hidden: false, title: t.title, workspaceId: t.workspaceId, workspaceName: t.workspaceId !== scope.dependentWorkspaceId ? (w.workspaceNames?.[t.workspaceId] ?? null) : null });
      }
      return out;
    },
  };
}

const task = (tid: string, title: string, over: Partial<World['tasks'][number]> = {}): World['tasks'][number] => ({
  id: tid, title, workspaceId: W1, missionId: null, dependsOn: [], inferredDependsOn: [], status: 'pending', ...over,
});

const waitingFor = (options: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'question', prompt: 'Ship it?', options, ...extra });
const askedAt = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000);

const load = (w: World) => loadQuestionWaits({ taskId: A, viewer: { kind: 'member' }, now: new Date(NOW) }, io(w)) as Promise<QuestionWaits>;
const summary = (w: QuestionWaits) => partsText(waitsSummary(w));

const chain = (): World => ({
  tasks: [
    task(A, 'Acceptance tests', { status: 'in_progress', missionId: M }),
    task(B, 'Autostart repair', { dependsOn: [A], missionId: M }),
    task(C, 'Real-machine check', { dependsOn: [B], missionId: M2, workspaceId: W2 }),
  ],
  missions: [
    { id: M, title: 'Checkout rebuild', executor: null, goalCriteria: null },
    { id: M2, title: 'Device lab', executor: null, goalCriteria: null },
  ],
  workspaceNames: { [W2]: 'device-lab' },
  worker: { runner: 'runner-1', updatedAt: askedAt(30), waitingFor: waitingFor([]) },
});

describe('AC-1: declared dependents one and two steps out, named once', () => {
  it('names B, then C, by title, each a link to its task', async () => {
    const w = await load(chain());
    expect(w.waiting.map(t => [t.title, t.depth, t.missionTitle])).toEqual([['Autostart repair', 1, 'Checkout rebuild'], ['Real-machine check', 2, 'Device lab']]);
    expect(w.waiting[1].after).toEqual({ id: B, title: 'Autostart repair' });
    const parts = waitsSummary(w);
    expect(partsText(parts)).toBe('Waits on this: Autostart repair, then Real-machine check.');
    expect(parts.filter(p => p.href).map(p => [p.text, p.href])).toEqual([['Autostart repair', `/app/tasks/${B}`], ['Real-machine check', `/app/tasks/${C}`]]);
    // No other line repeats them.
    expect(waitsFooter(w, NOW)).not.toContain('Autostart repair');
  });

  it('beyond two names it gives a count', async () => {
    const world = chain();
    world.tasks.push(task(D, 'Release notes', { dependsOn: [A] }), task(id(6), 'Release', { dependsOn: [C] }));
    const w = await load(world);
    expect(w.beyondCount).toBe(1);
    expect(summary(w)).toBe('Waits on this: Autostart repair, Release notes and 2 more.');
  });

  it('leaves out finished dependents', async () => {
    const world = chain();
    world.tasks[1].status = 'completed';
    expect((await load(world)).waiting).toEqual([]);
  });
});

describe('AC-2: a lane the task holds, with positions', () => {
  it('says it holds the lane with 2 queued, keeping their positions as data', async () => {
    const world = chain();
    world.tasks.push(task(D, 'Add index', { workspaceId: W1 }), task(id(7), 'Drop column', { workspaceId: W1 }));
    world.lanes = [{ lane: 'schema', queued: [{ id: D, title: 'Add index', position: 2 }, { id: id(7), title: 'Drop column', position: 3 }] }];
    const w = await load(world);
    expect(w.lanes).toEqual([{ lane: 'schema', queued: [{ id: D, title: 'Add index', position: 2 }, { id: id(7), title: 'Drop column', position: 3 }], hiddenCount: 0 }]);
    expect(summary(w)).toBe('Waits on this: Autostart repair, then Real-machine check. Holds the schema lane: 2 queued.');
  });

  it('a lane waiter the viewer cannot see is counted', async () => {
    const world = chain();
    world.tasks.push(task(H, 'Secret migration', { workspaceId: WHIDDEN }));
    world.hidden = [WHIDDEN];
    world.lanes = [{ lane: 'schema', queued: [{ id: H, title: 'Secret migration', position: 2 }] }];
    const w = await load(world);
    expect(w.lanes[0]).toEqual({ lane: 'schema', queued: [], hiddenCount: 1 });
    expect(JSON.stringify(w)).not.toContain('Secret migration');
  });
});

describe('AC-3: overlapping files are not waiting work', () => {
  it('a dependent held only by an edge the path-overlap pass added is not listed', async () => {
    const world = chain();
    world.tasks.push(task(D, 'Docs pass', { dependsOn: [A], inferredDependsOn: [A] }));
    const w = await load(world);
    expect(w.waiting.map(t => t.title)).not.toContain('Docs pass');
  });
});

describe('AC-4: an acceptance-test task names the criteria the answer affects', () => {
  const spec: SpecRow = { title: 'Checkout totals', verifiedBy: null, criterionIds: Array.from({ length: 20 }, (_, i) => `R-${i + 1}`) };
  const entry = { type: 'living_spec' as const, specId: SPEC, specRevisionId: REV, revision: 3, contentHash: 'h' };

  it('affects every in-scope criterion; the card gives the count, the data the ids', async () => {
    const world = chain();
    world.tasks[0].context = { acceptanceTests: { missionId: M, specId: SPEC, specRevisionId: REV } };
    world.missions[0].goalCriteria = [{ ...entry, criteria: spec.criterionIds.slice(0, 19) }];
    world.spec = spec;
    const w = await load(world);
    expect(w.criteria).toEqual({ specId: SPEC, specTitle: 'Checkout totals', affected: spec.criterionIds.slice(0, 19), total: 19 });
    expect(summary(w)).toContain('Affects the evidence for 19 of 19 criteria in Checkout totals.');
    expect(summary(w)).not.toContain('R-1');
  });

  it('a waived criterion is out of scope', () => {
    const hit = affectedCriteria({ entry: { ...entry, waived: [{ criterionId: 'R-20', reason: 'n/a', by: 'p', at: '' }] }, criterionIds: spec.criterionIds, verifiedBy: null, context: { finalVerification: { missionId: M } }, pathManifest: null, missionId: M });
    expect(hit).toEqual({ affected: spec.criterionIds.slice(0, 19), total: 19 });
  });

  it('a task pinned to some criteria affects those', () => {
    const hit = affectedCriteria({ entry, criterionIds: spec.criterionIds, verifiedBy: null, context: { specSource: { specId: SPEC, criteria: ['R-2', 'AC-9', 'R-3'] } }, pathManifest: null, missionId: M });
    expect(hit).toEqual({ affected: ['R-2', 'R-3'], total: 20 });
  });

  it('tests recorded as a criterion evidence count when the task declares their paths', () => {
    const hit = affectedCriteria({ entry, criterionIds: ['R-1', 'R-2'], verifiedBy: { 'R-2': ['apps/web/src/lib/checkout.test.ts'] }, context: {}, pathManifest: ['apps/web/src/lib'], missionId: M });
    expect(hit).toEqual({ affected: ['R-2'], total: 2 });
  });

  it('a task that supplies no evidence affects none', () => {
    expect(affectedCriteria({ entry, criterionIds: ['R-1'], verifiedBy: null, context: {}, pathManifest: null, missionId: M })).toBeNull();
  });
});

describe('AC-5: expiry and what happens then, in the footer', () => {
  it('asked 30 minutes ago in a mission (4 hours)', async () => {
    const world = chain();
    world.worker = { runner: 'runner-1', updatedAt: askedAt(30), waitingFor: waitingFor([{ label: 'Ship', recommended: true }, { label: 'Hold' }]) };
    const w = await load(world);
    expect(waitsFooter(w, NOW)).toBe('Expires in 3 hours 30 minutes, then the task starts again and the agent goes with Ship.');
  });

  it('a standalone task waits 24 hours; an interactive session ends', () => {
    const e = expiryOf({ askedAt: new Date(NOW), missionId: null, missionExecutor: null, runner: 'mcp', deliveryId: null, recommended: 'Ship' });
    expect(e.expiresAt).toBe(new Date(NOW + 24 * 3600_000).toISOString());
    expect(e.onExpiry).toEqual({ action: 'ends', option: null });
  });

  it('an interactive session in a local mission starts again; a delivery decides itself', () => {
    expect(expiryOf({ askedAt: new Date(NOW), missionId: M, missionExecutor: 'local', runner: 'mcp', deliveryId: null, recommended: null }).onExpiry.action).toBe('restart');
    expect(expiryOf({ askedAt: new Date(NOW), missionId: M, missionExecutor: null, runner: 'r', deliveryId: id(7), recommended: 'Ship' }).onExpiry.action).toBe('delivery');
  });
});

describe('AC-6: option effects from outcome kinds', () => {
  it('finishes says B starts; continues says B keeps waiting; recommended first', async () => {
    const world = chain();
    world.worker = { runner: 'r', updatedAt: askedAt(1), waitingFor: waitingFor([
      { label: 'Keep testing', outcome: 'continues' },
      { label: 'Accept as is', outcome: 'finishes', recommended: true },
    ]) };
    const w = await load(world);
    expect(w.options.map(o => [o.label, o.outcome, o.effect])).toEqual([
      ['Accept as is', 'finishes', 'Finishes the task: Autostart repair starts'],
      ['Keep testing', 'continues', 'Keeps working: Autostart repair keeps waiting'],
    ]);
  });

  it('stops fails declared dependents and what waits after them', async () => {
    const world = chain();
    world.worker = { runner: 'r', updatedAt: askedAt(1), waitingFor: waitingFor([{ label: 'Give up', outcome: 'stops' }]) };
    expect((await load(world)).options[0].effect).toBe('Stops the task: Autostart repair fails too, then Real-machine check');
  });

  it('a dependent with another open dependency does not start', async () => {
    const world = chain();
    world.tasks.push(task(D, 'Other upstream', { status: 'in_progress' }));
    world.tasks[1].dependsOn = [A, D];
    world.worker = { runner: 'r', updatedAt: askedAt(1), waitingFor: waitingFor([{ label: 'Done', outcome: 'finishes' }]) };
    expect((await load(world)).options[0].effect).toBe('Finishes the task: Autostart repair still waits on another task');
  });

  it('options with no kind carry only their consequence', async () => {
    const world = chain();
    world.worker = { runner: 'r', updatedAt: askedAt(5), waitingFor: waitingFor(['Yes', { label: 'No', consequence: 'Stops here.' }]) };
    const w = await load(world);
    expect(w.options.map(o => [o.label, o.outcome, o.effect])).toEqual([['Yes', null, null], ['No', null, null]]);
    expect(summary(w)).toContain('Waits on this:');
  });
});

describe('AC-7: nothing waits', () => {
  it('says so with no waiting work and no mission', async () => {
    const w = await load({ tasks: [task(A, 'Lonely task', { status: 'in_progress' })], missions: [], worker: { runner: 'r', updatedAt: askedAt(2), waitingFor: waitingFor([]) } });
    expect(summary(w)).toBe(`${NOTHING_WAITS}.`);
    expect(NOTHING_WAITS).toBe('Nothing else waits on this answer');
  });

  it('with a mission it names the mission instead', async () => {
    const w = await load({ tasks: [task(A, 'T', { missionId: M })], missions: [{ id: M, title: 'Mission X', executor: null, goalCriteria: null }], worker: null });
    expect(summary(w)).toBe('Part of Mission X; nothing else waits on this answer.');
  });
});

describe('AC-8: a waiting task the viewer cannot see', () => {
  it('is counted and nothing about it is named', async () => {
    const world = chain();
    world.tasks.push(task(H, 'Secret payroll migration', { dependsOn: [A], workspaceId: WHIDDEN, missionId: id(99) }));
    world.missions.push({ id: id(99), title: 'Payroll secrets', executor: null, goalCriteria: null });
    world.hidden = [WHIDDEN];
    world.worker = { runner: 'r', updatedAt: askedAt(1), waitingFor: waitingFor([{ label: 'Stop', outcome: 'stops' }]) };
    const w = await load(world);
    expect(w.hiddenCount).toBe(1);
    const all = JSON.stringify(w) + summary(w) + waitsFooter(w, NOW);
    for (const secret of ['Secret payroll', 'Payroll secrets', H, WHIDDEN]) expect(all).not.toContain(secret);
    expect(summary(w)).toBe("Waits on this: Autostart repair, then Real-machine check and 1 task you can't see.");
    expect(w.options[0].effect).toBe("Stops the task: Autostart repair and 1 task you can't see fail too, then Real-machine check");
  });
});

describe('AC-10: names, never ids', () => {
  it('no text holds a raw id; every name links to its page', async () => {
    const world = chain();
    world.tasks.push(task(H, 'Hidden one', { dependsOn: [A], workspaceId: WHIDDEN }));
    world.hidden = [WHIDDEN];
    world.tasks[0].context = { acceptanceTests: { missionId: M, specId: SPEC } };
    world.missions[0].goalCriteria = [{ type: 'living_spec', specId: SPEC, specRevisionId: REV, revision: 1, contentHash: 'h' }];
    world.spec = { title: 'Spec S', verifiedBy: null, criterionIds: ['R-1'] };
    world.worker = { runner: 'r', updatedAt: askedAt(5), waitingFor: waitingFor([{ label: 'Go', outcome: 'finishes' }]) };
    const w = await load(world);
    for (const p of waitsSummary(w)) {
      expect(p.text).not.toMatch(UUID);
      expect(p.text).not.toMatch(/dependsOn|missionId|taskId|waiting_input|hiddenCount|expiresAt/);
      if (p.href) expect(p.href).toMatch(/^\/app\/(tasks|missions|specs)\//);
    }
    expect(waitsFooter(w, NOW)).not.toMatch(UUID);
    for (const o of w.options) expect(o.effect ?? '').not.toMatch(UUID);
  });
});
