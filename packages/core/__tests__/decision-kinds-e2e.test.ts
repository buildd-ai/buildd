import { describe, it, expect } from 'bun:test';
import { defineBuilddDecisionKind } from '../decision-kinds';
import { runBuilddDecision, type BuilddDecisionDeps } from '../decision-policy';
import { labelDecisionOutcome } from '../decision-outcomes';
import { computeDecisionReadout } from '../decision-readout';
import { createSyntheticDecisionLedger, formatDecisionComparison } from '../decision-shadow-harness';
import {
  POST_SESSION_OUTCOME_SOURCE,
  POST_SESSION_TRIAGE_BINDING,
  POST_SESSION_TRIAGE_CONFIG,
  postSessionTriageKind,
  triageFocusOf,
  type PostSessionTriageFeatures,
} from '../decision-kind-post-session-triage';
import {
  SCOUT_OUTCOME_SOURCE,
  SCOUT_PROBE_SELECTION_BINDING,
  SCOUT_PROBE_SELECTION_CONFIG,
  type ScoutProbeFeatures,
} from '../decision-kind-scout-probe-selection';

/**
 * End to end, synthetic: both first-party kinds through the real buildd plan
 * (`runBuilddDecision`), the real ledger row mapping, real outcome labelling
 * and the real readout, with only the provider, key lookup and stores faked.
 *
 * Triage runs live with an out-of-band challenger; scout runs shadow with an
 * escalation slot. Each fake reply is keyed by a subject index the kind
 * forwards to the model (triage `unreadSources`, scout `priorFailures`), so
 * the script reads as "subject N, route R answers X".
 */

const TEAM = 'team-1';
const scope = { teamId: TEAM, workspaceId: 'ws-1' };
const RICH = 'acme/rich-1';
const CHEAP_VERSION = 'typesafe/jev-1.13-20260917';

type Reply = { pick: string; confidence: number; focus?: string } | { fail: number };

function harness(script: Record<'cheap' | 'rich', Record<number, Reply>>, subjectOf: (state: any) => number, opts: { disabled?: boolean } = {}) {
  let clock = 0;
  const ledger = createSyntheticDecisionLedger();
  const calls: Array<{ route: 'cheap' | 'rich'; subject: number }> = [];
  const deps: BuilddDecisionDeps = {
    ...ledger.deps,
    now: () => clock,
    resolveAccess: (async () => opts.disabled
      ? { ok: false, error: { kind: 'capability_disabled', capability: 'post_session_triage' } }
      : { ok: true, apiKey: 'k', model: 'typesafe/jev-1.13' }) as any,
    resolveRoute: (async () => ({ apiKey: 'k', endpoint: { kind: 'chat', baseURL: 'https://openrouter.ai/api/v1', provider: 'openrouter' }, model: RICH })) as any,
    call: (async (p: any) => {
      const route = p.model ? 'rich' : 'cheap';
      const subject = subjectOf(p.state);
      calls.push({ route, subject });
      const latency = route === 'rich' ? 400 : 40;
      clock += latency;
      const reply = script[route][subject];
      if (!reply || 'fail' in reply) {
        return { ok: false, error: { kind: 'provider_error', status: reply ? reply.fail : 500, message: 'synthetic' }, latencyMs: latency, attempts: 2 };
      }
      const answers: Record<string, unknown> = {
        [p.decisionId === 'buildd.post_session_triage' ? 'decision' : 'probe']:
          { type: 'choice', choice: reply.pick, confidence: reply.confidence, probabilities: { [reply.pick]: reply.confidence } },
      };
      if (reply.focus) answers.focus = { type: 'choice', choice: reply.focus, confidence: 0.6, probabilities: { [reply.focus]: 0.6 } };
      return {
        ok: true, answers, model: route === 'rich' ? `${RICH}-20261001` : CHEAP_VERSION,
        usage: { inputTokens: 60, outputTokens: 2, costUsd: route === 'rich' ? 0.002 : 0.00002 }, latencyMs: latency, attempts: 1,
      };
    }) as any,
  };
  return { deps, ledger, calls };
}

// ── The two kinds, rebound for the comparison ─────────────────────────────────
// Same config (rules, questions, versions); the binding adds what a feature
// would add after measuring: a challenger for triage, an escalation model for
// scout. Redefining an id replaces it in this process only.

const triageKind = defineBuilddDecisionKind(POST_SESSION_TRIAGE_CONFIG, {
  ...POST_SESSION_TRIAGE_BINDING,
  challenger: { via: 'openrouter', endpoint: 'chat', model: RICH, fraction: 1 },
  measuredModels: [RICH],
});
const scoutKind = defineBuilddDecisionKind(SCOUT_PROBE_SELECTION_CONFIG, {
  ...SCOUT_PROBE_SELECTION_BINDING,
  // The shipped binding is live; this suite needs one shadow kind to show applied-vs-shadow truth.
  mode: 'shadow',
  escalation: { via: 'openrouter', endpoint: 'chat', model: RICH },
  measuredModels: [RICH],
});

const session = (i: number, over: Partial<PostSessionTriageFeatures> = {}): PostSessionTriageFeatures => ({
  sessionFailed: false, retried: false, prShipped: true, merged: true, reviewRounds: 1, requestChanges: 0,
  ciFixAttempts: 0, errorTotal: 0, transcriptPresent: true, unreadSources: i, hardTriggers: [], ...over,
});
const probe = (i: number, over: Partial<ScoutProbeFeatures> = {}): ScoutProbeFeatures => ({
  probeKind: 'api_contract', supported: true, mustRun: false, touchesChangedPaths: false,
  priorFailures: i, changedFiles: 6, budgetRemaining: 3, ...over,
});

async function runTriage() {
  const h = harness({
    cheap: {
      2: { pick: 'analyse', confidence: 0.9, focus: 'retrieval' },
      3: { pick: 'skip', confidence: 0.85, focus: 'general' },
      4: { pick: 'analyse', confidence: 0.5, focus: 'runtime' },
      5: { fail: 503 },
    },
    rich: {
      2: { pick: 'analyse', confidence: 0.92, focus: 'retrieval' },
      3: { pick: 'analyse', confidence: 0.8, focus: 'orchestration' },
      4: { pick: 'analyse', confidence: 0.88, focus: 'runtime' },
      5: { pick: 'skip', confidence: 0.7, focus: 'general' },
    },
  }, s => s.unreadSources);
  const inputs: Array<[string, unknown]> = [
    ['w1', session(1, { hardTriggers: ['reviewer_escalated'] })],
    ['w2', session(2)],
    ['w3', session(3)],
    ['w4', session(4)],
    ['w5', session(5)],
    ['w6', { sessionFailed: 'yes' }],
  ];
  const responses = [];
  for (const [id, features] of inputs) {
    responses.push(await runBuilddDecision(triageKind, { features: features as PostSessionTriageFeatures, subjectRef: { type: 'worker', id } }, scope, h.deps));
  }
  await h.ledger.flush();
  return { ...h, responses };
}

async function runScout() {
  const h = harness({
    cheap: {
      3: { pick: 'run', confidence: 0.9 },
      4: { pick: 'defer', confidence: 0.6 },
      6: { pick: 'run', confidence: 0.5 },
    },
    rich: {
      4: { pick: 'defer', confidence: 0.75 },
      6: { fail: 429 },
    },
  }, s => s.priorFailures);
  const inputs: Array<[string, ScoutProbeFeatures]> = [
    ['p1', probe(1, { supported: false })],
    ['p2', probe(2, { mustRun: true })],
    ['p3', probe(3)],
    ['p4', probe(4)],
    ['p5', probe(5, { budgetRemaining: 0 })],
    ['p6', probe(6, { touchesChangedPaths: true })],
  ];
  const responses = [];
  for (const [id, features] of inputs) {
    responses.push(await runBuilddDecision(scoutKind, { features, subjectRef: { type: 'scout_probe', id } }, scope, h.deps));
  }
  await h.ledger.flush();
  return { ...h, responses };
}

describe('two kinds, one substrate, end to end', () => {
  it('deterministic overrides decide without asking a model, in live and shadow kinds alike', async () => {
    const t = await runTriage();
    const s = await runScout();
    expect(t.responses[0]).toMatchObject({ decision: 'analyse', source: 'rule', reasonCode: 'hard_trigger_reviewer_escalated', attempts: [] });
    expect(s.responses[0]).toMatchObject({ decision: 'unsupported', source: 'rule', attempts: [] });
    expect(s.responses[1]).toMatchObject({ decision: 'run', source: 'rule', reasonCode: 'must_run' });
    expect(s.responses[4]).toMatchObject({ decision: 'defer', source: 'rule', reasonCode: 'budget_exhausted' });
    expect(t.calls.filter(c => c.subject === 1 && c.route === 'cheap')).toHaveLength(0);
    expect(s.calls.filter(c => [1, 2, 5].includes(c.subject))).toHaveLength(0);
    // A rule decision is still a ledger row, with the rule's answer.
    expect(t.ledger.records[0]).toMatchObject({ status: 'fallback', ruleAnswer: 'analyse', appliedAnswer: 'analyse', attemptCount: 0 });
  });

  it('the cheap route is attempted first and applied live at threshold', async () => {
    const t = await runTriage();
    expect(t.responses[1]).toMatchObject({ decision: 'analyse', source: 'model', provider: 'openrouter', modelVersion: CHEAP_VERSION, escalationChain: ['cheap'] });
    expect(triageFocusOf(t.responses[1])).toBe('retrieval');
    expect(t.responses[1].attempts[0]).toMatchObject({ role: 'cheap', applied: true, latencyMs: 40, usage: { costUsd: 0.00002 } });
  });

  it('each kind owns its fallback: triage fails open to skip, scout leans toward coverage', async () => {
    const t = await runTriage();
    expect(t.responses[3]).toMatchObject({ decision: 'skip', fallbackCause: 'low_confidence', escalationSkipped: 'not_configured' });
    expect(t.responses[4]).toMatchObject({ decision: 'skip', fallbackCause: 'provider_failure', reasonCode: 'triage_unavailable' });
    expect(t.responses[4].attempts[0].failure).toMatchObject({ kind: 'provider_error', status: 503, retryable: true });
    expect(t.responses[5]).toMatchObject({ decision: 'skip', fallbackCause: 'invalid_features', reasonCode: 'triage_unavailable', featureDigest: null });
    const s = await runScout();
    expect(s.responses[5]).toMatchObject({ decision: 'run', fallbackCause: 'shadow', reasonCode: 'heuristic_run_shadow' });
  });

  it('escalation runs on a low-confidence cheap answer and is kept on the attempt chain', async () => {
    const s = await runScout();
    const r = s.responses[3];
    expect(r.escalationChain).toEqual(['cheap', 'escalation']);
    expect(r.attempts[0]).toMatchObject({ role: 'cheap', outcome: 'below_threshold', decision: 'defer' });
    expect(r.attempts[1]).toMatchObject({ role: 'escalation', outcome: 'decided', decision: 'defer', escalatedFrom: 0, provider: 'openrouter', modelVersion: `${RICH}-20261001` });
    expect(r.latencyMs).toBe(440);
    expect(r.costUsd).toBeCloseTo(0.00202, 8);
    // A failed escalation is recorded too, and the fallback still answers.
    expect(s.responses[5].attempts.map(a => [a.role, a.outcome])).toEqual([['cheap', 'below_threshold'], ['escalation', 'failed']]);
    expect(s.ledger.records[3]).toMatchObject({ escalated: true, attemptCount: 2 });
  });

  it('applied-vs-shadow truth: a shadow kind records what the model said, and what actually ran', async () => {
    const s = await runScout();
    // p3: the model said run, confidently; the shadow fallback deferred it.
    expect(s.responses[2]).toMatchObject({ decision: 'defer', source: 'fallback', fallbackCause: 'shadow', mode: 'shadow' });
    expect(s.responses[2].attempts[0]).toMatchObject({ decision: 'run', outcome: 'decided', applied: false });
    expect(s.ledger.records[2]).toMatchObject({ status: 'suggested', applied: false, verdict: 'run', appliedAnswer: 'defer' });
    // The live kind's ledger row says applied.
    const t = await runTriage();
    expect(t.ledger.records[1]).toMatchObject({ status: 'applied', applied: true, verdict: 'analyse', appliedAnswer: 'analyse' });
    expect([...s.responses, ...t.responses].every(r => r.attempts.every(a => !a.applied || r.source === 'model'))).toBe(true);
  });

  it('policy, feature-schema, prompt and provider versions are independent fields on every row', async () => {
    const t = await runTriage();
    const s = await runScout();
    const [tr, sr] = [t.responses[1], s.responses[3]];
    expect(tr.policyVersion).toBe('pst-2026-10-03.a');
    expect(sr.policyVersion).toBe('spsel-2026-10-03.a');
    expect(tr.featureSchemaVersion).toBe('pst-features-v1');
    expect(sr.featureSchemaVersion).toBe('spsel-features-v1');
    expect(t.ledger.records[1]).toMatchObject({
      policyVersion: 'pst-2026-10-03.a',
      promptVersion: `pst-2026-10-03.a|pst-features-v1|${postSessionTriageKind.promptFingerprint}|${postSessionTriageKind.configFingerprint}`,
      provider: 'openrouter',
      model: CHEAP_VERSION,
    });
    expect(s.ledger.records[3]).toMatchObject({ provider: 'openrouter', model: `${RICH}-20261001` });
  });

  it('the challenger runs out of band, never changes the answer, and is recorded per decision', async () => {
    const t = await runTriage();
    // Applied answers are what runTriage returned before the challengers ran.
    expect(t.responses.map(r => r.decision)).toEqual(['analyse', 'analyse', 'skip', 'skip', 'skip', 'skip']);
    const byRecord = new Map(t.ledger.challengers.map(c => [c.decisionRecordId, c]));
    const rec = (i: number) => byRecord.get(t.ledger.records[i].id)!;
    expect(rec(0)).toMatchObject({ status: 'skipped', skipReason: 'deterministic_override' });
    expect(rec(1)).toMatchObject({ status: 'attempted', decision: 'analyse', agrees: true, model: RICH });
    expect(rec(2)).toMatchObject({ status: 'attempted', decision: 'analyse', agrees: false, appliedAnswer: 'skip' });
    expect(rec(3)).toMatchObject({ status: 'attempted', decision: 'analyse', agrees: false });
    expect(rec(5)).toMatchObject({ status: 'skipped', skipReason: 'invalid_features' });
    expect(t.ledger.records.every(r => r.appliedAnswer !== null)).toBe(true);
  });

  it('late outcome labels attach to the immutable rows, deduped, with conflicts surfaced', async () => {
    const t = await runTriage();
    const label = (id: string, l: string) => labelDecisionOutcome(
      { teamId: TEAM, capability: triageKind.kind, subject: { type: 'worker', id }, source: POST_SESSION_OUTCOME_SOURCE, label: l },
      { store: t.ledger.outcomeStore },
    );
    expect(await label('w2', 'actionable')).toMatchObject({ ok: true, results: [{ status: 'recorded' }] });
    expect(await label('w2', 'actionable')).toMatchObject({ ok: true, results: [{ status: 'duplicate' }] });
    expect(await label('w2', 'not_actionable')).toMatchObject({ ok: true, results: [{ status: 'conflict', existing: { label: 'actionable' } }] });
    expect(await label('nobody', 'actionable')).toEqual({ ok: false, error: 'not_found' });
    expect(t.ledger.outcomes).toHaveLength(1);
    expect(t.ledger.records[1]).toMatchObject({ appliedAnswer: 'analyse', status: 'applied' });
  });

  it('collection health says disabled, not "insufficient sample", when the switch is off', async () => {
    const h = harness({ cheap: {}, rich: {} }, s => s.unreadSources, { disabled: true });
    const r = await runBuilddDecision(triageKind, { features: session(2), subjectRef: { type: 'worker', id: 'w2' } }, scope, h.deps);
    expect(r).toMatchObject({ decision: 'skip', mode: 'disabled' });
    expect(h.ledger.records).toHaveLength(0);
    const readout = computeDecisionReadout(h.ledger.readoutRows(triageKind.kind), { access: 'capability_disabled', eligibleSubjects: 6 }, { minLabelled: 3 });
    expect(readout.collection).toMatchObject({ state: 'disabled', collecting: false });
  });

  it('reads out both kinds side by side: coverage, latency, cost, decision and outcome', async () => {
    const t = await runTriage();
    const s = await runScout();
    for (const [id, l] of [['w1', 'actionable'], ['w2', 'actionable'], ['w3', 'not_actionable'], ['w4', 'actionable']] as const) {
      await labelDecisionOutcome({ teamId: TEAM, capability: triageKind.kind, subject: { type: 'worker', id }, source: POST_SESSION_OUTCOME_SOURCE, label: l }, { store: t.ledger.outcomeStore });
    }
    for (const [id, l] of [['p3', 'defect_found'], ['p4', 'no_defect']] as const) {
      await labelDecisionOutcome({ teamId: TEAM, capability: scoutKind.kind, subject: { type: 'scout_probe', id }, source: SCOUT_OUTCOME_SOURCE, label: l }, { store: s.ledger.outcomeStore });
    }

    const triageRows = t.ledger.readoutRows(triageKind.kind, { challengerConfigured: true });
    const scoutRows = s.ledger.readoutRows(scoutKind.kind);
    const triageReadout = computeDecisionReadout(triageRows, { access: 'enabled', eligibleSubjects: 8 }, { minLabelled: 3, objective: triageKind.binding.readout!.objective });
    const scoutReadout = computeDecisionReadout(scoutRows, { access: 'enabled', eligibleSubjects: 6 }, { minLabelled: 3, objective: scoutKind.binding.readout!.objective });

    expect(triageReadout).toMatchObject({
      collection: { state: 'sufficient', collecting: true },
      decidedSubjects: 6, coverage: 0.75,
      byStatus: { applied: 2, suggested: 1, fallback: 3 },
      failures: { provider: 1, key: 0, capability: 0 },
      challenger: { attempted: 4, skipped: { deterministic_override: 1, invalid_features: 1 }, notRun: 0 },
      outcomes: { labelled: 4, unlabelled: 2 },
    });
    // w4's fallback skipped an actionable session; the challenger said analyse.
    expect(triageReadout.challenger.scored).toEqual({ n: 3, appliedCorrect: 2, challengerCorrect: 2 });
    expect(triageReadout.causal).toEqual({ claim: false, reason: 'no_randomized_assignment' });

    expect(scoutReadout).toMatchObject({
      collection: { state: 'insufficient_sample', collecting: true },
      decidedSubjects: 6, coverage: 1,
      byStatus: { applied: 0, suggested: 3, fallback: 3 },
      escalation: { eligible: 3, escalated: 2 },
    });
    // p3: the shadow fallback deferred a probe that found a defect (the
    // cheap model had said run). p6 is in the same group, unlabelled.
    const shadowGroup = scoutReadout.groups.find(g => g.model === CHEAP_VERSION)!;
    expect(shadowGroup).toMatchObject({ n: 2, applied: 0, labelled: 1, scored: 1, correct: 0 });

    const table = formatDecisionComparison([
      { label: 'post_session_triage (live)', readout: triageReadout, rows: triageRows },
      { label: 'scout_probe_selection (shadow)', readout: scoutReadout, rows: scoutRows },
    ]);
    const lines = table.split('\n');
    const row = (name: string) => lines.find(l => l.startsWith(name))!.split('|').map(c => c.trim());
    expect(row('collection')).toEqual(['collection', 'sufficient', 'insufficient_sample (labelled 2 < 3)']);
    expect(row('coverage')).toEqual(['coverage', '6/8 = 75%', '6/6 = 100%']);
    expect(row('applied / suggested / fallback')).toEqual(['applied / suggested / fallback', '2 / 1 / 3', '0 / 3 / 3']);
    expect(row('decision in effect')).toEqual(['decision in effect', 'analyse 2, skip 4', 'defer 3, run 2, unsupported 1']);
    expect(row('escalation')[2]).toBe('2/3 = 67%');
    expect(row('challenger agreement')).toEqual(['challenger agreement', '2/4 = 50%', 'none']);
    // Rules answer in 0ms; scout's escalations cost 440ms each.
    expect(row('latency p50 / p90')).toEqual(['latency p50 / p90', '40ms / 40ms', '0ms / 440ms']);
    expect(row('labelled')).toEqual(['labelled', '4/6', '2/6']);
    if (process.env.DECISION_COMPARISON_PRINT) process.stderr.write(`\n${table}\n\n`);
  });
});
