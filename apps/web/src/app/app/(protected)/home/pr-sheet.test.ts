import { describe, expect, it } from 'bun:test';
import { parsePrParam, prSheetSignInHref } from './pr-sheet';

describe('Home PR sheet param', () => {
  it('reads a PR number', () => {
    expect(parsePrParam('42')).toBe(42);
  });

  it('ignores anything that is not one', () => {
    for (const raw of [undefined, '', '0', '-3', '4x', '1.5', ['42']]) expect(parsePrParam(raw as any)).toBeNull();
  });

  it('sends a signed-out reader back to the same sheet, token intact', () => {
    const href = prSheetSignInHref(42, 'a.b+c');
    const back = new URL(href, 'https://x.test').searchParams.get('callbackUrl');
    expect(back).toBe('/app/home?pr=42&t=a.b%2Bc');
    expect(new URL(back!, 'https://x.test').searchParams.get('t')).toBe('a.b+c');
  });
});
