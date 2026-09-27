import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Kbd, KeyHintsOnly, KeyHintsProvider, keyHintsFromQuery } from './KeyHints';

const html = (on: boolean | null, node: React.ReactNode) =>
  renderToStaticMarkup(on === null ? <>{node}</> : <KeyHintsProvider value={on}>{node}</KeyHintsProvider>);

describe('Kbd', () => {
  it('is hidden by default: no provider, or the preference off', () => {
    expect(html(null, <Kbd>1</Kbd>)).toBe('');
    expect(html(false, <Kbd>Esc</Kbd>)).toBe('');
  });

  it('renders a keycap when the person turned hints on', () => {
    const out = html(true, <Kbd>Esc</Kbd>);
    expect(out).toContain('<kbd');
    expect(out).toContain('data-testid="key-hint"');
    expect(out).toContain('Esc');
  });
});

describe('KeyHintsOnly', () => {
  it('shows its children only with hints on', () => {
    expect(html(false, <KeyHintsOnly>Press 1 or 2 to answer</KeyHintsOnly>)).toBe('');
    expect(html(true, <KeyHintsOnly>Press 1 or 2 to answer</KeyHintsOnly>)).toBe('Press 1 or 2 to answer');
  });
});

describe('keyHintsFromQuery', () => {
  it('reads ?hints=1 for the fixtures pages, off otherwise', () => {
    expect(keyHintsFromQuery(new URLSearchParams('hints=1'))).toBe(true);
    expect(keyHintsFromQuery(new URLSearchParams('hints=on'))).toBe(true);
    expect(keyHintsFromQuery(new URLSearchParams('hints=0'))).toBe(false);
    expect(keyHintsFromQuery(new URLSearchParams(''))).toBe(false);
    expect(keyHintsFromQuery(null)).toBe(false);
  });
});
