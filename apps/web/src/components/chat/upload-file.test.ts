import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { uploadChatFile } from './upload-file';

const ID = '11111111-1111-4111-8111-111111111111';
type Call = { url: string; method: string; body?: unknown };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fake(opts: { directPut: 'ok' | 'cors' | 500; finalize?: Record<string, unknown>; finalizeStatus?: number }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    if (url === '/api/chat/uploads') return Response.json({ artifactId: ID, uploadUrl: 'https://bucket.example/put' });
    if (url === 'https://bucket.example/put') {
      if (opts.directPut === 'cors') throw new TypeError('Failed to fetch');
      return new Response(null, { status: opts.directPut === 'ok' ? 200 : 500 });
    }
    if (url.endsWith('/content')) return Response.json({ stored: true });
    if (url.endsWith('/finalize')) return Response.json(opts.finalize ?? { state: 'ready' }, { status: opts.finalizeStatus ?? 200 });
    if (method === 'DELETE') return Response.json({ removed: true });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return calls;
}
const png = () => new File([new Uint8Array([1, 2, 3, 4])], 'chart.png', { type: 'image/png' });

describe('uploadChatFile', () => {
  it('starts, PUTs straight to storage, finalizes with the browser hash, and resolves a ready draft', async () => {
    const calls = fake({ directPut: 'ok' });
    const draft = await uploadChatFile(png(), new AbortController().signal, 'team-1');
    expect(draft).toEqual({ kind: 'file', id: ID, name: 'chart.png', mediaType: 'image/png', sizeBytes: 4 });
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'POST /api/chat/uploads', 'PUT https://bucket.example/put', `POST /api/chat/uploads/${ID}/finalize`,
    ]);
    expect(calls[0]!.body).toEqual({ name: 'chart.png', mediaType: 'image/png', sizeBytes: 4, teamId: 'team-1' });
    expect(calls[2]!.body).toEqual({ sha256: createHash('sha256').update(Buffer.from([1, 2, 3, 4])).digest('hex') });
  });

  it('a refused direct PUT (CORS) is relayed through the server', async () => {
    const calls = fake({ directPut: 'cors' });
    await uploadChatFile(png(), new AbortController().signal, null);
    expect(calls.map(c => `${c.method} ${c.url}`)).toContain(`PUT /api/chat/uploads/${ID}/content`);
  });

  it('a failed check rejects: the card shows it failed, never attached', async () => {
    fake({ directPut: 'ok', finalize: { state: 'failed', reason: 'sha256_mismatch' }, finalizeStatus: 422 });
    await expect(uploadChatFile(png(), new AbortController().signal, null)).rejects.toThrow('Upload check failed');
  });

  it('a cancel after the upload started takes it back', async () => {
    const calls = fake({ directPut: 'ok' });
    const c = new AbortController();
    const p = uploadChatFile(png(), c.signal, null);
    await new Promise(r => setTimeout(r, 0));
    c.abort();
    await p.catch(() => {});
    await new Promise(r => setTimeout(r, 0));
    expect(calls.some(x => x.method === 'DELETE' && x.url === `/api/chat/uploads/${ID}`)).toBe(true);
  });
});
