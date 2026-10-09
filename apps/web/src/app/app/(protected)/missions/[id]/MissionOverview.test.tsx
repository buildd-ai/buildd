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
});
