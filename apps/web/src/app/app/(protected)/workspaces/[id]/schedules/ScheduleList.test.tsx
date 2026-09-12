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
