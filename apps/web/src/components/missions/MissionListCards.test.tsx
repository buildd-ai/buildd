import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildMissionCardView, summarizeMissionForCard } from '@/lib/mission-card-view';
import { buildMissionListCard, type ListMissionRow, type ListTaskRow } from '@/lib/mission-list-card';
import PhaseBar from './PhaseBar';
import { ActiveMissionCard, MiniMissionCard } from './MissionListCards';

/**
 * Regression: a mission with cancelled tasks printed "16/17 done, 1 in CI"
 * while the visual strip drew 18 boxes (a dashed "skipped" cell for the
 * cancelled task the count already excludes). `buildMissionListCard` is now
 * the one place that decides which cells are countable (mission-list-card.ts);
 * these tests confirm every renderer that iterates its `phases[].cells` — the
 * `lg` list bar, the `sm` Home strip, and the Missions-list mini strip — draws
 * exactly that collection, never more.
 */
const NOW = Date.now();
let clock = NOW - 60 * 60_000;
function task(id: string, over: Partial<ListTaskRow> = {}): ListTaskRow {
  clock += 60_000;
  return { id, title: `feat(${id}): something`, status: 'pending', taskClass: 'work', mode: 'execution', createdAt: new Date(clock), workers: [], ...over };
}
const phase = (i: number, label: string) => ({ missionPhaseIndex: i, missionPhaseLabel: label });

const row: ListMissionRow = {
  id: 'm-jev', title: 'Jev schedules the work', status: 'active', createdAt: new Date(NOW - 3600_000),
  tasks: [
    task('a', { ...phase(0, 'Work'), status: 'completed', workers: [{ status: 'completed' }] }),
    task('b', { ...phase(0, 'Work'), status: 'completed', workers: [{ status: 'completed' }] }),
    task('ci', { ...phase(0, 'Work'), status: 'completed', workers: [{ status: 'completed', prNumber: 99, prUrl: 'https://example.test/pr/99', prLifecycleStatus: 'ci_running' }] }),
    task('cancelled', { ...phase(0, 'Work'), status: 'cancelled' }),
  ],
};
const summary = summarizeMissionForCard(row, { now: NOW });
const view = buildMissionCardView(row, { from: 'missions', now: NOW, summary });
const model = buildMissionListCard(row, view, summary, { now: NOW });

describe('PhaseBar — lg (missions list) draws exactly the countable cells', () => {
  const html = renderToStaticMarkup(<PhaseBar phases={model.phases} size="lg" />);
  const cellMatches = html.match(/data-testid="phase-bar-cell"/g) ?? [];

  it('renders model.counts.total cells, no skipped cell', () => {
    expect(cellMatches).toHaveLength(model.counts.total);
    expect(html).not.toContain('data-state="skipped"');
    expect(html).not.toContain('data-task-id="cancelled"');
  });

  it("the phase caption's own total matches the boxes drawn for it", () => {
    expect(html).toMatch(/2\/3/);
  });
});

describe('PhaseBar — sm (Home compact strip) draws the same collection', () => {
  const html = renderToStaticMarkup(<PhaseBar phases={model.phases} size="sm" />);
  const cellMatches = html.match(/data-testid="phase-bar-cell"/g) ?? [];

  it('renders model.counts.total cells, no skipped cell', () => {
    expect(cellMatches).toHaveLength(model.counts.total);
    expect(html).not.toContain('data-state="skipped"');
  });
});

describe('MiniMissionCard — the flattened mini strip draws the same collection', () => {
  const html = renderToStaticMarkup(<MiniMissionCard view={view} model={model} />);

  it('draws exactly counts.total boxes and prints the matching n/N', () => {
    // The mini strip has no per-box testid (bare <span> glyphs); count by
    // the cell-box wrapper class applied once per cell instead.
    const boxMatches = html.match(/class="flex-1 /g) ?? [];
    expect(boxMatches).toHaveLength(model.counts.total);
    expect(html).not.toContain('border-dashed');
    expect(html).toContain(`${model.counts.done}/${model.counts.total}`);
  });
});

// Surface audit: with nobody live the card printed a dangling "· 1h", and on a
// phone its situation sentence was cut to one line; compact cards cut titles
// that had room to wrap.
describe('mission cards — elapsed separator and wrapping', () => {
  const sentence = 'Waiting on review for the change that keeps the runner list paged on every workspace';
  const withSentence = { ...model, sentence, elapsedMin: 60 };
  const elapsedText = (html: string) => html.replace(/<[^>]+>/g, '\u0000').split('\u0000').map(s => s.trim()).filter(s => /^·?\s*1h$/.test(s));

  it('no live agents: the elapsed time has no leading dot', () => {
    const html = renderToStaticMarkup(<ActiveMissionCard view={view} model={{ ...withSentence, live: { count: 0, dots: [] } }} />);
    expect(elapsedText(html)).toEqual(['1h']);
  });

  it('live agents: the dot separates "live" from the elapsed time', () => {
    const html = renderToStaticMarkup(<ActiveMissionCard view={view} model={{ ...withSentence, live: { count: 2, dots: [{ roleSlug: null, color: null }, { roleSlug: null, color: null }] } }} />);
    expect(elapsedText(html)).toEqual(['· 1h']);
  });

  it('the situation sentence wraps to two lines instead of truncating to one', () => {
    const html = renderToStaticMarkup(<ActiveMissionCard view={view} model={withSentence} />);
    const p = html.match(/<p class="([^"]+)"[^>]*>(?:(?!<\/p>).)*Waiting on review/)?.[1] ?? '';
    expect(p).toContain('line-clamp-2');
    expect(p.split(/\s+/)).not.toContain('truncate');
  });

  it('the card title wraps to two lines on a phone instead of truncating', () => {
    const html = renderToStaticMarkup(<ActiveMissionCard view={view} model={withSentence} />);
    const h3 = html.match(/<h3 class="([^"]+)"/)?.[1] ?? '';
    expect(h3).toContain('line-clamp-2');
    expect(h3.split(/\s+/)).not.toContain('truncate');
  });

  it('a compact card title wraps instead of truncating', () => {
    const html = renderToStaticMarkup(<MiniMissionCard view={view} model={model} />);
    const h3 = html.match(/<h3 class="([^"]+)"/)?.[1] ?? '';
    expect(h3).toContain('line-clamp-2');
    expect(h3.split(/\s+/)).not.toContain('truncate');
  });
});
