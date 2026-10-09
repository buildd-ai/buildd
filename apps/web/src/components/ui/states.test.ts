import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATES, STATE_KEYS, STATUS_PILL, statusPill } from './states';

const css = readFileSync(join(import.meta.dir, '../../app/globals.css'), 'utf8');

// The strip spec's display states (docs/specs/mission-progress-strip-ordering.md §3.1)
// plus the delivery states it does not carry.
const SPEC_STATES = ['landed', 'review', 'running', 'fixing', 'waiting', 'ci_failed', 'failed', 'ready', 'blocked', 'queued'];
const DELIVERY_STATES = ['landing', 'recovering', 'not_landed', 'needs_you'];

describe('state table', () => {
  it('covers every strip display state plus recovering, not landed and needs you', () => {
    for (const k of [...SPEC_STATES, ...DELIVERY_STATES]) expect(STATE_KEYS).toContain(k as never);
  });

  it('gives every state its own glyph', () => {
    const glyphs = STATE_KEYS.map(k => STATES[k].glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('gives every state its own word', () => {
    const words = STATE_KEYS.map(k => STATES[k].word);
    expect(new Set(words).size).toBe(words.length);
  });

  // Greyscale: hue is dropped, so two cells must differ in fill shape or frame.
  it('gives every state a texture distinguishable without colour', () => {
    const shapes = STATE_KEYS.map(k => `${STATES[k].pattern}/${STATES[k].frame}`);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('flat fills carry their glyph inside the cell', () => {
    for (const k of STATE_KEYS) {
      if (STATES[k].pattern === 'flat') expect(STATES[k].cellGlyph).toBe(true);
    }
  });

  it('every pattern, frame and tone the table uses has a rule in globals.css', () => {
    for (const k of STATE_KEYS) {
      const s = STATES[k];
      expect(css).toContain(`.state-cell[data-pattern="${s.pattern}"]`);
      if (s.frame !== 'none') expect(css).toContain(`.state-cell[data-frame="${s.frame}"]`);
      if (s.tone !== 'q') expect(css).toContain(`.state-cell[data-tone="${s.tone}"]`);
    }
  });

  it('ready, blocked and queued are three textures (ST-3)', () => {
    expect(STATES.ready.pattern).toBe('empty');
    expect(STATES.blocked.pattern).toBe('hatch-dense');
    expect(STATES.queued.pattern).toBe('hatch-sparse');
  });
});

describe('statusPill', () => {
  it('maps every task/worker status onto a state in the table', () => {
    for (const { state } of Object.values(STATUS_PILL)) expect(STATE_KEYS).toContain(state);
  });

  it('keeps the display words, never the raw enum', () => {
    expect(statusPill('in_progress')).toEqual({ state: 'running', label: 'Running' });
    expect(statusPill('waiting_on_you').state).toBe('needs_you');
    expect(statusPill('completed').state).toBe('landed');
  });

  it('falls back to the neutral pill with the status as its word', () => {
    expect(statusPill('mystery')).toEqual({ state: 'ready', label: 'mystery' });
  });
});
