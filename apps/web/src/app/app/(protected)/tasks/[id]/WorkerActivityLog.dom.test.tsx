/**
 * The log's "N tools" chip opens the tool calls under the milestone they
 * happened in, and closes them again. Runs in its own process
 * (scripts/run-unit-tests.ts), so the happy-dom globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/task-1' });

import { describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkerMilestone } from '@buildd/core/db/schema';

const { default: WorkerActivityTimeline } = await import('./WorkerActivityTimeline');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_000_000;
const milestones: WorkerMilestone[] = [
  { type: 'status', label: 'Found the cause', ts: T0 },
  { type: 'status', label: 'Let me run the tests', ts: T0 + 1_000 },
  { type: 'action', label: 'Ran: bun test', tool: 'Bash', cmd: 'bun test', ts: T0 + 2_000 },
  { type: 'status', label: 'Tests pass', ts: T0 + 30_000 },
];

describe('log tools chip', () => {
  it('reveals and hides the tool calls under their milestone', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<WorkerActivityTimeline milestones={milestones} startedAt={T0} nowMs={T0 + 40_000} live />); });

    expect(el.textContent).not.toContain('Ran: bun test');
    const chips = el.querySelectorAll('[data-testid="worker-log-tools-chip"]');
    expect(chips.length).toBe(1);
    const chip = chips[0] as HTMLButtonElement;
    expect(chip.getAttribute('aria-expanded')).toBe('false');

    await act(async () => { chip.click(); });
    const tools = el.querySelector('[data-testid="worker-log-tools"]');
    expect(tools?.textContent).toContain('Ran: bun test');
    // Under "Found the cause" (the narration folded into it), not "Tests pass".
    expect(tools?.closest('[data-testid="worker-log-entry"]')?.textContent).toContain('Found the cause');

    await act(async () => { chip.click(); });
    expect(el.textContent).not.toContain('Ran: bun test');

    await act(async () => root.unmount());
    el.remove();
  });
});
