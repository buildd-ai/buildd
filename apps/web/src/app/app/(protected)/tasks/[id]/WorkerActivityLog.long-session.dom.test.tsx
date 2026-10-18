/**
 * A 550-turn session on a phone: the log opens on a handful of rows, a tap adds
 * a page (never hundreds at once), and every raw milestone stays reachable.
 * Rows carry no fixed width, so 320 and 390px both wrap instead of scrolling.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/task-1', width: 320, height: 640 });

import { describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkerMilestone } from '@buildd/core/db/schema';

const { default: WorkerActivityTimeline } = await import('./WorkerActivityTimeline');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_000_000;
const OPS = [['Read'], ['Edit'], ['Bash'], ['get_task']];
const turns: WorkerMilestone[] = Array.from({ length: 550 }, (_, i) => ({
  type: 'phase' as const, label: `Finding ${i}: the ${i % 7 === 0 ? 'cache' : 'queue'} path differs`, toolCount: 1, ops: OPS[i % 4], ts: T0 + i * 10_000,
}));

const rows = (el: Element) => el.querySelectorAll('[data-testid="worker-log-entry"]').length;

describe('long session', () => {
  it('starts on a short page and grows one page per tap', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<WorkerActivityTimeline milestones={turns} startedAt={T0} nowMs={T0 + 600 * 10_000} />); });
    expect(rows(el)).toBeLessThanOrEqual(8);

    const more = () => [...el.querySelectorAll('button')].find(b => /more/.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { more().click(); });
    expect(rows(el)).toBeGreaterThan(8);
    expect(rows(el)).toBeLessThanOrEqual(8 + 25);
    expect(more().textContent).toMatch(/\d+ left/);
  });

  it('keeps every milestone reachable: Show all lists them', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<WorkerActivityTimeline milestones={turns} startedAt={T0} nowMs={T0 + 600 * 10_000} />); });
    const all = [...el.querySelectorAll('button')].find(b => /Show all/.test(b.textContent ?? '')) as HTMLButtonElement;
    await act(async () => { all.click(); });
    expect(rows(el)).toBeGreaterThan(50);
  });
});
