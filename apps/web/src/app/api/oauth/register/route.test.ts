import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// storage.createClient(): db.insert().values() — no real DB in unit tests.
mock.module('@buildd/core/db', () => ({
  db: { insert: () => ({ values: async () => undefined }) },
}));

let hits = 0;
let limiterUnavailable = false;
let counterKeys: string[] = [];
mock.module('@/lib/redis', () => ({ incrWindow: async (key: string) => { counterKeys.push(key); return limiterUnavailable ? null : ++hits; } }));
beforeEach(() => { hits = 0; limiterUnavailable = false; counterKeys = []; });

import { POST } from './route';

function registerRequest(body: unknown, ip = '192.0.2.1') {
  return new NextRequest('https://buildd.dev/api/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /api/oauth/register — redirect_uris validation', () => {
  it('rejects schemes that are dangerous in any redirect context', async () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'vbscript:msgbox(1)',
      'file:///etc/hosts',
      'blob:https://example.com/abc',
    ]) {
      const res = await POST(registerRequest({ redirect_uris: [uri] }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_redirect_uri');
    }
  });

  it('rejects a redirect URI carrying a fragment (RFC 6749 §3.1.2)', async () => {
    const res = await POST(registerRequest({ redirect_uris: ['https://example.com/cb#frag'] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('rejects the whole registration when any one URI is dangerous', async () => {
    const res = await POST(
      registerRequest({ redirect_uris: ['https://example.com/cb', 'javascript:alert(1)'] }),
    );
    expect(res.status).toBe(400);
  });

  // Public HTTPS and native loopback callbacks remain open to registration.
  it('still accepts https, loopback redirect URIs', async () => {
    for (const uri of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://some-other-host.example/cb',
      'http://localhost:41776/callback/abc',
      'http://127.0.0.1:41776/callback/abc',
      'http://[::1]:41776/callback',
    ]) {
      const res = await POST(registerRequest({ redirect_uris: [uri], client_name: 'Fake Client' }));
      expect(res.status).toBe(201);
      expect((await res.json()).redirect_uris).toEqual([uri]);
    }
  });
});

describe('registration hardening', () => {
  it('rejects non-https, non-loopback redirects', async () => {
    for (const uri of ['http://example.com/cb', 'com.example.app://cb', 'http://localhost.evil.example/cb', 'https://user:pass@example.com/cb']) {
      expect((await POST(registerRequest({ redirect_uris: [uri] }))).status).toBe(400);
    }
  });
  it('rejects reserved names and lookalikes on unrelated hosts', async () => {
    for (const name of ['Claude', 'CLAUDE CODE', 'buildd', 'buildd CLI', 'Ｃｌａｕｄｅ', 'Clаude', 'c l a u d e', 'buіldd', 'C1aude', 'CIaude', 'Claude Cоde', 'buіIdd']) {
      hits = 0;
      const res = await POST(registerRequest({ client_name: name, redirect_uris: ['https://other.example/cb'] }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_client_metadata');
    }
  });
  it('allows reserved names only when every redirect matches its hosts', async () => {
    for (const [name, uri] of [['Claude', 'https://claude.ai/cb'], ['Claude Code', 'http://127.0.0.1:4000/cb'], ['buildd CLI', 'http://localhost:4000/cb'], ['buildd', 'https://buildd.dev/cb']]) {
      expect((await POST(registerRequest({ client_name: name, redirect_uris: [uri] }))).status).toBe(201);
      expect((await POST(registerRequest({ client_name: name, redirect_uris: [uri, 'https://other.example/cb'] }))).status).toBe(400);
    }
  });
  it('uses a separate hashed counter for each trusted ingress IP', async () => {
    await POST(registerRequest({ redirect_uris: ['https://example.com/cb'] }, '192.0.2.1'));
    await POST(registerRequest({ redirect_uris: ['https://example.com/cb'] }, '192.0.2.2'));
    expect(counterKeys[0]).not.toBe(counterKeys[1]);
    expect(counterKeys[0]).not.toContain('192.0.2.1');
  });
  it('returns a retryable 503 if the shared limiter is unavailable', async () => {
    limiterUnavailable = true;
    const res = await POST(registerRequest({ redirect_uris: ['https://example.com/cb'] }));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
  });
  it('returns 429 after ten attempts in the IP window', async () => {
    for (let i = 0; i < 10; i++) expect((await POST(registerRequest({ redirect_uris: ['https://example.com/cb'] }))).status).toBe(201);
    const res = await POST(registerRequest({ redirect_uris: ['https://example.com/cb'] }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

afterAll(() => mock.restore());
