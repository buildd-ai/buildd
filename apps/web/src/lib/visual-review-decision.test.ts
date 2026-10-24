import { describe, expect, it } from 'bun:test';
import { SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE } from '@buildd/core/surface-audit';
import { buildVisualReviewModel } from './visual-review-model';
import { recaptureFixtureInput } from './visual-review-model.fixtures';
import { visualReviewDecision, withoutStaleRoundCap } from './visual-review-decision';

const mission = { id: 'm1', title: 'Spec page: readable on a phone', href: '/app/missions/m1' };

describe('visualReviewDecision', () => {
  const model = buildVisualReviewModel(recaptureFixtureInput('recapture-decide'));

  it('fixes merged with no new screenshot: asks about the fixed screens with the real options', () => {
    expect(model.phase).toBe('needs_you');
    const v = visualReviewDecision(model, mission)!;
    expect(v).not.toBeNull();
    expect(v.question).toMatch(/^Are the \d+ fixed screens? fixed\?$/);
    expect(v.options.map(o => o.label)).toEqual(['Mark all fixed', 'Review screens →', 'Skip the review']);
    expect(v.summary).toMatch(/merged with no new screenshot\.$/);
    expect(v.summary!.length).toBeLessThan(60);
    expect(v.answer.kind).toBe('visual');
    if (v.answer.kind === 'visual') expect(v.answer.markFixed.flatMap(g => g.artifactIds).length).toBeGreaterThan(0);
  });

  it('is null when the review needs nobody', () => {
    expect(visualReviewDecision({ ...model, phase: 'reviewed', needsYou: null }, mission)).toBeNull();
    expect(visualReviewDecision(null, mission)).toBeNull();
  });

  it('drops the round-cap note once a review state exists, keeps it without one', () => {
    const notes = [{ title: SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE }, { title: 'Other' }];
    expect(withoutStaleRoundCap(notes, model).map(n => n.title)).toEqual(['Other']);
    expect(withoutStaleRoundCap(notes, null)).toHaveLength(2);
  });
});
