import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeMissionFlightStrip } from '@buildd/core/mission-helpers';
import { FlightDetailSheet } from './FlightDetailSheet';

const date = (ms: number) => new Date(ms);
const worker = (id: string, taskId: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id,
  taskId,
  status: 'completed',
  startedAt: date(start),
  completedAt: date(end),
  ...extra,
});

const BASE_DATA = computeMissionFlightStrip(
  [{ id: 'a', status: 'completed', roleSlug: 'builder' }],
  [worker('w1', 'a', 0, 60_000)],
);

describe('FlightDetailSheet', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <FlightDetailSheet open={false} onClose={() => {}} data={BASE_DATA} missionId="m1" missionTitle="Ship the thing" />,
    );
    expect(html).toBe('');
  });

  it('renders the header, title, legend, stat grid and mission link when open', () => {
    const html = renderToStaticMarkup(
      <FlightDetailSheet open={true} onClose={() => {}} data={BASE_DATA} missionId="m1" missionTitle="Ship the thing" />,
    );
    expect(html).toContain('FLIGHT DETAIL');
    expect(html).toContain('Ship the thing');
    expect(html).toContain('You stepped in');
    expect(html).toContain('Orchestrator ran a model');
    expect(html).toContain('1, 2, 3+ in parallel');
    expect(html).toContain('Failed, retried');
    expect(html).toContain('agent time');
    expect(html).toContain('idle, not drawn');
    expect(html).toContain('build ↔ check');
    expect(html).toContain('human-steered');
    expect(html).toContain('href="/app/missions/m1"');
    expect(html).toContain('Open mission');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
  });

  it('renders an em dash, not 0%, for human% when there were no steering touches to take a share of', () => {
    const html = renderToStaticMarkup(
      <FlightDetailSheet open={true} onClose={() => {}} data={BASE_DATA} missionId="m1" missionTitle="Ship the thing" />,
    );
    expect(html).toContain('>—</span><span class="text-[10px] text-text-muted">human-steered</span>');
  });

  it('renders an em dash, not 0 loops, for build/check loop count on a mission with no trustworthy lane data', () => {
    const html = renderToStaticMarkup(
      <FlightDetailSheet
        open={true}
        onClose={() => {}}
        data={computeMissionFlightStrip([{ id: 'a', status: 'completed' }], [worker('w1', 'a', 0, 100)])}
        missionId="m1"
        missionTitle="Ship the thing"
      />,
    );
    expect(html).toContain('>—</span><span class="text-[10px] text-text-muted">build ↔ check</span>');
  });

  it('shows a real loop count and human% once lane and steering data exist', () => {
    const tasks = [
      { id: 'b1', status: 'completed', roleSlug: 'builder' },
      { id: 'c1', status: 'completed', roleSlug: 'reviewer' },
      { id: 'b2', status: 'completed', roleSlug: 'builder' },
    ];
    const data = computeMissionFlightStrip(
      tasks,
      [worker('w1', 'b1', 0, 10), worker('w2', 'c1', 10, 20), worker('w3', 'b2', 20, 30)],
      { steeringEvents: [{ id: 'h1', kind: 'human', at: date(15) }] },
    );
    const html = renderToStaticMarkup(
      <FlightDetailSheet open={true} onClose={() => {}} data={data} missionId="m1" missionTitle="Ship the thing" />,
    );
    expect(html).toContain('1 loop');
    expect(html).toContain('100%');
    expect(html).toContain('THINK');
    expect(html).toContain('BUILD');
    expect(html).toContain('CHECK');
  });

  it('falls back to an unlabelled work row when the mission has no trustworthy lane data', () => {
    const html = renderToStaticMarkup(
      <FlightDetailSheet
        open={true}
        onClose={() => {}}
        data={computeMissionFlightStrip([{ id: 'a', status: 'completed' }], [worker('w1', 'a', 0, 100)])}
        missionId="m1"
        missionTitle="Ship the thing"
      />,
    );
    expect(html).not.toContain('THINK');
    expect(html).not.toContain('BUILD');
    expect(html).not.toContain('CHECK');
    expect(html).toContain('WORK');
  });
});
