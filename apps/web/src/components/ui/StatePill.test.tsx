import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import StatePill, { StatusPill, TonePill } from './StatePill';
import { STATES, STATE_KEYS } from './states';

const classes = (html: string) => html.match(/^<span class="([^"]*)"/)?.[1].split(/\s+/) ?? [];

describe('StatePill', () => {
  it('renders glyph + word for every state', () => {
    for (const k of STATE_KEYS) {
      const html = renderToStaticMarkup(<StatePill state={k} />);
      expect(html).toContain(STATES[k].glyph);
      expect(html).toContain(STATES[k].word);
      expect(html).toContain(`data-state="${k}"`);
    }
  });

  it('tinted sits on the tone tint with the pill radius; plain has no fill', () => {
    const tinted = classes(renderToStaticMarkup(<StatePill state="review" />));
    expect(tinted).toContain('bg-[var(--run-tint)]');
    expect(tinted).toContain('rounded-[var(--radius-pill)]');
    const plain = classes(renderToStaticMarkup(<StatePill state="review" variant="plain" />));
    expect(plain.some(c => c.startsWith('bg-'))).toBe(false);
    expect(plain).toContain('text-status-info');
  });

  it('a label replaces the word, the glyph stays', () => {
    const html = renderToStaticMarkup(<StatePill state="review" label="Auditing · 2 of 7 merged" />);
    expect(html).toContain('◐');
    expect(html).toContain('2 of 7 merged');
  });

  // In a squeezed flex row (Worker History on a phone) a badge wrapped onto two lines.
  it('never wraps or shrinks inside a flex row', () => {
    const cls = classes(renderToStaticMarkup(<StatePill state="needs_you" />));
    expect(cls).toContain('whitespace-nowrap');
    expect(cls).toContain('shrink-0');
  });
});

// Regression (task page Related tasks): an attempt's badge read the raw DB value.
describe('StatusPill', () => {
  it('reads an in-progress task as Running, never the raw enum', () => {
    const html = renderToStaticMarkup(<StatusPill status="in_progress" />);
    expect(html).toContain('Running');
    expect(html).toContain(STATES.running.glyph);
    expect(html).not.toContain('in_progress');
  });

  it('a person-blocking status reads as Needs you in the decision tone', () => {
    expect(renderToStaticMarkup(<StatusPill status="waiting_input" />)).toContain('data-tone="dec"');
  });
});

describe('TonePill', () => {
  it('is the same pill shape without a glyph', () => {
    const html = renderToStaticMarkup(<TonePill tone="dec">Needs a decision</TonePill>);
    expect(classes(html)).toContain('rounded-[var(--radius-pill)]');
    expect(html).toContain('Needs a decision');
  });
});
