import { describe, it, expect } from 'bun:test';
import type { DecisionRequest } from '@builddai/ai-kit/decide';
import type { ScoutProbeFeatures } from '../decision-kind-scout-probe-selection';
import type { ScoutProbeCandidate, ScoutCandidateSet, ScoutProbeFamily, ScoutSeverity, ScoutSignalType } from '../quality-scout/candidates';
import {
  selectScoutProbes,
  createScoutProbeDecider,
  DEFAULT_SCOUT_BUDGET,
  DEFAULT_MAX_MUST_RUN,
  type ScoutProbeDecider,
} from '../quality-scout/selector';

let n = 0;
function cand(over: Partial<ScoutProbeCandidate> & { signal?: ScoutSignalType } = {}): ScoutProbeCandidate {
  n++;
  const { signal = 'change', ...rest } = over;
  return {
    id: `sc_${n}`,
    family: 'contract' as ScoutProbeFamily,
    probeKind: 'api_contract',
    title: `candidate ${n}`,
    hypothesis: 'h',
    invariant: `invariant ${n}`,
    grounding: 'change',
    sourceSignals: [{ type: signal, ref: `ref-${n}` }],
    anchor: `area-${n}`,
    paths: [`area-${n}/file.go`],
    touchesChangedPaths: true,
    severity: 'medium' as ScoutSeverity,
    priorFailures: 0,
    preconditions: ['cli-journey'],
    // One distinct execution per candidate unless a test says otherwise.
    executor: `cli-journey:j${n}`,
    supported: true,
    estimatedCost: 'medium',
    evidenceRequirements: ['x'],
    ...rest,
  };
}

const set = (candidates: ScoutProbeCandidate[], changedFiles = 10): ScoutCandidateSet => ({ candidates, truncated: 0, changedFiles, warnings: [] });

/** A decider that records what it was asked and answers from a table. */
function recorder(answer: (f: ScoutProbeFeatures, req: DecisionRequest<ScoutProbeFeatures>) => 'run' | 'defer' | 'unsupported' = () => 'run') {
  const asked: DecisionRequest<ScoutProbeFeatures>[] = [];
  const decide: ScoutProbeDecider = async (req) => {
    asked.push(req);
    return { decision: answer(req.features, req), reasonCode: 'model_x', source: 'model' };
  };
  return { decide, asked };
}

const ids = (xs: readonly { candidate: ScoutProbeCandidate }[]) => xs.map((x) => x.candidate.id);

describe('selectScoutProbes — budget', () => {
  it('selects at most the default budget, which is between 3 and 5', async () => {
    expect(DEFAULT_SCOUT_BUDGET).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_SCOUT_BUDGET).toBeLessThanOrEqual(5);
    const cs = Array.from({ length: 12 }, (_, i) => cand({ family: (['contract', 'surface', 'persistence', 'release', 'state-transition'] as const)[i % 5] }));
    const r = await selectScoutProbes(set(cs), recorder().decide);
    expect(r.selected).toHaveLength(DEFAULT_SCOUT_BUDGET);
    expect(r.budget).toBe(DEFAULT_SCOUT_BUDGET);
  });

  it('honours a configured budget and never exceeds it, even with many must-run candidates', async () => {
    const cs = Array.from({ length: 8 }, (_, i) => cand({ severity: 'critical', family: (['contract', 'surface', 'persistence', 'release'] as const)[i % 4] }));
    const r = await selectScoutProbes(set(cs), recorder().decide, { budget: 2 });
    expect(r.selected.length).toBeLessThanOrEqual(2);
  });

  it('accounts for every candidate exactly once: selected or skipped with a reason', async () => {
    const cs = Array.from({ length: 10 }, () => cand());
    const r = await selectScoutProbes(set(cs), recorder((f) => (f.priorFailures > 0 ? 'run' : 'defer')).decide);
    const all = [...ids(r.selected), ...ids(r.skipped)].sort();
    expect(all).toEqual(cs.map((c) => c.id).sort());
    for (const s of r.skipped) expect(s.reason).toBeTruthy();
  });

  it('bounds the number of decisions asked', async () => {
    const cs = Array.from({ length: 40 }, () => cand());
    const rec = recorder(() => 'defer');
    const r = await selectScoutProbes(set(cs), rec.decide, { budget: 3 });
    expect(rec.asked.length).toBeLessThanOrEqual(9);
    expect(r.decisionsAsked).toBe(rec.asked.length);
    expect(r.skipped.some((s) => s.reason === 'not_considered')).toBe(true);
  });
});

describe('selectScoutProbes — deterministic must-run', () => {
  it('runs a critical candidate on changed paths without asking the decision model', async () => {
    const critical = cand({ severity: 'critical' });
    const rec = recorder(() => 'defer');
    const r = await selectScoutProbes(set([cand(), critical]), rec.decide);
    const pick = r.selected.find((s) => s.candidate.id === critical.id);
    expect(pick?.via).toBe('must_run');
    expect(pick?.reasonCode).toBe('critical_on_changed_path');
    expect(rec.asked.map((a) => a.subjectRef?.id)).not.toContain(critical.id);
  });

  it('re-checks a prior high/critical finding that touches changed paths', async () => {
    const prior = cand({ severity: 'high', signal: 'prior-finding', grounding: 'history' });
    const r = await selectScoutProbes(set([prior]), recorder(() => 'defer').decide);
    expect(r.selected[0]).toMatchObject({ via: 'must_run', reasonCode: 'prior_severe_finding_touched' });
  });

  it('runs a touched high-severity critical path the owner declared', async () => {
    const cp = cand({ severity: 'high', signal: 'critical-path', grounding: 'config' });
    const r = await selectScoutProbes(set([cp]), recorder(() => 'defer').decide);
    expect(r.selected[0]).toMatchObject({ via: 'must_run', reasonCode: 'critical_path_touched' });
  });

  it('keeps the must-run set deliberately short; the rest compete normally', async () => {
    const severe = Array.from({ length: 5 }, (_, i) => cand({ severity: 'critical', family: (['contract', 'surface', 'persistence', 'release', 'state-transition'] as const)[i] }));
    const r = await selectScoutProbes(set(severe), recorder(() => 'defer').decide, { budget: 5 });
    expect(r.selected.filter((s) => s.via === 'must_run')).toHaveLength(DEFAULT_MAX_MUST_RUN);
    expect(DEFAULT_MAX_MUST_RUN).toBeLessThan(DEFAULT_SCOUT_BUDGET);
  });

  it('an untouched critical candidate is not must-run (history alone is not proof)', async () => {
    const stale = cand({ severity: 'critical', touchesChangedPaths: false, grounding: 'history', signal: 'failure' });
    const rec = recorder(() => 'defer');
    const r = await selectScoutProbes(set([stale]), rec.decide);
    expect(r.selected).toHaveLength(0);
    expect(rec.asked).toHaveLength(1);
  });

  it('an unsupported must-run candidate is recorded as unsupported, never silently selected or dropped', async () => {
    const blocked = cand({ severity: 'critical', supported: false, executor: null, unsupportedReason: 'no migrations' });
    const r = await selectScoutProbes(set([blocked]), recorder().decide);
    expect(r.selected).toHaveLength(0);
    expect(r.skipped[0]).toMatchObject({ reason: 'unsupported', detail: 'no migrations' });
  });
});

describe('selectScoutProbes — decision stage', () => {
  it('asks the kind with bounded structured metadata only — no titles, paths or invariants', async () => {
    const c = cand({ priorFailures: 3, title: 'secret title', invariant: 'secret invariant' });
    const rec = recorder();
    await selectScoutProbes(set([c], 42), rec.decide, { budget: 4 });
    const [req] = rec.asked;
    expect(Object.keys(req.features).sort()).toEqual(
      ['budgetRemaining', 'changedFiles', 'mustRun', 'priorFailures', 'probeKind', 'supported', 'touchesChangedPaths'].sort(),
    );
    expect(req.features).toMatchObject({ probeKind: 'api_contract', supported: true, mustRun: false, priorFailures: 3, changedFiles: 42, budgetRemaining: 4 });
    expect(req.subjectRef).toEqual({ type: 'scout_candidate', id: c.id });
    expect(JSON.stringify(req)).not.toMatch(/secret/);
  });

  it('selects what the kind says to run and records what it defers', async () => {
    const a = cand({ priorFailures: 1 });
    const b = cand({ family: 'surface' });
    const r = await selectScoutProbes(set([a, b]), recorder((f) => (f.priorFailures > 0 ? 'run' : 'defer')).decide);
    expect(ids(r.selected)).toEqual([a.id]);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'deferred' })]);
    expect(r.skipped[0].candidate.id).toBe(b.id);
  });

  it('on a decider that throws, uses the kind\'s deterministic fallback and stays bounded', async () => {
    const touched = cand();
    const untouched = cand({ touchesChangedPaths: false, family: 'surface' });
    const boom: ScoutProbeDecider = async () => { throw new Error('provider down'); };
    const r = await selectScoutProbes(set([touched, untouched]), boom);
    expect(ids(r.selected)).toEqual([touched.id]);
    expect(r.selected[0]).toMatchObject({ decisionSource: 'fallback' });
    expect(r.selected[0].reasonCode).toMatch(/^heuristic_run_provider_failure/);
    expect(r.decisionFailures).toBe(2);
  });

  it('treats an answer outside the kind\'s decision set as a failure and falls back', async () => {
    const weird: ScoutProbeDecider = async () => ({ decision: 'maybe' as never, reasonCode: 'x', source: 'model' });
    const r = await selectScoutProbes(set([cand()]), weird);
    expect(r.selected[0].decisionSource).toBe('fallback');
    expect(r.decisionFailures).toBe(1);
  });
});

describe('selectScoutProbes — independence', () => {
  it('skips a near-duplicate that shares an anchor with a selected probe', async () => {
    const a = cand({ anchor: 'internal/billing', family: 'contract' });
    const b = cand({ anchor: 'internal/billing', family: 'contract', probeKind: 'regression', signal: 'failure' });
    const r = await selectScoutProbes(set([a, b]), recorder().decide);
    expect(ids(r.selected)).toEqual([a.id]);
    expect(r.skipped[0]).toMatchObject({ reason: 'near_duplicate', duplicateOf: a.id });
  });

  it('a different family on the same changed area is a different hypothesis, not a duplicate', async () => {
    // One area holding both UI and non-UI changes yields a contract and a surface candidate with the same anchor.
    const contract = cand({ anchor: 'apps/web', family: 'contract', paths: ['apps/web/src/lib/a.ts'] });
    const surface = cand({ anchor: 'apps/web', family: 'surface', probeKind: 'visual', executor: 'ui-surface', paths: ['apps/web/src/app/page.tsx'] });
    const r = await selectScoutProbes(set([contract, surface]), recorder().decide);
    expect(ids(r.selected)).toEqual([contract.id, surface.id]);
  });

  it('an anchor shared across families never makes one hypothesis a duplicate of another', async () => {
    // A changed package holding a schema file yields persistence and contract candidates on one anchor.
    const persistence = cand({ anchor: 'packages/core', family: 'persistence', probeKind: 'spec_invariant', paths: ['packages/core/db/schema.ts'] });
    const contract = cand({ anchor: 'packages/core', family: 'contract', paths: ['packages/core/index.ts'] });
    const r = await selectScoutProbes(set([persistence, contract]), recorder().decide);
    expect(ids(r.selected)).toEqual([persistence.id, contract.id]);
  });

  it('an unsupported candidate is never the reason a supported one is skipped', async () => {
    const persistence = cand({ anchor: 'packages/core', family: 'persistence', supported: false, executor: null, unsupportedReason: 'none' });
    const contract = cand({ anchor: 'packages/core', family: 'contract' });
    const r = await selectScoutProbes(set([persistence, contract]), recorder().decide);
    expect(ids(r.selected)).toEqual([contract.id]);
  });

  it('hypotheses that would run the same command are one probe: the rest do not spend budget slots', async () => {
    const a = cand({ family: 'contract', executor: 'verification-command' });
    const b = cand({ family: 'persistence', probeKind: 'spec_invariant', executor: 'verification-command' });
    const c = cand({ family: 'release', probeKind: 'spec_invariant', executor: 'verification-command' });
    const other = cand({ family: 'state-transition', probeKind: 'regression' });
    const rec = recorder();
    const r = await selectScoutProbes(set([a, b, c, other]), rec.decide, { budget: 4 });
    expect(ids(r.selected)).toEqual([a.id, other.id]);
    expect(r.skipped).toEqual([
      expect.objectContaining({ reason: 'near_duplicate', duplicateOf: a.id }),
      expect.objectContaining({ reason: 'near_duplicate', duplicateOf: a.id }),
    ]);
    expect(rec.asked.map((q) => q.subjectRef?.id)).toEqual([a.id, other.id]);
  });

  it('spec and readiness probes read their own signals, so a shared executor is not the same execution', async () => {
    const a = cand({ family: 'contract', probeKind: 'spec_invariant', executor: 'spec' });
    const b = cand({ family: 'contract', probeKind: 'spec_invariant', executor: 'spec' });
    const r = await selectScoutProbes(set([a, b]), recorder().decide);
    expect(ids(r.selected)).toEqual([a.id, b.id]);
  });

  it('skips a same-kind candidate whose paths largely overlap a selected one', async () => {
    const paths = ['x/a.go', 'x/b.go', 'x/c.go'];
    const a = cand({ paths });
    const b = cand({ paths: [...paths, 'x/d.go'] });
    const r = await selectScoutProbes(set([a, b]), recorder().decide);
    expect(ids(r.selected)).toEqual([a.id]);
    expect(r.skipped[0].reason).toBe('near_duplicate');
  });

  it('caps one probe family so five variants of one hypothesis family cannot fill the run', async () => {
    const cs = Array.from({ length: 6 }, () => cand({ family: 'contract' }));
    const others = [cand({ family: 'surface' }), cand({ family: 'release' })];
    const r = await selectScoutProbes(set([...cs, ...others]), recorder().decide, { budget: 5 });
    const contract = r.selected.filter((s) => s.candidate.family === 'contract');
    expect(contract.length).toBeLessThanOrEqual(2);
    expect(r.selected.map((s) => s.candidate.family)).toEqual(expect.arrayContaining(['surface', 'release']));
    expect(r.skipped.some((s) => s.reason === 'family_cap')).toBe(true);
  });

  it('does not spend a decision on an unsupported, duplicate or capped candidate', async () => {
    const a = cand({ anchor: 'same' });
    const dup = cand({ anchor: 'same' });
    const blocked = cand({ supported: false, executor: null, unsupportedReason: 'none' });
    const rec = recorder();
    await selectScoutProbes(set([a, dup, blocked]), rec.decide);
    expect(rec.asked.map((q) => q.subjectRef?.id)).toEqual([a.id]);
  });
});

/** A decider that charges a fixed cost per call, reported through `spent()` like the server's receipt sink. */
function charging(perCall: number, answer: () => 'run' | 'defer' = () => 'defer') {
  let spent = 0;
  let calls = 0;
  const decide: ScoutProbeDecider = async () => {
    calls++;
    spent += perCall;
    return { decision: answer(), reasonCode: 'model_x', source: 'model' };
  };
  return { decide, spent: () => spent, calls: () => calls };
}

const spread = (k: number, over: Partial<ScoutProbeCandidate> = {}) =>
  Array.from({ length: k }, (_, i) => cand({ family: (['contract', 'surface', 'persistence', 'release', 'state-transition'] as const)[i % 5], ...over }));

describe('selectScoutProbes — cost cap', () => {
  it('makes no decision call that would take spend past the cap', async () => {
    const c = charging(0.01);
    const r = await selectScoutProbes(set(spread(10)), c.decide, { budget: 4, cost: { maxUsd: 0.025, spent: c.spent } });
    // 0.01 + 0.01 = 0.02; a third call would reach 0.03 > 0.025.
    expect(c.calls()).toBe(2);
    expect(c.spent()).toBeLessThanOrEqual(0.025);
    expect(r.decisionsAsked).toBe(2);
    expect(r.costCapHit).toBe(true);
  });

  it('never calls the decider when spend is already at the cap', async () => {
    const c = charging(0.01);
    const r = await selectScoutProbes(set(spread(6)), c.decide, { cost: { maxUsd: 0.01, spent: () => 0.01 } });
    expect(c.calls()).toBe(0);
    expect(r.decisionsAsked).toBe(0);
    expect(r.costCapHit).toBe(true);
  });

  it('fills the remaining slots with the deterministic fallback instead of dropping them', async () => {
    const c = charging(0.01);
    const r = await selectScoutProbes(set(spread(8)), c.decide, { budget: 4, cost: { maxUsd: 0.015, spent: c.spent } });
    expect(c.calls()).toBe(1);
    // Every candidate touches the changed paths, so the fallback runs them.
    expect(r.selected).toHaveLength(4);
    const capped = r.selected.filter((s) => s.reasonCode.endsWith('cost_cap'));
    expect(capped.length).toBe(4);
    for (const s of capped) expect(s.decisionSource).toBe('fallback');
    expect(r.decisionsCapped).toBeGreaterThanOrEqual(4);
    // A capped decision is not a failed one.
    expect(r.decisionFailures).toBe(0);
    for (const s of r.skipped) expect(s.reason).not.toBe('not_considered');
  });

  it('the fallback defers a capped candidate that does not touch the change', async () => {
    const c = charging(0.01);
    const r = await selectScoutProbes(set(spread(3, { touchesChangedPaths: false })), c.decide, { cost: { maxUsd: 0, spent: c.spent } });
    expect(c.calls()).toBe(0);
    expect(r.selected).toHaveLength(0);
    for (const s of r.skipped) expect(s).toMatchObject({ reason: 'deferred', reasonCode: 'heuristic_defer_cost_cap' });
  });

  it('without a cap, or when the decider cannot report spend, selection is bounded only by the decision limit', async () => {
    const a = charging(1);
    const ra = await selectScoutProbes(set(spread(6)), a.decide, { budget: 2 });
    expect(ra.costCapHit).toBe(false);
    expect(ra.decisionsCapped).toBe(0);
    expect(a.calls()).toBe(6);

    const b = charging(1);
    const rb = await selectScoutProbes(set(spread(6)), b.decide, { budget: 2, cost: { maxUsd: 0.5, spent: () => null } });
    expect(rb.costCapHit).toBe(false);
    expect(b.calls()).toBe(6);
  });
});

describe('createScoutProbeDecider', () => {
  it('runs the shared kind; with the capability off it returns the kind\'s fallback, never a provider name', async () => {
    const decide = createScoutProbeDecider(
      { teamId: 'team-1', workspaceId: 'ws-1' },
      {
        resolveAccess: (async () => ({ ok: false, error: { kind: 'capability_disabled', capability: 'scout_probe_selection' } })) as never,
        record: false,
      },
    );
    const run = await decide({
      features: { probeKind: 'api_contract', supported: true, mustRun: false, touchesChangedPaths: true, priorFailures: 0, changedFiles: 3, budgetRemaining: 3 },
    });
    expect(run).toMatchObject({ decision: 'run', source: 'fallback' });
    const defer = await decide({
      features: { probeKind: 'visual', supported: true, mustRun: false, touchesChangedPaths: false, priorFailures: 0, changedFiles: 3, budgetRemaining: 3 },
    });
    expect(defer.decision).toBe('defer');
  });

  it('end to end: a disabled kind still yields a bounded, coverage-leaning selection', async () => {
    const decide = createScoutProbeDecider(
      { teamId: 'team-1' },
      { resolveAccess: (async () => { throw new Error('db down'); }) as never, record: false },
    );
    const cs = Array.from({ length: 10 }, (_, i) => cand({ family: (['contract', 'surface', 'persistence', 'release', 'state-transition'] as const)[i % 5] }));
    const r = await selectScoutProbes(set(cs), decide, { budget: 3 });
    expect(r.selected).toHaveLength(3);
    for (const s of r.selected) expect(s.decisionSource).toBe('fallback');
  });
});

describe('selectScoutProbes — hosts', () => {
  it('a candidate no available host can run is skipped no_host, costing no decision and no slot', async () => {
    const cmd = cand({ executor: 'cli-journey:only-a-runner' });
    const ok = (['contract', 'surface', 'persistence', 'release'] as const).map((family) => cand({ family }));
    const r = recorder();
    const out = await selectScoutProbes(set([cmd, ...ok]), r.decide, {
      budget: 4,
      hostable: (c) => (c.id === cmd.id ? 'no_runner_host' : null),
    });
    expect(ids(out.selected)).toEqual(ok.map((c) => c.id));
    expect(out.skipped).toEqual([expect.objectContaining({ reason: 'no_host', reasonCode: 'no_runner_host' })]);
    expect(r.asked.some((q) => q.subjectRef?.id === cmd.id)).toBe(false);
  });

  it('applies to must-run candidates too: nothing is promised that no host can run', async () => {
    const severe = cand({ severity: 'critical' });
    const out = await selectScoutProbes(set([severe]), recorder().decide, { hostable: () => 'no_runner_host' });
    expect(out.selected).toEqual([]);
    expect(out.skipped[0].reason).toBe('no_host');
  });

  it('without hostable, selection is unchanged', async () => {
    const cs = Array.from({ length: 3 }, () => cand());
    const a = await selectScoutProbes(set(cs), recorder().decide);
    const b = await selectScoutProbes(set(cs), recorder().decide, { hostable: () => null });
    expect(ids(b.selected)).toEqual(ids(a.selected));
  });
});

describe('selectScoutProbes — capture cap', () => {
  const surface = (over: Partial<ScoutProbeCandidate> = {}) => cand({ family: 'surface', probeKind: 'visual', executor: 'ui-surface', ...over });
  const needsCapture = (c: ScoutProbeCandidate) => !!c.executor?.startsWith('ui-surface');

  it('selects at most max surface probes; the rest are skipped over_budget before costing a decision, and the slot goes to a cheaper probe', async () => {
    const a = surface({ anchor: 'ui-a', paths: ['ui-a/page.tsx'] });
    const b = surface({ anchor: 'ui-b', paths: ['ui-b/page.tsx'], executor: 'ui-surface:other', invariant: 'other' });
    const cmd = cand();
    const r = recorder();
    const out = await selectScoutProbes(set([a, b, cmd]), r.decide, { budget: 3, capture: { max: 1, needsCapture } });
    expect(ids(out.selected)).toEqual([a.id, cmd.id]);
    expect(out.skipped).toEqual([expect.objectContaining({ candidate: b, reason: 'over_budget', reasonCode: 'max_capture_probes' })]);
    expect(r.asked.some((q) => q.subjectRef?.id === b.id)).toBe(false);
  });

  it('max 0 turns surface probes off; must-run candidates obey the cap too', async () => {
    const severe = surface({ severity: 'critical' });
    const out = await selectScoutProbes(set([severe]), recorder().decide, { capture: { max: 0, needsCapture } });
    expect(out.selected).toEqual([]);
    expect(out.skipped[0]).toMatchObject({ reason: 'over_budget', reasonCode: 'max_capture_probes' });
  });
});
