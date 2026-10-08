import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildMissionCardView, summarizeMissionForCard } from '@/lib/mission-card-view';
import { buildMissionListCard, type ListMissionRow, type ListTaskRow } from '@/lib/mission-list-card';
import PhaseBar from './PhaseBar';
import { MiniMissionCard } from './MissionListCards';

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

describe('ActiveMissionCard — elapsed time rendering', () => {
  it('does not render a leading dot when there are no live agents', () => {
    const rowNoLive = { ...row, tasks: [] };
    const summary = summarizeMissionForCard(rowNoLive, { now: NOW });
    const view = buildMissionCardView(rowNoLive, { from: 'missions', now: NOW, summary });
    const model = buildMissionListCard(rowNoLive, view, summary, { now: NOW });
    const html = renderToStaticMarkup(
      <div className="flex items-center gap-2.5 font-mono text-[12px] text-text-secondary">
        {model.live.count > 0 && (
          <>
            <span className="flex gap-[3px]" aria-hidden="true">
              {model.live.dots.slice(0, 10).map((d, i) => (
                <i key={i} className={`inline-block h-2.5 w-2.5 ${d.color ? '' : 'bg-accent'}`} style={d.color ? { backgroundColor: d.color } : undefined} />
              ))}
            </span>
            <span><b className="text-text-primary">{model.live.count}</b> live</span>
            {model.elapsedMin != null && <span className="text-text-muted">· {model.elapsedMin}</span>}
          </>
        )}
        {model.live.count === 0 && model.elapsedMin != null && <span className="text-text-muted">{model.elapsedMin}</span>}
      </div>
    );
    expect(html).not.toContain('·');
  });
});
