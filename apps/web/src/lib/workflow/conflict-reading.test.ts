/**
 * T12's reading of a live PR (seam.ts `conflictReading`). The live shape that
 * stranded approved, green PRs: no "require up to date" branch protection, so
 * GitHub reported `mergeable_state: clean` for a PR many commits behind dev.
 * Landing's freshness rail saw `behind_by > 0` and asked for a refresh; T12
 * read `clean` as "nothing to do" and answered `not_conflicting`, which the
 * doors report as "the branch already has every base commit". Same evidence,
 * same answer, every sweep: no update-branch call, no merge, no escalation.
 */
import { describe, expect, test } from 'bun:test';
import { conflictReading } from './seam';

describe('conflictReading', () => {
  test('a behind-hinted door on a clean PR whose head lacks the base tip reads behind', () => {
    expect(conflictReading('clean', 'behind', false)).toBe('behind');
    // Every mergeable state GitHub uses without strict protection, not only `clean`.
    for (const s of ['unstable', 'has_hooks', 'blocked']) expect(conflictReading(s, 'behind', false)).toBe('behind');
  });

  test('a head that already contains the base tip is clean: nothing to refresh', () => {
    expect(conflictReading('clean', 'behind', true)).toBe('clean');
  });

  test('an unread ancestry keeps today\'s answer (clean), never a guessed refresh', () => {
    expect(conflictReading('clean', 'behind', null)).toBe('clean');
  });

  test('a dirty-hinted door is not turned into a refresh by ancestry', () => {
    expect(conflictReading('clean', 'dirty', false)).toBe('clean');
  });

  test("GitHub's own dirty/behind win; an unsettled state is unknown", () => {
    expect(conflictReading('dirty', 'behind', true)).toBe('dirty');
    expect(conflictReading('behind', 'dirty', true)).toBe('behind');
    expect(conflictReading('unknown', 'behind', false)).toBe('unknown');
    expect(conflictReading(null, 'behind', false)).toBe('unknown');
  });
});
