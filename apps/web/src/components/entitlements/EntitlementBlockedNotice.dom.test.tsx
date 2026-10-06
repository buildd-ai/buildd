/**
 * EntitlementBlockedNotice mounted (happy-dom): a plan limit reads as a queued
 * task with a way to raise the limit, never as an error, for every block kind.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { EntitlementBlock } from '@buildd/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: EntitlementBlockedNotice } = await import('./EntitlementBlockedNotice');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(block: EntitlementBlock, onLeaveQueued?: () => void) {
  act(() => root.render(<EntitlementBlockedNotice block={block} onLeaveQueued={onLeaveQueued} upgradeHref="/upgrade" />));
  return container.querySelector('[data-testid="entitlement-blocked"]') as HTMLElement;
}

const individual: EntitlementBlock = { kind: 'concurrency', key: 'managed_runner.concurrency', active: 3, limit: 3, scope: 'individual' };
const team: EntitlementBlock = { kind: 'concurrency', key: 'managed_runner.concurrency', active: 10, limit: 10, scope: 'team' };
const hours: EntitlementBlock = { kind: 'usage', key: 'managed_runner.hours', unit: 'runner_hours', used: 50, limit: 50, resetsAt: '2026-11-01T00:00:00.000Z', scope: 'individual' };

/** No error colour, no alert role, anywhere in the notice. */
function expectNotAnError(el: HTMLElement) {
  expect(el.getAttribute('role')).toBe('status');
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(el.outerHTML).not.toMatch(/status-error|status-warning|text-red|border-red/);
  expect(el.textContent).not.toMatch(/fail|error/i);
}

describe('EntitlementBlockedNotice', () => {
  it('concurrency (hosted individual): the limit, that it starts by itself, and the upgrade', () => {
    const el = render(individual);
    expect(el.dataset.kind).toBe('concurrency');
    expect(el.textContent).toContain('3 managed runs already active');
    expect(el.textContent).toContain('Your plan includes up to 3 at once.');
    expect(el.textContent).toContain('This task will start automatically when one finishes.');
    const cta = el.querySelector('[data-testid="entitlement-upgrade"]') as HTMLAnchorElement;
    expect(cta.textContent).toBe('Upgrade parallel capacity');
    expect(cta.getAttribute('href')).toBe('/upgrade');
    expect(el.querySelector('[data-action="leave_queued"]')?.textContent).toBe('Leave queued');
    expect(el.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('info');
    expectNotAnError(el);
  });

  it('concurrency (team): says the limit is shared', () => {
    const el = render(team);
    expect(el.textContent).toContain('10 managed runs already active');
    expect(el.textContent).toContain('up to 10 at once, shared across your team');
    expectNotAnError(el);
  });

  it('runner-hours exhausted: the same component, its own words and action', () => {
    const el = render(hours);
    expect(el.dataset.kind).toBe('usage');
    expect(el.textContent).toContain('Monthly runner-hours used: 50 of 50');
    expect(el.textContent).toContain('start automatically when hours refill on Nov 1');
    expect(el.querySelector('[data-testid="entitlement-upgrade"]')?.textContent).toBe('Add runner-hours');
    expectNotAnError(el);
  });

  it('tells the plan limit apart from self-hosted capacity', () => {
    expect(render(individual).textContent).toContain('Your own runners are not limited by your plan.');
  });

  it('Leave queued collapses to one line in place', () => {
    const el = render(individual);
    act(() => (el.querySelector('[data-action="leave_queued"]') as HTMLButtonElement).click());
    const collapsed = container.querySelector('[data-testid="entitlement-blocked"]') as HTMLElement;
    expect(collapsed.dataset.collapsed).toBe('true');
    expect(collapsed.textContent).toContain('3 managed runs already active');
    expectNotAnError(collapsed);
  });

  it('Leave queued hands back to the host when the host owns the state', () => {
    let left = 0;
    const hosted = render(team, () => { left++; });
    act(() => (hosted.querySelector('[data-action="leave_queued"]') as HTMLButtonElement).click());
    expect(left).toBe(1);
  });
});
