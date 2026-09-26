import { describe, it, expect } from 'bun:test';
import { applyNeonLocalOverride, assertLoopbackUrl } from '../db/neon-local';

describe('applyNeonLocalOverride', () => {
  it('is a no-op when NEON_LOCAL_FETCH_ENDPOINT is unset', () => {
    expect(applyNeonLocalOverride({ DATABASE_URL: 'postgres://u:p@ep-x.neon.tech/db' })).toBe(false);
  });

  it('refuses a remote DATABASE_URL behind a local proxy', () => {
    expect(() =>
      applyNeonLocalOverride({
        NEON_LOCAL_FETCH_ENDPOINT: 'http://127.0.0.1:54444/sql',
        DATABASE_URL: 'postgres://u:p@ep-x.neon.tech/db',
      }),
    ).toThrow(/not localhost/);
  });

  it('refuses a remote fetch endpoint', () => {
    expect(() =>
      applyNeonLocalOverride({
        NEON_LOCAL_FETCH_ENDPOINT: 'https://proxy.example.com/sql',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      }),
    ).toThrow(/not localhost/);
  });

  it('refuses when DATABASE_URL is missing', () => {
    expect(() =>
      applyNeonLocalOverride({ NEON_LOCAL_FETCH_ENDPOINT: 'http://127.0.0.1:54444/sql' }),
    ).toThrow(/DATABASE_URL is not set/);
  });

  it('activates for loopback endpoint + loopback DATABASE_URL', () => {
    expect(
      applyNeonLocalOverride({
        NEON_LOCAL_FETCH_ENDPOINT: 'http://127.0.0.1:54444/sql',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      }),
    ).toBe(true);
  });
});

describe('assertLoopbackUrl', () => {
  it('does not treat a lookalike subdomain as loopback', () => {
    expect(() => assertLoopbackUrl('X', 'postgres://u:p@localhost.evil.test/db')).toThrow();
    expect(() => assertLoopbackUrl('X', 'postgres://u:p@127.0.0.1.nip.io/db')).toThrow();
  });
  it('rejects an unparseable URL', () => {
    expect(() => assertLoopbackUrl('X', 'not a url')).toThrow(/not a valid URL/);
  });
});
