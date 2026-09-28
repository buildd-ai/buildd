/**
 * The global needs-input banner links into mission context
 * (docs/design/mission-feed-mobile-continuity.md, "Interaction, URL and
 * scroll model"). Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NeedsInputBanner, { needsInputTaskHref } from './NeedsInputBanner';
import { NeedsInputContext } from './NeedsInputProvider';
import { hideNeedsInputBanner, hideNeedsInputBannerOnPhone, hideNeedsInputFor } from '@/lib/needs-input-hidden';

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

  it('does not render at all while the summoned canvas is up (it would sit above the scrim)', () => {
    const release = hideNeedsInputBanner();
    try {
      expect(render([waiting('q1', 'feat(checkout): pay in currency')])).toBe('');
    } finally { release(); }
    expect(render([waiting('q1', 'feat(checkout): pay in currency')])).toContain('needs your input');
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

describe('NeedsInputBanner: the phone chat canvas already says it', () => {
  const waiting = (id: string, title: string) => ({ id, title, workspaceId: 'ws', missionId: 'm1', waitingFor: null });
  const render = () => renderToStaticMarkup(
    <NeedsInputContext.Provider value={{ tasks: [waiting('q1', 'fix: a')], count: 1, alertPermission: 'unsupported', enableAlerts: () => {} }}>
      <NeedsInputBanner />
    </NeedsInputContext.Provider>,
  );
  const rootClass = (html: string) => /data-testid="global-needs-input-banner" class="([^"]*)"/.exec(html)?.[1].split(/\s+/) ?? [];

  it('hides on a phone while the canvas holds it, and stays on desktop', () => {
    const release = hideNeedsInputBannerOnPhone();
    try {
      const cls = rootClass(render());
      expect(cls).toContain('hidden');
      expect(cls).toContain('md:block');
    } finally { release(); }
  });

  it('shows everywhere otherwise', () => {
    expect(rootClass(render())).not.toContain('hidden');
  });
});

// Regression (demo capture): after the person answered, the banner still said
// the task needed their input until the worker resumed.
describe('NeedsInputBanner: an answer is on its way', () => {
  const task = (id: string, title: string, answerSent = false) => ({ id, title, workspaceId: 'ws', missionId: 'm1', waitingFor: null, answerSent });
  const render = (tasks: ReturnType<typeof task>[]) => renderToStaticMarkup(
    <NeedsInputContext.Provider value={{ tasks, count: tasks.filter(t => !t.answerSent).length, alertPermission: 'unsupported', enableAlerts: () => {} }}>
      <NeedsInputBanner />
    </NeedsInputContext.Provider>,
  );

  it('says the answer went, not that the task needs input', () => {
    const html = render([task('q1', 'feat(checkout): pay in currency', true)]);
    expect(html).toContain('data-testid="global-answer-sent-banner"');
    expect(html).toContain('Answer sent, waiting for the agent');
    expect(html).toContain('Pay in currency');
    expect(html).not.toContain('needs your input');
  });

  it('a task still waiting takes the banner; the answered one is not counted', () => {
    const html = render([task('q1', 'fix: a', true), task('q2', 'fix: b')]);
    expect(html).toContain('needs your input');
    expect(html).toContain('B');
    expect(html).not.toContain('2 tasks');
    expect(html).not.toContain('Answer sent');
  });
});
