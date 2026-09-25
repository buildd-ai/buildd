/**
 * FlightDetailSheet, mounted (happy-dom): selection is per-opening, and every
 * bar is a real hit target (W1, AC-20). Fixtures are illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/home' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { computeMissionFlightStrip } = await import('@buildd/core/mission-helpers');
const { FlightDetailSheet } = await import('./FlightDetailSheet');

const DATA = computeMissionFlightStrip(
  [
    { id: 'a', status: 'completed', roleSlug: 'builder' },
    { id: 'b', status: 'pending', roleSlug: 'builder' },
  ],
  [{ id: 'w1', taskId: 'a', status: 'completed', startedAt: new Date(0), completedAt: new Date(60_000) }],
);

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

function render(open: boolean) {
  act(() => {
    root.render(
      <FlightDetailSheet
        open={open}
        onClose={() => {}}
        data={DATA}
        missionId="m1"
        missionTitle="Ship the thing"
        from="home"
        taskTitles={{ a: 'Wire the lease', b: 'Check the lease' }}
      />,
    );
  });
}

const openLink = () => document.body.querySelector('[data-testid="flight-detail-open-mission"]') as HTMLAnchorElement;

describe('FlightDetailSheet (mounted)', () => {
  it('a selection does not survive closing and reopening the sheet', () => {
    render(true);
    const bar = document.body.querySelector('[data-testid="flight-detail-bar"][data-task-id="a"]') as Element;
    act(() => { bar.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(openLink().getAttribute('href')).toBe('/app/missions/m1?from=home&task=a');

    render(false);
    render(true);
    expect(openLink().getAttribute('href')).toBe('/app/missions/m1?from=home');
    expect(document.body.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it('every bar target hit-tests its whole band, including hollow queued bars', () => {
    render(true);
    const targets = [...document.body.querySelectorAll('[data-testid="flight-detail-bar"]')];
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const t of targets) {
      expect(t.getAttribute('pointer-events')).toBe('all');
      expect(Number(t.getAttribute('height'))).toBeGreaterThan(18);
      expect(Number(t.getAttribute('width'))).toBeGreaterThanOrEqual(12);
    }
  });

  it('a bar is labelled with its task title', () => {
    render(true);
    const bar = document.body.querySelector('[data-testid="flight-detail-bar"][data-task-id="b"]') as Element;
    expect(bar.getAttribute('aria-label')).toContain('Check the lease');
  });

  // The sheet is opened from inside the sticky mission masthead (its own z-20
  // stacking context), so a fixed z-50 sheet rendered in place still paints
  // under the fixed bottom nav. It must escape to <body>.
  it('portals the dialog to document.body, outside the trigger subtree', () => {
    render(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.parentElement).toBe(document.body);
  });

  it('removes the portalled dialog when closed', () => {
    render(true);
    render(false);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  // A flex column with max-h + overflow shrinks its children to fit instead of
  // scrolling: the chart squashed and the two-line title clipped on a phone.
  it('the scrolling panel does not shrink its children to fit', () => {
    render(true);
    const panel = document.body.querySelector('[data-testid="flight-detail-panel"]') as HTMLElement;
    expect(panel).not.toBeNull();
    const cls = panel.className.split(/\s+/);
    expect(cls).toContain('overflow-y-auto');
    const shrinkingFlexColumn = cls.includes('flex-col') && ![...panel.children].every(c => c.classList.contains('shrink-0'));
    expect(shrinkingFlexColumn).toBe(false);
  });
});
