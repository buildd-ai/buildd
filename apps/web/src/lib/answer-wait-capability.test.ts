import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  ANSWER_WAIT_CAP_HEADER,
  answerWaitStatus,
  buildAnswerWaitCommand,
  newWaitAskId,
  signAnswerWaitCapability,
  verifyAnswerWaitCapability,
} from './answer-wait-capability';

// The wait capability: what lets a plain shell command (no buildd CLI, no
// OAuth token) wait for the answer to an interactive session's ask_human
// question. Narrow (one worker, one ask, status only), signed, expiring.

const WORKER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY };
  process.env.AUTH_SECRET = 'test-auth-secret-for-wait-caps';
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const sign = (over: Partial<{ workerId: string; askId: string; expiresAt: number }> = {}) =>
  signAnswerWaitCapability({ workerId: WORKER, askId: 'ask-1', expiresAt: NOW + 4 * HOUR, ...over })!;

describe('signAnswerWaitCapability / verifyAnswerWaitCapability', () => {
  it('a fresh capability verifies for its own worker and carries its ask', () => {
    const cap = sign();
    expect(cap.startsWith('bldw_')).toBe(true);
    expect(verifyAnswerWaitCapability(cap, WORKER, NOW)).toEqual({ ok: true, workerId: WORKER, askId: 'ask-1', expiresAt: NOW + 4 * HOUR });
  });

  it('is refused once expired', () => {
    const cap = sign({ expiresAt: NOW + 1000 });
    expect(verifyAnswerWaitCapability(cap, WORKER, NOW + 1000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is refused for any other worker', () => {
    expect(verifyAnswerWaitCapability(sign(), OTHER, NOW)).toEqual({ ok: false, reason: 'wrong_worker' });
  });

  it('is refused when tampered with: payload or signature', () => {
    const cap = sign();
    const [payload, mac] = cap.slice('bldw_'.length).split('.');
    const forged = Buffer.from(JSON.stringify({ w: WORKER, a: 'ask-1', e: NOW + 400 * HOUR })).toString('base64url');
    expect(verifyAnswerWaitCapability(`bldw_${forged}.${mac}`, WORKER, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    const flipped = mac!.slice(0, -1) + (mac!.endsWith('A') ? 'B' : 'A');
    expect(verifyAnswerWaitCapability(`bldw_${payload}.${flipped}`, WORKER, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is refused when signed under another secret', () => {
    const cap = sign();
    process.env.AUTH_SECRET = 'a-different-secret';
    expect(verifyAnswerWaitCapability(cap, WORKER, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses missing and malformed values', () => {
    expect(verifyAnswerWaitCapability(null, WORKER, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyAnswerWaitCapability('', WORKER, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyAnswerWaitCapability('bld_abc', WORKER, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyAnswerWaitCapability('bldw_nodot', WORKER, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is not some other signed token: a presence-style mac over the same payload does not verify', () => {
    // Domain separation: the key is HKDF-derived under its own label.
    const payload = Buffer.from(JSON.stringify({ w: WORKER, a: 'ask-1', e: NOW + HOUR })).toString('base64url');
    const { createHmac } = require('crypto');
    const rawMac = createHmac('sha256', process.env.AUTH_SECRET!).update(payload).digest('base64url');
    expect(verifyAnswerWaitCapability(`bldw_${payload}.${rawMac}`, WORKER, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('fails closed with no signing secret', () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    expect(signAnswerWaitCapability({ workerId: WORKER, askId: 'a', expiresAt: NOW + HOUR })).toBeNull();
    expect(verifyAnswerWaitCapability('bldw_x.y', WORKER, NOW)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('ask ids are random and url-safe', () => {
    const a = newWaitAskId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(newWaitAskId()).not.toBe(a);
  });
});

describe('answerWaitStatus', () => {
  const parked = (waitCapId: string | null = 'ask-1') => ({
    id: WORKER, runner: 'mcp', status: 'waiting_input',
    waitingFor: { type: 'question', prompt: 'Flag or straight on?', ...(waitCapId ? { waitCapId } : {}) },
    instructionHistory: [], continuationTaskId: null,
  });
  const answered = (deliveryAsk: string | undefined, deliveryState = 'pending') => ({
    worker: {
      id: WORKER, runner: 'mcp', status: 'running', waitingFor: null,
      instructionHistory: [{ id: 'msg-1', type: 'instruction', message: 'Behind a flag.', deliveryState }],
      continuationTaskId: null,
    },
    taskContext: {
      answerDelivery: { path: 'interactive', workerId: WORKER, messageId: 'msg-1', ...(deliveryAsk ? { waitCapId: deliveryAsk } : {}) },
    },
  });

  it('waiting while its own ask is the open question', () => {
    expect(answerWaitStatus({ worker: parked(), taskContext: {}, askId: 'ask-1' })).toEqual({ state: 'waiting' });
  });

  it('superseded once a newer ask replaced the question', () => {
    expect(answerWaitStatus({ worker: parked('ask-2'), taskContext: {}, askId: 'ask-1' })).toEqual({ state: 'superseded' });
    expect(answerWaitStatus({ worker: parked(null), taskContext: {}, askId: 'ask-1' })).toEqual({ state: 'superseded' });
  });

  it('answered when the unread answer is the one to its own ask', () => {
    const { worker, taskContext } = answered('ask-1');
    expect(answerWaitStatus({ worker, taskContext, askId: 'ask-1' })).toEqual({ state: 'answered' });
  });

  it('superseded when the unread answer belongs to another ask', () => {
    const { worker, taskContext } = answered('ask-2');
    expect(answerWaitStatus({ worker, taskContext, askId: 'ask-1' })).toEqual({ state: 'superseded' });
  });

  it('superseded once the answer has been read (consumed)', () => {
    const { worker, taskContext } = answered('ask-1', 'acknowledged');
    expect(answerWaitStatus({ worker, taskContext, askId: 'ask-1' })).toEqual({ state: 'superseded' });
  });

  it('ended when the worker has ended', () => {
    expect(answerWaitStatus({ worker: { ...parked(), status: 'failed' }, taskContext: {}, askId: 'ask-1' })).toEqual({ state: 'ended', reason: 'failed' });
  });

  it('not_interactive for a runner-managed worker', () => {
    expect(answerWaitStatus({ worker: { ...parked(), runner: 'runner-1' }, taskContext: {}, askId: 'ask-1' })).toEqual({ state: 'not_interactive' });
  });
});

describe('buildAnswerWaitCommand', () => {
  const CAP = 'bldw_eyJ3IjoiMSJ9.abc-DEF_123';
  const URL = `https://buildd.dev/api/workers/${WORKER}/answer/wait`;

  it('is plain sh + curl, never the buildd CLI, with the capability sent as a header', () => {
    const cmd = buildAnswerWaitCommand({ waitUrl: URL, capability: CAP, expiresAt: NOW + HOUR });
    expect(cmd.startsWith("sh -c '")).toBe(true);
    expect(cmd).toContain('curl');
    expect(cmd).toContain(ANSWER_WAIT_CAP_HEADER);
    expect(cmd).not.toMatch(/(^|[\s;|&(])buildd\s/);
    expect(cmd).toContain(`'${URL}'`);
    expect(cmd).toContain(`'${CAP}'`);
    expect(cmd).not.toContain(`?cap=`);
    expect(cmd).toContain(String(Math.floor((NOW + HOUR) / 1000)));
  });

  it('carries no long-lived credential: no bearer, no bld_/bldt_/bldp_ key', () => {
    const cmd = buildAnswerWaitCommand({ waitUrl: URL, capability: CAP, expiresAt: NOW + HOUR });
    expect(cmd.toLowerCase()).not.toContain('authorization');
    expect(cmd).not.toMatch(/\bbld[tp]?_/);
  });

  it('refuses inputs that would break out of the quoting', () => {
    expect(() => buildAnswerWaitCommand({ waitUrl: URL, capability: "x'; rm -rf ~; '", expiresAt: NOW })).toThrow();
    expect(() => buildAnswerWaitCommand({ waitUrl: "https://x/'", capability: CAP, expiresAt: NOW })).toThrow();
  });
});

// The generated command, run for real against a tiny local stub.
describe('the wait command against a local stub', () => {
  type Reply = { status: number; body?: unknown };
  async function run(replies: Reply[], opts: { expiresInMs?: number } = {}) {
    const seen: { cap: string | null; method: string }[] = [];
    let i = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({ cap: req.headers.get(ANSWER_WAIT_CAP_HEADER), method: req.method });
        const r = replies[Math.min(i++, replies.length - 1)]!;
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
      },
    });
    try {
      const cmd = buildAnswerWaitCommand({
        waitUrl: `http://127.0.0.1:${server.port}/api/workers/${WORKER}/answer/wait`,
        capability: 'bldw_test.cap',
        expiresAt: Date.now() + (opts.expiresInMs ?? 60_000),
      });
      const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' });
      const code = await proc.exited;
      const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      return { code, out, seen };
    } finally {
      server.stop(true);
    }
  }

  it('keeps waiting through a timeout, then exits 0 once answered, sending the capability header', async () => {
    const { code, out, seen } = await run([
      { status: 200, body: { answered: false, state: 'waiting', retryAfter: 0 } },
      { status: 200, body: { answered: true, state: 'answered' } },
    ]);
    expect(code).toBe(0);
    expect(out).toContain('await_answer');
    expect(seen).toHaveLength(2);
    expect(seen.every(s => s.cap === 'bldw_test.cap' && s.method === 'POST')).toBe(true);
  }, 20_000);

  it('retries a transient 5xx, then exits 0 once answered', async () => {
    const { code, seen } = await run([
      { status: 503, body: { error: 'busy' } },
      { status: 200, body: { answered: true, state: 'answered' } },
    ]);
    expect(code).toBe(0);
    expect(seen).toHaveLength(2);
  }, 20_000);

  it('exits non-zero with a one-line reason on a refused capability', async () => {
    const { code, out } = await run([{ status: 401, body: { error: 'invalid_wait_capability', reason: 'superseded' } }]);
    expect(code).toBe(3);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toContain('superseded');
  }, 20_000);

  it('exits non-zero when the session has ended', async () => {
    const { code, out } = await run([{ status: 200, body: { answered: false, state: 'ended', reason: 'cancelled' } }]);
    expect(code).toBe(4);
    expect(out).toContain('cancelled');
  }, 20_000);

  it('exits non-zero once past the park deadline without calling', async () => {
    const { code, out, seen } = await run([{ status: 200, body: { answered: true } }], { expiresInMs: -1000 });
    expect(code).toBe(2);
    expect(out).toContain('expired');
    expect(seen).toHaveLength(0);
  }, 20_000);
});
