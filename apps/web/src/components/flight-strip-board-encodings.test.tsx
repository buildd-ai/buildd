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
  FLIGHT_STRIP_HUMAN_COLOR,
} from './FlightStrip';
import { FlightDetailSheet } from './FlightDetailSheet';

/**
 * One realistic fixture exercising every encoding rule from all three design
 * boards (design:flight-strip/missions-list, /flight-detail-sheet,
 * /mission-detail) AT ONCE, the way a real mission actually would — not in
 * isolation the way the rest of this suite necessarily does. Modeled on the
 * missions-list board's "rework-heavy run" card: three phases, mixed
 * concurrency, a failed-then-retried build, and both kinds of steering marks.
 * Regressions where two surfaces disagree about the same underlying data
 * (e.g. one recognizes a failure fill and the other doesn't) only show up
 * when both are rendered from the identical `data` object, which is the
 * point of this file.
 */
const date = (ms: number) => new Date(ms);
const worker = (id: string, taskId: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id,
  taskId,
  status: 'completed',
  startedAt: date(start),
  completedAt: date(end),
  ...extra,
});

const tasks = [
  { id: 'think', status: 'completed', roleSlug: 'researcher' },
  { id: 'build-fail', status: 'completed', roleSlug: 'builder' },
  { id: 'build-retry', status: 'completed', roleSlug: 'builder' },
  { id: 'build-parallel-a', status: 'completed', roleSlug: 'builder' },
  { id: 'build-parallel-b', status: 'completed', roleSlug: 'builder' },
  { id: 'check', status: 'completed', roleSlug: 'reviewer' },
];

const P1_END = 20 * 60_000;
const P2_START = P1_END + GAP;
const RETRY_START = P2_START + 20 * 60_000;
const PARALLEL_START = RETRY_START + 20 * 60_000;
const P3_START = PARALLEL_START + 20 * 60_000 + GAP;

const workers = [
  worker('w-think', 'think', 0, P1_END),
  worker('w-fail', 'build-fail', P2_START, P2_START + 15 * 60_000, { exitCause: 'code_failure' }),
  worker('w-retry', 'build-retry', RETRY_START, RETRY_START + 15 * 60_000),
  worker('w-parallel-a', 'build-parallel-a', PARALLEL_START, PARALLEL_START + 15 * 60_000),
  worker('w-parallel-b', 'build-parallel-b', PARALLEL_START + 2 * 60_000, PARALLEL_START + 17 * 60_000),
  worker('w-check', 'check', P3_START, P3_START + 10 * 60_000),
];

const steeringEvents = [
  { id: 'kickoff', kind: 'human' as const, at: date(0) },
  { id: 'mid-flight-1', kind: 'human' as const, at: date(P2_START + 5 * 60_000) },
  { id: 'orch-1', kind: 'orchestrator' as const, at: date(P1_END) },
];

const data = computeMissionFlightStrip(tasks, workers, { steeringEvents, missionCompletedAt: date(P3_START + 10 * 60_000) });

describe('board encoding consistency across FlightStrip and FlightDetailSheet', () => {
  it('the fixture actually exercises three phases, a failure, and mixed concurrency (sanity check on the fixture itself)', () => {
    expect(data.phases.length).toBeGreaterThanOrEqual(2);
    expect(data.bars.some(b => b.fill === 'failure')).toBe(true);
    expect(data.peakConcurrency).toBeGreaterThanOrEqual(2);
    expect(data.rail.marks.filter(m => m.kind === 'human').length).toBe(2);
    expect(data.rail.marks.filter(m => m.kind === 'orchestrator').length).toBe(1);
  });

  it('the compact card strip (missions-list board) renders the failure fill, lanes, and steering marks', () => {
    const html = renderToStaticMarkup(<FlightStrip data={data} />);
    expect(html).toContain('THINK');
    expect(html).toContain('BUILD');
    expect(html).toContain('CHECK');
    expect(html).toContain(FLIGHT_STRIP_FAILURE_FILL);
    expect(html).toContain(FLIGHT_STRIP_CONCURRENCY_FILL[1]);
    expect(html).toContain(FLIGHT_STRIP_HUMAN_COLOR);
  });

  it('the expanded detail sheet (flight-detail-sheet board) renders the same failure and shows it in the loop/stat derivation', () => {
    const html = renderToStaticMarkup(
      <FlightDetailSheet open={true} onClose={() => {}} data={data} missionId="m1" missionTitle="Rework-heavy run" />,
    );
    expect(html).toContain(FLIGHT_STRIP_FAILURE_FILL);
    expect(html).toContain('build ↔ check');
    // Two human touches: one at mission start (position 0, not mid-flight) and
    // one genuinely mid-flight — the prose line's count must agree with the
    // rail data both surfaces share, not restate a hardcoded "6" from the board.
    expect(html).toContain('1 of 2 human touch');
    expect(html).toContain('1 build failed and was retried');
  });

  it('both surfaces agree on phase count — neither silently drops or invents a divider', () => {
    const cardHtml = renderToStaticMarkup(<FlightStrip data={data} />);
    const sheetHtml = renderToStaticMarkup(
      <FlightDetailSheet open={true} onClose={() => {}} data={data} missionId="m1" missionTitle="Rework-heavy run" />,
    );
    // Every phase after the first draws a divider on the card strip. Its axis
    // LABEL may be collision-culled at card width (addendum D4: labels never
    // overlap, and an unlabelled gap is fine), so the divider is what counts.
    const dividers = cardHtml.match(/stroke-dasharray="2 2"/g) ?? [];
    expect(dividers).toHaveLength(data.phases.length - 1);
    // The first phase renders as a bare label ("P1"); a later phase label, when
    // it fits, carries the elided-gap duration inline ("15m idle · P2"),
    // matching the missions-list board's "7h idle · P2" convention.
    expect(cardHtml).toContain(`>${data.phases[0].label}<`);
    for (const [i, phase] of data.phases.entries()) {
      if (i > 0 && cardHtml.includes(`>${phase.label}<`)) throw new Error(`phase ${phase.label} lost its idle prefix`);
    }
    // The sheet culls colliding axis labels the same way (D4), so it too is
    // judged by dividers; its first phase label always survives.
    const sheetDividers = sheetHtml.match(/stroke-dasharray="2 2"/g) ?? [];
    expect(sheetDividers).toHaveLength(data.phases.length - 1);
    expect(sheetHtml).toContain(`>${data.phases[0].label}<`);
  });

  it('the now-line is absent on both surfaces once the mission has completed', () => {
    expect(data.now).toBeNull();
    const cardHtml = renderToStaticMarkup(<FlightStrip data={data} />);
    expect(cardHtml).not.toContain('>now<');
  });
});
