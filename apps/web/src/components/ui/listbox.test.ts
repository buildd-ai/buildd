import { describe, expect, it } from 'bun:test';
import { edgeIndex, fuzzyFilter, fuzzyScore, isTypeaheadKey, moveHighlight, typeaheadIndex } from './listbox';

const opts = (labels: string[], disabled: number[] = []) =>
  labels.map((label, i) => ({ label, disabled: disabled.includes(i) }));

describe('moveHighlight', () => {
  it('steps and wraps', () => {
    const o = opts(['a', 'b', 'c']);
    expect(moveHighlight(o, 0, 1)).toBe(1);
    expect(moveHighlight(o, 2, 1)).toBe(0);
    expect(moveHighlight(o, 0, -1)).toBe(2);
  });

  it('skips disabled options', () => {
    const o = opts(['a', 'b', 'c', 'd'], [1, 2]);
    expect(moveHighlight(o, 0, 1)).toBe(3);
    expect(moveHighlight(o, 3, -1)).toBe(0);
  });

  it('stops at the edge without wrap (PageDown)', () => {
    const o = opts(['a', 'b', 'c']);
    expect(moveHighlight(o, 1, 10, false)).toBe(2);
    expect(moveHighlight(o, 1, -10, false)).toBe(0);
  });

  it('opens on the first enabled option from -1', () => {
    expect(moveHighlight(opts(['a', 'b'], [0]), -1, 1)).toBe(1);
  });

  it('returns -1 when nothing is enabled', () => {
    expect(moveHighlight(opts(['a', 'b'], [0, 1]), -1, 1)).toBe(-1);
    expect(moveHighlight([], 0, 1)).toBe(-1);
  });
});

describe('edgeIndex', () => {
  it('finds the first and last enabled', () => {
    const o = opts(['a', 'b', 'c', 'd'], [0, 3]);
    expect(edgeIndex(o, 'first')).toBe(1);
    expect(edgeIndex(o, 'last')).toBe(2);
  });
});

describe('typeaheadIndex', () => {
  const o = opts(['Apple', 'Banana', 'Blueberry', 'Cherry', 'Citrus'], []);

  it('jumps to the next label starting with the key', () => {
    expect(typeaheadIndex(o, 0, 'b')).toBe(1);
    expect(typeaheadIndex(o, 1, 'b')).toBe(2);
  });

  it('cycles with a repeated key, like a native select', () => {
    expect(typeaheadIndex(o, 2, 'bb')).toBe(1);
  });

  it('keeps the current option while a longer prefix still matches it', () => {
    expect(typeaheadIndex(o, 3, 'ch')).toBe(3);
    expect(typeaheadIndex(o, 3, 'ci')).toBe(4);
  });

  it('skips disabled options and returns -1 on no match', () => {
    expect(typeaheadIndex(opts(['Ant', 'Axe'], [1]), 0, 'a')).toBe(0);
    expect(typeaheadIndex(o, 0, 'z')).toBe(-1);
  });
});

describe('fuzzyScore', () => {
  it('matches an in-order subsequence per token', () => {
    expect(fuzzyScore('son5', 'claude-sonnet-5')).not.toBeNull();
    expect(fuzzyScore('ds v3', 'deepseek/deepseek-v3')).not.toBeNull();
    expect(fuzzyScore('5son', 'claude-sonnet-5')).toBeNull();
  });

  it('ranks a contiguous word-start hit above a scattered one', () => {
    const a = fuzzyScore('opus', 'claude-opus-5')!;
    const b = fuzzyScore('opus', 'o-p-u-s')!;
    expect(a).toBeGreaterThan(b);
  });

  it('empty query matches everything', () => {
    expect(fuzzyScore('  ', 'x')).toBe(0);
  });
});

describe('fuzzyFilter', () => {
  it('filters, ranks, and keeps input order on ties', () => {
    const items = ['google/gemini-3-pro', 'anthropic/claude-sonnet-5', 'anthropic/claude-opus-5'];
    expect(fuzzyFilter(items, 'claude', (s) => s)).toEqual([
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-5',
    ]);
    expect(fuzzyFilter(items, '', (s) => s)).toEqual(items);
  });
});

describe('isTypeaheadKey', () => {
  it('accepts one printable character without modifiers', () => {
    expect(isTypeaheadKey({ key: 'a' })).toBe(true);
    expect(isTypeaheadKey({ key: ' ' })).toBe(false);
    expect(isTypeaheadKey({ key: 'ArrowDown' })).toBe(false);
    expect(isTypeaheadKey({ key: 'a', metaKey: true })).toBe(false);
  });
});
