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
