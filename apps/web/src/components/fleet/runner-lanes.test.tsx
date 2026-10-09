import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetSnapshot } from '@buildd/shared';
import SlotLanes from './SlotLanes';
import { RunnerLanes, idleSentences, idleSlotCount, laneCaption, runnerLanes } from './runner-lanes';

const T = Date.UTC(2026, 0, 1);
const m = (n: number) => T + n * 60_000;
const bar = (id: string, state: 'running' | 'waiting' | 'done' | 'failed', s: number, e: number | null) =>
  ({ id, start: m(s), end: e == null ? null : m(e), label: `task ${id}`, color: null, roleName: 'Builder', state } as const);

const fleet = {
  runners: [{
    id: 'r1', name: 'atlas',
    slots: [
      { lane: { bars: [bar('a', 'done', 0, 30), bar('b', 'failed', 40, 50)] } },
      { lane: { bars: [bar('c', 'running', 10, null), bar('d', 'waiting', 0, 5)] } },
    ],
  }],
  live: 1, capacity: 2, window: { from: m(0), to: m(60) },
} as unknown as FleetSnapshot;

describe('runnerLanes', () => {
  it('maps bar states to strip-cell states, with no role letter', () => {
    const [lane] = runnerLanes(fleet);
    expect(lane.badge).toBeNull();
    expect(lane.minSlots).toBe(2);
    expect(Object.fromEntries(lane.bars.map(b => [b.id, b.cell?.state]))).toEqual({ a: 'landed', b: 'failed', c: 'running', d: 'waiting' });
    expect(lane.bars[0].label).toBe('task a');
  });
});

describe('idleSentences', () => {
  it('longest first, at most three', () => {
    const s = [10, 40, 20, 30].map((len, i) => ({ from: m(i * 100), to: m(i * 100 + len), waited: 2 }));
    const out = idleSentences(s);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('every slot sat idle 40m while 2 tasks waited');
    expect(out[2]).toContain('20m');
  });
});

describe('RunnerLanes', () => {
  const html = renderToStaticMarkup(<RunnerLanes fleet={fleet} idle={[{ from: m(5), to: m(10), waited: 1 }]} now={m(60)} />);
  it('draws state-cell bars, shade and the sentence', () => {
    expect(html).toContain('state-cell');
    expect(html).toContain('data-state="landed"');
    expect(html).toContain('data-pattern="hatch-bold"');
    expect(html).toContain('slot-lanes-shade');
    expect(html).toContain('every slot sat idle 5m while 1 task waited');
    expect(html).toContain('task a');
  });
  it('has no role letter avatar', () => {
    expect(html).not.toContain('border-[1.5px] border-border-strong bg-surface-1');
  });
});

describe('SlotLanes shade', () => {
  it('renders one flat tint per row per span, none without the prop', () => {
    const lanes = [{ id: 'x', label: 'x', bars: [], minSlots: 2 }];
    const withShade = renderToStaticMarkup(<SlotLanes lanes={lanes} from={m(0)} to={m(20)} shade={[{ from: m(1), to: m(3) }]} />);
    expect(withShade.split('slot-lanes-shade').length - 1).toBe(2);
    expect(withShade).not.toContain('fleet-hatch');
    expect(renderToStaticMarkup(<SlotLanes lanes={lanes} from={m(0)} to={m(20)} />)).not.toContain('slot-lanes-shade');
  });
});

describe('runnerLanes: missions, empty slots and short runs', () => {
  const W = { from: m(0), to: m(100) };
  const mk = (id: string, state: 'running' | 'waiting' | 'done' | 'failed', s: number, e: number | null, missionId: string | null = null) =>
    ({ ...bar(id, state, s, e), missionId } as const);
  const snap = (slots: ReadonlyArray<ReadonlyArray<ReturnType<typeof mk>>>) => ({
    runners: [{ id: 'r1', name: 'atlas', slots: slots.map(bars => ({ lane: { bars } })) }],
    live: 0, capacity: slots.length, window: W,
  } as unknown as FleetSnapshot);

  it('a bar\'s focus key is its mission, none without one', () => {
    const [lane] = runnerLanes(snap([[mk('a', 'done', 0, 40, 'm1'), mk('b', 'done', 50, 90)]]), W);
    expect(lane.bars.map(b => b.focusKey)).toEqual(['m1', undefined]);
  });

  it('draws only the slots that held work in the window', () => {
    const f = snap([[mk('a', 'done', 0, 40)], [], [], [mk('b', 'running', 50, null)]]);
    const [lane] = runnerLanes(f, W);
    expect(lane.minSlots).toBe(2);
    expect(idleSlotCount(f)).toBe(2);
  });

  it('merges adjacent short finished runs in a slot into one quiet tick that lists them', () => {
    const [lane] = runnerLanes(snap([[
      mk('a', 'done', 10, 12, 'm1'), mk('b', 'done', 13, 15, 'm1'), mk('c', 'done', 16, 18, 'm1'),
      mk('d', 'done', 40, 80, 'm1'),
    ]]), W);
    expect(lane.bars.map(b => b.id)).toEqual(['short:a', 'd']);
    const merged = lane.bars[0];
    expect(merged.label).toBe('3 short runs');
    expect(merged.endMark).toBeNull();
    expect(merged.cell).toBeUndefined();
    expect(merged.href).toBeUndefined();
    expect(merged.focusKey).toBe('m1');
    expect(merged.start).toBe(m(10));
    expect(merged.end).toBe(m(18));
  });

  it('a failed short run stays its own red tick; a lone short run is left as it is', () => {
    const [lane] = runnerLanes(snap([[
      mk('a', 'done', 10, 12), mk('b', 'failed', 13, 15), mk('c', 'done', 16, 18), mk('e', 'done', 60, 62),
    ]]), W);
    expect(lane.bars.map(b => b.id)).toEqual(['a', 'b', 'c', 'e']);
    expect(lane.bars[1].endMark).toBe('fail');
  });

  it('a merged tick spanning two missions belongs to neither', () => {
    const [lane] = runnerLanes(snap([[mk('a', 'done', 10, 12, 'm1'), mk('b', 'done', 13, 15, 'm2')]]), W);
    expect(lane.bars[0].focusKey).toBeUndefined();
  });
});

describe('laneCaption', () => {
  const missions = { m1: { title: 'Delivery UX', landed: 2, total: 7 } };
  it('no selection: the chart title', () => {
    expect(laneCaption(null, missions)).toEqual({ text: 'Slots over the last hours', href: null });
  });
  it('a mission bar: mission title and merged count, linking to the mission', () => {
    expect(laneCaption({ id: 'a', focusKey: 'm1', title: 'feat(x): y', label: 'y', href: '/t/a' }, missions))
      .toEqual({ text: 'Delivery UX · 2 of 7 merged', href: '/app/missions/m1' });
  });
  it('a bar with no mission (or an unknown one): the task\'s display title, linking to the task', () => {
    expect(laneCaption({ id: 'a', title: 'fix(api): retry the claim', label: 'retry', href: '/t/a' }, missions))
      .toEqual({ text: 'Retry the claim', href: '/t/a' });
    expect(laneCaption({ id: 'a', focusKey: 'm9', title: 'chore: bump', label: 'bump', href: '/t/a' }, missions).text).toBe('Bump');
  });
});

describe('RunnerLanes on Health', () => {
  const html = renderToStaticMarkup(<RunnerLanes fleet={fleet} idle={[]} now={m(60)} missions={{}} />);
  it('owns its caption and draws the chart unframed inside the page card', () => {
    expect(html).toContain('data-testid="runner-lanes-caption"');
    expect(html).toContain('Slots over the last hours');
    expect(html).not.toContain('border-2 border-border-strong');
  });
});
