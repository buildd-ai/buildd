import { describe, expect, it } from 'bun:test';
import { buildActionQueue } from './action-queue';
import { resolveQueueAttention } from './home-attention';
import { decisionCollectionNeedsYouItems, DECISION_FEATURES_HREF } from './decision-collection-needs-you';
import type { HealthRow } from '@buildd/core/decision-feature-health';

/** A decision feature that was asked all day and never decided raises one Home card for the platform owner. */

let seq = 0;
const row = (capability: string, over: Partial<HealthRow> = {}) => ({
  id: `r${++seq}`, capability, status: 'applied' as const, applied: true, verdict: 'x', reason: null,
  latencyMs: 10, costUsd: 0, overridden: false, ...over,
});
const fell = (capability: string, reason: string) => row(capability, { status: 'fallback', applied: false, verdict: null, reason });

describe('decisionCollectionNeedsYouItems', () => {
  it('raises one item per feature that was asked but never got a model answer, with the fix as its sentence', () => {
    const items = decisionCollectionNeedsYouItems([
      fell('task_role_shadow', 'insufficient_candidates'),
      fell('task_role_shadow', 'insufficient_candidates'),
      row('mission_goal_quality'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'incident',
      incidentId: 'decision-feature:task_role_shadow',
      fixHref: DECISION_FEATURES_HREF,
    });
    expect(items[0].incidentTitle).toBe('Task role routing is not deciding');
    expect(items[0].failureMessage).toStartWith('Not deciding: fewer than two roles say when to use them.');
  });

  it('raises misconfigured features, but not one a team deliberately switched off', () => {
    const items = decisionCollectionNeedsYouItems([fell('mission_goal_quality', 'missing_key'), fell('task_role_shadow', 'capability_disabled')]);
    expect(items.map(i => i.incidentId)).toEqual(['decision-feature:mission_goal_quality']);
  });

  it('is quiet when nothing asked a feature (idle is not broken)', () => {
    expect(decisionCollectionNeedsYouItems([])).toEqual([]);
  });

  it('renders as an owner card on Home', () => {
    const [raw] = decisionCollectionNeedsYouItems([fell('task_role_shadow', 'timeout')]);
    const [queued] = buildActionQueue([raw], []);
    const card = resolveQueueAttention(queued);
    expect(card).toMatchObject({ title: 'Task role routing is not deciding', primary: { href: DECISION_FEATURES_HREF } });
    expect(card?.sentence).toContain('did not answer in time');
  });
});
