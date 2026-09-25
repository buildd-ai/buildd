import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeMissionFlightStrip } from '@buildd/core/mission-helpers';
import { FlightDetailSheet, visiblePhaseLabels } from './FlightDetailSheet';
import { axisLabelWidth } from './FlightStrip';

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
    expect(html).toContain('>—</span><span class="text-[11px] md:text-[10px] text-text-muted">human-steered</span>');
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
    expect(html).toContain('>—</span><span class="text-[11px] md:text-[10px] text-text-muted">build ↔ check</span>');
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

  // AC-20: "Open mission →" carries the selected bar into mission context.
  it('Open mission carries the origin, and the selected bar as the task sheet', () => {
    const plain = renderToStaticMarkup(
      <FlightDetailSheet open={true} onClose={() => {}} data={BASE_DATA} missionId="m1" missionTitle="Ship the thing" from="home" />,
    );
    expect(plain).toContain('href="/app/missions/m1?from=home"');

    const selected = renderToStaticMarkup(
      <FlightDetailSheet
        open={true}
        onClose={() => {}}
        data={BASE_DATA}
        missionId="m1"
        missionTitle="Ship the thing"
        from="home"
        initialTaskId="a"
      />,
    );
    expect(selected).toContain('href="/app/missions/m1?from=home&amp;task=a"');
    expect(selected).toContain('data-testid="flight-detail-open-mission"');
  });

  it('every drawn bar is a selectable target carrying its task id', () => {
    const html = renderToStaticMarkup(
      <FlightDetailSheet open={true} onClose={() => {}} data={BASE_DATA} missionId="m1" missionTitle="Ship the thing" initialTaskId="a" />,
    );
    expect(html).toContain('data-testid="flight-detail-bar"');
    expect(html).toContain('data-task-id="a"');
    expect(html).toContain('aria-pressed="true"');
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

// QA: a many-phase mission drew P8, P9, P10 and the "16m" duration on top of
// each other ("P8P9P1016m"). Labels are thinned so no two overlap.
describe('visiblePhaseLabels', () => {
  const W = 358;
  const phases = (n: number, from = 0, to = 1) =>
    Array.from({ length: n }, (_, i) => ({ label: `P${i + 1}`, position: n === 1 ? 0 : from + ((to - from) * i) / (n - 1) }));

  it('keeps every label when they are well spread', () => {
    expect(visiblePhaseLabels(phases(3, 0, 0.6), W, '16m')).toEqual([0, 1, 2]);
  });

  it('always keeps the first phase label', () => {
    expect(visiblePhaseLabels(phases(40), W, '16m')[0]).toBe(0);
  });

  it('drops labels that would collide with each other or with the duration', () => {
    const ps = [
      { label: 'P1', position: 0 },
      { label: 'P7', position: 0.5 },
      { label: 'P8', position: 0.9 },
      { label: 'P9', position: 0.92 },
      { label: 'P10', position: 0.95 },
    ];
    const shown = visiblePhaseLabels(ps, W, '16m');
    expect(shown).toContain(0);
    expect(shown).toContain(1);
    // At most one of the three crowded labels survives, and none under the duration.
    expect(shown.filter(i => i >= 2).length).toBeLessThanOrEqual(1);
  });

  it('never returns two labels whose boxes overlap', () => {
    const ps = phases(25, 0, 0.98);
    const shown = visiblePhaseLabels(ps, W, '1h 4m');
    const est = (t: string) => axisLabelWidth(t, 9);
    for (let k = 1; k < shown.length; k++) {
      const a = ps[shown[k - 1]];
      const b = ps[shown[k]];
      const ax = shown[k - 1] === 0 ? 0 : a.position * W;
      expect(b.position * W).toBeGreaterThanOrEqual(ax + est(a.label));
    }
    const last = ps[shown[shown.length - 1]];
    expect(last.position * W + est(last.label)).toBeLessThanOrEqual(W - est('1h 4m'));
  });

  it('renders only the thinned labels in the chart', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, status: 'completed', roleSlug: 'builder' }));
    // Twelve short spans separated by long idle gaps → twelve phases.
    const workers = tasks.map((t, i) => worker(`w${i}`, t.id, i * 10_000_000, i * 10_000_000 + 1_000));
    const data = computeMissionFlightStrip(tasks, workers);
    expect(data.phases.length).toBeGreaterThan(8);
    const html = renderToStaticMarkup(
      <FlightDetailSheet open={true} onClose={() => {}} data={data} missionId="m1" missionTitle="Ship the thing" />,
    );
    const rendered = [...html.matchAll(/>(P\d+)<\/text>/g)].map(m => m[1]);
    expect(rendered.length).toBeLessThan(data.phases.length);
    expect(rendered[0]).toBe('P1');
  });
});

