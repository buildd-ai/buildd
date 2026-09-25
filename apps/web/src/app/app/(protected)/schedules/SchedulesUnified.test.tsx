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

// Mobile QA: below `sm` the row hid its whole stats column, leaving only a raw
// cron string, and Delete was opacity-0 until hover — which a phone never has.
describe('SchedulesUnified — mobile row', () => {
  const inAnHour = () => new Date(Date.now() + 60 * 60_000 + 30_000).toISOString();

  /** The class attribute of the first element carrying `data-testid`. */
  const classOf = (html: string, testid: string) => {
    const m = html.match(new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`));
    if (!m) return null;
    return m[0].match(/class="([^"]*)"/)?.[1] ?? '';
  };

  it('shows the next-run time on mobile, not just the cron', () => {
    const html = render([item({ id: 'w-1', nextRunAt: inAnHour() })]);
    const cls = classOf(html, 'schedule-next-run-mobile');
    expect(cls).not.toBeNull();
    expect(cls!.split(/\s+/)).toContain('sm:hidden');
    expect(html).toMatch(/data-testid="schedule-next-run-mobile"[^>]*>[^<]*(next )?in 1h/);
  });

  it('says paused on mobile for a disabled schedule', () => {
    const html = render([item({ id: 'w-1', isEnabled: false, nextRunAt: inAnHour() })]);
    expect(html).toMatch(/data-testid="schedule-next-run-mobile"[^>]*>[^<]*paused/);
  });

  it('the delete button is not hover-gated on touch or at phone width', () => {
    const html = render([item({ id: 'w-1', apiType: 'taskSchedule' })]);
    const tokens = classOf(html, 'schedule-delete-btn')!.split(/\s+/);
    // Any hiding must be scoped to a fine pointer at md+, never unconditional.
    for (const t of tokens.filter(t => /(^|:)opacity-0$/.test(t))) {
      expect(t.startsWith('md:pointer-fine:')).toBe(true);
    }
    expect(tokens).toContain('h-11');
    expect(tokens).toContain('w-11');
  });

  it('the filter tabs scroll inside their bar instead of widening the page', () => {
    const html = render([item({ id: 'w-1' })]);
    const tokens = classOf(html, 'schedule-filter-tabs')!.split(/\s+/);
    expect(tokens).toContain('overflow-x-auto');
    expect(tokens).toContain('min-w-0');
  });

  // Desktop regression from the scroller: the active tab's underline must sit
  // on the bar's rule, which a clipped -mb-px overlap can no longer reach.
  it('draws the bar rule as an inset shadow the active underline paints over', () => {
    const html = render([item({ id: 'w-1' })]);
    const tokens = classOf(html, 'schedule-filter-tabs')!.split(/\s+/);
    expect(tokens).not.toContain('border-b');
    expect(tokens).toContain('shadow-[inset_0_-1px_0_var(--border)]');
  });
});
