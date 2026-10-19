import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Lifecycle from './Lifecycle';

const current = (html: string) => html.match(/<span data-step="(\w+)" aria-current="step"[^>]*>([^<]*)/)?.slice(1) ?? [];

describe('Lifecycle', () => {
  it('Build → Verify → Deliver with the current step marked', () => {
    const html = renderToStaticMarkup(<Lifecycle state="review" />);
    expect(html).toContain('✓ Build');
    expect(current(html)).toEqual(['Verify', '◐ Verify']);
    expect(html).toMatch(/data-step="Deliver" class="text-text-muted">Deliver</);
  });

  it('building sits on Build', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="running" />))[0]).toBe('Build');
  });

  it('repair carries the repair count on Verify', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="fixing" repairs={2} />))).toEqual(['Verify', '↻ Verify · repair 2']);
  });

  it('recovering reads paused, needs you reads needs you', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="recovering" />))[1]).toBe('⊘ Verify paused');
    expect(current(renderToStaticMarkup(<Lifecycle state="needs_you" />))[1]).toBe('! Verify · waiting on you');
  });

  it('landing sits on Deliver; landed ticks all three', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="landing" />))).toEqual(['Deliver', '▲ Deliver']);
    const landed = renderToStaticMarkup(<Lifecycle state="landed" />);
    expect(landed.match(/✓/g)).toHaveLength(3);
    expect(landed).not.toContain('aria-current');
  });

  it('a closed PR reads closed without merging on Deliver', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="not_landed" />))[1]).toBe('✕ Deliver · closed without merging');
  });

  it('a waiting task has no current step', () => {
    expect(renderToStaticMarkup(<Lifecycle state="queued" />)).not.toContain('aria-current');
  });
});

describe('Lifecycle: delivery adapters', () => {
  it('a review with past repair rounds keeps its round count on Verify', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="review" repairs={2} />))[1]).toBe('◐ Verify ↻2');
    expect(current(renderToStaticMarkup(<Lifecycle state="review" repairs={0} />))[1]).toBe('◐ Verify');
  });

  it('notes give each step its own phrase, current step marked', () => {
    const html = renderToStaticMarkup(<Lifecycle state="fixing" repairs={2} notes={['PR #4 opened', 'Repair 2 · CI failed', 'Not yet']} />);
    const steps = [...html.matchAll(/data-testid="lifecycle-step" data-stage="(\w+)" data-state="(\w+)"/g)].map(m => [m[1], m[2]]);
    expect(steps).toEqual([['build', 'done'], ['verify', 'current'], ['deliver', 'later']]);
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
    expect(current(renderToStaticMarkup(<Lifecycle state="needs_you" repairs={2} />))[1]).toBe('! Verify · waiting on you ↻2');
    expect(current(renderToStaticMarkup(<Lifecycle state="recovering" repairs={1} />))[1]).toBe('⊘ Verify paused ↻1');
  });
});

describe('Lifecycle: phrase (docs/specs/task-page.md, State mapping)', () => {
  it('a phrase replaces the state variant on the current step', () => {
    expect(current(renderToStaticMarkup(<Lifecycle state="review" phrase="updating branch" />))[1]).toBe('◐ Verify · updating branch');
    expect(current(renderToStaticMarkup(<Lifecycle state="landing" phrase="awaiting merge" />))[1]).toBe('▲ Deliver · awaiting merge');
  });

  it('a phrase never turns a non-repair into "repair N"', () => {
    const html = renderToStaticMarkup(<Lifecycle state="review" phrase="in review" repairs={0} />);
    expect(html).not.toContain('repair');
  });

  it('done steps stay ticked with a phrase on the current one', () => {
    const html = renderToStaticMarkup(<Lifecycle state="landing" phrase="awaiting merge" />);
    expect(html).toContain('✓ Build');
    expect(html).toContain('✓ Verify');
  });
});
