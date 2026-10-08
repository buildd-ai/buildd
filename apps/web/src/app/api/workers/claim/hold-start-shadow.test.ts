import { describe, it, expect, beforeEach } from 'bun:test';
import { choice, defineDecision, JEV_MODEL } from '@builddai/ai-kit/decide';
import type { OrchestrationDecisionDeps, OrchestrationDecisionRow } from '@buildd/core/orchestration-decision';
import {
  ClaimHoldCollector,
  acquireGatedStartPaths,
  gatedStartApplies,
  gatedStartReachable,
  releaseGatedStartPaths,
  resetClaimHoldMemos,
  runClaimHoldShadow,
  scheduleClaimHoldShadow,
  settleClaimHoldShadow,
  type ClaimHoldDeps,
  type ClaimHoldTaskContext,
} from './hold-start-shadow';

/**
 * Hold/start at claim (§5b), claim-route half. Every dependency is injected:
 * no DB, no key, no network.
 */

const TEAM = '00000000-0000-4000-8000-0000000000t1';
const WS = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-000000000001';
const HOLDER = '00000000-0000-4000-8000-000000000002';

const ctx = (over: Partial<ClaimHoldTaskContext> = {}): ClaimHoldTaskContext => ({
  teamId: TEAM,
  workspaceId: WS,
  missionId: null,
  taskId: TASK,
  accountId: null,
  title: 'Add the widget',
  taskCreatedAt: '2026-09-30T11:00:00.000Z',
  retryKind: null,
  forced: false,
  leaseReadFailed: false,
  gitConfig: null,
  now: '2026-09-30T12:00:00.000Z',
  ...over,
});

const pr = (over: Record<string, unknown> = {}) => ({
  taskId: HOLDER,
  prNumber: 7,
  prUrl: 'https://example.test/pr/7',
  pathManifest: ['apps/web/src/widget.ts'],
  workerStatus: 'completed',
  prLifecycle: 'ci_green',
  ...over,
});

const QUESTIONS = { action: choice({ question: 'q' }, { HOLD: 'h', START: 's' }) };
const GATED = defineDecision({ id: 'buildd.orchestration_claim_hold', promptVersion: 'test-gated', questions: QUESTIONS, mode: 'gated', minConfidence: 0.8 });

const SHADOW = defineDecision({ id: 'buildd.orchestration_claim_hold', promptVersion: 'test-shadow', questions: QUESTIONS, mode: 'shadow' });

function decisionDeps(over: Partial<OrchestrationDecisionDeps> & { rows?: OrchestrationDecisionRow[]; label?: string; model?: string } = {}) {
  const rows = over.rows ?? [];
  let accessCalls = 0;
  let calls = 0;
  const deps: OrchestrationDecisionDeps = {
    resolveAccess: async () => { accessCalls++; return { ok: true, apiKey: 'k', model: over.model ?? JEV_MODEL } as any; },
    call: (async () => {
      calls++;
      return {
        ok: true,
        answers: { action: { choice: over.label ?? 'START', confidence: 0.97, distribution: {} } },
        model: over.model ?? JEV_MODEL,
        usage: { inputTokens: 50, outputTokens: 1, costUsd: 0.00001 },
        latencyMs: 5,
        attempts: 1,
      };
    }) as any,
    record: async (row) => { rows.push(row); },
    ...over,
  };
  return { deps, rows, counts: () => ({ accessCalls, calls }) };
}

function harness(over: Partial<ClaimHoldDeps> = {}, dd = decisionDeps()) {
  const deps: ClaimHoldDeps = {
    decisionDeps: dd.deps,
    hasRecent: async () => false,
    loadHolder: async () => ({ title: 'Other', workerStatus: 'completed', lastActivityAt: '2026-09-30T11:30:00.000Z', prLifecycle: 'ci_green', baseStale: false }),
    ...over,
  };
  return { ...dd, deps };
}

beforeEach(() => resetClaimHoldMemos());

describe('ClaimHoldCollector.noteOpenPrOverlap: deterministic rails', () => {
  it('records an eligible advisory PR overlap with its digest', () => {
    const c = new ClaimHoldCollector();
    const note = c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    expect(note).not.toBeNull();
    expect(c.candidates).toHaveLength(1);
    expect(c.candidates[0].candidate).toMatchObject({ gate: 'open_pr_overlap', taskId: TASK, overlapPaths: ['apps/web/src/widget.ts'], holder: { taskId: HOLDER, prNumber: 7 } });
    expect(c.candidates[0].digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a live PR holder is never recorded', () => {
    const c = new ClaimHoldCollector();
    expect(c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr({ workerStatus: 'running' })], new Map())).toBeNull();
    expect(c.candidates).toHaveLength(0);
    expect(c.skipped).toEqual({ live_holder: 1 });
  });

  it('if ANY overlapping PR is live, the deferral is not asked about', () => {
    const c = new ClaimHoldCollector();
    const prs = [pr(), pr({ taskId: 'other', prNumber: 8, workerStatus: 'waiting_input' })];
    expect(c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], prs, new Map())).toBeNull();
  });

  it('an overlap with an exclusive live lease is never recorded', () => {
    const c = new ClaimHoldCollector();
    const leases = new Map([['someone-else', ['apps/web/src/widget.ts']]]);
    expect(c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], leases)).toBeNull();
    expect(c.skipped).toEqual({ live_lease: 1 });
  });

  it('the task\'s own leases do not count as a live lease', () => {
    const c = new ClaimHoldCollector();
    const leases = new Map([[TASK, ['apps/web/src/widget.ts']]]);
    expect(c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], leases)).not.toBeNull();
  });

  it('a serialized surface from workspace config is never recorded', () => {
    const c = new ClaimHoldCollector();
    const gitConfig = { conflictSurfaces: [{ label: 'widgets', pattern: 'apps/web/src', serialize: true }] } as any;
    expect(c.noteOpenPrOverlap(ctx({ gitConfig }), ['apps/web/src/widget.ts'], [pr()], new Map())).toBeNull();
    expect(c.skipped).toEqual({ serialized_surface: 1 });
  });

  it('a migration path is never recorded', () => {
    const c = new ClaimHoldCollector();
    const p = ['packages/core/drizzle/0300_x.sql'];
    expect(c.noteOpenPrOverlap(ctx(), p, [pr({ pathManifest: p })], new Map())).toBeNull();
    expect(c.skipped).toEqual({ migration: 1 });
  });

  it('a failed lease read (unknown state) is never recorded', () => {
    const c = new ClaimHoldCollector();
    expect(c.noteOpenPrOverlap(ctx({ leaseReadFailed: true }), ['apps/web/src/widget.ts'], [pr()], undefined)).toBeNull();
    expect(c.skipped).toEqual({ state_unresolved: 1 });
  });

  it('a forced claim is never recorded', () => {
    const c = new ClaimHoldCollector();
    expect(c.noteOpenPrOverlap(ctx({ forced: true }), ['apps/web/src/widget.ts'], [pr()], new Map())).toBeNull();
  });

  it('caps the candidates per claim', () => {
    const c = new ClaimHoldCollector();
    for (let i = 0; i < 8; i++) c.noteOpenPrOverlap(ctx({ taskId: `t-${i}` }), ['apps/web/src/widget.ts'], [pr()], new Map());
    expect(c.candidates).toHaveLength(5);
  });
});

describe('ClaimHoldCollector.noteSoftOverlap: prefix-only declared overlap', () => {
  const holder = (over: Record<string, unknown> = {}) => ({ taskId: HOLDER, overlapPaths: ['scripts', 'scripts/run-unit-tests.ts'], workerStatus: 'running', ...over });

  it('records an eligible soft overlap, even with a live holder', () => {
    const c = new ClaimHoldCollector();
    const note = c.noteSoftOverlap(ctx(), ['scripts/'], holder(), new Map());
    expect(note?.candidate).toMatchObject({ gate: 'soft_overlap', scope: 'declared', overlapPaths: ['scripts', 'scripts/run-unit-tests.ts'], holder: { taskId: HOLDER, prNumber: null, workerStatus: 'running' } });
  });

  it('a live lease held by another task on the scope wins: not asked', () => {
    const c = new ClaimHoldCollector();
    expect(c.noteSoftOverlap(ctx(), ['scripts/'], holder(), new Map([[HOLDER, ['scripts/run-unit-tests.ts']]]))).toBeNull();
    expect(c.skipped).toEqual({ live_lease: 1 });
  });

  it('a migration or serialized overlap is not asked', () => {
    const c = new ClaimHoldCollector();
    expect(c.noteSoftOverlap(ctx(), ['packages/core/'], holder({ overlapPaths: ['packages/core/drizzle'] }), new Map())).toBeNull();
    const gitConfig = { conflictSurfaces: [{ label: 'scripts', pattern: 'scripts', serialize: true }] } as any;
    expect(c.noteSoftOverlap(ctx({ gitConfig }), ['scripts/'], holder(), new Map())).toBeNull();
    expect(c.skipped).toEqual({ migration: 1, serialized_surface: 1 });
  });

  it('never throws', () => {
    const c = new ClaimHoldCollector();
    expect(() => c.noteSoftOverlap(null as any, ['scripts/'], holder(), new Map())).not.toThrow();
    expect(c.skipped.error).toBe(1);
  });
});

describe('ClaimHoldCollector never throws into the claim loop', () => {
  const malformed: Array<[string, any]> = [
    ['conflictSurfaces is an object', { conflictSurfaces: { label: 'x', pattern: 'apps', serialize: true } }],
    ['a conflictSurfaces pattern is not a string', { conflictSurfaces: [{ label: 'x', pattern: 42, serialize: true }] }],
    ['sequenceNamespaces is an object', { sequenceNamespaces: { label: 'm', dir: 'db', serialize: true } }],
  ];
  for (const [name, gitConfig] of malformed) {
    it(`open-PR overlap with a malformed gitConfig (${name}) is skipped as an error`, () => {
      const c = new ClaimHoldCollector();
      expect(() => c.noteOpenPrOverlap(ctx({ gitConfig }), ['apps/web/src/widget.ts'], [pr()], new Map())).not.toThrow();
      expect(c.noteOpenPrOverlap(ctx({ gitConfig }), ['apps/web/src/widget.ts'], [pr()], new Map())).toBeNull();
      expect(c.candidates).toHaveLength(0);
      expect(c.skipped.error).toBe(2);
    });
  }

  it('a malformed open-PR entry is skipped as an error, not thrown', () => {
    const c = new ClaimHoldCollector();
    const bad = [{ taskId: HOLDER, prNumber: 7, pathManifest: 'apps/web/src/widget.ts' as any, workerStatus: 'completed', prLifecycle: null }];
    expect(() => c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], bad, new Map())).not.toThrow();
    expect(c.candidates).toHaveLength(0);
  });

  it('advisory_manifest noting never throws on a bad context', () => {
    const c = new ClaimHoldCollector();
    expect(() => c.noteAdvisoryManifest(null as any, 'peer')).not.toThrow();
    expect(c.skipped.error).toBe(1);
  });
});

describe('ClaimHoldCollector.noteAdvisoryManifest', () => {
  it('records the scope-undeclared serialization', () => {
    const c = new ClaimHoldCollector();
    const note = c.noteAdvisoryManifest(ctx({ missionId: 'm1' }), 'peer-task');
    expect(note?.candidate).toMatchObject({ gate: 'advisory_manifest', scope: 'undeclared', holder: { taskId: 'peer-task', prNumber: null } });
  });

  it('a failed lease read is unknown state, not recorded', () => {
    const c = new ClaimHoldCollector();
    expect(c.noteAdvisoryManifest(ctx({ leaseReadFailed: true }), 'peer-task')).toBeNull();
  });
});

describe('runClaimHoldShadow: records every decision; only a confident Jev START applies', () => {
  it('a shadow definition records the rule verdict and the suggestion, content-free, with the cohort draw', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness({ decision: SHADOW });
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows).toHaveLength(1);
    const row = h.rows[0];
    expect(row).toMatchObject({
      capability: 'orchestration_claim',
      decisionId: 'buildd.orchestration_claim_hold',
      mode: 'shadow',
      ruleVerdict: 'HOLD',
      suggested: 'START',
      effective: 'HOLD',
      applied: false,
      status: 'suggested',
      reason: 'shadow',
      candidatePolicyVersion: 'ch1.open_pr_overlap',
      candidateDigest: c.candidates[0].digest,
      candidateCount: 2,
      taskId: TASK,
      workspaceId: WS,
      prNumber: null,
    });
    expect(JSON.stringify(row)).not.toContain('widget');
    expect(JSON.stringify(row)).not.toContain('Add the widget');
  });

  it('non-Jev model: a reached gated policy still records a suggestion, never applies', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const dd = decisionDeps({ model: 'openai/gpt-x' });
    const h = harness({ decision: GATED, applyingFraction: 1 }, dd);
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows[0]).toMatchObject({ applied: false, status: 'suggested', reason: 'non_jev', model: 'openai/gpt-x' });
  });

  it('Jev under a reached gated policy with the task in the cohort is the only applied START', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness({ decision: GATED, applyingFraction: 1 });
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows[0]).toMatchObject({ applied: true, effective: 'START', experimentArm: 'apply', propensity: 1 });
  });

  it('as shipped (no overrides) a confident Jev START applies: no promotion gate', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness();
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows[0]).toMatchObject({ mode: 'gated', applied: true, effective: 'START', experimentArm: 'apply', applyingFraction: 1 });
    expect(gatedStartReachable()).toBe(true);
  });

  it('a Jev START below the threshold is recorded, never applied: the task holds', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const dd = decisionDeps({
      call: (async () => ({ ok: true, answers: { action: { choice: 'START', confidence: 0.6, distribution: {} } }, model: JEV_MODEL, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 1, attempts: 1 })) as any,
    });
    const h = harness({}, dd);
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows[0]).toMatchObject({ applied: false, effective: 'HOLD', suggested: 'START' });
  });

  it('a Jev HOLD applies as HOLD: the task keeps waiting', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness({}, decisionDeps({ label: 'HOLD' }));
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows[0]).toMatchObject({ effective: 'HOLD' });
  });

  it('a decision error (provider down) fails closed to HOLD', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const dd = decisionDeps({ call: (async () => { throw new Error('provider down'); }) as any });
    const h = harness({}, dd);
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows[0]).toMatchObject({ status: 'fallback', effective: 'HOLD', applied: false });
  });

  it('rolling the requested fraction back to zero stops application even with evidence', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness({ decision: GATED, applyingFraction: 0 });
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows[0]).toMatchObject({ applied: false, applyingFraction: 0, experimentArm: 'observe' });
    expect(gatedStartReachable({ decision: GATED, applyingFraction: 0 })).toBe(false);
  });

  it('a state-read failure falls back to the rule and is recorded as retrieval_error', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness({ loadHolder: async () => { throw new Error('db down'); } });
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.counts().calls).toBe(0);
    expect(h.rows[0]).toMatchObject({ status: 'fallback', reason: 'retrieval_error', effective: 'HOLD', applied: false });
  });

  it('a team that has not opted in costs one access check, then nothing for a while', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    c.noteAdvisoryManifest(ctx({ taskId: 'task-2', missionId: 'm' }), 'peer');
    let access = 0;
    const dd = decisionDeps({ resolveAccess: async () => { access++; return { ok: false, error: { kind: 'capability_disabled', message: 'off' } } as any; } });
    const h = harness({}, dd);
    await runClaimHoldShadow(c.candidates, h.deps);
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(access).toBe(1);
    expect(h.rows).toHaveLength(0);
  });

  it('a team that has not opted in costs no ledger read: the opt-in check comes first', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    let recentReads = 0;
    const dd = decisionDeps({ resolveAccess: async () => ({ ok: false, error: { kind: 'capability_disabled', message: 'off' } }) as any });
    const h = harness({ hasRecent: async () => { recentReads++; return false; } }, dd);
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(recentReads).toBe(0);
    expect(h.rows).toHaveLength(0);
  });

  it('an opted-in team resolves access once per decision (not again inside the adapter)', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness();
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.counts().accessCalls).toBe(1);
    expect(h.rows).toHaveLength(1);
  });

  it('the same state is not asked twice: the ledger says it was asked recently', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness({ hasRecent: async () => true });
    await runClaimHoldShadow(c.candidates, h.deps);
    // The opt-in check runs first; the ledger read then stops the model call.
    expect(h.counts().accessCalls).toBe(1);
    expect(h.counts().calls).toBe(0);
    expect(h.rows).toHaveLength(0);
  });

  it('the same state is not asked twice on one instance either', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness();
    await runClaimHoldShadow(c.candidates, h.deps);
    await runClaimHoldShadow(c.candidates, h.deps);
    expect(h.rows).toHaveLength(1);
  });

  it('never throws, even when every dependency does', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness({ hasRecent: async () => { throw new Error('x'); }, decide: (async () => { throw new Error('y'); }) as any });
    await expect(runClaimHoldShadow(c.candidates, h.deps)).resolves.toBeUndefined();
  });
});

describe('scheduleClaimHoldShadow: never on the response path', () => {
  it('returns before any decision work starts', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    let started = false;
    let scheduled: (() => Promise<void>) | null = null;
    const h = harness({ hasRecent: async () => { started = true; return false; }, schedule: (fn) => { scheduled = fn; } });
    scheduleClaimHoldShadow(c, h.deps);
    expect(started).toBe(false);
    expect(scheduled).not.toBeNull();
    await scheduled!();
    expect(started).toBe(true);
  });

  it('schedules nothing when there is nothing to ask', () => {
    let scheduled = false;
    scheduleClaimHoldShadow(new ClaimHoldCollector(), { schedule: () => { scheduled = true; } });
    expect(scheduled).toBe(false);
  });

  it('outside a request scope (after() throws) it still runs, detached', async () => {
    const c = new ClaimHoldCollector();
    c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map());
    const h = harness();
    scheduleClaimHoldShadow(c, h.deps);
    expect(h.rows).toHaveLength(0);
    await settleClaimHoldShadow();
    expect(h.rows).toHaveLength(1);
  });
});

describe('gated START', () => {
  const note = () => {
    const c = new ClaimHoldCollector();
    return c.noteOpenPrOverlap(ctx(), ['apps/web/src/widget.ts'], [pr()], new Map())!;
  };

  it('rolled back (zero fraction) it is unreachable: no ledger lookup, always holds', async () => {
    let lookups = 0;
    expect(await gatedStartApplies(note(), { applyingFraction: 0, findAppliedStart: async () => { lookups++; return true; } })).toBe(false);
    expect(lookups).toBe(0);
  });

  it('as shipped it applies an applied START from the ledger', async () => {
    expect(await gatedStartApplies(note(), { findAppliedStart: async () => true })).toBe(true);
  });

  it('when reached, it applies only for an applied START on the same state digest', async () => {
    const keys: any[] = [];
    const n = note();
    const deps: ClaimHoldDeps = { decision: GATED, applyingFraction: 0.1, findAppliedStart: async (k) => { keys.push(k); return true; }, now: () => Date.parse('2026-09-30T12:00:00Z') };
    expect(await gatedStartApplies(n, deps)).toBe(true);
    expect(keys[0]).toMatchObject({ workspaceId: WS, taskId: TASK, decisionId: GATED.id, fingerprint: GATED.fingerprint, candidateDigest: n.digest });
    expect(keys[0].since.toISOString()).toBe('2026-09-30T11:50:00.000Z');
    expect(await gatedStartApplies(n, { ...deps, findAppliedStart: async () => false })).toBe(false);
  });

  it('a lookup error holds', async () => {
    expect(await gatedStartApplies(note(), { decision: GATED, applyingFraction: 1, findAppliedStart: async () => { throw new Error('x'); } })).toBe(false);
  });

  it('a shadow definition stays unreachable whatever the fraction: no ledger lookup', async () => {
    let lookups = 0;
    const deps: ClaimHoldDeps = { decision: SHADOW, applyingFraction: 1, findAppliedStart: async () => { lookups++; return true; } };
    expect(gatedStartReachable(deps)).toBe(false);
    expect(await gatedStartApplies(note(), deps)).toBe(false);
    expect(lookups).toBe(0);
  });

  it('acquires the declared paths through the exclusive primitive, all-or-nothing', async () => {
    const calls: any[] = [];
    const ok = await acquireGatedStartPaths({ workspaceId: WS, taskId: TASK, paths: ['**', 'apps/web/src/widget.ts'] }, {
      acquire: async (input) => { calls.push(input); return { kind: 'acquired', inserted: ['apps/web/src/widget.ts'], insertedIds: ['lease-1'], blocked: [], pathManifest: null, revision: 1 }; },
    });
    expect(ok).toEqual({ ok: true, inserted: ['apps/web/src/widget.ts'], insertedIds: ['lease-1'] });
    expect(calls).toEqual([{ workspaceId: WS, taskId: TASK, paths: ['apps/web/src/widget.ts'], declare: true }]);
  });

  it('a conflict, a closed task or an error means HOLD', async () => {
    const input = { workspaceId: WS, taskId: TASK, paths: ['a.ts'] };
    expect((await acquireGatedStartPaths(input, { acquire: async () => ({ kind: 'conflict', conflict: {} as any, blocked: [] }) })).ok).toBe(false);
    expect((await acquireGatedStartPaths(input, { acquire: async () => ({ kind: 'task_closed' }) })).ok).toBe(false);
    expect((await acquireGatedStartPaths(input, { acquire: async () => { throw new Error('x'); } })).ok).toBe(false);
  });

  it('a scope-undeclared START acquires nothing up front (observed touches lease later)', async () => {
    let called = false;
    expect(await acquireGatedStartPaths({ workspaceId: WS, taskId: TASK, paths: ['**'] }, { acquire: async () => { called = true; return { kind: 'task_closed' }; } })).toEqual({ ok: true, inserted: [], insertedIds: [] });
    expect(called).toBe(false);
  });

  describe('releaseGatedStartPaths: a START that lost the atomic claim gives its new leases back', () => {
    const input = { workspaceId: WS, taskId: TASK, insertedIds: ['lease-1'] };
    const released = (paths: string[], waiters: Array<{ waitingTaskId: string; blockedPath: string }> = []) => async () => ({
      kind: 'released' as const,
      result: { workspaceId: WS, releasedPaths: paths, notifiedWaiters: waiters.map(w => w.waitingTaskId), waiters },
    });

    it('releases only the rows this attempt inserted, never the task\'s other leases', async () => {
      const calls: any[] = [];
      const out = await releaseGatedStartPaths(input, {
        releaseRows: async (a) => { calls.push(a); return released(['apps/web/src/widget.ts'])(); },
        releaseReason: async () => 'abandoned',
        deliver: async () => {},
      });
      expect(out).toBe('released');
      expect(calls).toEqual([{ workspaceId: WS, taskId: TASK, leaseIds: ['lease-1'], keepStatuses: ['assigned', 'in_progress', 'review'] }]);
    });

    it('keeps them when the winning claim now owns the task (decided under the lock)', async () => {
      let delivered = 0;
      const out = await releaseGatedStartPaths(input, { releaseRows: async () => ({ kind: 'kept' }), deliver: async () => { delivered++; } });
      expect(out).toBe('kept_live_owner');
      expect(delivered).toBe(0);
    });

    it('waiters hear the task\'s real release reason, not a blanket "abandoned"', async () => {
      const seen: any[] = [];
      const out = await releaseGatedStartPaths(input, {
        releaseRows: released(['apps/web/src/widget.ts'], [{ waitingTaskId: HOLDER, blockedPath: 'apps/web/src/widget.ts' }]),
        releaseReason: async (taskId) => { expect(taskId).toBe(TASK); return 'merged'; },
        deliver: async (taskId, result, reason) => { seen.push({ taskId, reason, waiters: result.notifiedWaiters }); },
      });
      expect(out).toBe('released');
      expect(seen).toEqual([{ taskId: TASK, reason: 'merged', waiters: [HOLDER] }]);
    });

    it('nothing inserted: nothing to release, no statement', async () => {
      let calls = 0;
      const out = await releaseGatedStartPaths({ ...input, insertedIds: [] }, { releaseRows: async () => { calls++; return { kind: 'nothing' }; } });
      expect(out).toBe('nothing_inserted');
      expect(calls).toBe(0);
    });

    it('never throws: a failed release is reported, the reaper is the backstop', async () => {
      expect(await releaseGatedStartPaths(input, { releaseRows: async () => { throw new Error('db'); } })).toBe('error');
    });
  });
});
