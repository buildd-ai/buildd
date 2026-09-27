/**
 * The global needs-input banner links into mission context
 * (docs/design/mission-feed-mobile-continuity.md, "Interaction, URL and
 * scroll model"). Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NeedsInputBanner, { needsInputTaskHref } from './NeedsInputBanner';
import { NeedsInputContext } from './NeedsInputProvider';
import { hideNeedsInputFor } from '@/lib/needs-input-hidden';

describe('needsInputTaskHref', () => {
  it('opens a mission task as the sheet over its mission', () => {
    expect(needsInputTaskHref({ id: 'task-1', missionId: 'mission-1' })).toBe('/app/missions/mission-1?task=task-1');
  });

  it('opens a task with no mission on its own page', () => {
    expect(needsInputTaskHref({ id: 'task-1', missionId: null })).toBe('/app/tasks/task-1');
    expect(needsInputTaskHref({ id: 'task-1' })).toBe('/app/tasks/task-1');
  });
});

// Regression (demo capture, phone respond step): the banner for a question sat
// on top of the sheet answering that same question.
describe('NeedsInputBanner — the question open in its own sheet', () => {
  const waiting = (id: string, title: string) => ({ id, title, workspaceId: 'ws', missionId: 'm1', waitingFor: null });
  const render = (tasks: ReturnType<typeof waiting>[]) => renderToStaticMarkup(
    <NeedsInputContext.Provider value={{ tasks, count: tasks.length, alertPermission: 'unsupported', enableAlerts: () => {} }}>
      <NeedsInputBanner />
    </NeedsInputContext.Provider>,
  );

  it('does not render for the only waiting question while its sheet is open', () => {
    const release = hideNeedsInputFor('q1');
    try {
      expect(render([waiting('q1', 'feat(checkout): pay in currency')])).toBe('');
    } finally { release(); }
  });

  it('still names the other waiting question, counted without the open one', () => {
    const release = hideNeedsInputFor('q1');
    try {
      const html = render([waiting('q1', 'feat(checkout): pay in currency'), waiting('q2', 'docs: billing guide')]);
      expect(html).toContain('Billing guide');
      expect(html).not.toContain('ay in currency');
      expect(html).toContain('needs your input');
      expect(html).not.toContain('2 tasks');
    } finally { release(); }
  });

  it('renders again once the sheet is closed', () => {
    hideNeedsInputFor('q1')();
    expect(render([waiting('q1', 'feat(checkout): pay in currency')])).toContain('needs your input');
  });
});

// Regression (UX review): the banner named the task by its raw commit-style
// title ("feat(checkout): pay in the presentment currency via Stripe") where
// every page shows the sentence ("Pay in the presentment currency via Stripe").
describe('NeedsInputBanner — names the task as the task page does', () => {
  const waiting = (id: string, title: string) => ({ id, title, workspaceId: 'ws', missionId: 'm1', waitingFor: null });
  const render = (tasks: ReturnType<typeof waiting>[]) => renderToStaticMarkup(
    <NeedsInputContext.Provider value={{ tasks, count: tasks.length, alertPermission: 'unsupported', enableAlerts: () => {} }}>
      <NeedsInputBanner />
    </NeedsInputContext.Provider>,
  );

  it('drops the conventional-commit prefix', () => {
    const html = render([waiting('q1', 'feat(checkout): pay in the presentment currency via Stripe')]);
    expect(html).toContain('Pay in the presentment currency via Stripe');
    expect(html).not.toContain('feat(checkout)');
  });

  it('joins two waiting tasks without an em dash', () => {
    const html = render([waiting('q1', 'fix: a'), waiting('q2', 'fix: b')]);
    expect(html).toContain('2 tasks need your input');
    expect(html).not.toContain('\u2014');
  });
});
