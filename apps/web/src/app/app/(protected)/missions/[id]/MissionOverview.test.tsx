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
    expect(html).toContain('1 of 5 merged');
    expect(html).toContain('data-testid="overview-stepper"');
  });

  it('puts the agents and needs-you counts in the rail, capped to a 720px main column', () => {
    expect(html).toContain('data-testid="overview-rail"');
    expect(html).toContain('data-testid="rail-needs"');
    expect(html).toContain('min-[900px]:grid-cols-[minmax(0,720px)');
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

  it('the counts line is merged only; criteria live in the Verified pill and the rail', () => {
    const counts = out.match(/data-testid="overview-counts"[^>]*>([^<]*)</)?.[1];
    expect(counts).toBe('3 of 11 merged');
  });
});
