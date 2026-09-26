/**
 * MissionLanes: runner slots as rows on a time axis, with the side rail.
 * Static markup from fixture models (no database).
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: MissionLanes, laneWindow } = await import('./MissionLanes');
const { boardFixture, BOARD_T0 } = await import('@/lib/mission-board.fixtures');

const render = (moment: Parameters<typeof boardFixture>[0]) =>
  renderToStaticMarkup(<MissionLanes model={boardFixture(moment)} missionId="mission-1" completionText="Example outcome." />);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('MissionLanes — running', () => {
  const html = render('running');

  it('draws one bar per worker, each a sheet link for its task', () => {
    expect(count(html, 'data-testid="lane-bar"')).toBe(3);
    expect(html).toMatch(/href="\/app\/missions\/mission-1\?task=api"[^>]*data-task-id="api"|data-task-id="api"[^>]*href="\/app\/missions\/mission-1\?task=api"/);
  });

  it('a slot row per concurrent agent on a runner', () => {
    // alpha ran base then pay (one slot); beta ran api (one slot).
    expect(count(html, 'data-testid="slot-lane-row"')).toBe(2);
  });

  it('shows NOW with the future hatched, and the merged-PR track', () => {
    expect(html).toContain('data-testid="slot-lanes-now"');
    expect(html).toContain('data-testid="slot-lanes-mark"');
    expect(html).toContain('Merged 1');
  });

  it('side rail: needs you, in review, up next', () => {
    expect(html).toContain('data-testid="needs-you-band"');
    expect(html).toContain('Nothing waiting on you.');
    expect(html).toContain('data-testid="lanes-in-review"');
    expect(html).toContain('data-testid="lanes-up-next"');
  });
});

describe('MissionLanes — question and complete', () => {
  it('a waiting agent gets its answer buttons in the rail', () => {
    const html = render('question');
    expect(html).toContain('Round each line or the total?');
    expect(html).toContain('data-testid="board-answer-options"');
    expect(html).toMatch(/data-testid="lane-bar"[^>]*data-tone="waiting"/);
  });

  it('a complete mission drops NOW and shows the completion record and criteria', () => {
    const html = render('complete');
    expect(html).not.toContain('data-testid="slot-lanes-now"');
    expect(html).toContain('data-testid="mission-completion-record"');
    expect(html).toContain('data-testid="lanes-criteria"');
    expect(html).not.toContain('data-testid="lanes-up-next"');
  });
});

describe('laneWindow', () => {
  it('runs at least 10 minutes and five past now while live', () => {
    const m = boardFixture('running');
    expect(laneWindow(m, BOARD_T0 + 3 * 60_000)).toEqual({ from: BOARD_T0, to: BOARD_T0 + 10 * 60_000 });
    expect(laneWindow(m, BOARD_T0 + 12 * 60_000)).toEqual({ from: BOARD_T0, to: BOARD_T0 + 17 * 60_000 });
    expect(laneWindow(m, BOARD_T0 + 30 * 60_000).to).toBe(BOARD_T0 + 35 * 60_000);
  });

  it('a mission created long before its first run starts the axis at that run', () => {
    const m = boardFixture('running');
    const created = { ...m, startedAt: BOARD_T0 - 3 * 3_600_000 };
    const { from } = laneWindow(created, BOARD_T0 + 12 * 60_000);
    expect(from).toBeLessThan(BOARD_T0 + 60_000);
    expect(from).toBeGreaterThanOrEqual(BOARD_T0 - 5 * 60_000);
  });

  it('fits the finished run with a little air once complete', () => {
    const m = boardFixture('complete');
    const { to } = laneWindow(m, BOARD_T0 + 60 * 60_000);
    expect(to).toBeGreaterThan(BOARD_T0 + 17 * 60_000);
    expect(to).toBeLessThan(BOARD_T0 + 18 * 60_000);
  });
});
