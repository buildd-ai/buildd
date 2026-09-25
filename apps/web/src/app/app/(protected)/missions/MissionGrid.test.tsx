/**
 * Missions list grouping and cards (docs/design/mission-feed-mobile-continuity.md,
 * S5, AC-14, addendum D6/D7/D8). Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { derivedValue, derivedUnavailable } from '@buildd/core/derived-metric';
import { buildMissionCardView, type MissionCardRow, type MissionCardTaskRow } from '@/lib/mission-card-view';
import { MissionGrid, type MissionItem } from './MissionGrid';

let clock = Date.UTC(2026, 0, 1);
function task(id: string, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), workers: [], ...over };
}
function item(row: MissionCardRow, workspaceId = 'ws1'): MissionItem {
  return {
    view: buildMissionCardView(row, { from: 'missions' }),
    workspaceId, workspaceName: 'Platform', isHeld: row.isHeld ?? false,
    nextScanMins: null, lastActivityAt: new Date().toISOString(), lastRunAt: null,
  };
}

const running = item({
  id: 'm-run', title: 'Claim loop hardening', status: 'active',
  tasks: [task('a', { status: 'in_progress', workers: [{ status: 'running' }] }), task('b')],
});
const waiting = item({
  id: 'm-ask', title: 'Heartbeat renew', status: 'active',
  tasks: [task('c', { status: 'in_progress', workers: [{ status: 'waiting_input' }] })],
});
const done = item({
  id: 'm-done', title: 'Retire the legacy lock', status: 'completed', completedAt: new Date(),
  tasks: [task('d', { status: 'completed' })],
});

describe('MissionGrid', () => {
  const release = {
    ws1: {
      archetype: 'gated' as const,
      queueDepth: derivedValue(3),
      oldestMergedAt: derivedUnavailable<string>('no_scope'),
      baselineSource: 'healthy' as const,
      releaseId: 'rel-1',
    },
  };
  const html = renderToStaticMarkup(<MissionGrid missions={[running, waiting, done]} releaseFooters={release} />);

  it('an active mission with live agents under 100% lands in RUNNING, not NEEDS ATTENTION (AC-14)', () => {
    const runningGroup = html.split('data-testid="mission-group" data-group="running"')[1] ?? '';
    expect(runningGroup).toContain('Claim loop hardening');
    expect(html).not.toContain('data-group="attention"');
  });

  it('a mission waiting on the user counts as active in the tab counts (D8)', () => {
    expect(html).toMatch(/Active<span class="ml-1 opacity-60">2<\/span>/);
  });

  it('renders every card with the card masthead and a compact completed card (D7)', () => {
    expect(html.match(/data-testid="mission-masthead"/g)?.length).toBe(2);
    expect(html).toContain('data-testid="mission-card-compact"');
  });

  it('shows the workspace release state once, never on a card (D6)', () => {
    expect(html.match(/unshipped/g)?.length).toBe(1);
    expect(html.match(/data-testid="workspace-release-footer"/g)?.length).toBe(1);
  });

  it('links nothing straight to a task page', () => {
    expect(html).not.toContain('/app/tasks/');
  });
});

describe('MissionGrid — completed-only workspaces collapse to tight one-line headers', () => {
  const longAgo = new Date(Date.now() - 30 * 24 * 3_600_000);
  const old = (id: string, ws: string, name: string): MissionItem => ({
    ...item({ id, title: `Example ${id}`, status: 'completed', completedAt: longAgo, tasks: [task(`${id}-t`, { status: 'completed' })] }, ws),
    workspaceName: name,
    lastActivityAt: longAgo.toISOString(),
  });
  const html = renderToStaticMarkup(
    <MissionGrid missions={[old('o1', 'ws-a', 'Alpha'), old('o2', 'ws-b', 'Beta'), old('o3', 'ws-b', 'Beta'), running]} />,
  );

  it('stacks consecutive completed-only workspaces in one list, with no gap between them', () => {
    const lists = html.match(/<div[^>]*data-testid="mission-compact-workspaces"[^>]*>/g) ?? [];
    expect(lists).toHaveLength(1);
    expect(lists[0]).not.toMatch(/space-y-|gap-|py-|my-/);
    const list = html.slice(html.indexOf('data-testid="mission-compact-workspaces"'));
    const rows = list.match(/<button[^>]*data-testid="mission-workspace-compact"[^>]*>/g) ?? [];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // The row is the 44px tap target itself; no padding stacked on top of it.
      expect(row).toContain('min-h-11');
      expect(row).not.toMatch(/\bpy-|\bmy-/);
    }
  });

  it('each row still names the workspace and its hidden count, and expands on tap', () => {
    const list = html.slice(html.indexOf('data-testid="mission-compact-workspaces"'));
    expect(list).toContain('Alpha');
    expect(list).toContain('Show 1 older');
    expect(list).toContain('Beta');
    expect(list).toContain('Show 2 older');
    expect(list).toMatch(/data-testid="mission-workspace-compact"[^>]*aria-expanded="false"/);
  });
});

describe('MissionGrid — the Active count includes the missions waiting on you (D8)', () => {
  it('counts a paused mission whose work is done (READY FOR REVIEW) as active', () => {
    const review = item({ id: 'm-rev', title: 'Example review', status: 'paused', tasks: [task('r', { status: 'completed' })] });
    expect(review.view.chip.label).toBe('READY FOR REVIEW');
    const html = renderToStaticMarkup(<MissionGrid missions={[review]} />);
    expect(html).toMatch(/Active<span class="ml-1 opacity-60">1<\/span>/);
    expect(html).not.toContain('data-group="paused"');
  });
});

// Mobile QA: on a 320px phone the filter pills scroll with no sign there is
// more to the right. The bar fades its trailing edge below md.
describe('MissionGrid filter bar', () => {
  it('fades its trailing edge below md and keeps pills from shrinking', () => {
    const html = renderToStaticMarkup(<MissionGrid missions={[running, waiting, done]} />);
    const bar = html.match(/<div\b[^>]*data-testid="mission-filter-bar"[^>]*>/)![0];
    expect(bar).toContain('overflow-x-auto');
    expect(bar).toMatch(/\[mask-image:linear-gradient\(to_right[^\]]*transparent\)\]/);
    expect(bar).toContain('md:[mask-image:none]');
    const pill = html.match(/<button\b[^>]*class="[^"]*filter-pill[^"]*"[^>]*>/)![0];
    expect(pill).toContain('shrink-0');
  });
});
