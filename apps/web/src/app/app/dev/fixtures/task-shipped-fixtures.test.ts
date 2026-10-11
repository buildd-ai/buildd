import { describe, expect, it } from 'bun:test';
import { checkLede } from '@/lib/mission-shipped';
import { buildCommitChecksView } from '@/components/task/commit-checks-view';
import {
  COMMIT_CHECKS_VARIANTS,
  TASK_SHIPPED_VARIANTS,
  fixtureCommits,
  parseCommitChecksVariant,
  parseTaskShippedVariant,
  taskShippedFixtureInput,
  taskShippedFixtureVerdict,
  taskShippedFixtureView,
  fixtureOutcome,
} from './task-shipped-fixtures';
import { FIXTURE_VIEWS } from './visual-review-fixtures';

describe('task-shipped fixtures', () => {
  it('are reachable from the fixtures page', () => {
    expect(FIXTURE_VIEWS).toContain('task-shipped');
    expect(FIXTURE_VIEWS).toContain('commit-checks');
  });

  it('each variant leads with the verdict it is named for', () => {
    expect(taskShippedFixtureVerdict('open')).toMatchObject({ state: 'needs_you', headline: 'Ready to merge · PR #1234' });
    expect(taskShippedFixtureVerdict('merged-shots').state).toBe('shipped');
    expect(taskShippedFixtureView('merged-shots').heroShots.length).toBeGreaterThan(0);
    expect(taskShippedFixtureView('merged-shots').changeTypeLabel).toBe('On screen');
    expect(taskShippedFixtureView('no-lede').lede).toBeNull();
    const blocked = taskShippedFixtureVerdict('blocked');
    expect(blocked.state).toBe('blocked');
    expect(blocked.headline).toBe('PR blocked · 1 check failing: PR body lint');
    expect(fixtureOutcome('blocked').attempts[1].actions).toEqual(['Edited PR body']);
  });

  it('the fixture lede passes the same check a real one must', () => {
    const lede = taskShippedFixtureInput('open').record?.lede;
    expect(checkLede(lede).ok).toBe(true);
  });

  it('unknown variants fall back', () => {
    expect(parseTaskShippedVariant('nope')).toBe('open');
    expect(parseTaskShippedVariant(null)).toBe(TASK_SHIPPED_VARIANTS[0]);
    expect(parseCommitChecksVariant('nope')).toBeNull();
  });
});

describe('commit-checks fixtures', () => {
  it('cover all-passed, one-failed and two attempts', () => {
    expect(COMMIT_CHECKS_VARIANTS).toEqual(['all-passed', 'one-failed', 'two-attempts']);
    expect(buildCommitChecksView(fixtureCommits('all-passed'))[0].summary).toBe('✓ 9 checks passed');
    expect(buildCommitChecksView(fixtureCommits('one-failed'))[0].defaultOpen).toBe(true);
    expect(buildCommitChecksView(fixtureCommits('two-attempts')).map(v => v.defaultOpen)).toEqual([false, false]);
  });
});
