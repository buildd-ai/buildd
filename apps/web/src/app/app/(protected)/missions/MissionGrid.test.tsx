/**
 * Missions list: running card with a phase bar, recurring/held mini cards,
 * done rows (docs/design/mission-feed-mobile-continuity.md, D6/D8, and the
 * home + missions-list redesign). Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// The inline answer and Arm buttons refresh the route after a POST.
mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/missions',
  useSearchParams: () => new URLSearchParams(''),
}));

import { derivedValue, derivedUnavailable } from '@buildd/core/derived-metric';
import { buildMissionCardView, summarizeMissionForCard, type MissionCardTaskRow } from '@/lib/mission-card-view';
import { buildMissionListCard, type ListMissionRow } from '@/lib/mission-list-card';
import { MissionGrid, type MissionItem } from './MissionGrid';

let clock = Date.UTC(2026, 0, 1);
function task(id: string, over: Partial<MissionCardTaskRow> & Record<string, unknown> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `feat(${id}): something`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), workers: [], ...over };
}
function item(row: ListMissionRow, workspaceId = 'ws1'): MissionItem {
  const summary = summarizeMissionForCard(row);
  const view = buildMissionCardView(row, { from: 'missions', summary });
  return {
    view, list: buildMissionListCard(row, view, summary),
    workspaceId, workspaceName: 'Platform', isHeld: row.isHeld ?? false,
    nextScanMins: summary.nextScanMins, lastActivityAt: new Date().toISOString(), lastRunAt: null,
  };
}

const running = item({
  id: 'm-run', title: 'Claim loop hardening', status: 'active',
  tasks: [task('a', { status: 'in_progress', workers: [{ id: 'w1', status: 'running' }] }), task('b')],
});
const waiting = item({
  id: 'm-ask', title: 'Heartbeat renew', status: 'active',
  tasks: [task('c', {
    status: 'in_progress',
    workers: [{ id: 'w-q', status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Per line or total?', options: ['Per line', 'Total only'] } } as any],
  })],
});
const recurring = item({
  id: 'm-rec', title: 'Keep dependencies current', status: 'active',
  schedule: { id: 's1', cronExpression: '0 */6 * * *', nextRunAt: new Date(Date.now() + 9 * 60_000) },
  tasks: [task('tick', { mode: 'planning', kind: 'coordination', scheduleId: 's1', status: 'completed' })],
});
const held = item({ id: 'm-held', title: 'Spec first', status: 'paused', isHeld: true, tasks: [task('spec', { roleSlug: 'writer' })] });
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
  const html = renderToStaticMarkup(
    <MissionGrid missions={[running, waiting, recurring, held, done]} releaseFooters={release} />,
  );
  const card = (id: string) => {
    const at = html.indexOf(`/app/missions/${id}?`);
    return html.slice(html.lastIndexOf('data-testid="mission-card"', at), at + 4000);
  };

  it('tabs count by kind: All, Running, Recurring, Held, Done', () => {
    const tab = (k: string) => html.match(new RegExp(`data-tab="${k}"[^>]*>(?:(?!</button>).)*<b[^>]*>(\\d+)</b>`))?.[1];
    expect(tab('all')).toBe('5');
    expect(tab('active')).toBe('2');
    expect(tab('recurring')).toBe('1');
    expect(tab('held')).toBe('1');
    expect(tab('done')).toBe('1');
  });

  it('a running mission gets one status word and a labelled phase bar', () => {
    const c = card('m-run');
    expect(c).toContain('data-status="running"');
    expect(c).toContain('data-testid="phase-bar"');
    expect(c).toMatch(/data-testid="phase-bar-cell" data-state="running"/);
  });

  it('a mission waiting on the owner answers inline, one tap per option', () => {
    const c = card('m-ask');
    expect(c).toContain('data-status="needs_you"');
    expect(c).toContain('data-testid="mission-inline-answer"');
    expect(c.match(/data-testid="mission-inline-answer-option"/g)?.length).toBe(2);
  });

  it('a recurring mission shows its cadence chip and next tick', () => {
    const c = card('m-rec');
    expect(c).toContain('↻ every 6h');
    expect(c).toMatch(/next <b[^>]*>9m<\/b>/);
  });

  it('a held mission carries Arm', () => {
    expect(card('m-held')).toContain('data-testid="mission-arm-button"');
  });

  it('done missions are compact table rows', () => {
    const table = html.slice(html.indexOf('data-testid="mission-done-table"'));
    expect(table).toContain('Retire the legacy lock');
    expect(table).toContain('data-status="done"');
  });

  it('shows the workspace release state once, never on a card (D6)', () => {
    expect(html.match(/unshipped/g)?.length).toBe(1);
    expect(html.match(/data-testid="workspace-release-footer"/g)?.length).toBe(1);
  });

  it('links nothing straight to a task page', () => {
    expect(html).not.toContain('/app/tasks/');
  });

  it('uses no raw colours', () => {
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

describe('MissionGrid — nothing running', () => {
  it('says so, with the free slots and the last thing that shipped', () => {
    const html = renderToStaticMarkup(<MissionGrid missions={[done, recurring]} slots={{ live: 0, max: 8 }} />);
    const empty = html.slice(html.indexOf('data-testid="missions-nothing-running"'));
    expect(empty).toContain('All 8 slots free.');
    expect(empty).toContain('Retire the legacy lock');
  });
});

describe('MissionGrid — the Running tab includes the missions waiting on you (D8)', () => {
  it('counts a paused mission whose work is done (READY FOR REVIEW) as running', () => {
    const review = item({ id: 'm-rev', title: 'Example review', status: 'paused', tasks: [task('r', { status: 'completed' })] });
    expect(review.view.chip.label).toBe('READY FOR REVIEW');
    const html = renderToStaticMarkup(<MissionGrid missions={[review]} />);
    expect(html).toMatch(/data-tab="active"(?:(?!<\/button>).)*<b[^>]*>1<\/b>/);
  });
});

// Mobile QA: on a 320px phone the tabs scroll with no sign there is more to
// the right. The bar fades its trailing edge below md.
describe('MissionGrid filter bar', () => {
  it('fades its trailing edge below md and keeps tabs from shrinking', () => {
    const html = renderToStaticMarkup(<MissionGrid missions={[running, waiting, done]} />);
    const bar = html.match(/<div\b[^>]*data-testid="mission-filter-bar"[^>]*>/)![0];
    expect(bar).toContain('overflow-x-auto');
    expect(bar).toMatch(/\[mask-image:linear-gradient\(to_right[^\]]*transparent\)\]/);
    expect(bar).toContain('md:[mask-image:none]');
    const tab = html.match(/<button\b[^>]*data-testid="mission-filter-tab"[^>]*>/)![0];
    expect(tab).toContain('shrink-0');
    expect(tab).toContain('min-h-11');
  });
});
