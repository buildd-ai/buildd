/**
 * MissionTaskRow: the one row anatomy (docs/design/mission-feed-mobile-continuity.md,
 * "One task row"). Rows come from `buildMissionFeedGroups` so the state, PR and
 * position a row shows are the model's, not the component's. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildMissionFeedGroups } from '@/lib/mission-feed-groups';
import type { MissionFeedTaskInput, MissionFeedWorkerInput } from '@/lib/mission-pulse';
import { MISSION_MASTHEAD_FOLDED_PX } from './MissionMasthead';
import MissionTaskRow, { MISSION_ROW_SCROLL_MARGIN_CLASS, buildTaskRowMeta } from './MissionTaskRow';

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const BUILD = { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD' };

function rowFor(tasks: MissionFeedTaskInput[], id: string, ctx = {}) {
  return buildMissionFeedGroups(tasks, ctx).rowsById.get(id)!;
}
const anchor = (html: string) => html.match(/<a[^>]*data-testid="mission-task-row"[^>]*>/)?.[0] ?? '';

describe('MissionTaskRow DOM contract', () => {
  const tasks = [t('a', { ...BUILD, title: 'Add claim lease column', kind: 'engineering' })];
  const html = renderToStaticMarkup(<MissionTaskRow row={rowFor(tasks, 'a')} missionId="m1" from="home" now={NOW} />);

  it('is a real link to the sheet URL with the #t- anchor id and data attributes', () => {
    const a = anchor(html);
    expect(a).toContain('href="/app/missions/m1?from=home&amp;task=a"');
    expect(a).toContain('id="t-a"');
    expect(a).toContain('data-task-id="a"');
    expect(a).toContain('data-status="queued"');
    expect(a).toContain('data-focused="false"');
  });

  it('carries scroll-margin-top equal to the folded masthead height (AC-5)', () => {
    expect(MISSION_ROW_SCROLL_MARGIN_CLASS).toBe(`scroll-mt-[${MISSION_MASTHEAD_FOLDED_PX}px]`);
    expect(anchor(html)).toContain(MISSION_ROW_SCROLL_MARGIN_CLASS);
  });

  it('puts the status glyph first, then the work-kind glyph, then the title', () => {
    const status = html.indexOf('data-testid="mission-task-row-status"');
    const kind = html.indexOf('data-testid="mission-task-row-kind"');
    const title = html.indexOf('Add claim lease column');
    expect(status).toBeGreaterThan(-1);
    expect(status).toBeLessThan(kind);
    expect(kind).toBeLessThan(title);
    expect(html).toContain('◆');
  });

  it('is at least a 52px tap target with a one-line truncated title', () => {
    expect(anchor(html)).toContain('min-h-[52px]');
    expect(html).toContain('truncate');
  });
});

describe('PR colour follows the real PR state', () => {
  const cases: Array<[string, Partial<MissionFeedWorkerInput>, string]> = [
    ['open', { prLifecycleStatus: 'ci_green' }, 'text-status-info'],
    ['merged', { mergedAt: new Date(NOW) }, 'text-status-success'],
    ['ci failing', { prLifecycleStatus: 'ci_failed' }, 'text-status-error'],
    ['closed', { prLifecycleStatus: 'closed' }, 'text-status-error'],
  ];
  for (const [name, worker, cls] of cases) {
    it(`${name} → ${cls}`, () => {
      const tasks = [t('p', { status: 'completed', worker: { status: 'completed', prNumber: 412, ...worker } })];
      const html = renderToStaticMarkup(<MissionTaskRow row={rowFor(tasks, 'p')} missionId="m1" now={NOW} />);
      const pr = html.match(/<span[^>]*data-testid="mission-task-row-pr"[^>]*>/)?.[0] ?? '';
      expect(pr).toContain(cls);
      expect(html).toContain('#412');
    });
  }

  it('marks running checks with ↻', () => {
    const tasks = [t('p', { status: 'completed', worker: { status: 'completed', prNumber: 7, prLifecycleStatus: 'ci_running' } })];
    const html = renderToStaticMarkup(<MissionTaskRow row={rowFor(tasks, 'p')} missionId="m1" now={NOW} />);
    expect(html).toContain('#7↻');
  });
});

describe('attempts disclosure (D1 / U8)', () => {
  const withAttempts = () => [
    t('p', { ...BUILD, status: 'completed' }),
    t('r1', { taskClass: 'attempt', parentTaskId: 'p', status: 'failed' }),
    t('r2', { taskClass: 'attempt', parentTaskId: 'p', status: 'failed' }),
    t('r3', { taskClass: 'attempt', parentTaskId: 'p', status: 'completed' }),
  ];
  const render = () => renderToStaticMarkup(
    <MissionTaskRow row={rowFor(withAttempts(), 'p')} missionId="m1" now={NOW} recordsCount={1} />,
  );
  const toggle = (html: string) => html.match(/<button[^>]*data-testid="mission-task-attempts"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';

  it('folds the count into the meta line as "↻ N" — no row of its own', () => {
    const html = render();
    // The meta line reads `phase · outcome · records · ↻ N`.
    const text = html.replace(/<[^>]+>/g, '');
    expect(text).toContain('BUILD · done · 1 rec · ↻ 3');
    // No separate full-height summary line under the row.
    expect(html).not.toContain('<summary');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('3 attempts</');
  });

  it('keeps the toggle outside the row link, and attempts never become rows', () => {
    const html = render();
    const linkClose = html.indexOf('</a>');
    expect(html.indexOf('data-testid="mission-task-attempts"')).toBeGreaterThan(linkClose);
    expect(html.match(/data-testid="mission-task-row"/g)).toHaveLength(1);
  });

  it('is a collapsed disclosure button with an accessible name and a 44px hit area', () => {
    const b = toggle(render());
    expect(b).toContain('aria-expanded="false"');
    expect(b).toContain('aria-label="3 attempts"');
    expect(b).toMatch(/aria-controls="[^"]+"/);
    expect(b).toContain('data-testid="mission-task-attempts-hit"');
    expect(b).toContain('min-h-11');
    expect(b).toContain('min-w-11');
    // Closed: the attempt list is not rendered yet.
    expect(render()).not.toContain('href="/app/tasks/r1');
  });

  it('singular attempt reads "1 attempt"', () => {
    const tasks = [t('p', BUILD), t('r1', { taskClass: 'attempt', parentTaskId: 'p', status: 'failed' })];
    const html = renderToStaticMarkup(<MissionTaskRow row={rowFor(tasks, 'p')} missionId="m1" now={NOW} />);
    expect(toggle(html)).toContain('aria-label="1 attempt"');
  });

  it('renders no disclosure without attempts', () => {
    const html = renderToStaticMarkup(<MissionTaskRow row={rowFor([t('p')], 'p')} missionId="m1" now={NOW} />);
    expect(html).not.toContain('mission-task-attempts');
    expect(html).not.toContain('↻');
  });
});

describe('buildTaskRowMeta', () => {
  it('needs-you input: phase · asked <age>', () => {
    const tasks = [t('q', { ...BUILD, status: 'in_progress', worker: { status: 'waiting_input', updatedAt: new Date(NOW - 12 * 60_000) } })];
    expect(buildTaskRowMeta(rowFor(tasks, 'q'), { now: NOW })).toBe('BUILD · asked 12m');
  });

  it('moving with a live line: phase · elapsed · action', () => {
    const tasks = [t('m', { ...BUILD, status: 'in_progress', worker: { status: 'running', startedAt: new Date(NOW - 4 * 60_000) } })];
    expect(buildTaskRowMeta(rowFor(tasks, 'm'), { now: NOW, liveLine: 'editing lease.ts' })).toBe('BUILD · 4m · editing lease.ts');
  });

  it('moving without a live line: running <elapsed>, plus records', () => {
    const tasks = [t('m', { ...BUILD, status: 'in_progress', worker: { status: 'running', startedAt: new Date(NOW - 4 * 60_000) } })];
    expect(buildTaskRowMeta(rowFor(tasks, 'm'), { now: NOW, recordsCount: 2 })).toBe('BUILD · running 4m · 2 rec');
  });

  it('queued behind an unfinished dependency reads "after <title>"', () => {
    const tasks = [t('a', { ...BUILD, title: 'Schema v2' }), t('b', { ...BUILD, dependsOn: ['a'] })];
    expect(buildTaskRowMeta(rowFor(tasks, 'b'), { now: NOW, blockedByTitle: 'Schema v2' })).toBe('BUILD · after Schema v2');
  });

  it('a PR awaiting you names the PR problem', () => {
    const conflict = [t('p', { status: 'completed', worker: { status: 'completed', prNumber: 9, prLifecycleStatus: 'conflict' } })];
    expect(buildTaskRowMeta(rowFor(conflict, 'p'), { now: NOW })).toBe('conflict');
    const green = [t('p', { status: 'completed', worker: { status: 'completed', prNumber: 9, prLifecycleStatus: 'ci_green' } })];
    expect(buildTaskRowMeta(rowFor(green, 'p'), { now: NOW })).toBe('ready to merge');
  });

  it('done, failed and cancelled rows read plainly', () => {
    expect(buildTaskRowMeta(rowFor([t('d', { status: 'completed' })], 'd'), { now: NOW })).toBe('done');
    expect(buildTaskRowMeta(rowFor([t('f', { status: 'failed' })], 'f'), { now: NOW })).toBe('failed');
    expect(buildTaskRowMeta(rowFor([t('x', { status: 'cancelled' })], 'x'), { now: NOW })).toBe('cancelled');
  });

  it('renders the meta line in the row', () => {
    const tasks = [t('d', { ...BUILD, status: 'completed' })];
    const html = renderToStaticMarkup(<MissionTaskRow row={rowFor(tasks, 'd')} missionId="m1" now={NOW} />);
    expect(html).toContain('BUILD · done');
  });
});
