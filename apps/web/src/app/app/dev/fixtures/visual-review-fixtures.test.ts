import { describe, it, expect } from 'bun:test';
import { parseQaMeta } from '@/lib/mission-visual-review';
import { mockWorkers } from './fixtures-data';
import {
  FIXTURE_VIEWS,
  VISUAL_REVIEW_FIXTURE_STATE,
  isFixtureView,
  visualReviewFixtureShots,
} from './visual-review-fixtures';

/**
 * The `?state=visual-review` fixture renders the mission Visual review strip
 * with placeholder shots. The images must be self-made SVGs, never captures:
 * the repo is public.
 */
describe('visual review fixture', () => {
  it('is a fixture view alongside the worker states, without joining mockWorkers', () => {
    expect(FIXTURE_VIEWS).toEqual([...Object.keys(mockWorkers), VISUAL_REVIEW_FIXTURE_STATE]);
    expect(VISUAL_REVIEW_FIXTURE_STATE in mockWorkers).toBe(false);
    expect(isFixtureView('visual-review')).toBe(true);
    expect(isFixtureView('waiting-input')).toBe(true);
    expect(isFixtureView('nope')).toBe(false);
    expect(isFixtureView(null)).toBe(false);
  });

  it('has shots whose metadata.qa parses, covering every verdict and both viewports', () => {
    for (const s of visualReviewFixtureShots) {
      expect(parseQaMeta({ qa: s.qa })).toEqual(s.qa);
    }
    const verdicts = new Set(visualReviewFixtureShots.map(s => s.qa.verdict));
    expect([...verdicts].sort()).toEqual(['issue', 'ok', 'unsure']);
    const viewports = new Set(visualReviewFixtureShots.map(s => s.qa.viewport));
    expect([...viewports].sort()).toEqual(['desktop', 'mobile']);
    expect(new Set(visualReviewFixtureShots.map(s => s.id)).size).toBe(visualReviewFixtureShots.length);
  });

  it('uses inline SVG images, plus one missing image to show the expired tile', () => {
    const svg = visualReviewFixtureShots.filter(s => s.src.startsWith('data:image/svg+xml,'));
    const other = visualReviewFixtureShots.filter(s => !s.src.startsWith('data:image/svg+xml,'));
    expect(svg.length).toBe(visualReviewFixtureShots.length - 1);
    expect(other.map(s => s.src)).toEqual(['/dev-fixtures/expired-shot.png']);
    for (const s of visualReviewFixtureShots) expect(s.src).not.toContain('/api/artifacts/');
  });

  it('is deterministic: fixed ISO dates and one run key', () => {
    for (const s of visualReviewFixtureShots) {
      expect(s.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(new Set(visualReviewFixtureShots.map(s => s.qa.runKey)).size).toBe(1);
  });
});
