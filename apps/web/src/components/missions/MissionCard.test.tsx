/**
 * The one mission card on Home and the missions list
 * (docs/design/mission-feed-mobile-continuity.md, W1, addendum D7).
 * Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildMissionCardView, type MissionCardRow, type MissionCardTaskRow } from '@/lib/mission-card-view';
import { computeMissionFlightStrip } from '@buildd/core/mission-helpers';
import MissionCard from './MissionCard';

let clock = Date.UTC(2026, 0, 1);
function task(id: string, over: Partial<MissionCardTaskRow> = {}): MissionCardTaskRow {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), workers: [], ...over };
}
const active: MissionCardRow = {
  id: 'm1',
  title: 'Claim loop hardening',
  status: 'active',
  isHeld: false,
  // A raw-markdown description must never reach the card (D7).
  tasks: [
    task('a', { status: 'completed' }),
    task('b', { title: 'Lease shadow mode', status: 'in_progress', workers: [{ status: 'waiting_input' }] }),
    task('c'),
  ],
};

describe('MissionCard (full)', () => {
  const view = buildMissionCardView(active, { from: 'home' });
  const html = renderToStaticMarkup(<MissionCard view={view} />);

  it('renders the card masthead: title, one chip, situation line, pulse, caption, primary line', () => {
    expect(html).toContain('data-testid="mission-masthead"');
    expect(html).toContain('data-size="card"');
    expect(html).toContain('Claim loop hardening');
    expect(html.match(/data-testid="mission-state-chip"/g)?.length).toBe(1);
    expect(html).toContain('data-testid="mission-situation-line"');
    expect(html).toContain('data-testid="mission-pulse"');
    expect(html.match(/data-testid="mission-pulse-segment"/g)?.length).toBe(3);
    expect(html).toContain('1/3 · 1 live');
    expect(html).toContain('data-testid="mission-masthead-primary"');
    expect(html).toContain('Answer: Lease shadow mode');
  });

  it('links the body to the mission and the primary line to the task sheet in mission context', () => {
    expect(html).toContain('href="/app/missions/m1?from=home"');
    expect(html).toContain('href="/app/missions/m1?from=home&amp;task=b"');
    expect(html).not.toContain('/app/tasks/');
  });

  it('carries its group for the list and Home sections', () => {
    expect(html).toContain('data-group="running"');
  });

  it('has no orphan tokens or verification pill beside the one chip (D2, D7)', () => {
    expect(html).not.toContain('mission-verification-pill');
    expect(html).not.toContain('· Deferred');
    expect(html).not.toContain('##');
  });

  it('offers the time-axis strip behind ⤢ only when there is a strip to draw', () => {
    expect(html).not.toContain('data-testid="mission-card-expand"');
    const strip = computeMissionFlightStrip(
      [{ id: 'b', status: 'in_progress', roleSlug: 'builder' }],
      [{ id: 'w1', taskId: 'b', status: 'running', startedAt: new Date(Date.now() - 60_000) }],
    );
    const withStrip = renderToStaticMarkup(
      <MissionCard view={buildMissionCardView(active, { from: 'home', flightStrip: strip })} />,
    );
    expect(withStrip).toContain('data-testid="mission-card-expand"');
    expect(withStrip).toContain('aria-label="Open flight detail"');
  });
});

describe('MissionCard (compact, D7)', () => {
  it('a completed mission renders one line, no pulse and no primary line', () => {
    const view = buildMissionCardView(
      {
        id: 'm2', title: 'Retire the legacy lock', status: 'completed', completedAt: new Date(Date.now() - 2 * 86_400_000),
        tasks: [task('x', { status: 'completed' }), task('y', { status: 'completed' })],
      },
      { from: 'missions' },
    );
    const html = renderToStaticMarkup(<MissionCard view={view} />);
    expect(html).toContain('data-testid="mission-card-compact"');
    expect(html).toContain('Retire the legacy lock');
    expect(html).toContain('Completed 2d ago · 2/2');
    expect(html).not.toContain('mission-pulse');
    expect(html).not.toContain('mission-masthead-primary');
    expect(html).toContain('href="/app/missions/m2?from=missions"');
  });
});
