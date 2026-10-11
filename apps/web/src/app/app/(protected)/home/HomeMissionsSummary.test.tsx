/**
 * Surface audit (1280): Home's compact mission rows cut every title to a few
 * words behind a fixed 260px column while the phase bar beside it had room to
 * spare. The title column now shares the row and a title wraps to two lines.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => '/app/home',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { HomeMissionsSummary } = await import('./HomeMissionsSummary');
const { missionListExecutorFixture } = await import('@/app/app/dev/fixtures/mission-list-executor-fixtures');

const cards = missionListExecutorFixture();
const html = renderToStaticMarkup(
  <HomeMissionsSummary rows={cards.filter(c => c.model.kind === 'active').map(c => ({ view: c.view, model: c.model }))} total={cards.length} shippedToday={0} />,
);

describe('Home compact mission rows', () => {
  it('give the title a share of the row, not a fixed 260px column', () => {
    const rows = [...html.matchAll(/data-testid="home-mission-row"[^>]*class="([^"]+)"/g)].map(m => m[1]);
    expect(rows.length).toBeGreaterThan(0);
    for (const cls of rows) expect(cls).not.toContain('260px');
  });

  it('let a title wrap to two lines instead of truncating to one', () => {
    const titles = [...html.matchAll(/<a class="([^"]+)" href="\/app\/missions\//g)].map(m => m[1].split(/\s+/));
    expect(titles.length).toBeGreaterThan(0);
    for (const cls of titles) {
      expect(cls).toContain('line-clamp-2');
      expect(cls).not.toContain('truncate');
    }
  });
});
