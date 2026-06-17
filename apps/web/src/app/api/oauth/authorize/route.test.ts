import { describe, expect, it } from 'bun:test';
import { isRegisteredRedirectUri } from './route';

describe('OAuth authorize redirect URI validation', () => {
  it('accepts equivalent loopback hostnames for the same callback URI', () => {
    expect(
      isRegisteredRedirectUri(
        ['http://localhost:41776/callback/ziW6hvS99iVJ'],
        'http://127.0.0.1:41776/callback/ziW6hvS99iVJ',
      ),
    ).toBe(true);
  });

  it('rejects loopback callbacks with a different port or path', () => {
    expect(
      isRegisteredRedirectUri(
        ['http://localhost:41776/callback/ziW6hvS99iVJ'],
        'http://127.0.0.1:14567/callback/ziW6hvS99iVJ',
      ),
    ).toBe(false);
    expect(
      isRegisteredRedirectUri(
        ['http://localhost:41776/callback/ziW6hvS99iVJ'],
        'http://127.0.0.1:41776/callback/other',
      ),
    ).toBe(false);
  });

  it('keeps exact matching for non-loopback redirect URIs', () => {
    expect(
      isRegisteredRedirectUri(
        ['https://example.com/callback'],
        'https://example.com/callback',
      ),
    ).toBe(true);
    expect(
      isRegisteredRedirectUri(
        ['https://example.com/callback'],
        'https://example.org/callback',
      ),
    ).toBe(false);
  });
});
