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

describe('log row label', () => {
  it('is a 44px tap target below md, not its 20px line of text', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<WorkerActivityTimeline milestones={milestones} startedAt={T0} nowMs={T0 + 40_000} live />); });

    const labels = [...el.querySelectorAll('[data-testid="worker-log-entry"] > div > button:not([data-testid])')];
    expect(labels.length).toBeGreaterThan(0);
    for (const b of labels) expect(b.className.split(' ')).toEqual(expect.arrayContaining(['min-h-11', 'md:min-h-0']));

    await act(async () => root.unmount());
    el.remove();
  });
});

describe('tool-call preambles (mobile Activity regression)', () => {
  // Shaped like the reported mobile screenshot: a tool-heavy run where every
  // tool call was introduced by a "Now let me…" line.
  const run: WorkerMilestone[] = [
    { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: T0 },
    { type: 'phase', label: 'Now let me save a knowledge entry for this gotcha', toolCount: 1, ops: ['learn'], ts: T0 + 1_000 },
    { type: 'phase', label: 'Now let me create a workspace for the fixture', toolCount: 1, ops: ['create_workspace'], ts: T0 + 2_000 },
    { type: 'phase', label: 'Let me get error traces for this pattern', toolCount: 1, ops: ['get_error_traces'], ts: T0 + 3_000 },
    { type: 'phase', label: 'Let me check the decision record', toolCount: 1, ops: ['get_decision'], ts: T0 + 4_000 },
    { type: 'phase', label: 'Found it: the decision was superseded, so the gate is stale', toolCount: 2, ops: ['Edit'], ts: T0 + 5_000 },
  ];

  it('renders the actions, not the "Now let me…" rows, and keeps the raw text one tap away', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<WorkerActivityTimeline milestones={run} startedAt={T0} nowMs={T0 + 10_000} live={false} />); });

    const rows = [...el.querySelectorAll('[data-testid="worker-log-entry"]')].map(r => r.textContent ?? '');
    expect(rows.some(r => /now let me|let me (get|check)/i.test(r))).toBe(false);
    const text = el.textContent ?? '';
    for (const label of ['Saved knowledge', 'Created workspace', 'Checked error traces', 'Checked decision']) {
      expect(text).toContain(label);
    }
    // A finding is not scaffolding: it stays as written.
    expect(text).toContain('Found it: the decision was superseded');

    // Expanding the row exposes the exact words the agent wrote.
    const decision = [...el.querySelectorAll('[data-testid="worker-log-entry"]')].find(r => r.textContent?.includes('Checked decision'))!;
    await act(async () => { (decision.querySelector('button:not([data-testid])') as HTMLButtonElement).click(); });
    expect(decision.querySelector('[data-testid="worker-log-preamble"]')?.textContent).toBe('Let me check the decision record');

    await act(async () => root.unmount());
    el.remove();
  });
});
