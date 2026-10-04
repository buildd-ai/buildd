import { expect, test } from 'bun:test';
import { readCompletedSessionTranscript } from './completed-session-transcript';
const worker = { id: 'worker-test', workspaceId: 'workspace-test', status: 'completed', workspace: { teamId: 'team-test', dataClass: 'standard' } };
const header = { type: 'session', schemaVersion: 1, workerId: worker.id, workspaceId: worker.workspaceId, messageCount: 0, toolCallCount: 1 };
const call = { type: 'tool_call', seq: 0, toolCall: { name: 'Read', input: { path: 'example.ts' } } };
const jsonl = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const read = (text: string, w = worker) => readCompletedSessionTranscript(worker.id, { loadWorker: async () => w, open: async () => (async function* () { yield Buffer.from(text); })() });
test('full small transcript preserves existing records and source', async () => {
  const r = await read(jsonl(header, call));
  expect(r.traceAvailability).toBe('full');
  expect(r.records[1]).toEqual(call);
  expect(r.source?.kind).toBe('session-diagnostics');
});
test('at trailing window cap, early tools may be missing even though header counts match', async () => {
  const r = await read(jsonl({ ...header, toolCallCount: 200 }, ...Array.from({ length: 200 }, (_, seq) => ({ ...call, seq }))));
  expect(r.traceAvailability).toBe('truncated');
  expect(r.missingPortions).toContain('early_tool_calls');
});
test('size marker and count mismatch identify missing tail', async () => {
  const r = await read(jsonl(header, { type: 'truncated', reason: 'transcript_size_cap' }));
  expect(r.traceAvailability).toBe('truncated');
  expect(r.missingPortions).toContain('tail');
});
test('absent object differs from storage failure', async () => {
  for (const [error, reason] of [[{ name: 'NoSuchKey' }, 'object_missing'], [new Error('private details'), 'read_failed']] as const) {
    const r = await readCompletedSessionTranscript(worker.id, { loadWorker: async () => worker, open: async () => { throw error; } });
    expect(r.traceAvailability).toBe('absent');
    expect(r.reason).toBe(reason);
    expect(JSON.stringify(r)).not.toContain('private details');
  }
});
test('sensitive and active workers are excluded before storage access', async () => {
  for (const w of [{ ...worker, workspace: { ...worker.workspace, dataClass: 'sensitive' } }, { ...worker, status: 'working' }]) {
    let opened = false;
    const r = await readCompletedSessionTranscript(worker.id, { loadWorker: async () => w, open: async () => { opened = true; throw new Error(); } });
    expect(r.traceAvailability).toBe('absent');
    expect(opened).toBe(false);
  }
});
test('malformed JSONL fails open and retains usable records without claiming completeness', async () => {
  const r = await read(jsonl(header) + 'broken\n' + jsonl(call));
  expect(r.traceAvailability).toBe('truncated');
  expect(r.missingPortions).toContain('malformed_records');
  expect(r.records).toHaveLength(2);
});
test('missing header or mismatched identity is never full', async () => {
  expect((await read(jsonl(call))).traceAvailability).toBe('truncated');
  expect((await read(jsonl({ ...header, workerId: 'other' }, call))).records).toEqual([]);
});
test('a stream failing after partial data returns absent with no misleading partial trace', async () => {
  const r = await readCompletedSessionTranscript(worker.id, { loadWorker: async () => worker, open: async () => (async function* () { yield Buffer.from(jsonl(header)); throw new Error('backend'); })() });
  expect(r.traceAvailability).toBe('absent');
  expect(r.reason).toBe('read_failed');
  expect(r.records).toEqual([]);
});
test('count and sequence gaps prevent complete coverage', async () => {
  expect((await read(jsonl(header, { ...call, seq: 2 }))).traceAvailability).toBe('truncated');
  expect((await read(jsonl({ ...header, toolCallCount: -1 }, call))).traceAvailability).toBe('truncated');
});
test('empty objects are absent', async () => {
  expect((await read('')).reason).toBe('empty_object');
});
test('all shared terminal statuses are eligible', async () => {
  for (const status of ['completed', 'failed', 'error', 'superseded', 'done']) {
    expect((await read(jsonl(header, call), { ...worker, status })).traceAvailability).toBe('full');
  }
});
test('both message and output trailing windows are disclosed', async () => {
  const r = await read(jsonl({ ...header, messageCount: 200 }, call,
    ...Array.from({ length: 200 }, (_, seq) => ({ type: 'message', seq, message: {} })),
    ...Array.from({ length: 100 }, (_, seq) => ({ type: 'output', seq, line: 'text' }))));
  expect(r.missingPortions).toContain('early_messages');
  expect(r.missingPortions).toContain('early_output');
});
test('oversized objects are bounded and cannot claim full coverage', async () => {
  const r = await readCompletedSessionTranscript(worker.id, { loadWorker: async () => worker, open: async () => (async function* () {
    yield Buffer.alloc(8 * 1024 * 1024 + 1);
    throw new Error('must not request another chunk');
  })() });
  expect(r.traceAvailability).toBe('absent');
  expect(r.reason).toBe('read_size_limit');
});
test('worker lookup failure also fails open without reading storage', async () => {
  const r = await readCompletedSessionTranscript(worker.id, { loadWorker: async () => { throw new Error('database'); }, open: async () => { throw new Error('unexpected'); } });
  expect(r.traceAvailability).toBe('absent');
  expect(r.reason).toBe('read_failed');
});
test('duplicate headers and tool calls without arguments cannot establish full evidence', async () => {
  expect((await read(jsonl(header, header, call))).traceAvailability).toBe('truncated');
  expect((await read(jsonl(header, { type: 'tool_call', seq: 0 }))).traceAvailability).toBe('truncated');
});
