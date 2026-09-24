/**
 * Home's Missions section (docs/design/mission-feed-mobile-continuity.md, S5,
 * AC-14, addendum D8). Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildMissionCardView,
  summarizeMissionForCard,
  type MissionCardRow,
  type MissionCardTaskRow,
} from '@/lib/mission-card-view';
import { HomeMissions, selectHomeMissions, type HomeMissionSummary } from './HomeMissions';

let clock = Date.UTC(2026, 0, 1);
function task(id: string, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), workers: [], ...over };
}

const rows: MissionCardRow[] = [
  {
    id: 'm-run', title: 'Claim loop hardening', status: 'active',
    tasks: [
      task('a', { status: 'completed' }),
      task('b', { status: 'in_progress', workers: [{ status: 'running' }] }),
      task('c'),
    ],
  },
  {
    id: 'm-ask', title: 'Heartbeat renew', status: 'active',
    tasks: [task('d', { title: 'Lease expiry', status: 'in_progress', workers: [{ status: 'waiting_input' }] })],
  },
  { id: 'm-done', title: 'Retire the legacy lock', status: 'completed', tasks: [task('e', { status: 'completed' })] },
];

function summaries(): HomeMissionSummary[] {
  return rows.map(r => {
    const s = summarizeMissionForCard(r);
    return { id: r.id, group: s.group, nextScanMins: s.nextScanMins };
  });
}

describe('selectHomeMissions', () => {
  it('shows every active mission and the soonest three scheduled; counts active with the card grouping', () => {
    const list: HomeMissionSummary[] = [
      { id: 'r', group: 'running', nextScanMins: null },
      { id: 'a', group: 'attention', nextScanMins: null },
      { id: 's1', group: 'scheduled', nextScanMins: 90 },
      { id: 's2', group: 'scheduled', nextScanMins: 5 },
      { id: 's3', group: 'scheduled', nextScanMins: 30 },
      { id: 's4', group: 'scheduled', nextScanMins: 600 },
      { id: 'c', group: 'completed', nextScanMins: null },
      { id: 'p', group: 'paused', nextScanMins: null },
    ];
    const sel = selectHomeMissions(list);
    expect(sel.visibleIds).toEqual(['r', 'a', 's2', 's3', 's1']);
    expect(sel.activeCount).toBe(2);
    expect(sel.hiddenCount).toBe(3);
    expect(sel.scheduledCount).toBe(4);
    expect(sel.completedCount).toBe(1);
  });
});

describe('HomeMissions', () => {
  const list = summaries();
  const { visibleIds } = selectHomeMissions(list);
  const views = visibleIds.map(id => buildMissionCardView(rows.find(r => r.id === id)!, { from: 'home' }));
  const html = renderToStaticMarkup(<HomeMissions missions={list} views={views} />);

  it('renders the RUNNING NOW group for missions with live agents (AC-14)', () => {
    const running = html.split('data-testid="mission-group" data-group="running"')[1] ?? '';
    expect(running).toContain('RUNNING NOW');
    expect(running).toContain('Claim loop hardening');
    expect(html).not.toContain('NEEDS ATTENTION');
  });

  it('a mission waiting on the user is active: counted in the header (D8)', () => {
    expect(html).toContain('2 active');
  });

  it('each card carries the situation line and the pulse', () => {
    expect(html.match(/data-testid="mission-situation-line"/g)?.length).toBe(2);
    expect(html.match(/data-testid="mission-pulse"/g)?.length).toBe(2);
  });

  it('the card primary line opens the task in mission context, never the bare task page', () => {
    expect(html).toContain('href="/app/missions/m-ask?from=home&amp;task=d"');
    expect(html).not.toContain('/app/tasks/');
  });

  it('carries no per-card release footer (D6)', () => {
    expect(html).not.toContain('unshipped');
  });
});
