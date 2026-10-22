import { describe, it, expect } from 'bun:test';
import { replacementNamedInClose, replacedNamedInBody, prUrlFor } from './pr-named-replacement';

describe('replacementNamedInClose', () => {
  it('reads "Replaced by #N", any case', () => {
    expect(replacementNamedInClose('Replaced by #42')).toBe(42);
    expect(replacementNamedInClose('closing: replaced BY #7, see there')).toBe(7);
  });

  it('reads "superseded by #N"', () => {
    expect(replacementNamedInClose('Superseded by #301.')).toBe(301);
  });

  it('takes the first match', () => {
    expect(replacementNamedInClose('Replaced by #5. Earlier attempt superseded by #4')).toBe(5);
  });

  it('is null for no text, no match, or a non-positive number', () => {
    expect(replacementNamedInClose(null)).toBeNull();
    expect(replacementNamedInClose(undefined)).toBeNull();
    expect(replacementNamedInClose('')).toBeNull();
    expect(replacementNamedInClose('closing, not needed')).toBeNull();
    expect(replacementNamedInClose('Replaced by #0')).toBeNull();
    expect(replacementNamedInClose('Replaced by 42')).toBeNull();
  });

  it('needs a word boundary before the verb', () => {
    expect(replacementNamedInClose('unreplaced by #42')).toBeNull();
  });
});

describe('replacedNamedInBody', () => {
  it('reads "replaces #N" and "supersedes #N", any case', () => {
    expect(replacedNamedInBody('Replaces #12.\n\nSupersedes #13')).toEqual([12, 13]);
  });

  it('dedupes, keeping first-seen order', () => {
    expect(replacedNamedInBody('replaces #9, also replaces #8 and supersedes #9')).toEqual([9, 8]);
  });

  it('ignores mentions inside fenced code blocks', () => {
    const body = 'Real: replaces #1\n\n```\nreplaces #2\n```\n~~~md\nsupersedes #3\n~~~\nand supersedes #4';
    expect(replacedNamedInBody(body)).toEqual([1, 4]);
  });

  it('needs a word boundary: "misreplaces #3" is not a claim', () => {
    expect(replacedNamedInBody('misreplaces #3')).toEqual([]);
  });

  it('is empty for no text', () => {
    expect(replacedNamedInBody(null)).toEqual([]);
    expect(replacedNamedInBody(undefined)).toEqual([]);
    expect(replacedNamedInBody('nothing here #5')).toEqual([]);
  });
});

describe('prUrlFor', () => {
  it('builds the canonical PR URL', () => {
    expect(prUrlFor('org/repo', 12)).toBe('https://github.com/org/repo/pull/12');
  });
});
