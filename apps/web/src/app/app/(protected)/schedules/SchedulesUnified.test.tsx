import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// Client component: useRouter/useTransition need next/navigation to exist
// before the module is imported.
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
  usePathname: () => '/app/schedules',
  useSearchParams: () => new URLSearchParams(''),
}));

import SchedulesUnified, { type UnifiedScheduleItem } from './SchedulesUnified';

const item = (over: Partial<UnifiedScheduleItem> & { id: string }): UnifiedScheduleItem => ({
  name: 'Some schedule',
  type: 'workspace-schedule',
  workspaceId: 'ws-1',
  workspaceName: 'ws',
  cronExpression: '0 3 * * *',
  nextRunAt: null,
  lastRunAt: null,
  totalRuns: 0,
  consecutiveFailures: 0,
  isEnabled: true,
  lastError: null,
  href: '/app/schedules',
  apiType: 'taskSchedule',
  apiId: over.id,
  apiWorkspaceId: 'ws-1',
  ...over,
});

const render = (items: UnifiedScheduleItem[]) =>
  renderToStaticMarkup(<SchedulesUnified items={items} workspaces={[{ id: 'ws-1', name: 'ws' }]} />);

describe('SchedulesUnified — default heartbeat grouping (AC-5)', () => {
  it('renders a separate, collapsed heartbeat group in the default (all) view', () => {
    const html = render([
      item({ id: 'w-1', type: 'workspace-schedule', name: 'Workspace row' }),
      item({ id: 'h-1', type: 'heartbeat', name: 'Heartbeat row', apiType: 'mission' }),
    ]);
    const groupIdx = html.indexOf('data-testid="heartbeat-schedule-group"');
    expect(groupIdx).toBeGreaterThan(-1);
    // Collapsed by default: the heartbeat row's own content is not rendered,
    // only the group's toggle summary is.
    expect(html).not.toContain('Heartbeat row');
    expect(html).toContain('1 mission heartbeat');
    // The non-heartbeat row renders normally, outside/above the group.
    const wsIdx = html.indexOf('Workspace row');
    expect(wsIdx).toBeGreaterThan(-1);
    expect(wsIdx).toBeLessThan(groupIdx);
  });

  it('does not create an empty heartbeat group when there are no heartbeats', () => {
    const html = render([item({ id: 'w-1', type: 'workspace-schedule', name: 'Workspace row' })]);
    expect(html).not.toContain('data-testid="heartbeat-schedule-group"');
  });
});

describe('SchedulesUnified — stale lastError suppression (AC-4)', () => {
  it('renders no warning for a disabled schedule with a stale lastError', () => {
    const html = render([
      item({ id: 'w-1', isEnabled: false, lastError: 'boom: connection refused' }),
    ]);
    expect(html).not.toContain('boom: connection refused');
  });

  it('still renders the warning for an enabled schedule with the same lastError', () => {
    const html = render([
      item({ id: 'w-1', isEnabled: true, lastError: 'boom: connection refused' }),
    ]);
    expect(html).toContain('boom: connection refused');
  });
});
