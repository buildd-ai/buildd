/**
 * The lasting attachment link (living-specs.md §21): every request is checked
 * against the spec's workspace before a fresh download URL is made; a caller
 * that does not reach the spec gets its 404 and no URL; a body artifact opens
 * its artifact page.
 */
import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let caller: unknown = { kind: 'user', userId: 'u1' };
let opened: unknown = { ok: true, artifactId: 'a1', storageKey: 'artifacts/w/a1/pay.png', uploadState: 'ready', filename: 'pay.png', mimeType: 'image/png' };
const openCalls: unknown[] = [];
const signed: string[] = [];
mock.module('@/lib/specs/caller', () => ({ specCaller: async () => caller }));
mock.module('@/lib/specs/attachments', () => ({
  openSpecAttachment: async (...args: unknown[]) => { openCalls.push(args.slice(1)); return opened; },
  removeSpecAttachment: async () => ({ ok: true, removedFromRevision: 3 }),
}));
mock.module('@/lib/storage', () => ({
  isStorageConfigured: () => true,
  generateDownloadUrl: async (key: string) => { signed.push(key); return `https://r2.test/${key}?X-Amz-Expires=3600`; },
}));
mock.module('@/lib/artifact-upload', () => ({ finalizeArtifactUpload: async () => ({ state: 'ready', sha256: null, sizeBytes: 1 }) }));
const { GET, DELETE } = await import('./route');
const params = Promise.resolve({ specId: 's1', name: 'pay-screen' });

describe('/api/specs/[specId]/attachments/[name]', () => {
  it('redirects a caller who reaches the spec to a fresh download URL for that revision', async () => {
    const res = await GET(new NextRequest('http://l/api/specs/s1/attachments/pay-screen?revision=2'), { params });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://r2.test/artifacts/w/a1/pay.png?X-Amz-Expires=3600');
    expect(openCalls.at(-1)).toEqual(['s1', 'pay-screen', { revision: 2 }]);
  });

  it('a caller without access gets the 404 and no URL is signed', async () => {
    opened = { ok: false, status: 404, error: 'Spec not found' };
    const before = signed.length;
    const res = await GET(new NextRequest('http://l/api/specs/s1/attachments/pay-screen'), { params });
    expect(res.status).toBe(404);
    expect(signed.length).toBe(before);
  });

  it('a body artifact opens its artifact page; a bad revision is 400; no caller is 401', async () => {
    opened = { ok: true, artifactId: 'a2', storageKey: null, uploadState: null, filename: null, mimeType: null };
    const res = await GET(new NextRequest('http://l/api/specs/s1/attachments/pay-screen'), { params });
    expect(res.headers.get('location')).toBe('http://l/app/artifacts/a2');
    expect((await GET(new NextRequest('http://l/api/specs/s1/attachments/pay-screen?revision=0'), { params })).status).toBe(400);
    caller = null;
    expect((await GET(new NextRequest('http://l/api/specs/s1/attachments/pay-screen'), { params })).status).toBe(401);
    expect((await DELETE(new NextRequest('http://l/api/specs/s1/attachments/pay-screen', { method: 'DELETE' }), { params })).status).toBe(401);
  });
});
