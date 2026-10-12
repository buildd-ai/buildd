import { describe, expect, it } from 'bun:test';
import { featureHealthById, groupDecisionFeatures, type DecisionHealthRow } from './decision-features';

/** The per-feature readout on GET /api/admin/decisions/features. Synthetic rows. */

let seq = 0;
const row = (capability: string, over: Partial<DecisionHealthRow> = {}): DecisionHealthRow => ({
  id: `r${++seq}`, capability, status: 'applied', applied: true, verdict: 'x', reason: null,
  latencyMs: 50, costUsd: 0.001, overridden: false, ...over,
});

describe('featureHealthById', () => {
  it('reads each capability on its own rows and its own audit grades', () => {
    const a = row('task_role_shadow');
    const b = row('mission_goal_quality');
    const health = featureHealthById(
      [a, b, row('task_role_shadow', { status: 'fallback', applied: false, verdict: null, reason: 'timeout' })],
      [{ decisionRecordId: a.id, source: 'agent_audit', label: 'wrong' }, { decisionRecordId: b.id, source: 'agent_audit', label: 'right' }],
    );
    expect(health.get('task_role_shadow')).toMatchObject({ calls: 2, acted: { n: 1, pct: 50 }, graded: { n: 1, wrong: 1 } });
    expect(health.get('mission_goal_quality')).toMatchObject({ calls: 1, graded: { n: 1, right: 1 } });
  });
});

describe('groupDecisionFeatures with health', () => {
  it('attaches a readout to every feature: a quiet one reads not collecting, an alias reads under its target', () => {
    const rows = Array.from({ length: 3 }, () => row('task_role_shadow', { status: 'fallback', applied: false, verdict: null, reason: 'insufficient_candidates' }));
    const out = groupDecisionFeatures([], new Map(), featureHealthById(rows, []));
    const features = out.groups.flatMap(g => g.features);
    const role = features.find(f => f.id === 'task_role_shadow')!;
    expect(role.health?.collection).toMatchObject({ state: 'not_collecting', reason: 'insufficient_candidates' });
    expect(role.health?.collection.sentence).toStartWith('Not deciding: fewer than two roles say when to use them.');
    expect(features.find(f => f.id === 'task_role_apply')!.health).toBeNull();
    const quiet = features.find(f => f.id === 'mission_goal_quality')!;
    expect(quiet.health).toMatchObject({ calls: 0, collection: { state: 'not_collecting', reason: 'no_records' } });
  });

  it('gives a decision kind with its own id (unregistered) its readout too', () => {
    const rows = [row('buildd.post_session_triage')];
    const out = groupDecisionFeatures(
      [{ capability: 'buildd.post_session_triage', count: 1, applied: 1, suggested: 0, fallback: 0, overridden: 0, costUsd: 0, inputTokens: 0 }],
      new Map(),
      featureHealthById(rows, []),
    );
    expect(out.unregistered[0]).toMatchObject({ id: 'buildd.post_session_triage', health: { calls: 1 } });
  });

  it('leaves the response as it was when no health is passed', () => {
    const out = groupDecisionFeatures([], new Map());
    expect(out.groups.flatMap(g => g.features).every(f => !('health' in f))).toBe(true);
  });
});
