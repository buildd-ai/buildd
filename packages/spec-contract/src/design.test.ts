import { describe, expect, it } from 'bun:test';
import { designDrift, parseDesignRef, sameDesign } from './design';
import { criterionScreens } from './check-lines';

describe('parseDesignRef', () => {
  it('takes an artifact with or without a revision, and screens', () => {
    expect(parseDesignRef({ kind: 'artifact', ref: 'a1' })).toEqual({ ok: true, design: { kind: 'artifact', ref: 'a1' } });
    expect(parseDesignRef({ kind: 'artifact', ref: 'a1', version: 3, screens: [{ id: 'cart-empty', name: 'Empty cart' }, { id: '/cart#full' }] }))
      .toEqual({ ok: true, design: { kind: 'artifact', ref: 'a1', version: '3', screens: [{ id: 'cart-empty', name: 'Empty cart' }, { id: '/cart#full', name: '/cart#full' }] } });
  });

  it('a url or a design-tool file must name its version; a url must be https', () => {
    expect(parseDesignRef({ kind: 'url', ref: 'https://x.test/proto' })).toMatchObject({ ok: false, error: expect.stringContaining('version is required') });
    expect(parseDesignRef({ kind: 'figma', ref: 'FILEKEY' })).toMatchObject({ ok: false });
    expect(parseDesignRef({ kind: 'url', ref: 'http://x.test', version: 'v1' })).toMatchObject({ ok: false, error: expect.stringContaining('https') });
    expect(parseDesignRef({ kind: 'url', ref: 'https://x.test/p', version: 'v1' })).toMatchObject({ ok: true });
  });

  it('refuses unknown kinds, bad revisions and bad or repeated screens', () => {
    expect(parseDesignRef({ kind: 'sketch', ref: 'x' }).ok).toBe(false);
    expect(parseDesignRef({ kind: 'artifact', ref: 'a', version: '0' }).ok).toBe(false);
    expect(parseDesignRef({ kind: 'artifact', ref: 'a', version: 'v2' }).ok).toBe(false);
    expect(parseDesignRef({ kind: 'artifact', ref: 'a', screens: [{ id: 'has space' }] }).ok).toBe(false);
    expect(parseDesignRef({ kind: 'artifact', ref: 'a', screens: [{ id: 'x' }, { id: 'x' }] }).ok).toBe(false);
    expect(parseDesignRef([]).ok).toBe(false);
  });
});

describe('design drift', () => {
  it('reads changed only when the current version is known and differs', () => {
    expect(designDrift({ kind: 'artifact', ref: 'a', version: '3' }, '4')).toEqual({ pinned: '3', current: '4' });
    expect(designDrift({ kind: 'artifact', ref: 'a', version: '3' }, '3')).toBeNull();
    expect(designDrift({ kind: 'figma', ref: 'f', version: '9' }, null)).toBeNull();
    expect(designDrift(null, '1')).toBeNull();
  });

  it('sameDesign compares kind, ref, version and screens', () => {
    expect(sameDesign({ kind: 'artifact', ref: 'a', version: '1' }, { kind: 'artifact', ref: 'a', version: '1' })).toBe(true);
    expect(sameDesign({ kind: 'artifact', ref: 'a', version: '1' }, { kind: 'artifact', ref: 'a', version: '2' })).toBe(false);
    expect(sameDesign(null, undefined)).toBe(true);
  });
});

describe('criterionScreens', () => {
  it('collects screen lines under each criterion, skipping fences, headings and decisions', () => {
    const body = [
      '- **AC-1** An empty cart shows the empty state.',
      '  screen: cart-empty, `cart-empty-mobile`',
      '  screens: cart-empty',
      '  check: `bun test cart`',
      '- **D-1** Decided.',
      '  screen: nope',
      '## Heading',
      'screen: nope',
      '- **AC-2** Full cart.',
      '```',
      'screen: in-a-fence',
      '```',
      '  screen: cart-full',
    ].join('\n');
    expect(criterionScreens(body)).toEqual([
      { criterionId: 'AC-1', screens: ['cart-empty', 'cart-empty-mobile'] },
      { criterionId: 'AC-2', screens: ['cart-full'] },
    ]);
  });
});
