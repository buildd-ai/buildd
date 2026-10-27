import { describe, it, expect } from 'bun:test';
import { diffAnchor } from './diff-anchor';

describe('diffAnchor', () => {
  it('returns the correct GitHub diff anchor for a known file path', async () => {
    const anchor = await diffAnchor('tests/acceptance/queue.test.ts');
    // SHA-256 of 'tests/acceptance/queue.test.ts'
    expect(anchor).toBe('#diff-3eb7b6953021505b04c6227eb1837aa7c37031e8d7557f5b30ae327997aa462b');
    // Verify it's deterministic (same input gives same output)
    const anchor2 = await diffAnchor('tests/acceptance/queue.test.ts');
    expect(anchor2).toBe(anchor);
  });

  it('produces different anchors for different paths', async () => {
    const anchor1 = await diffAnchor('path/one.ts');
    const anchor2 = await diffAnchor('path/two.ts');
    expect(anchor1).not.toBe(anchor2);
  });

  it('returns empty string when crypto.subtle is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const anchor = await diffAnchor('tests/acceptance/queue.test.ts');
      expect(anchor).toBe('');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        writable: true,
        configurable: true,
      });
    }
  });
});
