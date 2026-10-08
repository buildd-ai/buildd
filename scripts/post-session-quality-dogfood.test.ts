import { describe, expect, it } from 'bun:test';
import { evaluateShadowReadiness, type DogfoodFinding, type DogfoodRun } from './post-session-quality-dogfood';

const okTriage = {
  status: 'ok', decision: 'skip', focus: 'general', reasonCode: 'routine_success', confidence: 0.8,
  provenance: { rule: 'triage', model: 'm' },
};

function run(over: Partial<DogfoodRun> = {}): DogfoodRun {
  return {
    id: 'run-1', workerId: 'worker-1', mode: 'shadow', state: 'skipped', triage: okTriage,
    hardTriggered: false, hardTriggerReasons: [], finalDecision: 'skip', traceAvailability: null, errorStage: null,
    ...over,
  };
}

const analysed = (over: Partial<DogfoodRun> = {}) => run({
  id: 'run-2', workerId: 'worker-2', state: 'analysed', finalDecision: 'analyse', traceAvailability: 'truncated',
  hardTriggered: true, hardTriggerReasons: ['review_fix_loop'],
  triage: { ...okTriage, decision: 'skip', provenance: { rule: 'hard_trigger' } },
  ...over,
});

function finding(over: Partial<DogfoodFinding> = {}): DogfoodFinding {
  return {
    id: 'finding-1', class: 'agent_use', severity: 'medium', confidence: '0.500', title: 't', occurrenceCount: 1,
    affectedRefs: [{ runId: 'run-2' }], evidenceRefs: [{ kind: 'post_session_run', ref: 'run-2' }],
    actionState: 'observed', actionTaskId: null, actionArtifactId: null,
    ...over,
  };
}

describe('evaluateShadowReadiness', () => {
  it('is ready when a skip and an analysed run carry full provenance and shadow filed nothing', () => {
    const v = evaluateShadowReadiness([run(), analysed()], [finding()]);
    expect(v.blockers).toEqual([]);
    expect(v.ready).toBe(true);
    expect(v.readout).toMatchObject({ runs: 2, analysed: 1, findings: 1, triage: { ok: 2, hardTriggered: 1, byRule: { triage: 1, hard_trigger: 1 } } });
  });

  it('is not ready with no runs at all — fixtures cannot stand in for a live pass', () => {
    const v = evaluateShadowReadiness([], []);
    expect(v.ready).toBe(false);
    expect(v.blockers[0]).toContain('no runs');
  });

  it('requires a run to reach analysis and a decision to come back ok', () => {
    const unavailable = { status: 'unavailable', decision: null, focus: null, reasonCode: 'triage_unavailable', confidence: null, provenance: { rule: 'fail_open_skip' } };
    const v = evaluateShadowReadiness([run({ triage: unavailable })], []);
    expect(v.blockers.some(b => b.includes('decision model has not been exercised'))).toBe(true);
    expect(v.blockers.some(b => b.includes('no run reached analysis'))).toBe(true);
  });

  it('flags a triage record missing focus, confidence or provenance', () => {
    const v = evaluateShadowReadiness([run({ triage: { ...okTriage, focus: null } }), run({ id: 'run-3', workerId: 'w3', hardTriggerReasons: null }), analysed()], [finding()]);
    expect(v.blockers).toEqual([
      'run run-1: decision, focus, reason or confidence missing',
      'run run-3: hard-trigger provenance missing',
    ]);
  });

  it('flags an analysed run without coverage, duplicate runs, evidence-free findings and shadow actions', () => {
    const v = evaluateShadowReadiness(
      [run(), run({ id: 'run-dup' }), analysed({ traceAvailability: null })],
      [finding({ evidenceRefs: [], actionTaskId: 'task-x', actionState: 'task_filed' })],
    );
    expect(v.blockers).toEqual(expect.arrayContaining([
      'run run-2: analysed without trace coverage',
      'worker worker-1: 2 runs for one policy version',
      'finding finding-1: no post-session run in its evidence',
      'finding finding-1: filed an action from shadow runs',
    ]));
  });
});
