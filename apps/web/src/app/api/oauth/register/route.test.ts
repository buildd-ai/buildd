import { afterAll, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// storage.createClient(): db.insert().values() — no real DB in unit tests.
mock.module('@buildd/core/db', () => ({
  db: { insert: () => ({ values: async () => undefined }) },
}));

import { POST } from './route';

function registerRequest(body: unknown) {
  return new NextRequest('https://buildd.dev/api/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
      expect((await res.json()).error).toBe('invalid_client_metadata');
    }
  });

  it('rejects a redirect URI carrying a fragment (RFC 6749 §3.1.2)', async () => {
    const res = await POST(registerRequest({ redirect_uris: ['https://example.com/cb#frag'] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client_metadata');
  });

  it('rejects the whole registration when any one URI is dangerous', async () => {
    const res = await POST(
      registerRequest({ redirect_uris: ['https://example.com/cb', 'javascript:alert(1)'] }),
    );
    expect(res.status).toBe(400);
  });

  // Compatibility guarantee: this fix must not lock out clients that legitimately
  // register loopback or private-use schemes.
  it('still accepts https, loopback and private-use redirect URIs', async () => {
    for (const uri of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://some-other-host.example/cb',
      'http://localhost:41776/callback/abc',
      'http://127.0.0.1:41776/callback/abc',
      'com.example.app://cb',
    ]) {
      const res = await POST(registerRequest({ redirect_uris: [uri], client_name: 'Fake Client' }));
      expect(res.status).toBe(201);
      expect((await res.json()).redirect_uris).toEqual([uri]);
    }
  });
});

afterAll(() => mock.restore());
