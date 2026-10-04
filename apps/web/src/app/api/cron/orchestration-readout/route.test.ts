import { beforeEach, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { artifacts, missionNotes } from '@buildd/core/db/schema';
import { ORCHESTRATION_PROMOTIONS } from '@buildd/core/orchestration-promotion';
import { PgDialect } from 'drizzle-orm/pg-core';

let workspaces: any[] = [];
let writes: any[] = [];
let predicate: any;
const insertedNotes = new Set<string>();
const select = mock(() => ({ from: () => ({ innerJoin: () => ({ where: async (where: any) => { predicate = where; return workspaces; } }) }) }));
const target = mock(async (): Promise<{ id: string; missionId: string | null }> => ({ id: 'task-fixture', missionId: 'mission-fixture' }));
mock.module('@buildd/core/db', () => ({ db: {
  select,
  query: { tasks: { findFirst: target } },
  insert: (table: unknown) => ({ values: (value: any) => {
    const write: any = { table, value };
    writes.push(write);
    return {
      onConflictDoUpdate: async (conflict: any) => { write.conflict = conflict; return []; },
      onConflictDoNothing: () => ({ returning: async () => {
        if (insertedNotes.has(value.id)) return [];
        insertedNotes.add(value.id);
        return [{ id: value.id }];
      } }),
    };
  } }),
} }));
const claim = mock(async (_opts: any) => ({ rows: [], hold: {}, links: new Map() }));
const manifest = mock(async (_opts: any) => ({ predictions: [], links: new Map() }));
const scheduling = mock(async (_opts: any) => []);
mock.module('@buildd/core/orchestration-readout-source', () => ({
  loadClaimReadoutInput: claim, loadManifestReadoutInput: manifest, loadSchedulingMetricsInput: scheduling,
}));
const group = () => ({
  capability: 'orchestration_claim',
  key: { decisionId: 'claim-hold', fingerprint: 'fingerprint', identity: 'identity', model: 'model', candidatePolicyVersion: 'policy', arm: 'observe' },
  counts: { decisions: 90, labelled: 90, censored: 0, missing: 0, excludedStraddle: 0, fingerprintMismatch: 0 },
  verdict: { verdict: 'eligible_for_gated', threshold: 0.9, reasons: ['held-out and later beat baseline'] },
  splits: { train: { n: 30, answered: 30, summary: { n: 30, errors: 0, confusions: [{ truth: 'START', pred: 'HOLD', count: 1, ids: ['private-task-id'] }] } } },
  split: { components: 90, straddling: 0, units: { train: 30, held_out: 30, later: 30 } },
  latencyMs: { p50: 1, p90: 2 }, censoredShare: 0, missingShare: 0,
  paths: ['private/source.ts'], title: 'private task title', taskContent: 'private task content',
});
const build = mock(async (_opts: any) => ({ capabilities: [{ capability: 'orchestration_claim', verdict: 'eligible_for_gated', reasons: [], groups: [group()] }], promotion: { eligible: [{ readoutRef: 'private/source.ts' }] } }));
mock.module('@buildd/core/orchestration-readout', () => ({ buildOrchestrationReadout: build }));
const trigger = mock(async () => {});
mock.module('@/lib/pusher', () => ({ triggerEvent: trigger, channels: { mission: (id: string) => id, workspace: (id: string) => id }, events: { MISSION_NOTE_POSTED: 'note' } }));
const { GET } = await import('./route');
const req = (token = 'test-secret') => new NextRequest('http://localhost/api/cron/orchestration-readout', { headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '0';
  workspaces = []; writes = [];
  insertedNotes.clear();
  for (const fn of [select, claim, manifest, scheduling, build, target, trigger]) fn.mockClear();
});

it('refuses unauthorized requests before querying', async () => {
  expect((await GET(req('wrong'))).status).toBe(401);
  expect(select).not.toHaveBeenCalled();
});

it('no opted-in workspace performs one query and no work', async () => {
  expect((await GET(req())).status).toBe(200);
  expect(select).toHaveBeenCalledTimes(1);
  expect(claim).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  const query = new PgDialect().sqlToQuery(predicate);
  expect(query.sql).toContain('enabled_decision_shadows');
  expect(query.sql).toContain('&&');
  expect(String(query.params[0])).toContain('orchestration_manifest');
  expect(String(query.params[0])).toContain('orchestration_claim');
});

it('writes a private workspace aggregate and one eligible note without promotion', async () => {
  workspaces = [{ workspaceId: 'workspace-fixture' }];
  const before = JSON.stringify(ORCHESTRATION_PROMOTIONS);
  expect((await GET(req())).status).toBe(200);
  const artifact = writes.find(w => w.table === artifacts).value;
  expect(artifact).toMatchObject({ workspaceId: 'workspace-fixture', key: 'conflict-aware-orchestration-readout', visibility: 'private', shareToken: null });
  expect(writes.find(w => w.table === artifacts).conflict).toMatchObject({ target: [artifacts.workspaceId, artifacts.key], set: { visibility: 'private', shareToken: null } });
  for (const secret of ['private/source.ts', 'private task title', 'private task content', 'private-task-id', 'promotion']) expect(artifact.content).not.toContain(secret);
  expect(JSON.parse(artifact.content).capabilities[0].groups[0].counts.labelled).toBe(90);
  expect(writes.filter(w => w.table === missionNotes)).toHaveLength(1);
  expect(writes.find(w => w.table === missionNotes).value.title).toContain('claim-hold');
  expect(JSON.stringify(ORCHESTRATION_PROMOTIONS)).toBe(before);
  const opts = build.mock.calls[0][0];
  expect(opts.window.until.getTime() - opts.window.since.getTime()).toBe(30 * 86400000);
  expect(opts.window.until.getTime() - opts.plan.laterFrom.getTime()).toBe(7 * 86400000);
  expect(claim.mock.calls[0][0].workspaceId).toBe('workspace-fixture');
  expect(manifest.mock.calls[0][0].workspaceId).toBe('workspace-fixture');
  expect(scheduling.mock.calls[0][0].workspaceId).toBe('workspace-fixture');
});

it('includes §6 scheduling metrics (counts and rates only, by ISO week) in the same private artifact', async () => {
  workspaces = [{ workspaceId: 'workspace-fixture' }];
  scheduling.mockImplementationOnce(async () => [{
    workspaceId: 'workspace-fixture',
    weekStart: new Date('2026-09-28T00:00:00Z'),
    mode: 'apply',
    deferrals: { path_overlap: 1, advisory_manifest: 0, ordered_behind: 0, codex_single_flight: 0 },
    claimedTaskCount: 2,
    strandedCount: 0,
    mergeLatenciesMs: [],
    conflictTaskCount: 0,
    mergedPrCount: 0,
    unsafeCoScheduleCount: 0,
    coScheduleSampleCount: 0,
    silentCompletionCount: 0,
    supersessionCancelCount: 0,
    supersessionRevertedCount: 0,
    claimPlans: [],
    plannerWouldBePickLabels: [],
  }]);
  await GET(req());
  const content = JSON.parse(writes.find(w => w.table === artifacts).value.content);
  expect(content.schedulingMetrics.weeks).toHaveLength(1);
  expect(content.schedulingMetrics.weeks[0]).toMatchObject({ mode: 'apply', weekLabel: '2026-W40' });
  expect(content.schedulingMetrics.weeks[0].metrics.primary.deferralsPerClaimedTask.value).toBe(0.5);
});

it('uses the same note identity on repeated runs', async () => {
  workspaces = [{ workspaceId: 'workspace-fixture' }];
  await GET(req()); await GET(req());
  const notes = writes.filter(w => w.table === missionNotes);
  expect(notes[0].value.id).toBe(notes[1].value.id);
  expect(trigger).toHaveBeenCalledTimes(1);
});

it('refuses when CRON_SECRET is not configured', async () => {
  delete process.env.CRON_SECRET;
  expect((await GET(req())).status).toBe(500);
  expect(select).not.toHaveBeenCalled();
});

it('stores insufficient evidence without posting a note', async () => {
  workspaces = [{ workspaceId: 'workspace-fixture' }];
  build.mockImplementationOnce(async () => ({ capabilities: [{ capability: 'orchestration_claim', verdict: 'insufficient_n', reasons: [], groups: [] }], promotion: { eligible: [] } }));
  await GET(req());
  expect(writes.filter(w => w.table === artifacts)).toHaveLength(1);
  expect(writes.filter(w => w.table === missionNotes)).toHaveLength(0);
  expect(target).not.toHaveBeenCalled();
});

it('continues other workspaces after a loader fails without exposing its error', async () => {
  workspaces = [{ workspaceId: 'workspace-bad' }, { workspaceId: 'workspace-fixture' }];
  claim.mockImplementationOnce(async () => { throw new Error('private/source.ts'); });
  const res = await GET(req());
  expect(await res.json()).toMatchObject({ processed: 2, changed: 1, errors: 1 });
  expect(writes.filter(w => w.table === artifacts)).toHaveLength(1);
});

it('separates note identities by workspace', async () => {
  workspaces = [{ workspaceId: 'workspace-a' }, { workspaceId: 'workspace-b' }];
  await GET(req());
  const notes = writes.filter(w => w.table === missionNotes);
  expect(notes[0].value.id).not.toBe(notes[1].value.id);
});

it('posts to the workspace task when it has no mission', async () => {
  workspaces = [{ workspaceId: 'workspace-fixture' }];
  target.mockImplementationOnce(async () => ({ id: 'task-fixture', missionId: null }));
  await GET(req());
  expect(writes.find(w => w.table === missionNotes).value).toMatchObject({ taskId: 'task-fixture', missionId: null });
  expect(trigger.mock.calls[0][0]).toBe('workspace-fixture');
});
