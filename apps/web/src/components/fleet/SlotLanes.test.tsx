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

  it('labels={false} drops the label column so a caller can draw its own rows beside it', () => {
    const html = render({ labels: false });
    expect(html).toContain('grid-template-columns:0px 1fr');
    expect(html).not.toContain('alpha');
    expect(html).toContain('left:calc(0px + (100% - 0px) * 0.5)');
    expect(render()).toContain('alpha');
  });

  it('bare drops the frame; tickLabel replaces the minute ticks', () => {
    expect(render({ bare: true })).not.toContain('shadow-[var(--card-shadow)]');
    const html = render({ tickLabel: (at: number) => `T${(at - m(0)) / 60_000}` });
    expect(html).toContain('>T4<');
    expect(html).not.toContain('>4m<');
  });

  it('drops a bar that ended before the window instead of drawing an empty box at the left edge', () => {
    const early: SlotLane[] = [{
      id: 'alpha', label: 'alpha',
      bars: [
        { id: 'gone', start: m(-120), end: m(-118), tone: 'done', label: 'tick' },
        { id: 'edge', start: m(-5), end: m(4), tone: 'done', label: 'straddles' },
        { id: 'here', start: m(6), end: null, tone: 'live', label: 'api' },
      ],
    }];
    const html = renderToStaticMarkup(<SlotLanes lanes={early} from={m(0)} to={m(20)} now={m(10)} />);
    expect(html).not.toContain('data-bar-id="gone"');
    // A bar that straddles the window start is clipped to it, not dropped.
    expect(html).toMatch(/data-bar-id="edge"[^>]*style="left:0%;width:calc\(20% - 2px\)"/);
    expect(html).toContain('data-bar-id="here"');
    // Slots still come from every bar, so rows line up with a caller's own slot rows.
    expect(count(html, 'data-testid="slot-lane-row"')).toBe(1);
  });

  it('a live bar that just started puts its label left of it, never out into the future hatch past NOW', () => {
    const fresh: SlotLane[] = [{
      id: 'alpha', label: 'alpha',
      bars: [
        { id: 'old', start: m(0), end: m(4), tone: 'done', label: 'schema' },
        { id: 'new', start: m(10), end: null, tone: 'live', scope: 'checkout', label: 'CI fix' },
      ],
    }];
    const html = renderToStaticMarkup(<SlotLanes lanes={fresh} from={m(0)} to={m(20)} now={m(10)} />);
    const outside = html.match(/<span class="pointer-events-none absolute[^"]*" style="([^"]*)"[^>]*>(?:(?!<\/span><\/span>).)*checkout/)?.[1] ?? '';
    expect(outside).not.toBe('');
    // Anchored by its right edge at the bar's start, capped to the gap since the previous bar.
    expect(outside).toContain('right:calc(50% + 8px)');
    expect(outside).toContain('max-width:calc(30% - 16px)');
    expect(outside).not.toContain('left:');
  });

  it('with no room before it, a short live bar keeps its label inside rather than spilling past NOW', () => {
    const packed: SlotLane[] = [{
      id: 'alpha', label: 'alpha',
      bars: [
        { id: 'old', start: m(0), end: m(10), tone: 'done', label: 'schema' },
        { id: 'new', start: m(10), end: null, tone: 'live', scope: 'checkout', label: 'CI fix' },
      ],
    }];
    const html = renderToStaticMarkup(<SlotLanes lanes={packed} from={m(0)} to={m(20)} now={m(10)} />);
    expect(html).not.toContain('pointer-events-none absolute top-[9px] flex h-8');
    expect(html).toMatch(/data-bar-id="new"[^>]*>(?:(?!<\/a>|<\/span><\/span>).)*CI fix/);
  });

  it('imports nothing mission-specific, so other surfaces can reuse it', () => {
    const src = readFileSync(join(import.meta.dir, 'SlotLanes.tsx'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(x => x[1]);
    expect(imports.filter(i => !['next/link', 'react', './slot-lanes-layout'].includes(i))).toEqual([]);
  });
});
