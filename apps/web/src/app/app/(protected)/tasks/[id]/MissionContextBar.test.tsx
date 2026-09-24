/**
 * AC-13: the sticky mission context bar on the full task page
 * (docs/design/mission-feed-mobile-continuity.md W6). Illustrative fixtures.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MissionCardRow, MissionCardTaskRow } from '@/lib/mission-card-view';
import { MissionContextBarView } from './MissionContextBar';
import { buildMissionContextBar } from './mission-context-bar';

let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const BUILD = { missionPhaseIndex: 1, missionPhaseLabel: 'BUILD' };
const row: MissionCardRow = {
  id: 'm1',
  title: 'Claim loop hardening',
  status: 'active',
  orchestrationMode: 'auto',
  tasks: [
    t('a', { ...BUILD, status: 'completed' }),
    t('b', { ...BUILD, status: 'in_progress', workers: [{ status: 'running' }] }),
    t('c', { ...BUILD }),
  ],
};

const html = renderToStaticMarkup(<MissionContextBarView bar={buildMissionContextBar(row, 'b')} />);

describe('MissionContextBarView', () => {
  it('renders the bar, sticky at the top of the page scroller', () => {
    expect(html).toContain('data-testid="mission-context-bar"');
    expect(html).toMatch(/data-testid="mission-context-bar"[^>]*class="[^"]*\bsticky\b[^"]*\btop-0\b/);
  });

  it('shows n / N and the phase label', () => {
    expect(html).toContain('2 / 3 · 1 BUILD');
  });

  it('‹ › point at the sibling task pages in pulse order', () => {
    expect(html).toMatch(/data-testid="mission-masthead-prev"[^>]*href="\/app\/tasks\/a\?from=mission&amp;missionId=m1"|href="\/app\/tasks\/a\?from=mission&amp;missionId=m1"[^>]*data-testid="mission-masthead-prev"/);
    expect(html).toMatch(/href="\/app\/tasks\/c\?from=mission&amp;missionId=m1"/);
  });

  it('the mission title is the up-link to this task’s row', () => {
    expect(html).toContain('href="/app/missions/m1#t-b"');
    expect(html).toContain('Claim loop hardening');
  });

  it('rings this task on the context pulse', () => {
    expect(html).toMatch(/data-testid="mission-pulse-segment"[^>]*data-task-id="b"[^>]*aria-current="true"|data-task-id="b"[^>]*aria-current="true"/);
  });

  it('shows the mission chip', () => {
    expect(html).toContain('data-testid="mission-state-chip"');
  });
});
