import { describe, it, expect, mock } from 'bun:test';
import { createPublicGatewayFetcher } from './fetch-public-gateway';
import { NonPublicAddressError, RedirectRefusedError } from './public-address';

describe('createPublicGatewayFetcher', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateV4Lookup = async () => [{ address: '192.168.1.1', family: 4 }];

  describe('public address check', () => {
    it('allows a call to a public address', async () => {
      const fetcher = createPublicGatewayFetcher({
        lookup: publicLookup,
        fetcher: mock(async (url: string, init?: RequestInit) => {
          expect(init?.redirect).toBe('manual');
          return new Response('{}', { status: 200 });
        }),
      });
      const response = await fetcher('https://93.184.216.34/chat');
      expect(response.status).toBe(200);
    });

    it('refuses a call to a private address', async () => {
      const fetcher = createPublicGatewayFetcher({ lookup: privateV4Lookup });

      try {
        await fetcher('https://192.168.1.1/chat');
        expect.unreachable('should have thrown NonPublicAddressError');
      } catch (e) {
        expect(e).toBeInstanceOf(NonPublicAddressError);
      }
    });

    it('refuses cloud metadata address', async () => {
      const fetcher = createPublicGatewayFetcher({
        lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      });

      try {
        await fetcher('https://metadata.example.test/chat');
        expect.unreachable('should have thrown NonPublicAddressError');
      } catch (e) {
        expect(e).toBeInstanceOf(NonPublicAddressError);
      }
    });
  });

  describe('redirect blocking', () => {
    it('refuses a 302 redirect', async () => {
      const fetcher = createPublicGatewayFetcher({
        lookup: publicLookup,
        fetcher: mock(async (_url: string, init?: RequestInit) => {
          expect(init?.redirect).toBe('manual');
          return new Response(null, { status: 302, headers: { location: 'https://example.com/' } });
        }),
      });

      try {
        await fetcher('https://93.184.216.34/chat');
        expect.unreachable('should have thrown RedirectRefusedError');
      } catch (e) {
        expect(e).toBeInstanceOf(RedirectRefusedError);
        expect((e as RedirectRefusedError).status).toBe(302);
      }
    });

    it('refuses a 301 redirect', async () => {
      const fetcher = createPublicGatewayFetcher({
        lookup: publicLookup,
        fetcher: mock(async () => {
          return new Response(null, { status: 301, headers: { location: 'https://example.com/' } });
        }),
      });

      try {
        await fetcher('https://93.184.216.34/chat');
        expect.unreachable('should have thrown RedirectRefusedError');
      } catch (e) {
        expect(e).toBeInstanceOf(RedirectRefusedError);
        expect((e as RedirectRefusedError).status).toBe(301);
      }
    });

    it('requests with redirect=manual flag', async () => {
      let capturedInit: RequestInit | undefined;
      const fetcher = createPublicGatewayFetcher({
        lookup: publicLookup,
        fetcher: mock(async (_url: string, init?: RequestInit) => {
          capturedInit = init;
          return new Response('ok', { status: 200 });
        }),
      });

      await fetcher('https://93.184.216.34/chat', { method: 'POST' });
      expect(capturedInit?.redirect).toBe('manual');
      expect(capturedInit?.method).toBe('POST');
    });
  });

  describe('host validation caching', () => {
    it('caches host validation results', async () => {
      let lookupCount = 0;
      const lookup = async () => {
        lookupCount++;
        return [{ address: '93.184.216.34', family: 4 }];
      };

      const fetcher = createPublicGatewayFetcher({
        lookup,
        cacheTtlMs: 5000,
        fetcher: mock(async () => new Response('ok', { status: 200 })),
      });

      // First call does DNS lookup
      await fetcher('https://public.example.test:4000/v1/chat/completions');
      expect(lookupCount).toBe(1);

      // Second call to same host uses cache
      await fetcher('https://public.example.test:4000/v1/messages');
      expect(lookupCount).toBe(1);

      // Call to different host does new lookup
      await fetcher('https://other.example.test/chat');
      expect(lookupCount).toBe(2);
    });

    it('respects cache TTL', async () => {
      let lookupCount = 0;
      const lookup = async () => {
        lookupCount++;
        return [{ address: '93.184.216.34', family: 4 }];
      };

      const fetcher = createPublicGatewayFetcher({
        lookup,
        cacheTtlMs: 50,
        fetcher: mock(async () => new Response('ok', { status: 200 })),
      });

      await fetcher('https://public.example.test/chat');
      expect(lookupCount).toBe(1);

      // Wait for cache to expire
      await new Promise(r => setTimeout(r, 100));

      // Call after expiry should do new lookup
      await fetcher('https://public.example.test/chat');
      expect(lookupCount).toBe(2);
    });
  });

  describe('successful requests', () => {
    it('passes through successful responses', async () => {
      const responseBody = { choices: [{ message: { content: 'hello' } }] };
      const fetcher = createPublicGatewayFetcher({
        lookup: publicLookup,
        fetcher: mock(async () => {
          return new Response(JSON.stringify(responseBody), { status: 200 });
        }),
      });

      const response = await fetcher('https://93.184.216.34/chat');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(responseBody);
    });

    it('passes through non-redirect error responses', async () => {
      const fetcher = createPublicGatewayFetcher({
        lookup: publicLookup,
        fetcher: mock(async () => {
          return new Response('Unauthorized', { status: 401 });
        }),
      });

      const response = await fetcher('https://93.184.216.34/chat');
      expect(response.status).toBe(401);
    });
  });

  describe('error message safety', () => {
    it('never includes resolved addresses in error messages', async () => {
      const fetcher = createPublicGatewayFetcher({ lookup: privateV4Lookup });

      try {
        await fetcher('https://private.example.test/chat');
        expect.unreachable('should have thrown');
      } catch (e) {
        const message = (e as Error).message;
        expect(message).not.toContain('192.168');
        expect(message).not.toContain('192.168.1.1');
        expect(message).toContain('not a public address');
      }
    });
  });
});
