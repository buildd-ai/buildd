import { describe, expect, it } from 'bun:test';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  applyScoutFailure,
  buildScoutProbeCheck,
  completeScoutRun,
  executeScoutProbe,
  expireRunnerProbes,
  failScoutRun,
  finalizeScoutProbes,
  recordScoutFailure,
  resolveScoutFinding,
  resolveScoutMode,
  scoutDismissal,
  scoutFindingCasWhere,
  scoutCheckId,
  scoutFindingLedgerSet,
  scoutFindingRow,
  scoutParkingExpiry,
  scoutProbeFromRow,
  scoutProbeRecord,
  scoutProbeRow,
  scoutRunFromRow,
  scoutRunRow,
  scoutRunStaleness,
  startScoutRun,
  type ScoutCandidateLike,
  type ScoutFindingStore,
} from '../quality-scout/ledger';
import { SCOUT_ACTION_STATES, SCOUT_AUTHORITY, SCOUT_MODES, SCOUT_RUN_STATUSES, type ScoutFinding, type ScoutProbeRecord, type ScoutRun, type ScoutRunParking } from '../quality-scout/types';
import { verificationSignature, type VerificationExecutor } from '../verification-check';
import { qualityScoutFindings, qualityScoutProbes, qualityScoutRuns } from '../db/schema';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const T0 = new Date('2026-10-04T10:00:00Z');
const T1 = new Date('2026-10-04T11:00:00Z');

function run(over: Partial<Parameters<typeof startScoutRun>[0]> = {}): ScoutRun {
  const r = startScoutRun({
    id: 'run-1',
    workspaceId: 'ws-1',
    trigger: 'manual',
    mode: 'shadow',
    candidate: { ref: 'main', sha: SHA },
    now: T0,
    ...over,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}

const CANDIDATE: ScoutCandidateLike = {
  id: 'cand-1',
  family: 'contract',
  probeKind: 'cli-journey',
  title: 'CLI exits non-zero on bad input',
  invariant: 'The CLI exits non-zero when given an unknown flag.',
  sourceSignals: [{ type: 'change', ref: 'src/cli.ts' }],
  preconditions: ['cli-journey'],
  executor: 'cli-journey:bad-flag',
  estimatedCost: 'low',
  severity: 'high',
  evidenceRequirements: ['command-output'],
};

const SELECTED = { status: 'selected', via: 'decision', reasonCode: 'changed_surface', decisionSource: 'model' } as const;

function probe(over: Partial<ScoutCandidateLike> = {}): ScoutProbeRecord {
  return scoutProbeRecord({ ...CANDIDATE, ...over }, SELECTED);
}

const failing: VerificationExecutor<{ exit: number }> = {
  kind: 'command',
  requires: [],
  run: (i) => (i.exit === 0
    ? { verdict: 'fail', observed: 'exit 0 on --nope', evidenceRefs: [{ kind: 'command_output', ref: 'ev-1' }], confidence: 0.9 }
    : { verdict: 'pass', observed: `exit ${i.exit}` }),
};

const CAPS = ['cli-journey:bad-flag'];
const EVIDENCE = { 'command-output': 'complete' } as const;

function executed(r: ScoutRun, input: { exit: number }, p = probe()): ScoutProbeRecord {
  return executeScoutProbe(r, p, failing, { input, evidence: EVIDENCE, capabilities: CAPS, now: T0 });
}

describe('mode', () => {
  it('has exactly off|shadow|propose and no blocking authority', () => {
    expect([...SCOUT_MODES]).toEqual(['off', 'shadow', 'propose']);
    expect(SCOUT_AUTHORITY).toBe('advisory');
    expect(SCOUT_ACTION_STATES.some(s => /\bblock|\bgate\b/.test(s))).toBe(false);
  });

  it('absent config is off; an unrecognised value is shadow, never propose', () => {
    expect(resolveScoutMode(undefined)).toBe('off');
    expect(resolveScoutMode({})).toBe('off');
    expect(resolveScoutMode({ mode: 'propose' })).toBe('propose');
    expect(resolveScoutMode({ mode: 'shadow' })).toBe('shadow');
    expect(resolveScoutMode({ mode: 'off' })).toBe('off');
    expect(resolveScoutMode({ mode: 'block' })).toBe('shadow');
    expect(resolveScoutMode('propose')).toBe('off');
  });
});

describe('startScoutRun', () => {
  it('records the exercised ref and SHA, the prior run and a clamped budget', () => {
    const r = run({ prior: { runId: 'run-0', sha: SHA2 }, budget: { maxProbes: 99 } });
    expect(r.candidate).toEqual({ ref: 'main', sha: SHA });
    expect(r.prior).toEqual({ runId: 'run-0', sha: SHA2 });
    expect(r.budget).toEqual({ maxProbes: 10, maxCostUsd: null, maxCaptureProbes: 1 });
    expect(r.status).toBe('running');
    expect(r.startedAt).toBe(T0.toISOString());
    expect(r.policyVersion).toBe('scout-v1');
  });

  it('defaults the budget to 4 probes', () => {
    expect(run().budget.maxProbes).toBe(4);
    expect(run({ budget: { maxProbes: 0 } }).budget.maxProbes).toBe(1);
  });

  it('lower-cases the SHA and refuses anything that is not a full SHA', () => {
    expect(run({ candidate: { ref: 'main', sha: SHA.toUpperCase() } }).candidate.sha).toBe(SHA);
    for (const sha of ['abc123', '', 'z'.repeat(40), 'HEAD']) {
      const r = startScoutRun({ workspaceId: 'ws', trigger: 'manual', mode: 'shadow', candidate: { ref: 'main', sha }, now: T0 });
      expect(r).toEqual({ ok: false, reason: 'invalid_sha' });
    }
  });

  it('refuses an empty ref and an unknown trigger', () => {
    expect(startScoutRun({ workspaceId: 'ws', trigger: 'manual', mode: 'shadow', candidate: { ref: ' ', sha: SHA }, now: T0 }))
      .toEqual({ ok: false, reason: 'invalid_ref' });
    expect(startScoutRun({ workspaceId: 'ws', trigger: 'nightly' as never, mode: 'shadow', candidate: { ref: 'main', sha: SHA }, now: T0 }))
      .toEqual({ ok: false, reason: 'invalid_trigger' });
  });

  it('mode off starts nothing', () => {
    expect(startScoutRun({ workspaceId: 'ws', trigger: 'manual', mode: 'off', candidate: { ref: 'main', sha: SHA }, now: T0 }))
      .toEqual({ ok: false, reason: 'mode_off' });
  });
});

describe('scoutProbeRecord', () => {
  it('stores the probe contract and normalises evidence requirements to the substrate shape', () => {
    const p = probe();
    expect(p.candidateId).toBe('cand-1');
    expect(p.risk).toBe('high');
    expect(p.mutates).toBe(false);
    expect(p.evidenceRequirements).toEqual([{ key: 'command-output', need: 'complete' }]);
    expect(p.result).toBeNull();
    expect(p.selection).toEqual(SELECTED);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('keeps substrate-shaped requirements as given', () => {
    expect(probe({ evidenceRequirements: [{ key: 'screenshot', need: 'partial' }] }).evidenceRequirements)
      .toEqual([{ key: 'screenshot', need: 'partial' }]);
  });

  it('refuses a probe with no invariant — it must be declared before execution', () => {
    expect(() => probe({ invariant: '   ' })).toThrow(/invariant/);
  });

  it('refuses an unknown family', () => {
    expect(() => probe({ family: 'vibes' as never })).toThrow(/family/);
  });
});

describe('buildScoutProbeCheck', () => {
  it('is a substrate check on the candidate SHA with a run-independent id', () => {
    const r = run();
    const c = buildScoutProbeCheck(r, probe(), failing);
    expect(c.id).toBe(scoutCheckId('cand-1'));
    expect(c.invariant).toBe(CANDIDATE.invariant);
    expect(c.subject).toEqual({ kind: 'candidate-sha', ref: SHA });
    expect(c.provenance).toEqual({ flavor: 'quality-scout', origin: 'run:run-1' });
    expect(c.executor.requires).toEqual(['cli-journey:bad-flag']);
    expect(c.defaultSeverity).toBe('high');
    expect(buildScoutProbeCheck(run({ id: 'run-2' }), probe(), failing).id).toBe(c.id);
  });
});

describe('executeScoutProbe — missing evidence or capability is never pass', () => {
  it('records a fail with the substrate signature', () => {
    const p = executed(run(), { exit: 0 });
    expect(p.result?.verdict).toBe('fail');
    expect(p.result?.severity).toBe('high');
    expect(p.result?.signature).toBe(verificationSignature([scoutCheckId('cand-1')]));
    expect(p.result?.subject.ref).toBe(SHA);
  });

  it('records a pass only when the executor ran on sufficient evidence', () => {
    expect(executed(run(), { exit: 2 }).result?.verdict).toBe('pass');
  });

  it('a missing capability is unsupported and the executor never runs', () => {
    let ran = false;
    const p = executeScoutProbe(run(), probe(), { ...failing, run: () => { ran = true; return { verdict: 'pass' }; } },
      { input: { exit: 2 }, evidence: EVIDENCE, capabilities: [], now: T0 });
    expect(p.result?.verdict).toBe('unsupported');
    expect(ran).toBe(false);
  });

  it('a probe with no matched executor is unsupported even if the executor would pass', () => {
    const p = executeScoutProbe(run(), probe({ executor: null }), { kind: 'x', requires: [], run: () => ({ verdict: 'pass' }) },
      { input: {}, evidence: EVIDENCE, capabilities: CAPS, now: T0 });
    expect(p.result?.verdict).toBe('unsupported');
  });

  it('absent evidence is inconclusive', () => {
    const p = executeScoutProbe(run(), probe(), failing, { input: { exit: 2 }, evidence: {}, capabilities: CAPS, now: T0 });
    expect(p.result?.verdict).toBe('inconclusive');
  });

  it('refuses to execute a skipped probe', () => {
    const skipped = scoutProbeRecord(CANDIDATE, { status: 'skipped', reason: 'over_budget', reasonCode: null });
    expect(() => executed(run(), { exit: 0 }, skipped)).toThrow(/selected/);
  });
});

describe('finalizeScoutProbes / completeScoutRun', () => {
  it('a selected probe that never ran is recorded inconclusive, not dropped and not passed', () => {
    const r = run();
    const [p] = finalizeScoutProbes(r, [probe()], T1);
    expect(p.result?.verdict).toBe('inconclusive');
    expect(p.result?.reason).toBe('not_executed');
    expect(p.result?.subject.ref).toBe(SHA);
  });

  it('leaves skipped probes without a result and executed probes untouched', () => {
    const r = run();
    const skipped = scoutProbeRecord(CANDIDATE, { status: 'skipped', reason: 'family_cap', reasonCode: null });
    const done = executed(r, { exit: 0 });
    const out = finalizeScoutProbes(r, [skipped, done], T1);
    expect(out[0].result).toBeNull();
    expect(out[1]).toBe(done);
  });

  it('completes with verdict counts and selection counters', () => {
    const r = run();
    const skipped = scoutProbeRecord({ ...CANDIDATE, id: 'cand-2' }, { status: 'skipped', reason: 'over_budget', reasonCode: null });
    const { run: done, totals, probes } = completeScoutRun(r, [executed(r, { exit: 0 }), probe({ id: 'cand-3' }), skipped], {
      candidatesGenerated: 7, costUsd: 0.12, now: T1,
    });
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBe(T1.toISOString());
    expect(totals).toEqual({
      candidatesGenerated: 7,
      probesSelected: 2,
      probesSkipped: 1,
      verdicts: { total: 2, pass: 0, fail: 1, inconclusive: 1, unsupported: 0 },
      costUsd: 0.12,
    });
    expect(probes[1].result?.reason).toBe('not_executed');
  });

  it('a failed run keeps a bounded error', () => {
    const f = failScoutRun(run(), 'x'.repeat(1000), T1);
    expect(f.status).toBe('failed');
    expect(f.error?.length).toBeLessThanOrEqual(500);
  });
});

describe('scoutRunStaleness', () => {
  it('fresh on the same SHA, stale on a newer one, unknown without a usable current SHA or a finished run', () => {
    const { run: done } = completeScoutRun(run(), [], { candidatesGenerated: 0, now: T1 });
    expect(scoutRunStaleness(done, SHA)).toBe('fresh');
    expect(scoutRunStaleness(done, SHA2)).toBe('stale');
    expect(scoutRunStaleness(done, null)).toBe('unknown');
    expect(scoutRunStaleness(done, 'main')).toBe('unknown');
    expect(scoutRunStaleness(run(), SHA)).toBe('unknown');
  });
});

describe('findings — dedupe by signature, recurrence across runs', () => {
  it('a fail creates one open finding stamped with the exercised SHA', () => {
    const r = run();
    const { finding, change } = applyScoutFailure(null, r, executed(r, { exit: 0 }), T0);
    expect(change).toBe('created');
    expect(finding).toMatchObject({
      workspaceId: 'ws-1',
      signature: verificationSignature([scoutCheckId('cand-1')]),
      recurrenceKey: scoutCheckId('cand-1'),
      checkId: scoutCheckId('cand-1'),
      family: 'contract',
      severity: 'high',
      confidence: 0.9,
      state: 'open',
      actionState: 'none',
      occurrenceCount: 1,
      firstSeenSha: SHA,
      lastSeenSha: SHA,
      lastSeenRunId: 'run-1',
      reproducibility: 'unknown',
    });
  });

  it('the same failure in a later run recurs on the same finding instead of a new one', () => {
    const r1 = run();
    const first = applyScoutFailure(null, r1, executed(r1, { exit: 0 }), T0).finding!;
    const r2 = run({ id: 'run-2', candidate: { ref: 'main', sha: SHA2 } });
    const { finding, change } = applyScoutFailure({ ...first, actionState: 'filed', actionTaskId: 'task-9' }, r2, executed(r2, { exit: 0 }), T1);
    expect(change).toBe('recurred');
    expect(finding).toMatchObject({
      occurrenceCount: 2,
      firstSeenSha: SHA,
      lastSeenSha: SHA2,
      lastSeenRunId: 'run-2',
      actionState: 'filed',
      actionTaskId: 'task-9',
    });
  });

  it('reprocessing the same run is a no-op', () => {
    const r = run();
    const p = executed(r, { exit: 0 });
    const first = applyScoutFailure(null, r, p, T0).finding!;
    expect(applyScoutFailure(first, r, p, T1)).toEqual({ finding: first, change: 'unchanged' });
  });

  it('keeps the highest severity and confidence seen', () => {
    const r1 = run();
    const first = { ...applyScoutFailure(null, r1, executed(r1, { exit: 0 }), T0).finding!, severity: 'critical' as const, confidence: 0.95 };
    const r2 = run({ id: 'run-2' });
    const { finding } = applyScoutFailure(first, r2, executed(r2, { exit: 0 }), T1);
    expect(finding?.severity).toBe('critical');
    expect(finding?.confidence).toBe(0.95);
  });

  it('a resolved finding that fails again re-opens as a regression; a dismissed one stays dismissed', () => {
    const r1 = run();
    const first = applyScoutFailure(null, r1, executed(r1, { exit: 0 }), T0).finding!;
    const r2 = run({ id: 'run-2' });
    const resolved = resolveScoutFinding(first, r2, T1).finding!;
    const r3 = run({ id: 'run-3' });
    const again = applyScoutFailure(resolved, r3, executed(r3, { exit: 0 }), T1);
    expect(again.change).toBe('regressed');
    expect(again.finding).toMatchObject({ state: 'open', regressionCount: 1, resolvedRunId: null });

    const dismissed = applyScoutFailure({ ...first, state: 'dismissed' }, r3, executed(r3, { exit: 0 }), T1);
    expect(dismissed.finding?.state).toBe('dismissed');
    expect(dismissed.change).toBe('recurred');
  });

  it('only a fail touches the finding ledger', () => {
    const r = run();
    for (const p of [
      executed(r, { exit: 2 }),
      executeScoutProbe(r, probe(), failing, { input: { exit: 0 }, evidence: {}, capabilities: CAPS, now: T0 }),
      executeScoutProbe(r, probe(), failing, { input: { exit: 0 }, evidence: EVIDENCE, capabilities: [], now: T0 }),
    ]) {
      expect(applyScoutFailure(null, r, p, T0)).toEqual({ finding: null, change: 'ignored' });
    }
  });

  it('a pass resolves an open finding at the passing SHA; anything else leaves it alone', () => {
    const r1 = run();
    const first = applyScoutFailure(null, r1, executed(r1, { exit: 0 }), T0).finding!;
    const r2 = run({ id: 'run-2', candidate: { ref: 'main', sha: SHA2 } });
    expect(resolveScoutFinding(first, r2, T1)).toMatchObject({
      change: 'resolved',
      finding: { state: 'resolved', resolvedRunId: 'run-2', resolvedSha: SHA2, resolvedAt: T1.toISOString() },
    });
    expect(resolveScoutFinding({ ...first, state: 'dismissed' }, r2, T1).change).toBe('unchanged');
  });
});

describe('findings — reproducibility', () => {
  it('a known reproducibility from the executor is stored; unknown never overwrites a known one', () => {
    const r1 = run();
    const created = applyScoutFailure(null, r1, executed(r1, { exit: 0 }), T0, 'deterministic').finding!;
    expect(created.reproducibility).toBe('deterministic');
    const r2 = run({ id: 'run-2' });
    expect(applyScoutFailure(created, r2, executed(r2, { exit: 0 }), T1, 'unknown').finding!.reproducibility).toBe('deterministic');
    const r3 = run({ id: 'run-3' });
    expect(applyScoutFailure(created, r3, executed(r3, { exit: 0 }), T1, 'intermittent').finding!.reproducibility).toBe('intermittent');
  });

  it('defaults to unknown when the caller does not say', () => {
    const r = run();
    expect(applyScoutFailure(null, r, executed(r, { exit: 0 }), T0).finding!.reproducibility).toBe('unknown');
  });
});

describe('ledger writes never touch the action columns', () => {
  it('the recurrence update omits action_state and action_task_id, which the action claim owns', () => {
    const r = run();
    const f = { ...applyScoutFailure(null, r, executed(r, { exit: 0 }), T0).finding!, actionState: 'filed' as const, actionTaskId: 'task-1' };
    const set = scoutFindingLedgerSet(f);
    expect(set).not.toHaveProperty('actionState');
    expect(set).not.toHaveProperty('actionTaskId');
    expect(set.occurrenceCount).toBe(1);
    // The insert of a new row still carries them (their defaults).
    expect(scoutFindingRow(f)).toHaveProperty('actionState', 'filed');
  });
});

describe('dismissal', () => {
  it('a new finding starts undismissed', () => {
    const r = run();
    expect(applyScoutFailure(null, r, executed(r, { exit: 0 }), T0).finding).toMatchObject({
      dismissedReason: null,
      dismissedAt: null,
      dismissedBy: null,
    });
  });

  it('scoutDismissal needs a reason and who; trims and clips the reason', () => {
    expect(scoutDismissal({ reason: '  ', by: 'user:u-1', now: T0 })).toEqual({ ok: false, error: 'reason_required' });
    expect(scoutDismissal({ reason: 'not a defect', by: '', now: T0 })).toEqual({ ok: false, error: 'by_required' });
    expect(scoutDismissal({ reason: '  flaky env  ', by: 'user:u-1', now: T0 })).toEqual({
      ok: true,
      fields: { state: 'dismissed', dismissedReason: 'flaky env', dismissedBy: 'user:u-1', dismissedAt: T0 },
    });
    const long = scoutDismissal({ reason: 'x'.repeat(2000), by: 'user:u-1', now: T0 });
    expect(long.ok && long.fields.dismissedReason.length).toBe(500);
  });

  it('a recurrence keeps a dismissal and its reason', () => {
    const r1 = run();
    const first = applyScoutFailure(null, r1, executed(r1, { exit: 0 }), T0).finding!;
    const dismissed = { ...first, state: 'dismissed' as const, dismissedReason: 'expected', dismissedBy: 'user:u-1', dismissedAt: T0.toISOString() };
    const r2 = run({ id: 'run-2' });
    expect(applyScoutFailure(dismissed, r2, executed(r2, { exit: 0 }), T1).finding).toMatchObject({
      state: 'dismissed',
      dismissedReason: 'expected',
      occurrenceCount: 2,
    });
  });

  it('the recurrence write never carries the dismissal columns', () => {
    const r = run();
    const set = scoutFindingLedgerSet(applyScoutFailure(null, r, executed(r, { exit: 0 }), T0).finding!);
    for (const k of ['dismissedReason', 'dismissedAt', 'dismissedBy']) expect(set).not.toHaveProperty(k);
  });

  it('a recurrence read before a dismissal cannot write over it: its compare-and-set also requires the row is not dismissed', () => {
    const r = run();
    const open = applyScoutFailure(null, r, executed(r, { exit: 0 }), T0).finding!;
    const q = new PgDialect().sqlToQuery(scoutFindingCasWhere(open, 1)!);
    expect(q.sql).toContain('"state" <> $');
    expect(q.params).toContain('dismissed');
    // Merging into an already-dismissed row needs no such guard: it keeps the state.
    const q2 = new PgDialect().sqlToQuery(scoutFindingCasWhere({ ...open, state: 'dismissed' }, 1)!);
    expect(q2.sql).not.toContain('"state" <>');
  });
});

describe('recordScoutFailure — compare-and-set on occurrence count', () => {
  function memoryStore(initial: ScoutFinding | null, opts: { raceOnce?: boolean } = {}) {
    let row = initial;
    let raced = false;
    const store: ScoutFindingStore = {
      async find() { return row; },
      async insert(f) {
        if (row) return false;
        row = f;
        return true;
      },
      async update(f, expectedCount) {
        if (opts.raceOnce && !raced) {
          raced = true;
          row = { ...row!, occurrenceCount: row!.occurrenceCount + 1, lastSeenRunId: 'run-other' };
          return false;
        }
        if (!row || row.occurrenceCount !== expectedCount) return false;
        row = f;
        return true;
      },
    };
    return { store, get: () => row };
  }

  it('inserts the first occurrence', async () => {
    const r = run();
    const m = memoryStore(null);
    expect(await recordScoutFailure(r, executed(r, { exit: 0 }), { store: m.store, now: () => T0 })).toBe('created');
    expect(m.get()?.occurrenceCount).toBe(1);
  });

  it('re-reads and re-merges after losing a race, so no occurrence is lost', async () => {
    const r1 = run();
    const first = applyScoutFailure(null, r1, executed(r1, { exit: 0 }), T0).finding!;
    const m = memoryStore(first, { raceOnce: true });
    const r2 = run({ id: 'run-2' });
    expect(await recordScoutFailure(r2, executed(r2, { exit: 0 }), { store: m.store, now: () => T1 })).toBe('recurred');
    expect(m.get()?.occurrenceCount).toBe(3);
    expect(m.get()?.lastSeenRunId).toBe('run-2');
  });

  it('never throws; a store error is reported as failed', async () => {
    const r = run();
    const store: ScoutFindingStore = {
      find: async () => { throw new Error('db down'); },
      insert: async () => true,
      update: async () => true,
    };
    expect(await recordScoutFailure(r, executed(r, { exit: 0 }), { store, now: () => T0 })).toBe('failed');
  });

  it('a non-fail result writes nothing', async () => {
    const r = run();
    const m = memoryStore(null);
    expect(await recordScoutFailure(r, executed(r, { exit: 2 }), { store: m.store, now: () => T0 })).toBe('ignored');
    expect(m.get()).toBeNull();
  });
});

describe('schema', () => {
  const uniques = (t: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(t).indexes.filter(i => i.config.unique).map(i => i.config.columns.map(c => (c as { name: string }).name));

  it('runs record the exercised ref and SHA', () => {
    const cols = getTableConfig(qualityScoutRuns).columns.map(c => c.name);
    for (const c of ['candidate_ref', 'candidate_sha', 'prior_run_id', 'prior_sha', 'mode', 'status', 'budget', 'policy_version']) {
      expect(cols).toContain(c);
    }
  });

  it('runs carry the operational metrics readout', () => {
    expect(getTableConfig(qualityScoutRuns).columns.map(c => c.name)).toContain('metrics');
    const r = run();
    expect(scoutRunRow(r).metrics).toBeNull();
  });

  it('one probe row per candidate per run', () => {
    expect(uniques(qualityScoutProbes)).toContainEqual(['run_id', 'candidate_id']);
  });

  it('findings carry a dismissal reason, time and actor', () => {
    const cols = getTableConfig(qualityScoutFindings).columns.map(c => c.name);
    for (const c of ['dismissed_reason', 'dismissed_at', 'dismissed_by']) expect(cols).toContain(c);
  });

  it('one finding per workspace and signature', () => {
    expect(uniques(qualityScoutFindings)).toContainEqual(['workspace_id', 'signature']);
  });
});

// ── Runner-host parking ─────────────────────────────────────────────────────

describe('parked runs', () => {
  const parking = (over: Partial<ScoutRunParking> = {}): ScoutRunParking => ({
    parkedAt: T0.toISOString(),
    hostDeadline: new Date(T0.getTime() + 30 * 60_000).toISOString(),
    runnerMaxDurationMs: 20 * 60_000,
    profile: { capabilities: [] } as unknown as ScoutRunParking['profile'],
    plan: {
      candidatesGenerated: 1, candidatesTruncated: 0, decisionsAsked: 1, decisionFailures: 0, costCapHit: false,
      stages: { profile: { ms: 1, costUsd: null }, signals: { ms: 0, costUsd: null }, generate: { ms: 0, costUsd: null }, select: { ms: 2, costUsd: 0.001 }, execute: { ms: 3, costUsd: null }, act: { ms: 0, costUsd: null } },
      warnings: ['w'], deadlineHit: false, reproducibility: { a: 'deterministic' },
    },
    lease: null,
    leaseLapses: 0,
    ...over,
  });
  const at = (min: number) => new Date(T0.getTime() + min * 60_000);

  it('awaiting_host is a run status', () => {
    expect(SCOUT_RUN_STATUSES).toContain('awaiting_host');
  });

  it('expires at its deadline as no_runner_claimed when nobody ever held it', () => {
    expect(scoutParkingExpiry(parking(), at(29))).toBeNull();
    expect(scoutParkingExpiry(parking(), at(30))).toBe('no_runner_claimed');
  });

  it('a lease that lapses once is not yet expiry; twice is runner_host_lost, deadline or not', () => {
    const held = parking({ lease: { holder: 'r', expiresAt: at(5).toISOString() } });
    expect(scoutParkingExpiry(held, at(4))).toBeNull();
    expect(scoutParkingExpiry(held, at(6))).toBeNull();
    expect(scoutParkingExpiry({ ...held, leaseLapses: 1 }, at(6))).toBe('runner_host_lost');
    expect(scoutParkingExpiry({ ...held, leaseLapses: 1 }, at(4))).toBeNull();
    expect(scoutParkingExpiry(held, at(31))).toBe('runner_host_lost');
  });

  it('expires only runner probes without a result, as unsupported — never pass', () => {
    const r = run();
    const runner = { ...probe({ id: 'runner' }), host: 'runner' as const };
    const server = { ...probe({ id: 'server' }), host: 'server' as const };
    const done = executed(r, { exit: 0 }, { ...probe({ id: 'done' }), host: 'runner' as const } as ScoutProbeRecord);
    const skipped = { ...scoutProbeRecord({ ...CANDIDATE, id: 'skip' }, { status: 'skipped', reason: 'deferred', reasonCode: null }), host: undefined };
    const out = expireRunnerProbes(r, [runner, server, done, skipped], 'no_runner_claimed', T1);
    expect(out.expired).toBe(1);
    expect(out.probes[0].result).toMatchObject({ verdict: 'unsupported', reason: 'no_runner_claimed' });
    expect(out.probes[1].result).toBeNull();
    expect(out.probes[2]).toBe(done);
    expect(out.probes[3].result).toBeNull();
  });

  it('a parked run and its probe hosts round-trip through their rows', () => {
    const r: ScoutRun = { ...run(), status: 'awaiting_host', parking: parking({ lease: { holder: 'runner-1', expiresAt: at(25).toISOString() }, leaseLapses: 1 }) };
    const row = { ...scoutRunRow(r), createdAt: T0 } as Parameters<typeof scoutRunFromRow>[0];
    expect(row.hostLeaseLapses).toBe(1);
    expect(scoutRunFromRow(row)).toEqual(r);
    const p = { ...probe(), host: 'runner' as const };
    const prow = { ...scoutProbeRow(r, p), id: 'x', createdAt: T0, updatedAt: T0 } as Parameters<typeof scoutProbeFromRow>[0];
    expect(prow.host).toBe('runner');
    expect(scoutProbeFromRow(prow)).toEqual(p);
  });

  it('a run that never parked writes no host state and reads back without parking', () => {
    const row = { ...scoutRunRow(run()), createdAt: T0 } as Parameters<typeof scoutRunFromRow>[0];
    expect(row.hostState).toBeNull();
    expect(row.hostDeadline).toBeNull();
    expect(scoutRunFromRow(row).parking).toBeNull();
  });
});

describe('clampScoutCaptureProbes', () => {
  it('defaults to one surface probe per run, allows 0, and caps the top', async () => {
    const { clampScoutCaptureProbes } = await import('../quality-scout/ledger');
    expect(clampScoutCaptureProbes(undefined)).toBe(1);
    expect(clampScoutCaptureProbes('2')).toBe(1);
    expect(clampScoutCaptureProbes(0)).toBe(0);
    expect(clampScoutCaptureProbes(-4)).toBe(0);
    expect(clampScoutCaptureProbes(2.7)).toBe(2);
    expect(clampScoutCaptureProbes(99)).toBe(3);
  });
});
