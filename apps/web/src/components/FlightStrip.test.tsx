import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  computeMissionFlightStrip,
  FLIGHT_STRIP_IDLE_THRESHOLD_MS as GAP,
} from '@buildd/core/mission-helpers';
import {
  FlightStrip,
  FLIGHT_STRIP_CONCURRENCY_FILL,
  FLIGHT_STRIP_FAILURE_FILL,
  FLIGHT_STRIP_NOW_COLOR,
  FLIGHT_STRIP_HUMAN_COLOR,
  FLIGHT_STRIP_LANE_FOLD_CAP,
} from './FlightStrip';

const date = (ms: number) => new Date(ms);
const worker = (id: string, taskId: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id,
  taskId,
  status: 'completed',
  startedAt: date(start),
  completedAt: date(end),
  ...extra,
});

describe('FlightStrip', () => {
  it('renders a single uncaptioned track for a mission with no lane data', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100)],
    );
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).not.toContain('THINK');
    expect(html).not.toContain('BUILD');
    expect(html).not.toContain('CHECK');
    expect(html).not.toContain('UNCLASSIFIED');
    expect(html).toContain(FLIGHT_STRIP_CONCURRENCY_FILL[1]);
  });

  it('renders mixed lanes plus an UNCLASSIFIED band for partially labelled missions', () => {
    const tasks = [
      { id: 'think', status: 'completed', roleSlug: 'researcher' },
      { id: 'build', status: 'completed', roleSlug: 'builder' },
      { id: 'check', status: 'completed', roleSlug: 'reviewer' },
      { id: 'unknown', status: 'completed' },
    ];
    const strip = computeMissionFlightStrip(tasks, [
      worker('w1', 'think', 0, 10),
      worker('w2', 'build', 10, 20),
      worker('w3', 'check', 20, 30),
      worker('w4', 'unknown', 30, 40),
    ]);
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).toContain('THINK');
    expect(html).toContain('BUILD');
    expect(html).toContain('CHECK');
    expect(html).toContain('UNCLASSIFIED');
  });

  it('omits the UNCLASSIFIED band when every task resolves to a lane', () => {
    const tasks = [
      { id: 'build', status: 'completed', roleSlug: 'builder' },
    ];
    const strip = computeMissionFlightStrip(tasks, [worker('w1', 'build', 0, 10)]);
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).toContain('BUILD');
    expect(html).not.toContain('UNCLASSIFIED');
  });

  it('renders an orchestrator-only mission: steering marks with zero lane bars', () => {
    const strip = computeMissionFlightStrip([], [], {
      steeringEvents: [
        { id: 'cycle-1', kind: 'orchestrator', at: date(0) },
        { id: 'cycle-2', kind: 'orchestrator', at: date(10) },
      ],
    });
    expect(strip.bars).toEqual([]);
    expect(strip.rail.visible).toBe(true);
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).toContain('STEER');
    // hollow orchestrator square uses a stroke, not a fill — no concurrency rect should exist
    expect(html).not.toContain(FLIGHT_STRIP_CONCURRENCY_FILL[1]);
  });

  it('renders a human steering diamond', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100)],
      { steeringEvents: [{ id: 'note', kind: 'human', at: date(50) }] },
    );
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).toContain(FLIGHT_STRIP_HUMAN_COLOR);
  });

  it('gives a failed span the failure fill, keyed off exitCause not status', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100, { exitCause: 'code_failure' })],
    );
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).toContain(FLIGHT_STRIP_FAILURE_FILL);
  });

  it('does not give a non-real failure cause the failure fill', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100, { exitCause: 'budget_limited' })],
    );
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).not.toContain(FLIGHT_STRIP_FAILURE_FILL);
  });

  it('renders a now-line and hollow dashed queued bars for an active mission', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'running' }, { id: 'queued', status: 'pending' }],
      [{ ...worker('w1', 'a', 0, 10), status: 'running', completedAt: null, updatedAt: date(10) }],
      { now: 100 },
    );
    expect(strip.now).not.toBeNull();
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).toContain(FLIGHT_STRIP_NOW_COLOR);
    expect(html).toContain('stroke-dasharray="3 2"');
    expect(html).toContain('>now<');
  });

  it('omits the now-line for a completed mission', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100)],
      { missionCompletedAt: date(100) },
    );
    expect(strip.now).toBeNull();
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).not.toContain('>now<');
  });

  it('labels phase dividers with the elided-gap duration', () => {
    const strip = computeMissionFlightStrip(
      [{ id: 'a', status: 'completed' }],
      [worker('w1', 'a', 0, 100), worker('w2', 'a', 100 + GAP, 300 + GAP)],
    );
    expect(strip.phases).toHaveLength(2);
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).toContain('P1');
    expect(html).toContain('idle · P2');
  });

  it('folds a lane past FLIGHT_STRIP_LANE_FOLD_CAP segments into one hatched block', () => {
    const n = FLIGHT_STRIP_LANE_FOLD_CAP + 3;
    const tasks = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, status: 'completed', roleSlug: 'builder' }));
    const workers = tasks.map((t, i) => worker(`w${i}`, t.id, i * 10, i * 10 + 5));
    const strip = computeMissionFlightStrip(tasks, workers);
    const html = renderToStaticMarkup(<FlightStrip data={strip} />);
    expect(html).toContain('fs-hatch');
    expect(html).toContain(`+${n - FLIGHT_STRIP_LANE_FOLD_CAP}`);
  });

  it('renders nothing crash-worthy for a fully empty strip', () => {
    const strip = computeMissionFlightStrip([], []);
    expect(() => renderToStaticMarkup(<FlightStrip data={strip} />)).not.toThrow();
  });
});
