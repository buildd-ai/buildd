/**
 * SlotLanes is generic: lanes of bars on a time axis, no product imports.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import SlotLanes, { type SlotLane } from './SlotLanes';

const T = Date.UTC(2026, 0, 1);
const m = (n: number) => T + n * 60_000;

const lanes: SlotLane[] = [
  {
    id: 'alpha', label: 'alpha',
    bars: [
      { id: 'a1', start: m(0), end: m(5), tone: 'done', scope: 'db', label: 'schema', endMark: 'ok', group: 'g1' },
      { id: 'a2', start: m(2), end: null, tone: 'live', label: 'api', href: '/x?task=g2', linkData: { 'data-task-id': 'g2' }, group: 'g2', deps: ['g1'] },
    ],
  },
  { id: 'beta', label: 'beta', bars: [], minSlots: 2 },
];

const render = (extra: Partial<Parameters<typeof SlotLanes>[0]> = {}) =>
  renderToStaticMarkup(<SlotLanes lanes={lanes} from={m(0)} to={m(20)} now={m(10)} {...extra} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('SlotLanes', () => {
  it('one row per slot: overlap opens a second slot, minSlots pads an idle lane', () => {
    expect(count(render(), 'data-testid="slot-lane-row"')).toBe(4);
  });

  it('positions bars on the axis and draws a live bar to now', () => {
    const html = render();
    expect(html).toMatch(/data-bar-id="a1"[^>]*style="left:0%;width:calc\(25% - 2px\)"/);
    expect(html).toMatch(/data-bar-id="a2"[^>]*style="left:10%;width:calc\(40% - 2px\)"/);
  });

  it('a bar with href is a link carrying its data attributes', () => {
    const tag = render().match(/<a [^>]*data-bar-id="a2"[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('href="/x?task=g2"');
    expect(tag).toContain('data-task-id="g2"');
  });

  it('NOW only while there is a now', () => {
    expect(render()).toContain('data-testid="slot-lanes-now"');
    expect(render({ now: null })).not.toContain('data-testid="slot-lanes-now"');
  });

  it('draws marks and phases when given', () => {
    const html = render({
      marks: [{ id: 'p1', at: m(6), label: '7', tone: 'ok' }],
      marksLabel: 'Merged 1',
      phases: [{ id: 'ph', label: '1 Build', start: m(0), end: m(8) }],
    });
    expect(html).toContain('data-testid="slot-lanes-mark"');
    expect(html).toContain('1 Build');
  });

  it('imports nothing mission-specific, so other surfaces can reuse it', () => {
    const src = readFileSync(join(import.meta.dir, 'SlotLanes.tsx'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(x => x[1]);
    expect(imports.filter(i => !['next/link', 'react', './slot-lanes-layout'].includes(i))).toEqual([]);
  });
});
