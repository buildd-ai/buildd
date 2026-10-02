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
  taskShippedFixtureView,
} from './task-shipped-fixtures';
import { FIXTURE_VIEWS } from './visual-review-fixtures';

describe('task-shipped fixtures', () => {
  it('are reachable from the fixtures page', () => {
    expect(FIXTURE_VIEWS).toContain('task-shipped');
    expect(FIXTURE_VIEWS).toContain('commit-checks');
  });

  it('each variant shows the state it is named for', () => {
    const open = taskShippedFixtureView('open');
    expect(open.action?.label).toBe('Review & merge');
    expect(open.chips.map(c => c.label)).toContain('Waiting on your merge');

    const merged = taskShippedFixtureView('merged-shots');
    expect(merged.action).toBeNull();
    expect(merged.chips.map(c => c.label)).toEqual(['Shipped']);
    expect(merged.heroShots.length).toBeGreaterThan(0);
    expect(merged.changeTypeLabel).toBe('On screen');

    expect(taskShippedFixtureView('recovered').hiccup?.label).toBe('One hiccup, already handled');
    expect(taskShippedFixtureView('no-lede').lede).toBeNull();
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
