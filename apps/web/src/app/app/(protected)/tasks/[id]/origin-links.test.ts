import { describe, test, expect } from 'bun:test';
import { originLinkCards } from './origin-links';

describe('originLinkCards', () => {
  test('every card says what it links to, above the thing itself', () => {
    const cards = originLinkCards([
      { key: 'worker', label: 'Plan the onboarding mission', href: '/app/tasks/t1' },
      { key: 'mission', label: 'Workspace onboarding', href: '/app/missions/m1' },
      { key: 'schedule', label: 'Nightly audit', href: '/app/schedules' },
      { key: 'parentTask', label: 'Fix the settings page', href: '/app/tasks/t2' },
    ]);
    expect(cards.map(c => [c.kind, c.title])).toEqual([
      ['Created by', 'Plan the onboarding mission'],
      ['Mission', 'Workspace onboarding'],
      ['Schedule', 'Nightly audit'],
      ['Parent task', 'Fix the settings page'],
    ]);
    expect(cards.every(c => !c.external)).toBe(true);
  });

  test('a PR card reads "#123", not "PR #123" under a "Pull request" heading', () => {
    const [card] = originLinkCards([{ key: 'pr', label: 'PR #123', href: 'https://github.com/o/r/pull/123' }]);
    expect(card).toMatchObject({ kind: 'Pull request', title: '#123', external: true });
  });

  test('a fallback label that only repeats the heading becomes a call to open it', () => {
    const cards = originLinkCards([
      { key: 'parentTask', label: 'Parent task', href: '/app/tasks/t2' },
      { key: 'run', label: 'CI run', href: 'https://github.com/o/r/actions/runs/1' },
      { key: 'worker', label: 'Agent run', href: '/app/tasks/t1' },
    ]);
    expect(cards.map(c => [c.kind, c.title])).toEqual([
      ['Parent task', 'Open task'],
      ['CI run', 'Open on GitHub'],
      ['Created by', 'Open the agent’s task'],
    ]);
  });
});
