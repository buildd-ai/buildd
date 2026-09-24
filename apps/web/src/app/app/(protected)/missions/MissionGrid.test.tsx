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
