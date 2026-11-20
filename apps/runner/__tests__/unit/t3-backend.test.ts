import { describe, expect, test } from 'bun:test';
import { T3Backend, type T3Command } from '../../src/backends/t3-backend';
import type { RunStreamedOpts } from '../../src/backends/types';

const opts: RunStreamedOpts = { prompt: 'Check the task', cwd: process.cwd(), sessionId: 'test-session', allowReducedConfinement: true };
const snapshot = { thread: { threadId: 'test-thread', worktreePath: process.cwd(), activeRunId: null, status: 'completed', pendingRequestCount: 0, pendingBackgroundTasks: [], model: 'test-model' } };
function fixture(results: unknown[] = [snapshot, { threadId: 'test-thread', runId: 'run-1', status: 'completed', reply: 'Done', error: null }], codes = [0, 0]) {
  const calls: T3Command[] = [];
  const backend = new T3Backend({ threadId: 'test-thread', execute: async command => {
    calls.push(command);
    return { stdout: JSON.stringify(results.shift()), stderr: '', exitCode: codes.shift() ?? 0 };
  } });
  return { calls, run: (overrides: Partial<RunStreamedOpts> = {}) => Array.fromAsync(backend.runStreamed({ ...opts, ...overrides })) };
}
describe('experimental T3 backend', () => {
  test('sends prompt on stdin and reports completion without inventing usage', async () => {
    const f = fixture();
    const prompt = 'literal $() `quoted` & | "\nsecond line';
    const events = await f.run({ prompt });
    expect(f.calls[1]).toEqual({ args: ['thread', 'send', 'test-thread', '-', '--wait', '--json'], cwd: opts.cwd, stdin: prompt });
    expect(events.slice(-2)).toEqual([{ type: 'turn_complete' }, { type: 'complete', summary: 'Done' }]);
  });
  for (const [name, override] of Object.entries({ confinement: { allowReducedConfinement: false }, sandbox: { sandboxMode: 'read-only' }, budget: { maxBudgetUsd: 1 }, turns: { maxTurns: 2 }, schema: { outputSchema: {} }, environment: { env: { EXAMPLE: 'value' } }, cancellation: { signal: new AbortController().signal }, resume: { resumeThreadId: 'other-thread' } })) {
    test(`rejects unsupported ${name} before executing`, async () => {
      const f = fixture();
      expect((await f.run(override as Partial<RunStreamedOpts>))[0]?.type).toBe('error');
      expect(f.calls).toHaveLength(0);
    });
  }
  test('rejects streaming input before executing', async () => {
    const f = fixture();
    expect((await f.run({ prompt: (async function* () { yield 'message'; })() }))[0]?.type).toBe('error');
    expect(f.calls).toHaveLength(0);
  });
  for (const change of [{ worktreePath: null }, { worktreePath: '/other' }, { activeRunId: 'busy' }, { status: 'running' }, { pendingRequestCount: 1 }, { pendingBackgroundTasks: [{}] }, { threadId: 'other' }]) {
    test(`does not send to an unsuitable thread: ${JSON.stringify(change)}`, async () => {
      const f = fixture([{ thread: { ...snapshot.thread, ...change } }]);
      expect((await f.run()).at(-1)?.type).toBe('error');
      expect(f.calls).toHaveLength(1);
    });
  }
  test('rejects a model mismatch', async () => {
    const f = fixture();
    expect((await f.run({ model: 'other' })).at(-1)?.type).toBe('error');
    expect(f.calls).toHaveLength(1);
  });
  for (const [status, code] of [['waiting', 2], ['failed', 1], ['interrupted', 1], ['completed', 1]] as const) {
    test(`does not report ${status}/${code} as success`, async () => {
      const f = fixture([snapshot, { threadId: 'test-thread', runId: 'run-1', status, reply: 'text', error: null }], [0, code]);
      const events = await f.run();
      expect(events.at(-1)?.type).toBe('error');
      expect(events.some(e => e.type === 'complete')).toBe(false);
    });
  }
  test('rejects mismatched result identity and malformed output', async () => {
    for (const result of [null, {}, { threadId: 'other', runId: 'run-1', status: 'completed', reply: 'wrong' }]) {
      expect((await fixture([snapshot, result]).run()).at(-1)?.type).toBe('error');
    }
  });
  test('executes subprocesses without shell interpolation and preserves stdin', async () => {
    const program = `const args = process.argv.slice(1); const prompt = args.includes('send') ? await Bun.stdin.text() : ''; console.log(JSON.stringify(args.includes('show') ? ${JSON.stringify(snapshot)} : {threadId:'test-thread',runId:'run-1',status:'completed',reply:prompt,error:null}));`;
    const backend = new T3Backend({ threadId: 'test-thread', command: [process.execPath, '-e', program, '--'] });
    const prompt = 'literal $(echo unsafe) `quoted` & | "\nsecond line';
    const events = await Array.fromAsync(backend.runStreamed({ ...opts, prompt }));
    expect(events.at(-1)).toEqual({ type: 'complete', summary: prompt });
  });
  test('reports invalid JSON and process launch failures as backend errors', async () => {
    for (const execute of [async () => ({ stdout: 'not json', stderr: '', exitCode: 0 }), async () => { throw new Error('missing CLI'); }]) {
      const backend = new T3Backend({ threadId: 'test-thread', execute });
      expect((await Array.fromAsync(backend.runStreamed(opts))).at(-1)?.type).toBe('error');
    }
  });
  test('rejects concurrent calls on one adapter', async () => {
    const backend = new T3Backend({ threadId: 'test-thread', execute: async () => ({ stdout: JSON.stringify(snapshot), stderr: '', exitCode: 0 }) });
    const first = backend.runStreamed(opts)[Symbol.asyncIterator]();
    expect((await first.next()).value?.type).toBe('progress');
    expect((await Array.fromAsync(backend.runStreamed(opts)))[0]).toEqual({ type: 'error', error: 'This T3 backend already has an active run' });
    await first.return?.();
  });
});
