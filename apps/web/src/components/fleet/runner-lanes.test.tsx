import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetSnapshot } from '@buildd/shared';
import SlotLanes from './SlotLanes';
import { RunnerLanes, idleSentences, runnerLanes } from './runner-lanes';

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
