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
const { buildVisualReviewFixtureModel } = await import('@/lib/visual-review-model.fixtures');

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

  it('the completion record drops a zero CI auto-fix count and counts screens reviewed', () => {
    const plain = render('complete');
    expect(plain).not.toContain('CI auto-fixed');
    const visual = { ...buildVisualReviewFixtureModel('reviewed'), missionId: 'mission-1' };
    const html = renderToStaticMarkup(
      <MissionLanes model={boardFixture('complete')} missionId="mission-1" completionText="x" visual={visual} />,
    );
    const s = visual.summary;
    // After your decisions (the Band's count), not the agent's.
    expect(s.ok).toBeLessThan(s.effectiveOk);
    expect(html.replace(/<[^>]+>/g, ' ')).toMatch(new RegExp(`${s.effectiveOk}/${s.shots}\\s+screens ok`));
    expect(html.replace(/<[^>]+>/g, ' ')).not.toContain('unsure');
    expect(html).toContain('data-testid="record-screen-calls"');
    const m = boardFixture('complete');
    m.record.ciFixes = 1;
    expect(renderToStaticMarkup(<MissionLanes model={m} missionId="mission-1" />)).toContain('CI auto-fixed');
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

describe('MissionLanes — complete, open for weeks', () => {
  const html = render('long-open');

  it('draws the friction report as its own kind, with a tooltip saying what it is', () => {
    expect(html).toContain('data-tone="side"');
    expect(html).toMatch(/title="Friction report · not mission work · run orphaned[^"]*"/);
    expect(html).not.toMatch(/data-tone="plan"[^>]*title="[^"]*no admin API/);
  });

  it('names every bar kind it draws in the legend', () => {
    expect(html).toContain('data-testid="mission-lanes-legend"');
    expect(html).toContain('data-legend="short"');
    expect(html).toContain('data-legend="side"');
    expect(html).not.toContain('data-legend="stopped"');
  });

  it('never prints a raw H:MM:SS over a day', () => {
    expect(html).not.toMatch(/\d{3,}:\d{2}:\d{2}/);
  });
});

describe('MissionLanes — visual review', () => {
  it('the side rail carries the Ask and the Tray from the same model as the Board', () => {
    const visual = { ...buildVisualReviewFixtureModel('needs_you', { needsYou: 'unsure', scenario: 'deck' }), missionId: 'mission-1' };
    const html = renderToStaticMarkup(<MissionLanes model={boardFixture('running')} missionId="mission-1" visual={visual} />);
    const screens = html.split('data-testid="lanes-screens"')[1] ?? '';
    expect(screens).toContain('data-testid="visual-review-ask"');
    expect(screens).toContain('data-testid="visual-review-tray"');
    expect(count(html, 'data-testid="visual-review-thumb"')).toBe(visual.cells.length);
    // Needs you counts the screens awaiting a human.
    const needs = html.split('data-testid="needs-you-band"')[1]?.split('</b>')[0] ?? '';
    expect(needs).toContain(`>${visual.summary.awaitingHuman}`);
  });

  it('while the Ask shows, the rail\'s Tray has no second Review button', () => {
    const visual = { ...buildVisualReviewFixtureModel('needs_you', { needsYou: 'unsure', scenario: 'deck' }), missionId: 'mission-1' };
    const html = renderToStaticMarkup(<MissionLanes model={boardFixture('running')} missionId="mission-1" visual={visual} />);
    expect(html).toContain('data-testid="visual-review-ask"');
    expect(html).not.toContain('data-testid="visual-review-review-button"');
  });

  it('no audit: no Screens section', () => {
    expect(render('running')).not.toContain('data-testid="lanes-screens"');
  });
});
