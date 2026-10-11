/**
 * The MCP routes make their REST calls to this server and forward the caller's
 * bearer on each one. The origin those calls go to must come from this
 * server's own configuration, never a hardcoded host: a server that cannot
 * name itself refuses rather than sending the bearer somewhere else.
 */

import { describe, it, expect } from 'bun:test';
import { resolveSelfOrigin, selfOriginUnconfiguredResponse } from './self-origin';

const req = (url: string) => new Request(url, { method: 'POST' });

describe('resolveSelfOrigin', () => {
  it('uses the Vercel deployment host when VERCEL_URL is set', () => {
    expect(resolveSelfOrigin(req('https://anything.example/api/mcp'), { VERCEL_URL: 'proj-abc.vercel.app', NEXTAUTH_URL: 'https://other.example' }))
      .toBe('https://proj-abc.vercel.app');
  });

  it('uses NEXTAUTH_URL off Vercel, reduced to its origin', () => {
    expect(resolveSelfOrigin(req('https://anything.example/api/mcp'), { NEXTAUTH_URL: 'https://self.example/some/path/' }))
      .toBe('https://self.example');
  });

  it('falls back to AUTH_URL when NEXTAUTH_URL is unset', () => {
    expect(resolveSelfOrigin(undefined, { AUTH_URL: 'http://localhost:3999' })).toBe('http://localhost:3999');
  });

  it('skips a configured value that is not an http(s) URL', () => {
    expect(resolveSelfOrigin(undefined, { NEXTAUTH_URL: 'not a url', NODE_ENV: 'production' })).toBeNull();
    expect(resolveSelfOrigin(undefined, { NEXTAUTH_URL: 'ftp://self.example', NODE_ENV: 'production' })).toBeNull();
  });

  it('resolves nothing when no origin is configured in production, whatever the request says', () => {
    expect(resolveSelfOrigin(req('https://buildd.dev/api/mcp'), { NODE_ENV: 'production' })).toBeNull();
    expect(resolveSelfOrigin(req('http://localhost:3000/api/mcp'), { NODE_ENV: 'production' })).toBeNull();
    expect(resolveSelfOrigin(undefined, { NODE_ENV: 'production' })).toBeNull();
  });

  it("uses the request's own origin only outside production and only for a loopback host", () => {
    expect(resolveSelfOrigin(req('http://localhost:3000/api/mcp'), { NODE_ENV: 'development' })).toBe('http://localhost:3000');
    expect(resolveSelfOrigin(req('http://127.0.0.1:4000/api/mcp'), { NODE_ENV: 'test' })).toBe('http://127.0.0.1:4000');
    expect(resolveSelfOrigin(req('http://[::1]:4000/api/mcp'), {})).toBe('http://[::1]:4000');
    // A non-loopback Host is caller-controlled: never a destination for the bearer.
    expect(resolveSelfOrigin(req('https://attacker.example/api/mcp'), { NODE_ENV: 'development' })).toBeNull();
    expect(resolveSelfOrigin(req('http://localhost.attacker.example/api/mcp'), { NODE_ENV: 'development' })).toBeNull();
  });

  it('never resolves to the public production host by default', () => {
    for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'development' }]) {
      expect(resolveSelfOrigin(undefined, env)).toBeNull();
    }
  });
});

describe('selfOriginUnconfiguredResponse', () => {
  it('is a 500 config error that names the setting to fix', async () => {
    const res = selfOriginUnconfiguredResponse();
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.error).toBe('self_origin_unconfigured');
    expect(body.message).toContain('NEXTAUTH_URL');
  });
});
