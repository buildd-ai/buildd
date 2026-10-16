import { describe, it, expect } from 'bun:test';
import nextConfig from '../next.config.mjs';

describe('nextConfig', () => {
  describe('headers', () => {
    it('should cache fonts at 30 days without immutable flag', async () => {
      const headers = await nextConfig.headers();

      const fontRule = headers.find((rule) => rule.source === '/fonts/:path*');
      expect(fontRule).toBeDefined();
      expect(fontRule?.headers).toBeDefined();

      const cacheControlHeader = fontRule?.headers?.find(
        (header) => header.key === 'Cache-Control'
      );
      expect(cacheControlHeader).toBeDefined();
      expect(cacheControlHeader?.value).toBe('public, max-age=2592000');
      expect(cacheControlHeader?.value).not.toContain('immutable');
    });
  });
});
