/**
 * BuilddClient.requestEvidenceUploadUrl — the runner's channel to evidence
 * storage. It holds no bucket credentials, sends no object key, and treats
 * every refusal or transport failure as null: evidence never fails a task.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/evidence-upload-url-client.test.ts
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';

const realFetch = globalThis.fetch;
let captured: Array<{ url: string; method?: string; body?: string }> = [];

function stubFetch(status: number, json: unknown) {
  globalThis.fetch = ((url: string, opts: any) => {
    captured.push({ url: String(url), method: opts?.method, body: opts?.body });
    return Promise.resolve(
      new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
    );
  }) as any;
}

function makeClient() {
  return new BuilddClient({
    projectsRoot: '/tmp',
    builddServer: 'https://coordination.example.invalid',
    apiKey: 'bld_test_key_value_0123456789',
    maxConcurrent: 1,
    model: 'claude-sonnet-4-5-20250929',
    serverless: true,
  } as any);
}

const REQ = { kind: 'command_output' as const, seq: 2, sizeBytes: 1234 };

describe('BuilddClient.requestEvidenceUploadUrl', () => {
  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns the presigned URL and the server-derived key', async () => {
    stubFetch(200, { uploadUrl: 'https://bucket.example.invalid/signed', key: 'evidence/w/r/t/k/command_output/1-2.log.gz', evidenceId: 'e' });
    const result = await makeClient().requestEvidenceUploadUrl('worker-1', REQ);
    expect(result).toEqual({ uploadUrl: 'https://bucket.example.invalid/signed', key: 'evidence/w/r/t/k/command_output/1-2.log.gz', evidenceId: 'e' });
  });

  it('omits evidenceId when an older server does not send one', async () => {
    stubFetch(200, { uploadUrl: 'u', key: 'k' });
    expect(await makeClient().requestEvidenceUploadUrl('worker-1', REQ)).toEqual({ uploadUrl: 'u', key: 'k' });
  });

  it('sends only kind, seq and sizeBytes to the evidence route', async () => {
    stubFetch(200, { uploadUrl: 'u', key: 'k' });
    await makeClient().requestEvidenceUploadUrl('worker-1', { ...REQ, key: 'steal/me' } as any);
    const body = JSON.parse(captured[0].body!);
    expect(Object.keys(body).sort()).toEqual(['kind', 'seq', 'sizeBytes']);
    expect(captured[0].url).toContain('/api/workers/worker-1/evidence-upload-url');
    expect(captured[0].method).toBe('POST');
  });

  for (const status of [400, 401, 403, 404, 409, 413, 424, 500, 503]) {
    it(`returns null on HTTP ${status}`, async () => {
      stubFetch(status, { error: 'refused' });
      expect(await makeClient().requestEvidenceUploadUrl('worker-1', REQ)).toBeNull();
    });
  }

  it('returns null on a network error', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as any;
    expect(await makeClient().requestEvidenceUploadUrl('worker-1', REQ)).toBeNull();
  });

  it('returns null when the response lacks a url or key', async () => {
    stubFetch(200, { uploadUrl: 'u' });
    expect(await makeClient().requestEvidenceUploadUrl('worker-1', REQ)).toBeNull();
  });
});

describe('BuilddClient.confirmEvidenceUpload', () => {
  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('POSTs to the confirm route with no body and returns true when stored', async () => {
    stubFetch(200, { evidenceId: 'ev-1', uploadState: 'stored', bytes: 10 });
    expect(await makeClient().confirmEvidenceUpload('worker-1', 'ev-1')).toBe(true);
    expect(captured[0].url).toContain('/api/workers/worker-1/evidence/ev-1/confirm');
    expect(captured[0].method).toBe('POST');
  });

  it('returns false when the server settled the row as failed', async () => {
    stubFetch(200, { evidenceId: 'ev-1', uploadState: 'failed', bytes: 10 });
    expect(await makeClient().confirmEvidenceUpload('worker-1', 'ev-1')).toBe(false);
  });

  for (const status of [400, 401, 403, 404, 424, 500, 503]) {
    it(`returns false on HTTP ${status}`, async () => {
      stubFetch(status, { error: 'refused' });
      expect(await makeClient().confirmEvidenceUpload('worker-1', 'ev-1')).toBe(false);
    });
  }

  it('returns false on a network error', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as any;
    expect(await makeClient().confirmEvidenceUpload('worker-1', 'ev-1')).toBe(false);
  });
});
