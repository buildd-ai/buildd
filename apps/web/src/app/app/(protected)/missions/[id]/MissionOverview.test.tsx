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
const { railLines } = await import('@/lib/mission-overview');
const { dagBoard, dagId, DAG_SPECS } = await import('@/app/app/dev/fixtures/mission-task-strip-fixtures');

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
    expect(html).toContain('1 of 5 landed');
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

  it('the counts line is landed only; criteria live in the Verified pill and the rail', () => {
    const counts = out.match(/data-testid="overview-counts"[^>]*>([^<]*)</)?.[1];
    expect(counts).toBe('3 of 11 landed');
  });
});
