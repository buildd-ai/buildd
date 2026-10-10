import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Lifecycle from './Lifecycle';

const current = (html: string) => html.match(/<span data-step="(\w+)" aria-current="step"[^>]*>([^<]*)/)?.slice(1) ?? [];

describe('Lifecycle', () => {
  it('Build → Audit → Land with the current step marked', () => {
    const html = renderToStaticMarkup(<Lifecycle state="review" />);
    expect(html).toContain('✓ Build');
    expect(current(html)).toEqual(['Audit', '◐ Audit']);
    expect(html).toMatch(/data-step="Land" class="text-text-muted">Land</);
  });

  it('building sits on Build', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="running" />))[0]).toBe('Build');
  });

  it('repair carries the repair count on Audit', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="fixing" repairs={2} />))).toEqual(['Audit', '↻ Audit · repair 2']);
  });

  it('recovering reads paused, needs you reads needs you', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="recovering" />))[1]).toBe('⊘ Audit paused');
    expect(current(renderToStaticMarkup(<Lifecycle state="needs_you" />))[1]).toBe('! Audit · needs you');
  });

  it('landing sits on Land; landed ticks all three', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="landing" />))).toEqual(['Land', '▲ Land']);
    const landed = renderToStaticMarkup(<Lifecycle state="landed" />);
    expect(landed.match(/✓/g)).toHaveLength(3);
    expect(landed).not.toContain('aria-current');
  });

  it('a held task has no current step', () => {
    expect(renderToStaticMarkup(<Lifecycle state="queued" />)).not.toContain('aria-current');
  });
});

describe('Lifecycle: delivery adapters', () => {
  it('a review with past repair rounds keeps its round count on Audit', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="review" repairs={2} />))[1]).toBe('◐ Audit ↻2');
    expect(current(renderToStaticMarkup(<Lifecycle state="review" repairs={0} />))[1]).toBe('◐ Audit');
  });

  it('notes give each step its own phrase, current step marked', () => {
    const html = renderToStaticMarkup(<Lifecycle state="fixing" repairs={2} notes={['PR #4 opened', 'Repair 2 · CI failed', 'Not yet']} />);
    const steps = [...html.matchAll(/data-testid="lifecycle-step" data-stage="(\w+)" data-state="(\w+)"/g)].map(m => [m[1], m[2]]);
    expect(steps).toEqual([['build', 'done'], ['audit', 'current'], ['land', 'later']]);
    expect(html).toContain('PR #4 opened');
    expect(html).toContain('Repair 2 · CI failed');
  });

  it('without notes there are no step cells (the one-line track)', () => {
    expect(renderToStaticMarkup(<Lifecycle state="review" />)).not.toContain('lifecycle-step');
  });
});

describe('Lifecycle: inline', () => {
  it('is phrasing content (spans only), so it can sit inside a link or a button row', () => {
    const html = renderToStaticMarkup(<Lifecycle state="fixing" repairs={1} notes={['a', 'b', 'c']} />);
    expect(html).not.toMatch(/<div/);
  });

  it('an audit-step exception keeps the rounds already taken', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="needs_you" repairs={2} />))[1]).toBe('! Audit · needs you ↻2');
    expect(current(renderToStaticMarkup(<Lifecycle state="recovering" repairs={1} />))[1]).toBe('⊘ Audit paused ↻1');
  });
});
