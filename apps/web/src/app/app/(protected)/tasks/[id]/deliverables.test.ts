/**
 * A task that only ran on a branch (a visual audit, a research task) opened no
 * PR and made no commits; its branch is not a deliverable.
 */
import { describe, expect, it } from 'bun:test';
import { hasCodeDeliverables } from './deliverables';

describe('hasCodeDeliverables', () => {
  it('is false for a branch with no commits and no PR', () => {
    expect(hasCodeDeliverables({ branch: 'buildd/abc-visual-review', commits: 0 })).toBe(false);
    expect(hasCodeDeliverables({ branch: 'buildd/abc-visual-review' })).toBe(false);
  });

  it('is true with commits or a PR', () => {
    expect(hasCodeDeliverables({ branch: 'b', commits: 2 })).toBe(true);
    expect(hasCodeDeliverables({ prUrl: 'https://example.test/pr/1' })).toBe(true);
  });

  it('is false for an empty result', () => {
    expect(hasCodeDeliverables({})).toBe(false);
  });
});
