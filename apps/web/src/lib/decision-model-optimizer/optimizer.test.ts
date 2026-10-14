import { describe, expect, it } from 'bun:test';
import { setDecisionModelForKind } from '@buildd/core/decision-model-store';
import { readDecisionModel, readDecisionModelOverrides, type DecisionModelRoute } from '@buildd/core/decision-model';
import type { StoredMeasurement } from '@buildd/core/decision-model-measurements';
import type { DecisionLedgerInput } from '@buildd/core/decision-ledger';
import type { ModelComparisonInput, ModelComparisonOutcome } from '../prompt-evals/compare-run';
import type { PromptEvalResultRow } from '../prompt-evals/run';
import {
  JEV_ROUTE,
  OPTIMIZER_PIN_MS,
  checkAutoReverts,
  optimizeTeam,
  planKindSwitch,
  runOptimizerSweep,
  switchFeed,
  undoSwitch,
  type ModelResult,
  type OptimizerDeps,
  type SwitchRow,
} from './optimizer';

// Synthetic fixtures only: made-up team ids and scores.
const TEAM = 'team-a';
const KIND = 'buildd.post_session_triage';
const CLEF: DecisionModelRoute = { endpoint: 'systemone', model: 'clef', via: 'cloudflare' };
const FLASH: DecisionModelRoute = { endpoint: 'systemone', model: 'clef-flash', via: 'cloudflare' };
const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 86_400_000;

type Derived = { coverage: number; precision: number; threshold?: number; source?: 'confidence' | 'top_p' } | null;

/** One comparison result row as compare-run stores it. */
function row(model: string, via: string, derived: Derived, opts: { labelled?: number; notRun?: number; status?: 'scored' | 'no_key'; kind?: string } = {}): PromptEvalResultRow {
  const d = derived ? {
    source: derived.source ?? 'top_p', threshold: derived.threshold ?? 0.7, coverage: derived.coverage, precision: derived.precision, wilsonLower: 0.91,
  } : null;
  return {
    runId: 'run-1', benchmarkSet: opts.kind ?? KIND, promptId: opts.kind ?? KIND, promptSource: 'replay', promptRowVersion: null,
    promptHash: 'h', promptVersion: 'v', model, status: 'scored', cases: 100, accuracy: 0.9, baselineAccuracy: 0.8,
    coverageAt90: null, accuracyAt90: null, errors: 0, notRun: opts.notRun ?? 0, costUsd: 0, caseSource: 'collected', caseOrigin: 'replay',
    metrics: {
      via, status: opts.status ?? 'scored', target: { target: 0.9, minLabelled: 50 }, labelled: opts.labelled ?? 100,
      derived: d, thresholds: { confidence: { bar: 0.9 }, top_p: { bar: 0.9 } },
    },
  };
}

const JEV_ID = JEV_ROUTE.model;

interface World {
  deps: OptimizerDeps;
  stored: { value: unknown };
  optedIn: Set<string>;
  compared: ModelComparisonInput[];
  preflights: DecisionModelRoute[];
  measurements: StoredMeasurement[];
  written: Array<Omit<StoredMeasurement, 'setAt'>>;
  switches: SwitchRow[];
  ledger: DecisionLedgerInput[];
  liveGrades: { graded: number; correct: number };
  now: { t: number };
}

function world(opts: { rows?: PromptEvalResultRow[]; optedIn?: boolean; preflightFails?: boolean; aborted?: 'call_cap' | null; problems?: string[]; stored?: unknown } = {}): World {
  const w: World = {
    stored: { value: opts.stored ?? null },
    optedIn: new Set(opts.optedIn === false ? [] : [TEAM]),
    compared: [], preflights: [], measurements: [], written: [], switches: [], ledger: [],
    liveGrades: { graded: 0, correct: 0 },
    now: { t: NOW },
    deps: undefined as never,
  };
  let seq = 0;
  w.deps = {
    optedIn: async teamId => w.optedIn.has(teamId),
    readDecisionModel: async () => w.stored.value,
    compare: async input => {
      w.compared.push(input);
      const out: ModelComparisonOutcome = {
        status: 'passed', runId: 'run-1', prodModel: JEV_ID, models: [], source: 'collected',
        problems: opts.problems ?? [], costUsd: 0, rows: opts.rows ?? [], aborted: opts.aborted ?? null,
      };
      return out;
    },
    preflight: async route => {
      w.preflights.push(route);
      return opts.preflightFails ? { ok: false, error: 'Cloudflare rejected a test decision: HTTP 403' } : { ok: true };
    },
    fingerprintFor: async () => 'fp-1',
    measurements: async () => w.measurements,
    writeMeasurement: async m => { w.written.push(m); },
    // The real store, on an in-memory column: proves only byKind is touched.
    setKindModel: async (teamId, kind, route, reason) => {
      const r = await setDecisionModelForKind(teamId, kind, route, { by: null, reason }, {
        read: async () => ({ found: true, value: w.stored.value }),
        compareAndSet: async (_t, expected, next) => {
          if (expected !== w.stored.value) return false;
          w.stored.value = next;
          return true;
        },
        audit: async () => {},
      });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    switches: {
      pinnedKinds: async (teamId, at) => new Set(w.switches.filter(s => s.teamId === teamId && s.pinnedUntil && s.pinnedUntil > at).map(s => s.kind)),
      insert: async r => {
        const s: SwitchRow = { ...r, id: `sw-${++seq}`, status: 'active', pinnedUntil: null, endedAt: null, endedBy: null, createdAt: new Date(w.now.t) };
        w.switches.push(s);
        return s.id;
      },
      supersede: async (teamId, kind) => {
        for (const s of w.switches) if (s.teamId === teamId && s.kind === kind && s.status === 'active') s.status = 'superseded';
      },
      listActive: async teamId => w.switches.filter(s => s.status === 'active' && (!teamId || s.teamId === teamId)),
      get: async id => w.switches.find(s => s.id === id) ?? null,
      end: async (id, status, patch) => {
        const s = w.switches.find(x => x.id === id && x.status === 'active');
        if (!s) return false;
        Object.assign(s, { status, ...patch });
        return true;
      },
    },
    liveGrades: async () => w.liveGrades,
    recordLedger: async input => { w.ledger.push(input); },
    now: () => w.now.t,
  };
  return w;
}

const result = (route: DecisionModelRoute, derived: Derived, extra: Partial<ModelResult> = {}): ModelResult => ({
  route, scored: true, notRun: 0, labelled: 100,
  derived: derived ? { source: 'top_p', threshold: 0.7, coverage: derived.coverage, precision: derived.precision, wilsonLower: 0.91 } : null,
  bar: 0.9, ...extra,
});

describe('planKindSwitch', () => {
  it('switches on a clear win, scored as coverage x precision', () => {
    const plan = planKindSwitch({
      kind: KIND, current: JEV_ROUTE, pinned: false, minLabelled: 50,
      results: [result(JEV_ROUTE, { coverage: 0.5, precision: 0.95 }), result(CLEF, { coverage: 0.8, precision: 0.95 })],
    });
    expect(plan.action).toBe('switch');
    if (plan.action !== 'switch') return;
    expect(plan.to.route).toEqual(CLEF);
    expect(plan.before).toBeCloseTo(0.475, 6);
    expect(plan.after).toBeCloseTo(0.76, 6);
  });

  it('keeps the current model when the winner is ahead by less than 5 points', () => {
    const plan = planKindSwitch({
      kind: KIND, current: JEV_ROUTE, pinned: false, minLabelled: 50,
      results: [result(JEV_ROUTE, { coverage: 0.6, precision: 0.95 }), result(CLEF, { coverage: 0.64, precision: 0.95 })],
    });
    expect(plan).toMatchObject({ action: 'keep', reason: 'within_margin' });
  });

  it('a tie keeps the current model', () => {
    const plan = planKindSwitch({
      kind: KIND, current: JEV_ROUTE, pinned: false, minLabelled: 50,
      results: [result(CLEF, { coverage: 0.6, precision: 0.95 }), result(JEV_ROUTE, { coverage: 0.6, precision: 0.95 })],
    });
    expect(plan).toMatchObject({ action: 'keep', reason: 'current_best' });
  });

  it('leaves a kind with too few graded cases alone', () => {
    const plan = planKindSwitch({
      kind: KIND, current: JEV_ROUTE, pinned: false, minLabelled: 50,
      results: [result(JEV_ROUTE, null, { labelled: 30 }), result(CLEF, { coverage: 0.9, precision: 0.99 }, { labelled: 30 })],
    });
    expect(plan).toMatchObject({ action: 'keep', reason: 'too_few_graded' });
  });

  it('a kind no model carries stays on its rule', () => {
    const plan = planKindSwitch({
      kind: KIND, current: JEV_ROUTE, pinned: false, minLabelled: 50,
      results: [result(JEV_ROUTE, null), result(CLEF, null)],
    });
    expect(plan).toMatchObject({ action: 'keep', reason: 'no_model_clears_bar' });
  });

  it('only compares models asked every case', () => {
    const plan = planKindSwitch({
      kind: KIND, current: JEV_ROUTE, pinned: false, minLabelled: 50,
      results: [result(JEV_ROUTE, { coverage: 0.5, precision: 0.95 }), result(CLEF, { coverage: 0.9, precision: 0.95 }, { notRun: 10 })],
    });
    expect(plan).toMatchObject({ action: 'keep', reason: 'current_best' });
  });

  it('a pinned kind is never switched', () => {
    const plan = planKindSwitch({
      kind: KIND, current: JEV_ROUTE, pinned: true, minLabelled: 50,
      results: [result(JEV_ROUTE, { coverage: 0.5, precision: 0.95 }), result(CLEF, { coverage: 0.9, precision: 0.95 })],
    });
    expect(plan).toMatchObject({ action: 'keep', reason: 'pinned' });
  });
});

const CLEAR_WIN = [
  row(JEV_ID, 'openrouter', { coverage: 0.5, precision: 0.95 }),
  row('clef', 'cloudflare', { coverage: 0.85, precision: 0.96, threshold: 0.65 }),
  row('clef-flash', 'cloudflare', { coverage: 0.6, precision: 0.95 }),
];

describe('optimizeTeam', () => {
  it('switches on a clear win: measurement, per-kind model, one switch row and a ledger event', async () => {
    const w = world({ rows: CLEAR_WIN, stored: { endpoint: 'chat', model: 'acme/default-1', via: 'openrouter', byKind: { [KIND]: JEV_ROUTE } } });
    const out = await optimizeTeam(TEAM, {}, w.deps);

    expect(out.status).toBe('ran');
    expect(w.compared[0]).toMatchObject({ teamId: TEAM, source: 'collected', trigger: 'manual' });
    expect(w.preflights).toEqual([CLEF]);
    expect(w.written).toEqual([expect.objectContaining({ kind: KIND, model: 'clef', threshold: 0.65, confidenceSource: 'top_p', measuredFingerprint: 'fp-1', evalRunId: 'run-1', status: 'active' })]);
    expect(readDecisionModelOverrides(w.stored.value)[KIND]).toEqual(CLEF);
    // The team default is never touched.
    expect(readDecisionModel(w.stored.value)).toEqual({ endpoint: 'chat', model: 'acme/default-1', via: 'openrouter' });
    expect(w.switches).toHaveLength(1);
    expect(w.switches[0]).toMatchObject({ cause: 'optimizer', kind: KIND, fromRoute: JEV_ROUTE, toRoute: CLEF, evalRunId: 'run-1', bar: 0.9 });
    expect(w.ledger).toHaveLength(1);
    expect(w.ledger[0]).toMatchObject({ teamId: TEAM, capability: 'decision_model_switch', subjectId: KIND, appliedAnswer: 'clef', ruleAnswer: JEV_ID });
    expect(w.ledger[0].reason).toContain('eval_run=run-1');
    expect(w.ledger[0].reason).toContain('before=0.475');
  });

  it('asks the current per-kind models and the default candidates', async () => {
    const w = world({ rows: [], stored: { byKind: { 'task_role': { endpoint: 'chat', model: 'acme/role-1', via: 'openrouter' } } } });
    await optimizeTeam(TEAM, {}, w.deps);
    const asked = w.compared[0].models.map(m => m.model);
    expect(asked).toEqual(expect.arrayContaining([JEV_ID, 'clef', 'clef-flash', 'acme/role-1']));
  });

  it('does not switch under the margin', async () => {
    const w = world({ rows: [row(JEV_ID, 'openrouter', { coverage: 0.6, precision: 0.95 }), row('clef', 'cloudflare', { coverage: 0.63, precision: 0.95 })] });
    const out = await optimizeTeam(TEAM, {}, w.deps);
    expect(out.kinds).toEqual([expect.objectContaining({ kind: KIND, action: 'keep', reason: 'within_margin' })]);
    expect(w.stored.value).toBeNull();
    expect(w.switches).toHaveLength(0);
    expect(w.written).toHaveLength(0);
  });

  it('does not switch below the minimum of graded cases', async () => {
    const w = world({ rows: [row(JEV_ID, 'openrouter', null, { labelled: 20 }), row('clef', 'cloudflare', { coverage: 0.9, precision: 1 }, { labelled: 20 })] });
    const out = await optimizeTeam(TEAM, {}, w.deps);
    expect(out.kinds[0]).toMatchObject({ action: 'keep', reason: 'too_few_graded' });
    expect(w.preflights).toHaveLength(0);
    expect(w.stored.value).toBeNull();
  });

  it('does not switch when the winner fails its test decision', async () => {
    const w = world({ rows: CLEAR_WIN, preflightFails: true });
    const out = await optimizeTeam(TEAM, {}, w.deps);
    expect(out.kinds[0]).toMatchObject({ action: 'keep', reason: 'preflight_failed' });
    expect(w.stored.value).toBeNull();
    expect(w.written).toHaveLength(0);
    expect(w.switches).toHaveLength(0);
  });

  it('never replays a team that has not opted in', async () => {
    const w = world({ rows: CLEAR_WIN, optedIn: false });
    const out = await optimizeTeam(TEAM, {}, w.deps);
    expect(out.status).toBe('not_opted_in');
    expect(w.compared).toHaveLength(0);
    expect(w.stored.value).toBeNull();
  });

  it('the call cap stops the run, names the limit, and leaves the cut-short kind alone', async () => {
    const w = world({
      rows: [row(JEV_ID, 'openrouter', { coverage: 0.5, precision: 0.95 }), row('clef', 'cloudflare', { coverage: 0.9, precision: 0.96 }, { notRun: 40 })],
      aborted: 'call_cap',
      problems: ['the call cap (300 calls) was reached: 40 case(s) not run'],
    });
    const out = await optimizeTeam(TEAM, { callCap: 300 }, w.deps);
    expect(w.compared[0].callCap).toBe(300);
    expect(out.aborted).toBe('call_cap');
    expect(out.problems.join(' ')).toContain('call cap (300 calls)');
    expect(out.kinds[0]).toMatchObject({ action: 'keep' });
    expect(w.switches).toHaveLength(0);
  });

  it('never loosens an existing stricter measurement for the same signal', async () => {
    const w = world({ rows: CLEAR_WIN });
    w.measurements.push({
      kind: KIND, model: 'clef', threshold: 0.8, precisionLower: 0.93, coverage: 0.5, n: 200, evalRunId: 'older', measuredFingerprint: 'fp-1',
      status: 'active', setByAccountId: null, setAt: new Date(NOW - DAY), reason: null, confidenceSource: 'top_p',
    });
    await optimizeTeam(TEAM, {}, w.deps);
    expect(w.written).toHaveLength(0);
    expect(readDecisionModelOverrides(w.stored.value)[KIND]).toEqual(CLEF);
  });

  // Measurements are platform-wide (one row per kind x model): a team's run must
  // never undo an operator's retirement for every team.
  it('never revives a retired measurement, and does not switch the kind', async () => {
    const w = world({ rows: CLEAR_WIN });
    w.measurements.push({
      kind: KIND, model: 'clef', threshold: 0.6, precisionLower: 0.92, coverage: 0.7, n: 200, evalRunId: 'older', measuredFingerprint: 'fp-1',
      status: 'retired', setByAccountId: 'operator', setAt: new Date(NOW - DAY), reason: 'records only', confidenceSource: 'top_p',
    });
    const out = await optimizeTeam(TEAM, {}, w.deps);
    expect(w.written).toHaveLength(0);
    expect(readDecisionModelOverrides(w.stored.value)[KIND]).toBeUndefined();
    expect(w.switches).toHaveLength(0);
    expect(out.status === 'ran' && out.kinds[0]).toMatchObject({ kind: KIND, action: 'keep', reason: 'measurement_retired' });
  });

  it('never replaces an active measurement on a different signal, and does not switch the kind', async () => {
    const w = world({ rows: CLEAR_WIN });
    w.measurements.push({
      kind: KIND, model: 'clef', threshold: 0.95, precisionLower: 0.93, coverage: 0.3, n: 200, evalRunId: 'older', measuredFingerprint: 'fp-1',
      status: 'active', setByAccountId: null, setAt: new Date(NOW - DAY), reason: null, confidenceSource: 'confidence',
    });
    const out = await optimizeTeam(TEAM, {}, w.deps);
    expect(w.written).toHaveLength(0);
    expect(readDecisionModelOverrides(w.stored.value)[KIND]).toBeUndefined();
    expect(w.switches).toHaveLength(0);
    expect(out.status === 'ran' && out.kinds[0]).toMatchObject({ kind: KIND, action: 'keep', reason: 'measurement_other_signal' });
  });
});

describe('undo', () => {
  it('restores the previous config, pins it for 30 days, and the next run does not switch again', async () => {
    const w = world({ rows: CLEAR_WIN });
    await optimizeTeam(TEAM, {}, w.deps);
    const sw = w.switches[0];
    expect(readDecisionModelOverrides(w.stored.value)[KIND]).toEqual(CLEF);

    const undone = await undoSwitch({ teamId: TEAM, switchId: sw.id, by: 'user-1' }, w.deps);
    expect(undone).toEqual({ ok: true });
    // No override before the switch: undo clears it.
    expect(w.stored.value).toBeNull();
    expect(sw).toMatchObject({ status: 'undone', endedBy: 'user-1' });
    expect(sw.pinnedUntil?.getTime()).toBe(NOW + OPTIMIZER_PIN_MS);
    expect(w.ledger.at(-1)).toMatchObject({ capability: 'decision_model_switch', subjectId: KIND });

    w.now.t = NOW + 7 * DAY;
    const again = await optimizeTeam(TEAM, {}, w.deps);
    expect(again.kinds[0]).toMatchObject({ action: 'keep', reason: 'pinned' });
    expect(w.stored.value).toBeNull();

    w.now.t = NOW + 31 * DAY;
    const later = await optimizeTeam(TEAM, {}, w.deps);
    expect(later.kinds[0]).toMatchObject({ action: 'switch' });
  });

  it('refuses a switch of another team, or one no longer in effect', async () => {
    const w = world({ rows: CLEAR_WIN });
    await optimizeTeam(TEAM, {}, w.deps);
    const id = w.switches[0].id;
    expect(await undoSwitch({ teamId: 'team-b', switchId: id, by: 'u' }, w.deps)).toMatchObject({ ok: false, status: 404 });
    w.stored.value = { byKind: { [KIND]: FLASH } };
    expect(await undoSwitch({ teamId: TEAM, switchId: id, by: 'u' }, w.deps)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('auto-revert', () => {
  it('restores the previous model when live graded precision falls below the bar over 20+ decisions', async () => {
    const w = world({ rows: CLEAR_WIN });
    await optimizeTeam(TEAM, {}, w.deps);
    w.now.t = NOW + 3 * DAY;

    w.liveGrades = { graded: 19, correct: 10 };
    expect((await checkAutoReverts(w.deps)).reverted).toBe(0);

    w.liveGrades = { graded: 24, correct: 20 };
    const out = await checkAutoReverts(w.deps);
    expect(out.reverted).toBe(1);
    expect(w.stored.value).toBeNull();
    expect(w.switches[0].status).toBe('reverted');
    expect(w.switches[1]).toMatchObject({ cause: 'auto_revert', kind: KIND, fromRoute: CLEF, toRoute: null, status: 'active', n: 24 });
    expect(w.ledger.at(-1)?.reason).toContain('auto_revert');
  });

  it('keeps a model at or above the bar', async () => {
    const w = world({ rows: CLEAR_WIN });
    await optimizeTeam(TEAM, {}, w.deps);
    w.liveGrades = { graded: 40, correct: 38 };
    expect((await checkAutoReverts(w.deps)).reverted).toBe(0);
    expect(readDecisionModelOverrides(w.stored.value)[KIND]).toEqual(CLEF);
  });
});

describe('switchFeed', () => {
  it('one line per switch in effect, in plain words', async () => {
    const w = world({ rows: CLEAR_WIN });
    await optimizeTeam(TEAM, {}, w.deps);
    const feed = await switchFeed(TEAM, w.deps);
    expect(feed).toEqual([{ id: w.switches[0].id, kind: KIND, text: 'Post-session triage now uses Clef', at: new Date(NOW).toISOString() }]);
    // No scores, thresholds or runs in what the team sees.
    expect(JSON.stringify(feed)).not.toMatch(/score|threshold|run-1|bar/);

    w.liveGrades = { graded: 30, correct: 10 };
    await checkAutoReverts(w.deps);
    expect((await switchFeed(TEAM, w.deps)).map(l => l.text)).toEqual(['Post-session triage is back on Jev']);
  });
});

describe('runOptimizerSweep', () => {
  it('checks reverts, runs due teams, skips the ones not opted in and defers past the budget', async () => {
    const w = world({ rows: CLEAR_WIN });
    const out = await runOptimizerSweep({ teamIds: [TEAM, 'team-b'], budgetMs: 10 * 60_000, trigger: 'cron' }, w.deps);
    expect(out.teams.map(t => t.status)).toEqual(['ran', 'not_opted_in']);
    expect(w.compared).toHaveLength(1);
    expect(w.compared[0].trigger).toBe('cron');

    const none = await runOptimizerSweep({ teamIds: [TEAM], budgetMs: 1000, trigger: 'cron' }, w.deps);
    expect(none.deferred).toEqual([TEAM]);
  });
});
