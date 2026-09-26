import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// Client component: useRouter needs next/navigation to exist before import.
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

import { ScheduleList } from './ScheduleList';

const schedule = (over: Partial<Parameters<typeof ScheduleList>[0]['initialSchedules'][number]> & { id: string }) => ({
  id: over.id,
  name: 'Some schedule',
  cronExpression: '0 3 * * *',
  timezone: 'UTC',
  taskTemplate: { title: 'Do a thing' },
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastTaskId: null,
  totalRuns: 0,
  consecutiveFailures: 0,
  lastError: null,
  lastCheckedAt: null,
  lastTriggerValue: null,
  totalChecks: 0,
  pendingSuggestion: null,
  ...over,
});

const render = (initialSchedules: ReturnType<typeof schedule>[]) =>
  renderToStaticMarkup(
    <ScheduleList workspaceId="ws-1" initialSchedules={initialSchedules} />,
  );

describe('ScheduleList — stale lastError suppression (AC-4)', () => {
  it('renders no warning for a disabled schedule with a stale lastError', () => {
    const html = render([
      schedule({ id: 's-1', enabled: false, lastError: 'boom: connection refused' }),
    ]);
    expect(html).not.toContain('boom: connection refused');
  });

  it('still renders the warning for an enabled schedule with the same lastError', () => {
    const html = render([
      schedule({ id: 's-1', enabled: true, lastError: 'boom: connection refused' }),
    ]);
    expect(html).toContain('boom: connection refused');
  });
});

describe('ScheduleList — narrow layout', () => {
  // At 320px the details column and the toggle/edit/delete cluster shared one
  // row, squeezing the details to a sliver. Below sm they stack.
  it('stacks details above the actions below sm and sits them side by side from sm', () => {
    const html = render([schedule({ id: 's-1', name: 'Nightly' })]);
    const row = html.match(/<div data-testid="schedule-row" class="([^"]*)"/);
    expect(row).not.toBeNull();
    const cls = row![1].split(/\s+/);
    expect(cls).toContain('flex-col');
    expect(cls).toContain('sm:flex-row');
    expect(cls).not.toContain('justify-between'); // only from sm
    expect(cls).toContain('sm:justify-between');

    const actions = html.match(/<div data-testid="schedule-row-actions" class="([^"]*)"/);
    expect(actions).not.toBeNull();
    const aCls = actions![1].split(/\s+/);
    expect(aCls.some(c => /^ml-[1-9]/.test(c))).toBe(false); // no left gutter when stacked
  });

  it('lets a long task title wrap instead of overflowing', () => {
    const html = render([schedule({ id: 's-1', taskTemplate: { title: 'x'.repeat(120) } })]);
    expect(html).toMatch(/class="[^"]*\[overflow-wrap:anywhere\][^"]*">Creates: x{120}/);
  });
});
