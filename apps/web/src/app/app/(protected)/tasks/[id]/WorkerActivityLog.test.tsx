import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkerMilestone } from '@buildd/core/db/schema';
import WorkerActivityTimeline, { entryGlyph } from './WorkerActivityTimeline';

// The running view's log: outcome milestones only, each with its duration;
// narration dropped; tool calls folded behind the "N tools" chip.
const T0 = 1_000_000;
const milestones: WorkerMilestone[] = [
  { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: T0 },
  { type: 'status', label: "Now I'll run the tests", ts: T0 + 10_000 },
  { type: 'action', label: 'Ran: bun test', tool: 'Bash', cmd: 'bun test', ts: T0 + 12_000 },
  { type: 'status', label: 'Tests pass', ts: T0 + 20_000 },
  { type: 'action', label: 'Edited b.ts', tool: 'Edit', path: 'b.ts', add: 3, rem: 1, ts: T0 + 25_000 },
  { type: 'status', label: 'Typecheck clean', ts: T0 + 62_000 },
];

function render(live = true, nowMs = T0 + 242_000) {
  return renderToStaticMarkup(
    <WorkerActivityTimeline milestones={milestones} startedAt={T0} nowMs={nowMs} live={live} />,
  );
}

describe('WorkerActivityTimeline log', () => {
  it('keeps the tape, drops the Touched list', () => {
    const html = render();
    expect(html).toContain('worker-activity-tape');
    expect(html).not.toContain('worker-touched');
    expect(html).not.toMatch(/>Touched</);
  });

  it('lists outcome milestones only, without narration', () => {
    const html = render();
    expect(html).toContain('Tests pass');
    expect(html).toContain('Typecheck clean');
    expect(html).not.toContain("Now I&#x27;ll run the tests");
    expect(html).not.toContain('Now I');
    expect(html.match(/data-testid="worker-log-entry"/g)?.length).toBe(3);
  });

  it('keeps tool calls collapsed behind the chip', () => {
    // The tape's ticks carry tool labels as titles; the log must not list them.
    const html = render().slice(render().indexOf('data-testid="worker-activity-log"'));
    expect(html).not.toContain('Ran: bun test');
    expect(html).not.toContain('Edited b.ts');
    expect(html).not.toContain('worker-log-tools"');
    expect(html.match(/data-testid="worker-log-tools-chip"/g)?.length).toBe(2);
    expect(html).toMatch(/1(&nbsp;| )tool\b/);
  });

  it('shows durations instead of "just now"', () => {
    const html = render();
    expect(html).not.toContain('just now');
    expect(html).not.toContain(' ago');
    const durations = [...html.matchAll(/data-testid="worker-log-duration"[^>]*>([^<]*)</g)].map(m => m[1]);
    expect(durations).toEqual(['running 3m', '42s', '20s']);
  });

  it('a finished run has no running entry', () => {
    const html = render(false, T0 + 999_000);
    expect(html).not.toContain('running ');
  });

  it('marks a passing outcome as success and a failure as an error', () => {
    expect(entryGlyph({ type: 'status', label: 'Tests pass' }).tone).toBe('success');
    expect(entryGlyph({ type: 'status', label: 'Tests failed' }).tone).toBe('error');
    expect(entryGlyph({ type: 'checkpoint', event: 'task_error' }).tone).toBe('error');
  });
});
