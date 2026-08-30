/**
 * BuilddClient.requestSessionUploadUrl — the runner's only channel to object
 * storage. It must never hold storage credentials, must treat every server
 * refusal (sensitive workspace, write-once conflict, storage off) as a quiet
 * skip rather than an error, and must never send a client-chosen object key.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/session-upload-url-client.test.ts
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { BuilddClient } from '../../src/buildd';

const realFetch = globalThis.fetch;
let captured: Array<{ url: string; method?: string; body?: string; headers: any }> = [];

function stubFetch(status: number, json: unknown) {
  globalThis.fetch = ((url: string, opts: any) => {
    captured.push({ url: String(url), method: opts?.method, body: opts?.body, headers: opts?.headers });
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

describe('BuilddClient.requestSessionUploadUrl', () => {
  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns the presigned URL and server-derived key on success', async () => {
    stubFetch(200, {
      uploadUrl: 'https://storage.example.invalid/signed',
      storageKey: 'sessions/team/workspace/worker/transcript.jsonl',
    });
    const result = await makeClient().requestSessionUploadUrl('worker-1', 'transcript', 1234);
    expect(result?.uploadUrl).toBe('https://storage.example.invalid/signed');
    expect(result?.storageKey).toBe('sessions/team/workspace/worker/transcript.jsonl');
  });

  it('sends only kind + sizeBytes — never an object key', async () => {
    stubFetch(200, { uploadUrl: 'u', storageKey: 'k' });
    await makeClient().requestSessionUploadUrl('worker-1', 'session-log', 99);
    const body = JSON.parse(captured[0].body!);
    expect(Object.keys(body).sort()).toEqual(['kind', 'sizeBytes']);
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('storageKey');
    expect(captured[0].url).toContain('/api/workers/worker-1/session-upload-url');
    expect(captured[0].method).toBe('POST');
  });

  it('returns null (not an error) when the workspace is sensitive', async () => {
    stubFetch(403, { error: 'Session diagnostics upload is not permitted for sensitive workspaces' });
    expect(await makeClient().requestSessionUploadUrl('worker-1', 'transcript', 10)).toBeNull();
  });

  it('returns null when the object already exists (write-once refusal)', async () => {
    stubFetch(409, { error: 'Session diagnostics already uploaded for this worker' });
    expect(await makeClient().requestSessionUploadUrl('worker-1', 'transcript', 10)).toBeNull();
  });

  it('returns null when storage is not configured', async () => {
    stubFetch(503, { error: 'Storage not configured' });
    expect(await makeClient().requestSessionUploadUrl('worker-1', 'transcript', 10)).toBeNull();
  });

  it('returns null when the payload is too large', async () => {
    stubFetch(413, { error: 'Session artifact exceeds limit' });
    expect(await makeClient().requestSessionUploadUrl('worker-1', 'transcript', 10)).toBeNull();
  });

  it('returns null when the caller is not authorized for the worker', async () => {
    stubFetch(404, { error: 'Worker not found' });
    expect(await makeClient().requestSessionUploadUrl('worker-1', 'transcript', 10)).toBeNull();
  });
});
