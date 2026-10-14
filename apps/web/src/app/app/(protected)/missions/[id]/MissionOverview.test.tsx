/**
 * The Overview: the lg strip with the finish-setting task selected, its focus
 * card, and the right rail. Static markup from the strip fixtures.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: MissionOverview } = await import('./MissionOverview');
const { railLines, overviewLayout } = await import('@/lib/mission-overview');
const { dagBoard, dagId, DAG_SPECS, overviewWavesBoard } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');
const legendText = (markup: string) => [...(markup.match(/data-testid="overview-counts"[\s\S]*?<\/p>/)?.[0] ?? '').matchAll(/data-legend="[^"]+"[^>]*>(?:<span[^>]*><\/span>)?([^<]*)</g)].map(m => m[1]);

const spec = DAG_SPECS.linear;
const html = renderToStaticMarkup(<MissionOverview model={dagBoard(spec)} missionId="mission-1" workspaceId="ws-1" />);

const compact = await import('@/app/app/dev/fixtures/mission-detail-compact-fixtures');

describe('MissionOverview', () => {
  it('opens on the task in flight, not the first task', () => {
    const selected = html.match(/data-id="([^"]+)"[^>]*aria-pressed="true"/)?.[1];
    expect(selected).toBe(dagId(spec, 'B'));
  });

  it('draws the lg strip, a focus card and the counts', () => {
    expect(html).toContain('data-size="lg"');
    expect(html).toContain('data-testid="focus-card"');
    expect(legendText(html)).toEqual(['1 done', '1 in progress', '3 waiting on tasks']);
    expect(html).toContain('data-testid="overview-stepper"');
  });

  it('puts the agents and needs-you counts in the rail, capped to a 720px main column', () => {
    expect(html).toContain('data-testid="overview-rail"');
    expect(html).toContain('data-testid="rail-needs"');
    expect(html).toContain('min-[900px]:grid-cols-[minmax(0,720px)');
  });

  // Owner report: "Agents live 1 / Needs you 0" is label-speak. Counts read as words.
  it('says the counts in words, not label and number', () => {
    const rail = html.slice(html.indexOf('data-testid="overview-counts-rail"'));
    expect(rail).not.toMatch(/Agents live|Needs you/);
    expect(railLines(0, 0)).toEqual({ agents: 'No agents working', needs: 'Nothing waiting on you' });
    expect(railLines(1, 1)).toEqual({ agents: '1 agent working', needs: '1 waiting on you' });
    expect(railLines(3, 2)).toEqual({ agents: '3 agents working', needs: '2 waiting on you' });
  });

  it('names the selection once: "02 of 05" in the card, the stepper keeps only the state', () => {
    expect(html).toContain('02 of 05');
    const stepper = html.slice(html.indexOf('data-testid="overview-stepper"'));
    expect(stepper).not.toMatch(/\d\d of \d\d/);
  });
});

describe('MissionOverview, 11 tasks with delivery', () => {
  const f = compact.missionDetailCompactFixture('eleven', null);
  const out = renderToStaticMarkup(<MissionOverview model={f.model} deliveries={f.deliveries} missionId="mission-1" workspaceId="ws-1" />);

  it('draws Build › Audit › Land once (the Lifecycle line), not a second stage grid', () => {
    expect(out.match(/data-testid="lifecycle"/g)).toHaveLength(1);
    expect(out).not.toContain('data-testid="delivery-stages"');
  });

  it('the counts line is build counts only; criteria live in the Verified pill and the rail', () => {
    const counts = legendText(out);
    expect(counts[0]).toBe('3 done');
    expect(counts.join(' ')).not.toMatch(/criteri/);
  });
});

// Spec f7f67f1a R-1, R-3, R-5, R-6 (revision 6).
describe('MissionOverview groups', () => {
  const model = overviewWavesBoard(20);
  const layout = overviewLayout(model);
  const out = renderToStaticMarkup(<MissionOverview model={model} missionId="mission-1" workspaceId="ws-1" />);
  const cellIds = [...out.matchAll(/<button[^>]*data-id="([^"]+)"/g)].map(m => m[1]);

  it('draws cells Done first, then In progress, Waiting and checks, so the keys step in that order', () => {
    expect(cellIds).toEqual(layout.order);
  });

  it('outlines only the In progress group, exactly over its columns', () => {
    const outlines = [...out.matchAll(/data-testid="task-strip-group-outline"[^>]*data-group="([^"]+)"[^>]*style="grid-column:([^;"]+)/g)];
    expect(outlines.map(o => o[1])).toEqual(['active']);
    const active = layout.groups.find(g => g.key === 'active')!.ids;
    const col = (id: string) => Number(out.match(new RegExp(`data-id="${id}"[^>]*style="grid-column:(\\d+)`))?.[1]);
    const [from, to] = outlines[0][2].split('/').map(Number);
    expect(from).toBe(col(active[0]));
    expect(to).toBe(col(active[active.length - 1]) + 1);
  });

  it('marks each waiting cell with its cause, and names it', () => {
    expect(out).toContain('data-wait="tasks"');
    expect(out).toContain('data-wait="slot"');
    expect(out).toContain('data-wait="hold"');
    expect(out).toMatch(/aria-label="\d\d Next in line: /);
    expect(out).toMatch(/aria-label="\d\d Held: /);
  });

  it('the legend says the groups in words', () => {
    expect(legendText(out)).toEqual(['10 done', '2 in progress', '4 waiting on tasks', '2 next in line', '1 held', '1 not started', '1 check']);
  });

  it('a two-task mission draws two compact cells, not two wide slabs', () => {
    const two = renderToStaticMarkup(<MissionOverview model={overviewWavesBoard(2)} missionId="mission-1" workspaceId="ws-1" />);
    expect(two).toContain('md:[--cell:minmax(0,56px)]');
    expect(two.match(/<button[^>]*data-id=/g)).toHaveLength(2);
  });
});
