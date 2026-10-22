/**
 * The History layout: a chronological event feed by day, two filters, retries nested.
 * Static markup from fixture models (no database).
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: MissionFeedLayout } = await import('./MissionFeedLayout');
const { boardFixture, BOARD_T0 } = await import('@/lib/mission-board.fixtures');

const html = renderToStaticMarkup(
  <MissionFeedLayout
    model={boardFixture('long-open')}
    missionId="mission-1"
    timeZone="UTC"
    completionText="Webhooks retry for a day, then park."
    notes={[{ id: 'q1', type: 'question', authorType: 'agent', title: 'Retry for 4 hours or 24?', taskId: 'retry', createdAt: BOARD_T0 + 12 * 60_000 }]}
  />,
);

describe('MissionFeedLayout', () => {
  it('has no band: the Overview owns the counts', () => {
    expect(html).not.toContain('data-testid="mission-band"');
  });

  it('offers Highlights and All activity with their counts, Highlights first, and says what each is', () => {
    expect(html).toContain('data-testid="segmented"');
    expect(html).toMatch(/aria-checked="true"[^>]*>Highlights · \d+</);
    expect(html).toMatch(/aria-checked="false"[^>]*>All activity · \d+</);
    expect(html).toContain('aria-describedby="history-lens-help"');
    expect(html).toMatch(/id="history-lens-help"[^>]*>Highlights: decisions, blockers and delivery milestones/);
  });

  it('lists events by day, oldest first, with glyphs and task links', () => {
    expect(html).toContain('data-testid="mission-event-feed"');
    expect(html.split('data-testid="feed-day"').length - 1).toBeGreaterThan(2);
    expect(html).toContain('data-kind="question"');
    // Highlights hides plain claims.
    expect(html).not.toContain('data-kind="claim"');
    expect(html).toContain('escalated to you: Retry for 4 hours or 24?');
    expect(html).toMatch(/href="\/app\/tasks\/retry"[^>]*data-task-id="retry"/);
  });

  it('says when the mission went quiet for weeks', () => {
    expect(html).toMatch(/data-testid="feed-quiet"[^>]*>.*?\d+ quiet days/);
  });

  it('carries none of the legacy Feed chrome', () => {
    for (const legacy of ['STEER', 'UNCLASSIFIED', 'Timeline · Structure', 'Nothing outstanding', 'Integrated', 'Verified ○']) {
      expect(html).not.toContain(legacy);
    }
  });
});

describe('MissionFeedLayout: Highlights over delivery episodes', () => {
  const task = Object.values(boardFixture('long-open').tasks)[0];
  const episode = {
    id: task.id, title: 'feat(kernel): Fold retries into the delivery', href: '', missionId: 'mission-1', missionTitle: 'M',
    kind: 'landed' as const, repairRounds: 1, prNumber: 7, at: BOARD_T0 + 40 * 60_000,
    steps: [
      { at: BOARD_T0 + 10 * 60_000, text: 'Build started', tone: 'ink' as const, void: false },
      { at: BOARD_T0 + 20 * 60_000, text: 'Built; PR #7 opened', tone: 'ink' as const, void: false },
      { at: BOARD_T0 + 40 * 60_000, text: 'Merged', tone: 'success' as const, void: false },
    ],
  };
  const withEpisodes = renderToStaticMarkup(
    <MissionFeedLayout
      model={boardFixture('long-open')} missionId="mission-1" timeZone="UTC" episodes={[episode]}
      notes={[{ id: 'q1', type: 'question', authorType: 'agent', title: 'Retry for 4 hours or 24?', taskId: 'retry', createdAt: BOARD_T0 + 12 * 60_000 }]}
    />,
  );

  it('titles the delivery from its task and keeps the scope as secondary context', () => {
    expect(withEpisodes).toContain('data-kind="episode"');
    expect(withEpisodes).toContain('Fold retries into the delivery');
    expect(withEpisodes).toMatch(/data-testid="feed-context"[^>]*>[^<]+</);
    expect(withEpisodes).toMatch(new RegExp(`href="/app/tasks/${task.id}"[^>]*data-task-id="${task.id}"`));
    expect(withEpisodes).toContain('PR #7 · Merged');
    expect(withEpisodes).toContain('3 steps');
  });

  it('never nests one link inside another, and the steps sit outside the row link', () => {
    for (const m of withEpisodes.matchAll(/<a [^>]*>(.*?)<\/a>/gs)) expect(m[1]).not.toContain('<a ');
    expect(withEpisodes).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*data-testid="episode-steps"/s);
  });

  it('draws an icon per kind that is named and shaped, not only coloured', () => {
    const icons = [...withEpisodes.matchAll(/data-testid="history-icon" data-icon="(\w+)" role="img" aria-label="([^"]+)"/g)];
    expect(icons.length).toBeGreaterThan(2);
    for (const [, , name] of icons) expect(name.length).toBeGreaterThan(2);
    expect(withEpisodes).toMatch(/data-icon="merged"[^>]*aria-label="Merged"/);
    expect(withEpisodes).toMatch(/data-icon="attention"[^>]*aria-label="Has a question"/);
  });

  it('has no fixed widths that could overflow a 360px or 390px phone', () => {
    const feed = withEpisodes.slice(withEpisodes.indexOf('data-testid="mission-event-feed"'));
    expect(feed).not.toMatch(/(?<![-\w])(?:w|min-w)-\[(?:3[6-9]\d|[4-9]\d\d)px\]/);
    expect(feed).toContain('[overflow-wrap:anywhere]');
    expect(feed).toContain('min-h-11');
  });
});
