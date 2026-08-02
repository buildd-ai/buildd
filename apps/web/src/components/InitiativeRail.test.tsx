import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import InitiativeRail from './InitiativeRail';
import type { InitiativeListItem } from '@/lib/initiative-list';

function makeInitiative(over: Partial<InitiativeListItem> & Pick<InitiativeListItem, 'id' | 'title'>): InitiativeListItem {
  return {
    description: null,
    status: 'active',
    priority: 0,
    workspaceId: null,
    workspace: null,
    missions: [],
    progress: { status: 'active', progress: 42, completedMissions: 1, totalMissions: 2, completedTasks: 5, totalTasks: 10 },
    segments: [],
    lastMotionAt: null,
    hasLinearLink: false,
    ...over,
  };
}

describe('InitiativeRail', () => {
  it('renders nothing (null) when initiatives list is empty', () => {
    const html = renderToStaticMarkup(<InitiativeRail initiatives={[]} />);
    expect(html).toBe('');
  });

  it('renders one card per initiative', () => {
    const initiatives = [
      makeInitiative({ id: 'i-1', title: 'Alpha Arc' }),
      makeInitiative({ id: 'i-2', title: 'Beta Arc' }),
    ];
    const html = renderToStaticMarkup(<InitiativeRail initiatives={initiatives} />);
    expect(html).toContain('Alpha Arc');
    expect(html).toContain('Beta Arc');
  });

  it('each card is 160px wide (w-[160px])', () => {
    const html = renderToStaticMarkup(
      <InitiativeRail initiatives={[makeInitiative({ id: 'i-1', title: 'Arc' })]} />,
    );
    expect(html).toContain('w-[160px]');
    expect(html).not.toContain('w-[300px]');
  });

  it('each card links to the initiative detail page', () => {
    const html = renderToStaticMarkup(
      <InitiativeRail initiatives={[makeInitiative({ id: 'abc-123', title: 'Test Arc' })]} />,
    );
    expect(html).toContain('/app/initiatives/abc-123');
  });

  it('shows rollup progress % on each card', () => {
    const html = renderToStaticMarkup(
      <InitiativeRail
        initiatives={[makeInitiative({ id: 'i-1', title: 'Arc', progress: { status: 'active', progress: 73, completedMissions: 1, totalMissions: 2, completedTasks: 7, totalTasks: 10 } })]}
      />,
    );
    expect(html).toContain('73%');
  });

  it('shows a status chip on each card', () => {
    const html = renderToStaticMarkup(
      <InitiativeRail
        initiatives={[makeInitiative({ id: 'i-1', title: 'Arc', progress: { status: 'blocked', progress: 30, completedMissions: 0, totalMissions: 2, completedTasks: 3, totalTasks: 10 } })]}
      />,
    );
    expect(html).toContain('BLOCKED');
  });

  it('renders an accent left border for active initiatives', () => {
    const html = renderToStaticMarkup(
      <InitiativeRail
        initiatives={[makeInitiative({ id: 'i-1', title: 'Active Arc', progress: { status: 'active', progress: 50, completedMissions: 1, totalMissions: 2, completedTasks: 5, totalTasks: 10 } })]}
      />,
    );
    // Accent bar exists (bg-primary element)
    expect(html).toContain('bg-primary');
  });

  it('renders an accent left border for blocked initiatives', () => {
    const html = renderToStaticMarkup(
      <InitiativeRail
        initiatives={[makeInitiative({ id: 'i-1', title: 'Blocked Arc', progress: { status: 'blocked', progress: 20, completedMissions: 0, totalMissions: 2, completedTasks: 2, totalTasks: 10 } })]}
      />,
    );
    expect(html).toContain('bg-primary');
  });

  it('renders NO accent border for completed initiatives', () => {
    const html = renderToStaticMarkup(
      <InitiativeRail
        initiatives={[makeInitiative({ id: 'i-1', title: 'Done Arc', progress: { status: 'completed', progress: 100, completedMissions: 2, totalMissions: 2, completedTasks: 10, totalTasks: 10 } })]}
      />,
    );
    expect(html).not.toContain('bg-primary');
  });

  it('renders a horizontal scroll container', () => {
    const html = renderToStaticMarkup(
      <InitiativeRail initiatives={[makeInitiative({ id: 'i-1', title: 'Arc' })]} />,
    );
    expect(html).toContain('overflow-x-auto');
  });
});
