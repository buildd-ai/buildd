import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskStrip, { type TaskStripCell } from './TaskStrip';
import { STATES, type StateKey } from './states';

const cells: TaskStripCell[] = (['landed', 'landed', 'review', 'running', 'blocked', 'queued', 'queued'] as StateKey[])
  .map((state, i) => ({ id: `t${i + 1}`, state, title: `Task ${i + 1}` }));

function cellTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}
/** Each cell's fill span, opening tag through its content. */
function fills(html: string): string[] {
  return html.match(/<span[^>]*data-testid="task-strip-fill"[^>]*>[^<]*<\/span>/g) ?? [];
}
function ticks(html: string): string[] {
  const row = html.slice(html.indexOf('data-testid="task-strip-ticks"'));
  return row.match(/<span[^>]*>[^<]*<\/span>/g) ?? [];
}

describe('TaskStrip lg', () => {
  it('one button per task, textured by state', () => {
    const html = renderToStaticMarkup(<TaskStrip cells={cells} selectedId="t3" />);
    const tags = cellTags(html);
    expect(tags).toHaveLength(7);
    expect(tags[2]).toContain(`data-pattern="${STATES.review.pattern}"`);
    expect(tags[2]).toContain('aria-pressed="true"');
    expect(tags[2]).toContain('aria-label="03 Auditing: Task 3"');
  });

  it('marks live on the tick row only; a marked cell renders exactly as unmarked (MK-4)', () => {
    const plain = renderToStaticMarkup(<TaskStrip cells={cells} selectedId="t4" />);
    const marked = renderToStaticMarkup(<TaskStrip cells={cells} selectedId="t4" marks={{ t5: 'direct', t6: 'transitive' }} />);
    expect(cellTags(marked)).toEqual(cellTags(plain));
    const row = ticks(marked);
    expect(row[4]).toContain('data-mark="direct"');
    expect(row[5]).toContain('data-mark="transitive"');
    expect(row[6]).not.toContain('data-mark');
  });

  it('direct and transitive differ in shape, not only colour (MK-2)', () => {
    const row = ticks(renderToStaticMarkup(<TaskStrip cells={cells} selectedId="t4" marks={new Map([['t5', 'direct'], ['t6', 'transitive']])} />));
    expect(row[4]).toContain('bg-accent');
    expect(row[5]).toContain('border-b-2');
    expect(row[5]).not.toContain('bg-accent');
  });

  it('the selected tick is never marked and keeps its number (MK-3)', () => {
    const row = ticks(renderToStaticMarkup(<TaskStrip cells={cells} selectedId="t4" marks={{ t4: 'direct' }} />));
    expect(row[3]).not.toContain('data-mark');
    expect(row[3]).toContain('>04<');
  });

  it('caps cells at 56px on desktop unless told not to', () => {
    expect(renderToStaticMarkup(<TaskStrip cells={cells} />)).toContain('md:[grid-template-columns:repeat(var(--n),minmax(0,56px))]');
    expect(renderToStaticMarkup(<TaskStrip cells={cells} capped={false} />)).not.toContain('56px');
  });

  it('flat-fill states draw their glyph inside the cell', () => {
    const html = renderToStaticMarkup(<TaskStrip cells={[{ id: 'a', state: 'needs_you' }, { id: 'b', state: 'landed' }]} />);
    const [needs, landed] = fills(html);
    expect(needs).toMatch(/>!<\/span>$/);
    expect(landed).toMatch(/><\/span>$/);
  });

  it('below md a cell is a slim bar in a 44px target, never a tall framed column', () => {
    const html = renderToStaticMarkup(<TaskStrip cells={cells} selectedId="t5" />);
    for (const tag of cellTags(html)) {
      expect(tag).toContain('h-11');
      expect(tag).toContain('md:h-16');
      expect(tag).not.toContain('outline');
    }
    for (const f of fills(html)) {
      expect(f).toContain('state-cell');
      expect(f).toContain(' h-4 ');
      expect(f).toContain('md:h-full');
    }
  });

  it('the selection is a separate marker below md and a ring from md, on the selected cell only', () => {
    const html = renderToStaticMarkup(<TaskStrip cells={cells} selectedId="t5" />);
    const markers = html.match(/<span[^>]*data-testid="task-strip-marker"[^>]*>/g) ?? [];
    expect(markers).toHaveLength(7);
    expect(markers.filter(m => m.includes('bg-text-primary'))).toHaveLength(1);
    expect(markers[4]).toContain('bg-text-primary');
    const rings = fills(html).filter(f => f.includes('md:[outline:2px_solid_var(--text-primary)]'));
    expect(rings).toHaveLength(1);
    expect(fills(html)[4]).toContain('md:[outline');
  });

  it('past 12 cells unmarked ticks go quiet and marks become bars', () => {
    const many: TaskStripCell[] = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, state: 'queued' as StateKey }));
    const row = ticks(renderToStaticMarkup(<TaskStrip cells={many} selectedId="c13" marks={{ c0: 'direct', c1: 'transitive' }} />));
    expect(row[0]).toContain('h-1.5');
    expect(row[1]).toContain('h-0.5');
    expect(row[2]).toMatch(/><\/span>$/);
    expect(row[13]).toContain('>14<');
  });
});

describe('TaskStrip sm', () => {
  it('is an image, not a toolbar, with one segment per task up to 16', () => {
    const html = renderToStaticMarkup(<TaskStrip size="sm" cells={cells} />);
    expect(html).toContain('role="img"');
    expect(html).not.toContain('<button');
    expect(html.match(/class="state-cell/g)).toHaveLength(7);
  });

  it('above 16 tasks, settled runs collapse into one segment sized by count', () => {
    const states: StateKey[] = [...Array(12).fill('landed'), 'running', 'running', ...Array(5).fill('queued')];
    const html = renderToStaticMarkup(<TaskStrip size="sm" cells={states.map((state, i) => ({ id: String(i), state }))} />);
    expect(html.match(/class="state-cell/g)).toHaveLength(4);
    expect(html).toContain('grid-template-columns:12fr minmax(6px,1fr) minmax(6px,1fr) 5fr');
    expect(html).toContain('12 merged');
  });
});
