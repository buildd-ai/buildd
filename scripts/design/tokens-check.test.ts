import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  compareTokens,
  extractTokens,
  parseTokensFile,
  renderTokensJson,
  TOKENS_PATH,
} from './tokens-check';

const CSS = `
/* a comment with --fake: #000; */
:root { --radius-card: 6px; --font-sans: var(--x), sans-serif; }
:root, [data-theme="dark"] {
  --surface-1: #1a1816;
  --card-border: rgba(255, 245, 230, 0.10); /* trailing */
  --long: 1px
     solid red;
  color-scheme: dark;
}
[data-theme="light"] {
  --surface-1: #f7f5f0;
}
:root, [data-theme] {
  --shared-faint: var(--faint);
  --shared-ok: var(--ok-tint);
}
.card { --not-a-token: 1; }
`;

describe('extractTokens', () => {
  it('reads Night from the dark block and Day from the light block', () => {
    const t = extractTokens(CSS);
    expect(t.night['--surface-1']).toBe('#1a1816');
    expect(t.day['--surface-1']).toBe('#f7f5f0');
  });
  it('applies :root and :root, [data-theme] tokens to both night and day', () => {
    const t = extractTokens(CSS);
    expect(t.night['--radius-card']).toBe('6px');
    expect(t.day['--radius-card']).toBe('6px');
    expect(t.night['--shared-faint']).toBe('var(--faint)');
    expect(t.day['--shared-faint']).toBe('var(--faint)');
    expect(t.night['--shared-ok']).toBe('var(--ok-tint)');
    expect(t.day['--shared-ok']).toBe('var(--ok-tint)');
  });
  it('ignores comments, other rules and non-custom properties', () => {
    const t = extractTokens(CSS);
    expect(t.night['--fake']).toBeUndefined();
    expect(t.night['--not-a-token']).toBeUndefined();
    expect(t.night['color-scheme']).toBeUndefined();
  });
  it('collapses whitespace in values', () => {
    expect(extractTokens(CSS).night['--long']).toBe('1px solid red');
  });
});

describe('renderTokensJson', () => {
  it('is deterministic: sorted keys, same output for same input', () => {
    const a = renderTokensJson(extractTokens(CSS));
    expect(renderTokensJson(extractTokens(CSS))).toBe(a);
    expect(a.endsWith('\n')).toBe(true);
    const keys = Object.keys(JSON.parse(a).night);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('compareTokens', () => {
  const expected = extractTokens(CSS);
  it('names each token whose value differs', () => {
    const other = { night: { '--surface-1': '#000000' }, day: { '--surface-1': '#f7f5f0' } };
    expect(compareTokens(expected, other)).toEqual([
      { theme: 'night', token: '--surface-1', expected: '#1a1816', actual: '#000000' },
    ]);
  });
  it('ignores tokens the other side does not declare', () => {
    expect(compareTokens(expected, { night: {}, day: {} })).toEqual([]);
  });
});

describe('parseTokensFile', () => {
  it('reads a tokens.json shape', () => {
    const t = parseTokensFile('x.json', renderTokensJson(extractTokens(CSS)));
    expect(t.day['--surface-1']).toBe('#f7f5f0');
  });
  it('reads a design HTML file with a style block', () => {
    const t = parseTokensFile('d.html', `<html><style>${CSS}</style></html>`);
    expect(t.night['--surface-1']).toBe('#1a1816');
  });
});

describe('committed tokens.json', () => {
  it('matches globals.css', () => {
    const root = join(import.meta.dir, '..', '..');
    const css = readFileSync(join(root, 'apps/web/src/app/globals.css'), 'utf8');
    const committed = readFileSync(join(root, TOKENS_PATH), 'utf8');
    expect(committed).toBe(renderTokensJson(extractTokens(css)));
  });
});
