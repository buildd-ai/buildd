import { describe, expect, it } from 'bun:test';
import { buildVisualReviewModel, emptyVisualReviewModel } from './visual-review-model';

const NOW = Date.UTC(2026, 0, 10, 12);

describe('emptyVisualReviewModel', () => {
  it('is the model of a mission whose tasks hold no audit and no fix', () => {
    const builders = [
      { id: 't1', title: 'Build the page', status: 'completed', roleSlug: 'builder', dependsOn: [], workers: [] },
      { id: 't2', title: 'Wire the route', status: 'in_progress', roleSlug: 'builder', dependsOn: ['t1'], workers: [] },
    ];
    const loaded = buildVisualReviewModel({
      missionId: 'm1', shots: [], tasks: builders as never, reviews: [], roundCapOpen: false,
      browserRunnerOnline: null, captureRef: null, missionIntegrationBranch: null, now: NOW,
    });
    expect(emptyVisualReviewModel('m1', NOW)).toEqual(loaded);
    expect(loaded.audit).toBeNull();
  });
});
