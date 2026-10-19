import { describe, expect, it } from 'bun:test';
import {
  completeTaskAttemptFrom,
  completionReplayPayload,
  isCompleteTaskCall,
  replayCompletion,
} from '../../src/completion-replay';
import { ServerRefusalError } from '../../src/server-refusal';

const AGENT_PARAMS = { summary: 'Already fixed on dev by #5215; the failing test passes there.', alreadyShippedIn: 5215 };
const ECONNRESET_RESULT = 'Error: request to https://buildd.dev/api/mcp failed, reason: read ECONNRESET';

describe('isCompleteTaskCall', () => {
  it('matches the group tool, the legacy tool and a direct tool', () => {
    expect(isCompleteTaskCall('mcp__buildd__buildd_work', { action: 'complete_task', params: {} })).toBe(true);
    expect(isCompleteTaskCall('mcp__buildd__buildd', { action: 'complete_task', params: {} })).toBe(true);
    expect(isCompleteTaskCall('mcp__buildd__complete_task', {})).toBe(true);
    expect(isCompleteTaskCall('mcp__buildd__buildd_work', { action: 'create_pr' })).toBe(false);
    expect(isCompleteTaskCall('Bash', { command: 'complete_task' })).toBe(false);
  });
});

describe('completeTaskAttemptFrom', () => {
  const call = { toolName: 'mcp__buildd__buildd_work', input: { action: 'complete_task', params: AGENT_PARAMS } };

  it('an ECONNRESET error result is a transient failure carrying the agent params', () => {
    const a = completeTaskAttemptFrom({ ...call, resultText: ECONNRESET_RESULT, isError: true, now: 1 });
    expect(a).toEqual({ params: AGENT_PARAMS, transientFailure: true, at: 1 });
  });

  it('a gate refusal is not transient: the server decided', () => {
    const a = completeTaskAttemptFrom({ ...call, resultText: '**Cannot complete task:** requires a pull request', isError: true });
    expect(a?.transientFailure).toBe(false);
  });

  it('a successful result clears it', () => {
    expect(completeTaskAttemptFrom({ ...call, resultText: 'Task completed (12 turns)', isError: false })?.transientFailure).toBe(false);
  });

  it('a failing complete_task (error param) is never replayed', () => {
    const a = completeTaskAttemptFrom({ toolName: call.toolName, input: { action: 'complete_task', params: { error: 'gave up' } }, resultText: ECONNRESET_RESULT, isError: true });
    expect(a?.transientFailure).toBe(false);
  });

  it('other tools are ignored', () => {
    expect(completeTaskAttemptFrom({ toolName: 'Bash', input: {}, resultText: ECONNRESET_RESULT, isError: true })).toBeNull();
  });
});

describe('completionReplayPayload', () => {
  it('is the MCP handler payload: agent-authored, viaCompleteTask, alreadyShippedIn kept for attribution', () => {
    expect(completionReplayPayload(AGENT_PARAMS)).toEqual({
      status: 'completed',
      viaCompleteTask: true,
      summary: AGENT_PARAMS.summary,
      summarySource: 'agent',
      alreadyShippedIn: 5215,
    });
  });
});

function server(opts: { persisted?: boolean; failSends?: number; refuse?: number; down?: boolean } = {}) {
  let status = opts.persisted ? 'completed' : 'running';
  let failures = opts.failSends ?? 0;
  const sent: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  return {
    sent, sleeps,
    deps: {
      async remoteStatus() { return opts.down ? null : status; },
      async send(p: Record<string, unknown>) {
        sent.push(p);
        if (opts.down || failures-- > 0) throw new Error('read ECONNRESET');
        if (opts.refuse) throw ServerRefusalError.from({ status: opts.refuse, raw: '{"error":"requires a pull request"}', method: 'PATCH', endpoint: '/api/workers/w' });
        // First writer wins: a second completion is a 409 that changes nothing.
        if (status !== 'running') return { error: 'Worker already completed', abort: true };
        status = 'completed';
        return { status: 'completed' };
      },
      async sleep(ms: number) { sleeps.push(ms); },
    },
  };
}

describe('replayCompletion', () => {
  it('ECONNRESET after the server persisted the completion: nothing is sent, it landed', async () => {
    const s = server({ persisted: true });
    expect(await replayCompletion(s.deps, AGENT_PARAMS)).toEqual({ outcome: 'landed', sends: 0 });
    expect(s.sent).toHaveLength(0);
  });

  it('ECONNRESET before the server persisted it: one replay lands it', async () => {
    const s = server();
    expect(await replayCompletion(s.deps, AGENT_PARAMS)).toEqual({ outcome: 'landed', sends: 1 });
    expect(s.sent[0]).toMatchObject({ status: 'completed', summarySource: 'agent', alreadyShippedIn: 5215 });
  });

  it('a replay that itself resets is retried within the bound', async () => {
    const s = server({ failSends: 2 });
    expect(await replayCompletion(s.deps, AGENT_PARAMS)).toEqual({ outcome: 'landed', sends: 3 });
    expect(s.sleeps).toEqual([2_000, 8_000]);
  });

  it('bounded: a server that stays down is unreachable after three tries', async () => {
    const s = server({ down: true });
    expect(await replayCompletion(s.deps, AGENT_PARAMS)).toEqual({ outcome: 'unreachable', sends: 3 });
  });

  it('a 4xx is the server refusing the completion itself: no retry', async () => {
    const s = server({ refuse: 400 });
    expect(await replayCompletion(s.deps, AGENT_PARAMS)).toEqual({ outcome: 'refused', sends: 1 });
  });

  it('a send swallowed by the outbox ({}) is not taken as landed without the read-back', async () => {
    let reads = 0;
    const out = await replayCompletion({
      async remoteStatus() { reads++; return 'running'; },
      async send() { return {}; },
      async sleep() {},
    }, AGENT_PARAMS);
    expect(out.outcome).toBe('unreachable');
    expect(reads).toBe(6);
  });

  it('idempotent: replaying twice records one completion', async () => {
    const s = server();
    await replayCompletion(s.deps, AGENT_PARAMS);
    expect(await replayCompletion(s.deps, AGENT_PARAMS)).toEqual({ outcome: 'landed', sends: 0 });
    expect(s.sent).toHaveLength(1);
  });
});
