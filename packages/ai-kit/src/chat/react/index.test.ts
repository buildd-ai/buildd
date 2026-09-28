import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_CSS_VARS } from './index';
import { greeting, thinkingSteps, tierLabel, toolRowLabel, toolSummary } from './model';

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const theme = strip(readFileSync(join(import.meta.dir, '..', 'theme.css'), 'utf8'));
const styles = strip(readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8'));

describe('theme.css', () => {
  it('defines exactly the --kit-* variables the components read', () => {
    const defined = [...theme.matchAll(/(--kit-[a-z-]+)\s*:/g)].map(m => m[1]).sort();
    expect(defined).toEqual([...KIT_CSS_VARS].sort());
  });
  it('uses no Tailwind directives', () => {
    expect(theme).not.toMatch(/@tailwind|@apply|@import\s+['"]tailwindcss/);
  });
});

describe('styles.css', () => {
  it('reads only the declared --kit-* variables', () => {
    const used = new Set([...styles.matchAll(/var\((--kit-[a-z-]+)/g)].map(m => m[1]));
    expect([...used].filter(v => !(KIT_CSS_VARS as readonly string[]).includes(v))).toEqual([]);
    expect(used.size).toBeGreaterThan(5);
  });
  it('defines no variables of its own and no literal colours: every colour comes from the theme', () => {
    expect(styles).not.toMatch(/--kit-[a-z-]+\s*:/);
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
  it('uses no Tailwind directives', () => {
    expect(styles).not.toMatch(/@tailwind|@apply|@import/);
  });
});

describe('thinkingSteps', () => {
  const step = (id: string, state: string, label = id) => ({ type: 'data-step', id, data: { id, label, state } });
  it('keeps the newest state per id, in first-seen order', () => {
    const parts = [step('a', 'active'), step('b', 'active'), step('a', 'done', 'A done')];
    expect(thinkingSteps(parts, true).map(s => [s.id, s.state, s.label])).toEqual([['a', 'done', 'A done'], ['b', 'active', 'b']]);
  });
  it('at most one active step while streaming; none once done', () => {
    const parts = [step('a', 'active'), step('b', 'active')];
    expect(thinkingSteps(parts, true).map(s => s.state)).toEqual(['done', 'active']);
    expect(thinkingSteps(parts, false).map(s => s.state)).toEqual(['done', 'done']);
  });
  it('adds a tail row while nothing is active or waiting', () => {
    expect(thinkingSteps([], true)).toEqual([{ id: 'kit-tail', label: 'Reading your question', state: 'active' }]);
    expect(thinkingSteps([step('a', 'done')], true).at(-1)!.label).toBe('Thinking it through');
    expect(thinkingSteps([step('a', 'done'), { type: 'text', text: 'So' }], true).at(-1)!.label).toBe('Writing the answer');
    expect(thinkingSteps([step('a', 'pending')], true)).toHaveLength(1);
    expect(thinkingSteps([], false)).toEqual([]);
  });
});

describe('labels', () => {
  it('tier: Auto, Auto · Standard, pinned', () => {
    expect(tierLabel(null, null)).toBe('Auto');
    expect(tierLabel(null, 'standard')).toBe('Auto · Standard');
    expect(tierLabel('premium-plus', 'standard')).toBe('Premium+');
    expect(tierLabel('budget', null, { budget: 'Cheap' })).toBe('Cheap');
  });
  it('greeting', () => {
    expect(greeting('Sam')).toBe('Hi Sam, what are we working on?');
    expect(greeting('  ')).toBe('What are we working on?');
  });
  it('tool rows prefer the step label and the result summary', () => {
    const part = { type: 'tool-search_notes', toolCallId: 'c', state: 'output-available' as const, output: { data: 1, objects: [{}, {}] } };
    expect(toolRowLabel(part, [])).toBe('Search notes');
    expect(toolRowLabel(part, [{ type: 'data-step', data: { id: 'c', label: 'Searched your notes', state: 'done' } }])).toBe('Searched your notes');
    expect(toolSummary(part)).toBe('2 items');
    expect(toolSummary({ ...part, state: 'output-error', errorText: 'boom' })).toBe('boom');
  });
});
