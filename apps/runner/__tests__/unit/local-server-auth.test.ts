import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isLoopbackAddress,
  resolveBindHost,
  loadOrCreateLocalToken,
  injectLocalToken,
  authorizeLocalRequest,
  escapeHtml,
  readLocalToken,
  LOCAL_TOKEN_HEADER,
} from '../../src/local-server-auth';

const TOKEN = 'a'.repeat(64);
const VIEWER = 'viewer-token';
const OWN_ORIGIN = 'http://127.0.0.1:8766';

function req(overrides: Partial<Parameters<typeof authorizeLocalRequest>[0]> = {}) {
  return authorizeLocalRequest({
    method: 'GET',
    path: '/api/version',
    headers: new Headers(),
    remoteAddr: '127.0.0.1',
    token: TOKEN,
    viewerToken: VIEWER,
    ownOrigins: [OWN_ORIGIN, 'http://localhost:8766'],
    ...overrides,
  });
}

describe('isLoopbackAddress', () => {
  it('accepts IPv4 loopback, IPv6 loopback and IPv4-mapped loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.10.0.3')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });
  it('rejects private, public and missing addresses', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('100.64.0.1')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('resolveBindHost', () => {
  it('defaults to loopback', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });
  it('honours an explicit BUILDD_UI_BIND', () => {
    expect(resolveBindHost({ BUILDD_UI_BIND: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindHost({ BUILDD_UI_BIND: '  ' })).toBe('127.0.0.1');
  });
});

describe('loadOrCreateLocalToken', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'local-token-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates a 32-byte hex token readable only by the owner', () => {
    const { token, path } = loadOrCreateLocalToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(path).toBe(join(dir, 'local-token'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').trim()).toBe(token);
  });

  it('reuses an existing valid token and tightens its permissions', () => {
    const existing = 'b'.repeat(64);
    const p = join(dir, 'local-token');
    writeFileSync(p, existing + '\n');
    chmodSync(p, 0o644);
    const { token } = loadOrCreateLocalToken(dir);
    expect(token).toBe(existing);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('prefers a valid BUILDD_LOCAL_TOKEN and persists it', () => {
    const fromEnv = 'c'.repeat(64);
    const { token, path } = loadOrCreateLocalToken(dir, { BUILDD_LOCAL_TOKEN: fromEnv });
    expect(token).toBe(fromEnv);
    expect(readFileSync(path, 'utf8').trim()).toBe(fromEnv);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readLocalToken({ BUILDD_HOME: dir })).toBe(fromEnv);
  });

  it('ignores a malformed BUILDD_LOCAL_TOKEN', () => {
    const { token } = loadOrCreateLocalToken(dir, { BUILDD_LOCAL_TOKEN: 'nope' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replaces a malformed token file', () => {
    writeFileSync(join(dir, 'local-token'), 'short');
    const { token } = loadOrCreateLocalToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('injectLocalToken', () => {
  it('adds the token meta tag and a fetch wrapper into <head>', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectLocalToken(html, TOKEN);
    expect(out).toContain(`<meta name="buildd-local-token" content="${TOKEN}">`);
    expect(out).toContain(LOCAL_TOKEN_HEADER);
    expect(out.indexOf('buildd-local-token')).toBeLessThan(out.indexOf('<title>'));
  });

  it('the injected wrapper adds the header to same-origin fetches only', () => {
    const out = injectLocalToken('<head></head>', TOKEN);
    const js = out.match(/<script>([\s\S]*)<\/script>/)![1];
    const calls: Array<[unknown, any]> = [];
    const fakeWindow: any = { fetch: (i: unknown, init: any) => { calls.push([i, init]); return Promise.resolve(); } };
    const fakeLocation = { href: 'http://127.0.0.1:8766/', origin: 'http://127.0.0.1:8766' };
    const fakeDocument = { querySelector: () => ({ content: TOKEN }) };
    new Function('window', 'location', 'document', js)(fakeWindow, fakeLocation, fakeDocument);
    fakeWindow.fetch('/api/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    fakeWindow.fetch('https://example.com/x');
    expect(calls[0][1].headers.get(LOCAL_TOKEN_HEADER)).toBe(TOKEN);
    expect(calls[0][1].headers.get('content-type')).toBe('application/json');
    expect(calls[1][1]).toBeUndefined();
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters', () => {
    expect(escapeHtml(`<b a="1">'&`)).toBe('&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
  });
});

describe('authorizeLocalRequest', () => {
  it('allows plain reads from loopback without a token', () => {
    expect(req()).toBeNull();
    expect(req({ path: '/api/workers' })).toBeNull();
  });

  it('requires the local token for mutating requests', () => {
    expect(req({ method: 'POST', path: '/api/config/server' })?.status).toBe(403);
    expect(req({ method: 'DELETE', path: '/api/outbox' })?.status).toBe(403);
    const headers = new Headers({ [LOCAL_TOKEN_HEADER]: 'wrong' });
    expect(req({ method: 'POST', path: '/api/abort', headers })?.status).toBe(403);
  });

  it('allows mutating requests that carry the local token', () => {
    const headers = new Headers({ [LOCAL_TOKEN_HEADER]: TOKEN });
    expect(req({ method: 'POST', path: '/api/config/server', headers })).toBeNull();
  });

  it('requires the local token to read the runner config', () => {
    expect(req({ path: '/api/config' })?.status).toBe(403);
    expect(req({ path: '/api/config', headers: new Headers({ [LOCAL_TOKEN_HEADER]: TOKEN }) })).toBeNull();
  });

  it('rejects a request whose Origin is not the server itself, even with the token', () => {
    const headers = new Headers({ [LOCAL_TOKEN_HEADER]: TOKEN, origin: 'https://example.com' });
    expect(req({ method: 'POST', path: '/api/abort', headers })?.status).toBe(403);
  });

  it('accepts same-origin requests', () => {
    const headers = new Headers({ [LOCAL_TOKEN_HEADER]: TOKEN, origin: OWN_ORIGIN });
    expect(req({ method: 'POST', path: '/api/abort', headers })).toBeNull();
  });

  it('lets the auth redirect flow through without the header (state-checked separately)', () => {
    expect(req({ path: '/auth/login' })).toBeNull();
    expect(req({ path: '/auth/callback' })).toBeNull();
  });

  it('requires the viewer token for worker data from a non-loopback peer', () => {
    expect(req({ path: '/api/workers', remoteAddr: '100.64.0.2' })?.status).toBe(401);
    expect(req({ path: '/health', remoteAddr: '192.168.1.2' })?.status).toBe(401);
    const headers = new Headers({ authorization: `Bearer ${VIEWER}` });
    expect(req({ path: '/api/workers', remoteAddr: '100.64.0.2', headers })).toBeNull();
    expect(req({ path: '/api/events', remoteAddr: '100.64.0.2', query: new URLSearchParams({ token: VIEWER }) })).toBeNull();
  });

  it('rejects a Host header that is not one of the server\'s own addresses', () => {
    // Guards the token-bearing UI page and local reads against a foreign
    // hostname resolving to loopback.
    const foreign = new Headers({ host: 'rebound.example:8766' });
    expect(req({ path: '/', headers: foreign })?.status).toBe(403);
    expect(req({ path: '/api/workers', headers: foreign })?.status).toBe(403);
    expect(req({ path: '/', headers: new Headers({ host: 'localhost:8766' }) })).toBeNull();
    expect(req({ path: '/', headers: new Headers({ host: '127.0.0.1:8766' }) })).toBeNull();
  });

  it('does not treat a localhost Host header as proof of a local peer', () => {
    const headers = new Headers({ host: 'localhost:8766' });
    expect(req({ path: '/api/workers', remoteAddr: '203.0.113.9', headers })?.status).toBe(401);
  });

  it('serves the UI shell to a non-loopback peer only with the viewer token', () => {
    expect(req({ path: '/', remoteAddr: '100.64.0.2' })?.status).toBe(401);
    expect(req({ path: '/', remoteAddr: '100.64.0.2', query: new URLSearchParams({ token: VIEWER }) })).toBeNull();
  });

  it('never allows the auth flow or other non-viewer paths from a non-loopback peer without the token', () => {
    expect(req({ path: '/auth/callback', remoteAddr: '100.64.0.2' })?.status).toBe(403);
    expect(req({ path: '/api/version', remoteAddr: '100.64.0.2' })?.status).toBe(403);
  });
});
