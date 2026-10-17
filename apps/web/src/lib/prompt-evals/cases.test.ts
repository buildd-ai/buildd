import { describe, expect, it } from 'bun:test';
import type { DecisionReplayInput } from '@buildd/core/decision-replay';
import { collectedFromReplay, labelledFromDatasets, sha256Hex, type CollectedDeps, type OutcomeLabel } from './cases';

const QUESTIONS = { verdict: { type: 'choice', instructions: 'Pick one.', options: { A: 'start', B: 'hold' } } } as never;

function dataset(rows: unknown[], extra: Record<string, unknown> = {}) {
  const set = Buffer.from(JSON.stringify({ questions: QUESTIONS, rows, ...extra }));
  const manifest = Buffer.from(JSON.stringify({ dataset: 'claim-hold', version: 'v1', files: [{ path: 'data/claim-hold-set.json', sha256: sha256Hex(set) }] }));
  const objects = new Map<string, Buffer>([
    ['claim-hold/v1/manifest.json', manifest],
    ['claim-hold/v1/data/claim-hold-set.json', set],
  ]);
  return { objects, read: async (k: string) => objects.get(k) ?? null };
}

const choice = (c: string, probs: Record<string, number>, confidence: number) => ({ verdict: { type: 'choice', choice: c, probabilities: probs, confidence } }) as never;

describe('labelledFromDatasets', () => {
  it('reads a set by its manifest, maps choices through slugFor, and takes the rule from the state', async () => {
    const { read } = dataset([
      { id: 'c1', gold: 'START', state: { rule: { verdict: 'HOLD' } } },
      { id: 'c2', gold: 'either', state: { rule: { verdict: 'HOLD' } } },
    ], { slugFor: { A: 'START', B: 'HOLD' } });
    const { groups, unscored } = await labelledFromDatasets(['claim-hold'], read, 100);
    expect(unscored).toEqual([]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g).toMatchObject({ kind: 'claim_hold', source: 'labelled', origin: 'dataset:claim-hold/v1', promptSource: 'dataset' });
    expect(g.promptHash).toMatch(/^[0-9a-f]{12}$/);
    const [c1, c2] = g.cases;
    expect(c1.ruleLabel).toBe('HOLD');
    const r = c1.read(choice('A', { A: 0.7, B: 0.3 }, 0.4));
    expect(r).toMatchObject({ label: 'START', confidence: 0.4, topP: 0.7 });
    // Margin: top p minus the runner-up's probability.
    expect(r.margin).toBeCloseTo(0.4, 9);
    expect(c1.judge('START')).toBe(true);
    expect(c1.judge('HOLD')).toBe(false);
    // `either` is unscored, not right and not wrong.
    expect(c2.judge('START')).toBeNull();
    expect(c1.labelled).toBe(true);
    expect(c2.labelled).toBe(false);
  });

  it('refuses a set whose bytes do not match the manifest sha256', async () => {
    const { objects, read } = dataset([{ id: 'c1', gold: 'START', state: 'x' }]);
    objects.set('claim-hold/v1/data/claim-hold-set.json', Buffer.from('{"questions":{},"rows":[]}'));
    const { groups, unscored } = await labelledFromDatasets(['claim-hold'], read, 100);
    expect(groups).toEqual([]);
    expect(unscored).toEqual([{ kind: 'claim_hold', source: 'labelled', origin: 'dataset:claim-hold/v1', reason: 'sha256_mismatch' }]);
  });

  it('names a missing manifest, an unsupported dataset and an unknown one', async () => {
    const { unscored } = await labelledFromDatasets(['task-category', 'merge-readiness', 'nope'], async () => null, 100);
    expect(unscored.map(u => u.reason)).toEqual(['no_manifest', 'unsupported_format', 'unknown_dataset']);
  });

  it('caps rows at the limit and counts the rest', async () => {
    const { read } = dataset(Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, gold: 'START', state: 's' })));
    const { groups } = await labelledFromDatasets(['claim-hold'], read, 3);
    expect(groups[0].cases).toHaveLength(3);
    expect(groups[0].skipped.over_limit).toBe(2);
  });
});

// A minimal decision kind: features { n }, one choice question, objective on the 'task_terminal' source.
function fakeKind(objectiveSource: string | null = 'task_terminal') {
  return {
    kind: 'buildd.fake',
    policyVersion: 'p1',
    decisions: ['go', 'stop'],
    promptFingerprint: 'abcdef0123456789',
    questions: QUESTIONS,
    parseFeatures: (x: unknown) => (x && typeof x === 'object' && typeof (x as { n?: unknown }).n === 'number' ? { ok: true, features: x } : { ok: false, message: 'bad' }),
    state: (f: { n: number }) => `n=${f.n}`,
    interpret: (a: { verdict?: { choice: string; confidence: number } }) => (a.verdict ? { decision: a.verdict.choice === 'A' ? 'go' : 'stop', confidence: a.verdict.confidence } : null),
    binding: {
      capability: 'post_session_triage',
      mode: 'live',
      readout: { objective: { source: objectiveSource ?? undefined, score: (o: { label: string }, answer: string) => (o.label === 'good' ? answer === 'go' : o.label === 'bad' ? answer === 'stop' : null) } },
    },
  } as never;
}

function replayInput(id: string, extra: Partial<DecisionReplayInput> = {}): DecisionReplayInput {
  return {
    capability: 'post_session_triage', decisionId: id, model: 'jev', promptRef: { id: 'buildd.fake', version: 'p1', contentHash: 'abcdef0123456789' },
    state: { n: 1 }, questionIds: ['verdict'], candidates: null, ruleAnswer: 'stop', askedAt: '2026-10-01T00:00:00Z', source: 'decision_records', featureSchemaVersion: 'f1',
    ...extra,
  };
}

function collectedDeps(inputs: DecisionReplayInput[], outcomes: Record<string, OutcomeLabel[]>, kind = fakeKind()): CollectedDeps {
  return {
    listReplayable: async () => inputs.map(i => ({ decisionId: i.decisionId, capability: i.capability })),
    loadReplay: async () => new Map(inputs.map(i => [i.decisionId, i])),
    loadOutcomes: async ids => new Map(ids.filter(id => outcomes[id]).map(id => [id, outcomes[id]])),
    kinds: () => [kind],
  };
}

const at = (iso: string) => new Date(iso);

describe('collectedFromReplay', () => {
  it('rebuilds the question from the stored features and judges through the kind objective', async () => {
    const deps = collectedDeps([replayInput('d1')], { d1: [{ source: 'task_terminal', label: 'good', value: null, observedAt: at('2026-10-02') }] });
    const { groups, unscored } = await collectedFromReplay({ teamId: 't', since: new Date(0), limit: 100 }, deps);
    expect(unscored).toEqual([]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g).toMatchObject({ kind: 'buildd.fake', source: 'collected', origin: 'replay', promptSource: 'replay', promptHash: 'abcdef012345' });
    const c = g.cases[0];
    expect(c.state).toBe('n=1');
    expect(c.ruleLabel).toBe('stop');
    const read = c.read(choice('A', { A: 0.8, B: 0.2 }, 0.3));
    expect(read).toMatchObject({ label: 'go', confidence: 0.3, topP: 0.8 });
    expect(read.margin).toBeCloseTo(0.6, 9);
    expect(c.judge('go')).toBe(true);
    expect(c.judge('stop')).toBe(false);
  });

  it('reads only the outcome source the objective names', async () => {
    const deps = collectedDeps([replayInput('d1'), replayInput('d2')], {
      d1: [{ source: 'human', label: 'bad', value: null, observedAt: at('2026-10-02') }, { source: 'task_terminal', label: 'good', value: null, observedAt: at('2026-10-03') }],
      d2: [{ source: 'human', label: 'bad', value: null, observedAt: at('2026-10-02') }],
    });
    const { groups } = await collectedFromReplay({ teamId: 't', since: new Date(0), limit: 100 }, deps);
    expect(groups[0].cases.map(c => c.id)).toEqual(['d1']);
    expect(groups[0].cases[0].judge('go')).toBe(true);
    // d2 has a human label only: not this objective's source, so not asked.
    expect(groups[0].skipped.no_outcome).toBe(1);
  });

  it('with no objective source, the earliest label stands', async () => {
    const deps = collectedDeps([replayInput('d1')], {
      d1: [{ source: 'agent_audit', label: 'bad', value: null, observedAt: at('2026-10-05') }, { source: 'pr_merged', label: 'good', value: null, observedAt: at('2026-10-02') }],
    }, fakeKind(null));
    const { groups } = await collectedFromReplay({ teamId: 't', since: new Date(0), limit: 100 }, deps);
    expect(groups[0].cases[0].judge('go')).toBe(true);
  });

  it('skips with a reason: no outcome, orchestration rows, unknown kinds, and unparseable features', async () => {
    const deps = collectedDeps([
      replayInput('d1'),
      replayInput('d2', { source: 'orchestration_decisions', promptRef: { id: 'orchestration.claim_hold', version: 'ch4', contentHash: null } }),
      replayInput('d3', { promptRef: { id: 'buildd.other', version: null, contentHash: null } }),
      replayInput('d4', { state: { n: 'x' } }),
    ], { d4: [{ source: 'task_terminal', label: 'good', value: null, observedAt: at('2026-10-02') }] });
    const { groups, unscored } = await collectedFromReplay({ teamId: 't', since: new Date(0), limit: 100 }, deps);
    expect(groups).toEqual([]);
    expect(unscored).toEqual(expect.arrayContaining([
      { kind: 'buildd.fake', source: 'collected', origin: 'replay', reason: 'features_unparseable,no_outcome' },
      { kind: 'orchestration.claim_hold', source: 'collected', origin: 'replay', reason: 'no_outcome_source' },
      { kind: 'buildd.other', source: 'collected', origin: 'replay', reason: 'kind_not_defined' },
    ]));
  });

  it('counts a case asked under other question text, and still scores it', async () => {
    const deps = collectedDeps([replayInput('d1', { promptRef: { id: 'buildd.fake', version: 'p0', contentHash: 'old' } })], {
      d1: [{ source: 'task_terminal', label: 'good', value: null, observedAt: at('2026-10-02') }],
    });
    const { groups } = await collectedFromReplay({ teamId: 't', since: new Date(0), limit: 100 }, deps);
    expect(groups[0].cases).toHaveLength(1);
    expect(groups[0].notes).toEqual({ asked_under_other_prompt: 1 });
  });

  it('filters by kind', async () => {
    const deps = collectedDeps([replayInput('d1')], { d1: [{ source: 'task_terminal', label: 'good', value: null, observedAt: at('2026-10-02') }] });
    const { groups } = await collectedFromReplay({ teamId: 't', since: new Date(0), limit: 100, kinds: ['buildd.other'] }, deps);
    expect(groups).toEqual([]);
  });
});
