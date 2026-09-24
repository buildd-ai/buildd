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
  axisLabelWidth,
  cullAxisLabels,
  laneLabelColumnWidth,
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

  describe('interactivity (mission-detail navigator)', () => {
    it('adds tap targets to bars when onBarSelect is passed', () => {
      const strip = computeMissionFlightStrip(
        [{ id: 'a', status: 'completed' }],
        [worker('w1', 'a', 0, 100)],
      );
      const html = renderToStaticMarkup(<FlightStrip data={strip} onBarSelect={() => {}} />);
      expect(html).toContain('role="button"');
      expect(html).toContain('tabindex="0"');
    });

    it('omits tap targets when onBarSelect is not passed (card usage stays unaffected)', () => {
      const strip = computeMissionFlightStrip(
        [{ id: 'a', status: 'completed' }],
        [worker('w1', 'a', 0, 100)],
      );
      const html = renderToStaticMarkup(<FlightStrip data={strip} />);
      expect(html).not.toContain('role="button"');
      expect(html).not.toContain('tabindex="0"');
      // outline rect is fill="none" stroke={NOW_COLOR} stroke-width="2" — that exact
      // triple is unique to it (the hatch pattern also uses stroke-width 2, but a
      // different color and no fill attribute)
      expect(html).not.toContain(`fill="none" stroke="${FLIGHT_STRIP_NOW_COLOR}" stroke-width="2"`);
    });

    it('outlines the selected solid bar', () => {
      const strip = computeMissionFlightStrip(
        [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }],
        [worker('w1', 'a', 0, 100), worker('w2', 'b', 100, 200)],
      );
      const html = renderToStaticMarkup(<FlightStrip data={strip} selectedTaskId="a" onBarSelect={() => {}} />);
      expect(html).toContain(`fill="none" stroke="${FLIGHT_STRIP_NOW_COLOR}" stroke-width="2"`);
    });

    it('outlines the selected dashed (queued) bar', () => {
      const strip = computeMissionFlightStrip(
        [{ id: 'a', status: 'running' }, { id: 'queued', status: 'pending' }],
        [{ ...worker('w1', 'a', 0, 10), status: 'running', completedAt: null, updatedAt: date(10) }],
        { now: 100 },
      );
      const html = renderToStaticMarkup(
        <FlightStrip data={strip} selectedTaskId="queued" onBarSelect={() => {}} />,
      );
      expect(html).toContain('stroke-dasharray="3 2"');
      expect(html).toContain(`fill="none" stroke="${FLIGHT_STRIP_NOW_COLOR}" stroke-width="2"`);
    });

    it('renders no outline when selectedTaskId matches no bar', () => {
      const strip = computeMissionFlightStrip(
        [{ id: 'a', status: 'completed' }],
        [worker('w1', 'a', 0, 100)],
      );
      const html = renderToStaticMarkup(
        <FlightStrip data={strip} selectedTaskId="does-not-exist" onBarSelect={() => {}} />,
      );
      expect(html).not.toContain(`fill="none" stroke="${FLIGHT_STRIP_NOW_COLOR}" stroke-width="2"`);
    });
  });

  describe('mobile viewport (320pt)', () => {
    it('renders readable text at 320pt viewport (256px width after padding)', () => {
      const strip = computeMissionFlightStrip(
        [{ id: 'a', status: 'completed', roleSlug: 'builder' }],
        [worker('w1', 'a', 0, 100)],
      );
      // 320pt viewport - 32px left padding - 32px right padding = 256px container width
      const html = renderToStaticMarkup(<FlightStrip data={strip} width={256} />);

      // Label font sizes should remain unchanged (not scaled down to ~6.8px)
      expect(html).toContain('font-size="8.5"');

      // Lane-label column (LABEL_W = 42) starts at x=0
      // The lane track should start at x=42 and work area width should be 256-42-4=210
      expect(html).toContain('x="42"');
      expect(html).toContain('width="210"');

      // The viewBox should match the container width to maintain 1:1 scaling
      expect(html).toContain('viewBox="0 0 256');

      // Verify that no universal scaling happens via CSS transforms
      expect(html).not.toContain('scale(0.8)');
      expect(html).not.toContain('transform="scale');
    });
  });
});

// Addendum D4: axis labels never overlap and lane labels are never truncated.
describe('FlightStrip readability (D4)', () => {
  const label = (id: string, x: number, text: string, priority: number, anchor: 'start' | 'middle' | 'end' = 'start') =>
    ({ id, x, text, priority, anchor });

  it('estimates mono label width from character count', () => {
    expect(axisLabelWidth('P1', 8.5)).toBeCloseTo(2 * 8.5 * 0.6);
  });

  it('keeps labels that do not collide', () => {
    const kept = cullAxisLabels([label('p1', 42, 'P1', 1), label('p2', 150, 'P2', 1)], { minX: 42, maxX: 318 });
    expect(kept.map(l => l.id)).toEqual(['p1', 'p2']);
  });

  it('drops the lower-priority label when two would overlap or sit closer than the minimum gap', () => {
    const kept = cullAxisLabels(
      [label('p1', 42, 'P1', 1), label('p2', 60, '12m idle · P2', 1), label('now', 64, 'now', 3, 'middle')],
      { minX: 42, maxX: 318 },
    );
    expect(kept.map(l => l.id)).toEqual(['p1', 'now']);
  });

  it('at equal priority the earlier (left) label wins', () => {
    const kept = cullAxisLabels([label('a', 100, 'AAAA', 1), label('b', 110, 'BBBB', 1)], { minX: 0, maxX: 318 });
    expect(kept.map(l => l.id)).toEqual(['a']);
  });

  it('drops a label that would run past the strip edge instead of clipping it', () => {
    const kept = cullAxisLabels([label('p9', 300, 'long phase label', 1)], { minX: 42, maxX: 318 });
    expect(kept).toEqual([]);
  });

  it('never renders two axis labels whose boxes overlap, even for crowded phases', () => {
    const tasks = [{ id: 'a', status: 'completed' }];
    const workers = [0, 1, 2, 3, 4].map(i => worker(`w${i}`, 'a', i * (GAP + 10), i * (GAP + 10) + 5));
    const strip = computeMissionFlightStrip(tasks, workers);
    expect(strip.phases.length).toBeGreaterThan(2);
    const html = renderToStaticMarkup(<FlightStrip data={strip} width={256} />);
    const axisTexts = [...html.matchAll(/<text data-axis-label="true" x="([\d.]+)"[^>]*?(?:text-anchor="(\w+)")?[^>]*>([^<]*)<\/text>/g)]
      .map(m => {
        const w = axisLabelWidth(m[3], 8.5);
        const x = Number(m[1]);
        const start = m[2] === 'middle' ? x - w / 2 : m[2] === 'end' ? x - w : x;
        return { start, end: start + w };
      })
      .sort((a, b) => a.start - b.start);
    expect(axisTexts.length).toBeGreaterThan(0);
    for (let i = 1; i < axisTexts.length; i++) expect(axisTexts[i].start).toBeGreaterThanOrEqual(axisTexts[i - 1].end);
  });

  it('widens the lane-label column so UNCLASSIFIED is never truncated', () => {
    const labels = ['THINK', 'BUILD', 'CHECK'];
    expect(laneLabelColumnWidth(labels.map(text => ({ text, fontSize: 8.5 })))).toBe(42);
    const w = laneLabelColumnWidth([...labels.map(text => ({ text, fontSize: 8.5 })), { text: 'UNCLASSIFIED', fontSize: 6 }]);
    expect(w).toBeGreaterThanOrEqual(axisLabelWidth('UNCLASSIFIED', 6) + 2);
  });
});
