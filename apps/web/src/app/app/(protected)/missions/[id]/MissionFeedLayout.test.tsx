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

  it('offers Changes and Everything, Changes first', () => {
    expect(html).toContain('data-testid="segmented"');
    expect(html).toMatch(/aria-checked="true"[^>]*>Changes</);
    expect(html).toMatch(/aria-checked="false"[^>]*>Everything</);
  });

  it('lists events by day, oldest first, with glyphs and task links', () => {
    expect(html).toContain('data-testid="mission-event-feed"');
    expect(html.split('data-testid="feed-day"').length - 1).toBeGreaterThan(2);
    expect(html).toContain('data-kind="question"');
    // Changes hides plain claims.
    expect(html).not.toContain('data-kind="claim"');
    expect(html).toContain('escalated to you: Retry for 4 hours or 24?');
    expect(html).toMatch(/href="\/app\/missions\/mission-1\?task=retry"[^>]*data-task-id="retry"/);
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
