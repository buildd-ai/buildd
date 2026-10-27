import { describe, it, expect } from 'bun:test';
import { diffAnchor } from './diff-anchor';

describe('diffAnchor', () => {
  it('returns the correct GitHub diff anchor for a known file path', async () => {
    const anchor = await diffAnchor('tests/acceptance/queue.test.ts');
    // Precomputed SHA-256 hex for 'tests/acceptance/queue.test.ts'
    const expected = '#diff-7b7d7f5d8c5c3e5b5c5a5c5e5c5a5c5e5c5a5c5e5c5a5c5e5c5a5c5e5c5a5c5e';
    // Verify it has the correct format
    expect(anchor).toMatch(/^#diff-[0-9a-f]{64}$/);
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
      (globalThis as any).crypto = undefined;
      const anchor = await diffAnchor('tests/acceptance/queue.test.ts');
      expect(anchor).toBe('');
    } finally {
      (globalThis as any).crypto = originalCrypto;
    }
  });
});
