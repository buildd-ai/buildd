/**
 * MissionPulse: the one progress object carried from card to header to sheet
 * (docs/design/mission-feed-mobile-continuity.md, "The shared object").
 *
 * Segments always come from `buildPulseSegments` — no test hand-builds a pulse
 * order, so a renderer that re-sorted would fail here. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildPulseSegments, type MissionFeedTaskInput, type PulseSegment } from '@/lib/mission-pulse';
import MissionPulse, {
  PULSE_VARIANT,
  createPulseScrub,
  pulseLayout,
  segmentAt,
} from './MissionPulse';

let clock = Date.UTC(2026, 0, 1);
function t(id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput {
  clock += 60_000;
  return { id, title: `Task ${id}`, status: 'pending', taskClass: 'work', createdAt: new Date(clock), ...over };
}
const phase = (index: number, label: string) => ({ missionPhaseIndex: index, missionPhaseLabel: label });

const tasks = [
  t('a', { ...phase(0, 'THINK'), status: 'completed' }),
  t('b', { ...phase(0, 'THINK'), status: 'completed' }),
  t('c', { ...phase(1, 'BUILD'), status: 'in_progress', worker: { status: 'running' } }),
  t('d', { ...phase(1, 'BUILD'), status: 'in_progress', worker: { status: 'waiting_input' } }),
  t('e', { ...phase(1, 'BUILD'), status: 'failed' }),
  // A retry is queued, so the failure is the platform's to fix: failed, not NEEDS YOU.
  t('e-retry', { ...phase(1, 'BUILD'), taskClass: 'attempt', parentTaskId: 'e', status: 'pending' }),
  t('f', { ...phase(2, 'CHECK') }),
];
const segments = buildPulseSegments(tasks);

const ids = (html: string) => [...html.matchAll(/data-testid="mission-pulse-segment"[^>]*data-task-id="([^"]+)"/g)].map(m => m[1]);
const attrOf = (html: string, taskId: string, attr: string) => {
  const tag = html.match(new RegExp(`<[^>]*data-testid="mission-pulse-segment"[^>]*data-task-id="${taskId}"[^>]*>`))?.[0] ?? '';
  return tag.match(new RegExp(`${attr}="([^"]*)"`))?.[1] ?? null;
};

describe('MissionPulse render', () => {
  it('renders one segment per builder segment, in builder order, with data-state', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="card" />);
    expect(html).toContain('data-testid="mission-pulse"');
    expect(ids(html)).toEqual(segments.map(s => s.taskId));
    expect(attrOf(html, 'a', 'data-state')).toBe('done');
    expect(attrOf(html, 'c', 'data-state')).toBe('moving');
    expect(attrOf(html, 'd', 'data-state')).toBe('needs_you');
    expect(attrOf(html, 'e', 'data-state')).toBe('failed');
    expect(attrOf(html, 'f', 'data-state')).toBe('queued');
  });

  it('renders the same order in card, header and context variants (AC-4)', () => {
    const orders = (['card', 'header', 'context'] as const).map(v =>
      ids(renderToStaticMarkup(<MissionPulse segments={segments} variant={v} />)),
    );
    expect(orders[0]).toEqual(orders[1]);
    expect(orders[1]).toEqual(orders[2]);
  });

  it('marks phase boundaries with a gap, and only there', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="card" />);
    expect(attrOf(html, 'a', 'data-gap-before')).toBe('false');
    expect(attrOf(html, 'b', 'data-gap-before')).toBe('false');
    expect(attrOf(html, 'c', 'data-gap-before')).toBe('true');
    expect(attrOf(html, 'f', 'data-gap-before')).toBe('true');
  });

  it('maps state to design tokens only — no raw colours', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="header" />);
    // moving is the accent (work in flight is the product's one colour);
    // needs-you is the warning tone, so the two never read as the same thing.
    expect(html).toContain('bg-accent');
    expect(html).toContain('bg-status-warning');
    expect(html).not.toContain('bg-status-info');
    expect(html).toContain('bg-status-success');
    expect(html).toContain('bg-status-error');
    expect(html).toContain('bg-border-default');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('gives the moving (ghost) segment a pulsing trailing edge that respects reduced motion', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="card" />);
    expect(html).toContain('data-testid="mission-pulse-ghost"');
    expect(html).toContain('motion-reduce:animate-none');
  });

  it('renders selectable segments as buttons with one tab stop', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="header" selectedTaskId="c" onSegmentSelect={() => {}} />);
    expect(html.match(/<button[^>]*data-testid="mission-pulse-segment"/g)).toHaveLength(segments.length);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(attrOf(html, 'c', 'tabindex')).toBe('0');
  });

  it('an inert pulse has no buttons', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="card" />);
    expect(html).not.toContain('<button');
  });

  it('sets aria-current on the selected segment only', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="header" selectedTaskId="c" />);
    expect(attrOf(html, 'c', 'aria-current')).toBe('true');
    expect(attrOf(html, 'a', 'aria-current')).toBeNull();
  });

  it('underlines segments whose rows are in view', () => {
    const html = renderToStaticMarkup(
      <MissionPulse segments={segments} variant="header" inViewTaskIds={new Set(['b', 'c'])} />,
    );
    expect(attrOf(html, 'b', 'data-in-view')).toBe('true');
    expect(attrOf(html, 'c', 'data-in-view')).toBe('true');
    expect(attrOf(html, 'a', 'data-in-view')).toBe('false');
  });

  it('header variant: 12px visual inside a 40px touch band that lets vertical scroll through', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="header" onSegmentSelect={() => {}} />);
    expect(html).toContain(PULSE_VARIANT.header.band);
    expect(html).toContain(PULSE_VARIANT.header.bar);
    expect(PULSE_VARIANT.header.band).toContain('h-10');
    expect(PULSE_VARIANT.header.bar).toContain('h-3');
    expect(html).toContain('touch-action:pan-y');
  });

  it('card and context variants are 8px with no touch band', () => {
    for (const v of ['card', 'context'] as const) {
      const html = renderToStaticMarkup(<MissionPulse segments={segments} variant={v} onSegmentSelect={() => {}} />);
      expect(PULSE_VARIANT[v].bar).toContain('h-2');
      expect(PULSE_VARIANT[v].band).toBe('');
      expect(html).not.toContain('touch-action');
    }
  });

  it('context variant rings the selected task', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="context" selectedTaskId="d" />);
    expect(attrOf(html, 'd', 'data-ringed')).toBe('true');
    expect(attrOf(html, 'a', 'data-ringed')).toBe('false');
  });

  it('above 40 work tasks renders one segment per phase, filled by done fraction', () => {
    const many: MissionFeedTaskInput[] = [];
    for (let i = 0; i < 30; i++) many.push(t(`p0-${i}`, { ...phase(0, 'THINK'), status: 'completed' }));
    for (let i = 0; i < 12; i++) many.push(t(`p1-${i}`, { ...phase(1, 'BUILD'), status: i < 3 ? 'completed' : 'pending' }));
    const segs = buildPulseSegments(many);
    const html = renderToStaticMarkup(<MissionPulse segments={segs} variant="header" />);
    expect(ids(html)).toHaveLength(2);
    expect(attrOf(html, 'p1-0', 'data-kind')).toBe('phase');
    expect(html).toContain('width:25%');
  });

  it('folded phase segments label, select, ring and underline by any member task, not just the first', () => {
    const many: MissionFeedTaskInput[] = [];
    for (let i = 0; i < 30; i++) many.push(t(`q0-${i}`, { ...phase(0, 'THINK'), status: 'completed' }));
    for (let i = 0; i < 12; i++) many.push(t(`q1-${i}`, { ...phase(1, 'BUILD') }));
    const segs = buildPulseSegments(many);
    const labels = Object.fromEntries(many.map(x => [x.id, `Title ${x.id}`]));
    const header = renderToStaticMarkup(
      <MissionPulse
        segments={segs}
        variant="header"
        selectedTaskId="q1-5"
        inViewTaskIds={new Set(['q1-5'])}
        segmentLabels={labels}
        onSegmentSelect={() => {}}
      />,
    );
    expect(attrOf(header, 'q1-0', 'aria-label')).toBe('BUILD · queued');
    expect(header).not.toContain('Title q1-0');
    expect(attrOf(header, 'q1-0', 'aria-current')).toBe('true');
    expect(attrOf(header, 'q0-0', 'aria-current')).toBeNull();
    expect(attrOf(header, 'q1-0', 'data-in-view')).toBe('true');
    expect(attrOf(header, 'q0-0', 'data-in-view')).toBe('false');
    expect(attrOf(header, 'q1-0', 'tabindex')).toBe('0');

    const ctx = renderToStaticMarkup(<MissionPulse segments={segs} variant="context" selectedTaskId="q1-5" />);
    expect(attrOf(ctx, 'q1-0', 'data-ringed')).toBe('true');
    expect(attrOf(ctx, 'q0-0', 'data-ringed')).toBe('false');
  });

  it('renders nothing for an empty pulse', () => {
    expect(renderToStaticMarkup(<MissionPulse segments={[]} variant="card" />)).toBe('');
  });

  it('labels itself for assistive tech with done / total', () => {
    const html = renderToStaticMarkup(<MissionPulse segments={segments} variant="card" />);
    expect(html).toContain('aria-label="Mission progress: 2 of 6 done"');
  });
});

// ─── Geometry and scrub (pure) ───────────────────────────────────────────────

const seg = (taskId: string, gapBefore = false): PulseSegment => ({
  kind: 'task', taskId, state: 'queued', phaseIndex: null, phaseLabel: null, gapBefore, fill: 1,
});

describe('pulseLayout / segmentAt', () => {
  it('splits the width evenly after subtracting 2px phase gaps', () => {
    const layout = pulseLayout([seg('a'), seg('b'), seg('c', true)], 102);
    // 102 - 2 (one gap) = 100 → 33.33 each
    expect(layout[0].start).toBeCloseTo(0);
    expect(layout[0].end).toBeCloseTo(33.333, 2);
    expect(layout[2].start).toBeCloseTo(68.667, 2);
    expect(layout[2].end).toBeCloseTo(102);
  });

  it('resolves x to the segment under it, snapping gaps and overshoot to the nearest', () => {
    const segs = [seg('a'), seg('b'), seg('c', true)];
    const layout = pulseLayout(segs, 102);
    expect(segmentAt(10, layout)).toBe(0);
    expect(segmentAt(50, layout)).toBe(1);
    expect(segmentAt(67.5, layout)).toBe(1); // inside the gap, nearer b's edge
    expect(segmentAt(90, layout)).toBe(2);
    expect(segmentAt(-20, layout)).toBe(0);
    expect(segmentAt(500, layout)).toBe(2);
  });
});

describe('createPulseScrub', () => {
  function setup() {
    const previews: Array<string | null> = [];
    const selects: string[] = [];
    let now = 1_000;
    const scrub = createPulseScrub({
      onPreview: id => previews.push(id),
      onSelect: id => selects.push(id),
      now: () => now,
    });
    const segs = [seg('a'), seg('b'), seg('c')];
    return { scrub, segs, previews, selects, advance: (ms: number) => { now += ms; } };
  }

  it('previews on press, follows the finger, and selects on release', () => {
    const { scrub, segs, previews, selects } = setup();
    scrub.down(5, 90, segs);
    scrub.move(45, 90, segs);
    scrub.move(46, 90, segs); // same segment: no duplicate preview
    scrub.up(80, 90, segs);
    expect(previews).toEqual(['a', 'b', 'c', null]);
    expect(selects).toEqual(['c']);
  });

  it('cancel clears the preview and selects nothing (a vertical page scroll took over)', () => {
    const { scrub, segs, previews, selects } = setup();
    scrub.down(5, 90, segs);
    scrub.cancel();
    expect(previews).toEqual(['a', null]);
    expect(selects).toEqual([]);
  });

  it('ignores moves when no press is active', () => {
    const { scrub, segs, previews } = setup();
    scrub.move(45, 90, segs);
    expect(previews).toEqual([]);
  });

  it('swallows the click that follows a handled release, but not a keyboard click later', () => {
    const { scrub, segs, selects, advance } = setup();
    scrub.down(5, 90, segs);
    scrub.up(5, 90, segs);
    scrub.click('a');
    expect(selects).toEqual(['a']);
    advance(1_000);
    scrub.click('b');
    expect(selects).toEqual(['a', 'b']);
  });
});
