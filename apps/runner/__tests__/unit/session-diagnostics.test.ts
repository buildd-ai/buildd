/**
 * Unit tests for durable session diagnostics (apps/runner/src/session-diagnostics.ts).
 *
 * Covers the two halves of the feature in isolation:
 *   1. SDK stderr capture — bounded, filed into the per-worker session log, and
 *      convertible into a worker_error_traces row on every session end.
 *   2. Transcript/session-log shipping — redacted runner-side before upload,
 *      size-declared, and never able to fail the worker.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/session-diagnostics.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';

const logged: Array<{ workerId: string; level: string; event: string; detail?: string; taskId?: string }> = [];

mock.module('../../src/session-logger', () => ({
  sessionLog: (workerId: string, level: string, event: string, detail?: string, taskId?: string) => {
    logged.push({ workerId, level, event, detail, taskId });
  },
  readSessionLogs: () => [],
}));

const {
  SessionStderrCollector,
  MAX_SESSION_STDERR_BYTES,
  STDERR_TRACE_EXCERPT_BYTES,
  MAX_TRANSCRIPT_BYTES,
  flushStderrTrace,
  buildSessionTranscript,
  buildSessionLogBody,
  uploadSessionDiagnostics,
} = await import('../../src/session-diagnostics');

const WORKER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeWorker(overrides: Record<string, any> = {}): any {
  return {
    id: WORKER_ID,
    taskId: TASK_ID,
    name: 'test-worker',
    status: 'error',
    turns: 0,
    costUsd: 0,
    messages: [],
    toolCalls: [],
    output: [],
    milestones: [],
    ...overrides,
  };
}

beforeEach(() => {
  logged.length = 0;
});

// ─── 1. Stderr capture ───────────────────────────────────────────────────────

describe('SessionStderrCollector', () => {
  test('stderr reaches the per-worker session log', () => {
    const c = new SessionStderrCollector(WORKER_ID, TASK_ID);
    c.push('Error: spawn ENOENT\n');

    const entries = logged.filter(e => e.event === 'session_stderr');
    expect(entries.length).toBe(1);
    expect(entries[0].workerId).toBe(WORKER_ID);
    expect(entries[0].taskId).toBe(TASK_ID);
    expect(entries[0].level).toBe('error');
    expect(entries[0].detail).toBe('Error: spawn ENOENT');
  });

  test('ignores blank chunks so the log is not padded with noise', () => {
    const c = new SessionStderrCollector(WORKER_ID);
    c.push('   \n');
    c.push('');
    expect(logged.filter(e => e.event === 'session_stderr').length).toBe(0);
    expect(c.isEmpty).toBe(true);
  });

  test('bounds the buffer at the per-stream byte limit and stops writing', () => {
    const c = new SessionStderrCollector(WORKER_ID);
    const chunk = 'x'.repeat(8192);
    for (let i = 0; i < 200; i++) c.push(chunk);

    expect(c.byteLength).toBeLessThanOrEqual(MAX_SESSION_STDERR_BYTES);
    expect(c.truncated).toBe(true);
    // Once capped, no further disk writes — a chatty session cannot exhaust disk.
    const writes = logged.filter(e => e.event === 'session_stderr').length;
    const before = writes;
    c.push('more output');
    expect(logged.filter(e => e.event === 'session_stderr').length).toBe(before);
    expect(logged.some(e => e.event === 'session_stderr_truncated')).toBe(true);
  });

  test('preserves the steering-delivery crash marker', () => {
    const c = new SessionStderrCollector(WORKER_ID);
    c.push('error: --session-id can only be used with --fork-session');
    expect(c.isSteeringDeliveryCrash).toBe(true);

    const clean = new SessionStderrCollector(WORKER_ID);
    clean.push('some other failure');
    expect(clean.isSteeringDeliveryCrash).toBe(false);
  });
});

describe('flushStderrTrace', () => {
  test('produces a trace on a zero-turn session end (no turns, no result)', () => {
    const worker = makeWorker({ turns: 0 });
    const c = new SessionStderrCollector(WORKER_ID, TASK_ID);
    c.push('claude: error while loading shared libraries');

    const trace = flushStderrTrace(worker, c);
    expect(trace).not.toBeNull();
    expect(worker.pendingErrorTraces).toHaveLength(1);
    expect(worker.pendingErrorTraces[0].source).toBe('stderr');
    expect(worker.pendingErrorTraces[0].excerpt).toContain('shared libraries');
    expect(worker.pendingErrorTraces[0].pattern).toBe('cli_stderr');
  });

  test('classifies a steering-delivery crash as cli_spawn_error', () => {
    const worker = makeWorker();
    const c = new SessionStderrCollector(WORKER_ID);
    c.push('--session-id can only be used with --fork-session');
    flushStderrTrace(worker, c);
    expect(worker.pendingErrorTraces[0].pattern).toBe('cli_spawn_error');
  });

  test('returns null and appends nothing when there was no stderr', () => {
    const worker = makeWorker();
    const c = new SessionStderrCollector(WORKER_ID);
    expect(flushStderrTrace(worker, c)).toBeNull();
    expect(worker.pendingErrorTraces).toBeUndefined();
  });

  test('is idempotent — a second flush with no new stderr adds nothing', () => {
    const worker = makeWorker();
    const c = new SessionStderrCollector(WORKER_ID);
    c.push('boom');
    expect(flushStderrTrace(worker, c)).not.toBeNull();
    expect(flushStderrTrace(worker, c)).toBeNull();
    expect(worker.pendingErrorTraces).toHaveLength(1);
  });

  test('flushes again when new stderr arrives after the first flush', () => {
    const worker = makeWorker();
    const c = new SessionStderrCollector(WORKER_ID);
    c.push('first failure');
    flushStderrTrace(worker, c);
    worker.pendingErrorTraces = []; // simulate worker-sync draining the buffer
    c.push('second failure');
    const trace = flushStderrTrace(worker, c);
    expect(trace).not.toBeNull();
    expect(worker.pendingErrorTraces[0].excerpt).toContain('second failure');
  });

  test('clamps the excerpt to the server-side trace limit', () => {
    const worker = makeWorker();
    const c = new SessionStderrCollector(WORKER_ID);
    c.push('y'.repeat(5000));
    flushStderrTrace(worker, c);
    expect(worker.pendingErrorTraces[0].excerpt.length).toBeLessThanOrEqual(STDERR_TRACE_EXCERPT_BYTES);
  });
});

// ─── 2. Transcript building + redaction ──────────────────────────────────────

describe('buildSessionTranscript', () => {
  const SECRET = 'bld_supersecretkeyvalue0123456789';

  test('emits one JSON object per line with a session header first', () => {
    const worker = makeWorker({
      sessionId: 'sess-1',
      messages: [{ type: 'text', content: 'hello' }],
      toolCalls: [{ name: 'Bash', input: { command: 'ls' } }],
      output: ['line one'],
    });
    const body = buildSessionTranscript(worker, [], 'some stderr');
    const lines = body.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0].type).toBe('session');
    expect(lines[0].workerId).toBe(WORKER_ID);
    expect(lines[0].sessionId).toBe('sess-1');
    expect(lines[0].stderr).toContain('some stderr');
    expect(lines.some(l => l.type === 'message')).toBe(true);
    expect(lines.some(l => l.type === 'tool_call')).toBe(true);
    expect(lines.some(l => l.type === 'output')).toBe(true);
  });

  test('redacts known secrets before the body is ever uploaded', () => {
    const worker = makeWorker({
      error: `auth failed for ${SECRET}`,
      messages: [{ type: 'text', content: `token is ${SECRET}` }],
      toolCalls: [{ name: 'Bash', input: { command: `curl -H "x: ${SECRET}"` }, result: SECRET }],
      output: [`echo ${SECRET}`],
    });
    const body = buildSessionTranscript(worker, [{ label: 'ANTHROPIC_API_KEY', value: SECRET }], SECRET);
    expect(body).not.toContain(SECRET);
    expect(body).toContain('[REDACTED:ANTHROPIC_API_KEY]');
  });

  test('redacts token-shaped strings even without a known-secret list', () => {
    const worker = makeWorker({ output: [`export KEY=${SECRET}`] });
    const body = buildSessionTranscript(worker, []);
    expect(body).not.toContain(SECRET);
  });

  test('records a zero-turn silent-start session rather than producing nothing', () => {
    const worker = makeWorker({ sessionId: undefined, turns: 0, messages: [], toolCalls: [], output: [] });
    const body = buildSessionTranscript(worker, [], 'bwrap: No permitted namespaces');
    const lines = body.trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('session');
    expect(lines[0].sessionId).toBeNull();
    expect(lines[0].turns).toBe(0);
    expect(lines[0].stderr).toContain('bwrap');
  });

  test('truncates a runaway transcript below the upload ceiling', () => {
    const bigMessages = Array.from({ length: 20_000 }, (_, i) => ({
      type: 'text',
      content: `message ${i} ${'z'.repeat(500)}`,
    }));
    const body = buildSessionTranscript(makeWorker({ messages: bigMessages }), []);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    const lines = body.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[lines.length - 1].type).toBe('truncated');
  });
});

describe('buildSessionLogBody', () => {
  test('serialises session log entries as JSONL with secrets redacted', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    const body = buildSessionLogBody(
      [{ ts: 1, level: 'error', event: 'session_stderr', workerId: WORKER_ID, detail: `token ${secret}` }],
      [{ label: 'GITHUB_TOKEN', value: secret }],
    );
    expect(body).not.toContain(secret);
    expect(JSON.parse(body.trim()).event).toBe('session_stderr');
  });

  test('returns an empty string when there are no entries', () => {
    expect(buildSessionLogBody([], [])).toBe('');
  });
});

// ─── 3. Upload behaviour ─────────────────────────────────────────────────────

describe('uploadSessionDiagnostics', () => {
  function deps(overrides: Record<string, any> = {}) {
    return {
      requestUploadUrl: mock(async (_workerId: string, _kind: string, _size: number) => ({
        uploadUrl: 'https://storage.example.invalid/signed',
        storageKey: 'sessions/t/w/x/transcript.jsonl',
      })),
      put: mock(async () => true),
      ...overrides,
    };
  }

  test('declares the exact byte length it intends to PUT', async () => {
    const d = deps();
    const worker = makeWorker({ output: ['hello'] });
    await uploadSessionDiagnostics(worker, [], d as any);

    const [, kind, sizeBytes] = d.requestUploadUrl.mock.calls[0];
    expect(kind).toBe('transcript');
    const putBody = d.put.mock.calls[0][1];
    expect(sizeBytes).toBe(Buffer.byteLength(putBody));
    expect(d.put.mock.calls[0][3]).toBe(sizeBytes);
  });

  test('uploads a body that contains no known secret', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const d = deps();
    const worker = makeWorker({ output: [`key=${secret}`] });
    await uploadSessionDiagnostics(worker, [{ label: 'ANTHROPIC_API_KEY', value: secret }], d as any);
    expect(d.put.mock.calls[0][1]).not.toContain(secret);
  });

  test('skips quietly when the server declines to sign (storage off / sensitive / write-once)', async () => {
    const d = deps({ requestUploadUrl: mock(async () => null) });
    const result = await uploadSessionDiagnostics(makeWorker(), [], d as any);
    expect(result.transcript).toBe('skipped');
    expect(d.put).not.toHaveBeenCalled();
  });

  test('does not throw when the presign request itself blows up', async () => {
    const d = deps({ requestUploadUrl: mock(async () => { throw new Error('403 Forbidden'); }) });
    const result = await uploadSessionDiagnostics(makeWorker(), [], d as any);
    expect(result.transcript).toBe('failed');
  });

  test('does not throw when the PUT fails — diagnostics never fail the worker', async () => {
    const d = deps({ put: mock(async () => { throw new Error('ECONNRESET'); }) });
    const result = await uploadSessionDiagnostics(makeWorker(), [], d as any);
    expect(result.transcript).toBe('failed');
    expect(logged.some(e => e.event === 'session_upload_failed')).toBe(true);
  });

  test('records the storage key in the session log so the object is locatable', async () => {
    const d = deps();
    await uploadSessionDiagnostics(makeWorker(), [], d as any);
    const entry = logged.find(e => e.event === 'session_upload');
    expect(entry?.detail).toContain('sessions/t/w/x/transcript.jsonl');
  });

  test('also ships the session log when entries exist', async () => {
    const d = deps({
      readLog: () => [{ ts: 1, level: 'error', event: 'session_stderr', workerId: WORKER_ID, detail: 'boom' }],
    });
    const result = await uploadSessionDiagnostics(makeWorker(), [], d as any);
    expect(result.sessionLog).toBe('uploaded');
    expect(d.requestUploadUrl.mock.calls.map((c: any[]) => c[1])).toContain('session-log');
  });

  test('the direct PUT to storage carries no buildd credential', async () => {
    const realFetch = globalThis.fetch;
    const seen: any[] = [];
    globalThis.fetch = ((url: string, opts: any) => {
      seen.push({ url: String(url), headers: opts?.headers, method: opts?.method });
      return Promise.resolve(new Response('', { status: 200 }));
    }) as any;
    try {
      // No `put` override — exercise the module's real fetch-based PUT.
      await uploadSessionDiagnostics(makeWorker(), [], {
        requestUploadUrl: async () => ({
          uploadUrl: 'https://storage.example.invalid/signed',
          storageKey: 'sessions/t/w/x/transcript.jsonl',
        }),
      } as any);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('PUT');
    const headerKeys = Object.keys(seen[0].headers ?? {}).map(k => k.toLowerCase());
    expect(headerKeys).not.toContain('authorization');
    expect(headerKeys).toContain('content-length');
  });

  test('refuses to attempt an upload above the ceiling', async () => {
    const d = deps();
    const huge = Array.from({ length: 200_000 }, (_, i) => 'q'.repeat(200) + i);
    await uploadSessionDiagnostics(makeWorker({ output: huge }), [], d as any);
    const sizeBytes = d.requestUploadUrl.mock.calls[0][2];
    expect(sizeBytes).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
  });
});
