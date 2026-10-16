import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import { INTERACTIVE_WORKER_RUNNER } from '@buildd/shared';
import { readInteractiveAnswer, type AnswerWorkerRow } from './await-answer';

/**
 * The wait capability: lets a plain shell command wait for the answer to an
 * interactive session's ask_human question (docs/specs/answered-question-resume.md).
 *
 * Claude Code wakes a session when a background Bash command exits, so a
 * session that runs ask_human's `waitCommand` with run_in_background spends no
 * turns while the person thinks. That shell has none of the session's
 * credentials (an OAuth token lives in the MCP client; a bld_ key does not own
 * an OAuth-claimed worker), so ask_human mints this instead. It can do one
 * thing: ask POST /api/workers/[id]/answer/wait whether ONE question on ONE
 * worker has been answered. That route answers status only, never the answer,
 * so a leaked command line discloses "answered or not" and nothing else.
 *
 * Format: `bldw_<base64url {w: workerId, a: askId, e: expiresAtMs}>.<HMAC>`,
 * signed with a key HKDF-derived from the server secret under its own label
 * (the presence-token / interactive-session pattern), so it never shares a key
 * with any other signed token. Not stored: what makes it single-question is
 * the ask id, which the mint stamps on the live question
 * (`workers.waitingFor.waitCapId`). A new ask replaces `waitingFor` and drops
 * the stamp; reading the answer acknowledges it. Either way the old capability
 * stops verifying against the row ('superseded').
 *
 * Fails closed: with no signing secret nothing is minted and nothing verifies.
 */

export const ANSWER_WAIT_CAP_PREFIX = 'bldw_';
/** The capability travels in this header, never the query string (which proxies and logs keep). */
export const ANSWER_WAIT_CAP_HEADER = 'x-buildd-wait-cap';
const KEY_LABEL = 'answer-wait-capability';

function signingKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY || null;
  if (!secret) return null;
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_LABEL, 32));
}

function mac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(`${KEY_LABEL}:${payload}`).digest('base64url');
}

/** Whether this server can mint (and so verify) capabilities at all. */
export function answerWaitSigningAvailable(): boolean {
  return signingKey() !== null;
}

/** A fresh ask id: 16 random bytes, url-safe. */
export function newWaitAskId(): string {
  return randomBytes(16).toString('base64url');
}

/** Null when no signing secret is configured. */
export function signAnswerWaitCapability(input: { workerId: string; askId: string; expiresAt: number }): string | null {
  const key = signingKey();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify({ w: input.workerId, a: input.askId, e: input.expiresAt })).toString('base64url');
  return `${ANSWER_WAIT_CAP_PREFIX}${payload}.${mac(key, payload)}`;
}

export type AnswerWaitCapabilityRefusal = 'missing' | 'malformed' | 'bad_signature' | 'wrong_worker' | 'expired' | 'unavailable';

export type VerifiedAnswerWaitCapability =
  | { ok: true; workerId: string; askId: string; expiresAt: number }
  | { ok: false; reason: AnswerWaitCapabilityRefusal };

/** Signature (constant-time), then worker, then expiry. Says nothing about whether the ask is still open. */
export function verifyAnswerWaitCapability(
  cap: string | null | undefined,
  workerId: string,
  now: number = Date.now(),
): VerifiedAnswerWaitCapability {
  if (!cap) return { ok: false, reason: 'missing' };
  const key = signingKey();
  if (!key) return { ok: false, reason: 'unavailable' };
  if (!cap.startsWith(ANSWER_WAIT_CAP_PREFIX)) return { ok: false, reason: 'malformed' };
  const body = cap.slice(ANSWER_WAIT_CAP_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0 || dot === body.length - 1) return { ok: false, reason: 'malformed' };
  const payload = body.slice(0, dot);
  const given = Buffer.from(body.slice(dot + 1));
  const expected = Buffer.from(mac(key, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  let parsed: { w?: unknown; a?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed.w !== 'string' || typeof parsed.a !== 'string' || !parsed.a || typeof parsed.e !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.w !== workerId) return { ok: false, reason: 'wrong_worker' };
  if (now >= parsed.e) return { ok: false, reason: 'expired' };
  return { ok: true, workerId: parsed.w, askId: parsed.a, expiresAt: parsed.e };
}

export type AnswerWaitStatus =
  | { state: 'waiting' }
  | { state: 'answered' }
  | { state: 'ended'; reason: string }
  /** The capability's ask is no longer the one open, or its answer was already read. */
  | { state: 'superseded' }
  | { state: 'not_interactive' };

/**
 * Where a capability's ask stands, read from the same record await_answer
 * reads (lib/await-answer.ts). An answer counts only if /respond recorded it
 * against this ask (`answerDelivery.waitCapId`).
 */
export function answerWaitStatus(input: { worker: AnswerWorkerRow; taskContext: unknown; askId: string }): AnswerWaitStatus {
  const { worker, askId } = input;
  if (worker.runner !== INTERACTIVE_WORKER_RUNNER) return { state: 'not_interactive' };
  const read = readInteractiveAnswer({ worker, taskContext: input.taskContext });
  if (read.state === 'answered') {
    const context = (input.taskContext && typeof input.taskContext === 'object' ? input.taskContext : {}) as Record<string, unknown>;
    const delivery = context.answerDelivery as { workerId?: string; messageId?: string; waitCapId?: string } | undefined;
    const ours = delivery?.waitCapId === askId && delivery.workerId === worker.id && delivery.messageId === read.messageId;
    return ours ? { state: 'answered' } : { state: 'superseded' };
  }
  if (read.state === 'waiting') {
    const stamp = (worker.waitingFor as { waitCapId?: unknown } | null)?.waitCapId;
    return stamp === askId ? { state: 'waiting' } : { state: 'superseded' };
  }
  if (read.reasonCode === 'session_ended') return { state: 'ended', reason: worker.status };
  return { state: 'superseded' };
}

/**
 * The waiter, POSIX sh + curl only (never the buildd CLI, which loads a repo
 * .env and can claim tasks). Arguments: $1 wait URL, $2 capability, $3 park
 * deadline (epoch seconds). Each POST long-polls up to 45 s server-side.
 *
 * Exit codes: 0 answered; 1 curl missing; 2 park deadline passed; 3 the
 * capability was refused (superseded, expired, invalid); 4 nothing left to
 * wait for (worker ended or gone). Transient failures (network, 429, 5xx)
 * retry after 2 s, then every 30 s, bounded by the deadline. Every non-zero
 * exit prints one line saying why.
 */
const WAIT_SCRIPT = [
  'u=$1;c=$2;d=$3;f=0;',
  'command -v curl >/dev/null 2>&1||{ echo "buildd: curl not found, wait with await_answer instead" >&2;exit 1;};',
  'while :;do ',
  'if [ "$(date +%s)" -ge "$d" ];then echo "buildd: question expired unanswered" >&2;exit 2;fi;',
  `r=$(curl -sS -m 60 -X POST -H "${ANSWER_WAIT_CAP_HEADER}: $c" -H "content-type: application/json" -d "{}" -w "XHTTPX%{http_code}" "$u" 2>/dev/null);`,
  'h=${r##*XHTTPX};b=${r%XHTTPX*};',
  'x=$(printf %s "$b"|sed -n "s/.*\\"reason\\":\\"\\([^\\"]*\\)\\".*/\\1/p");',
  'case $h in ',
  '200) f=0;case $b in ',
  '*\\"answered\\":true*) echo "buildd: answered, call await_answer {waitSeconds:0} to read it";exit 0;; ',
  '*\\"state\\":\\"waiting\\"*) sleep 1;; ',
  '*) echo "buildd: stopped waiting (${x:-ended})" >&2;exit 4;; ',
  'esac;; ',
  '401) echo "buildd: wait link no longer valid (${x:-refused}), call await_answer" >&2;exit 3;; ',
  '403|404) echo "buildd: nothing to wait for (${x:-gone}), call await_answer" >&2;exit 4;; ',
  '*) f=$((f+1));if [ $f -lt 6 ];then sleep 2;else sleep 30;fi;; ',
  'esac;done',
].join('');

const SAFE_ARG = /^[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/;

/**
 * The one-line command ask_human hands back:
 *   sh -c '<WAIT_SCRIPT>' buildd-wait '<waitUrl>' '<capability>' <deadlineEpochSeconds>
 * Inputs are server-built; anything that could leave its single quotes is refused.
 */
export function buildAnswerWaitCommand(input: { waitUrl: string; capability: string; expiresAt: number }): string {
  if (!/^https?:\/\//.test(input.waitUrl) || !SAFE_ARG.test(input.waitUrl)) throw new Error('waitUrl is not a plain URL');
  if (!SAFE_ARG.test(input.capability)) throw new Error('capability has characters a shell argument cannot carry');
  const deadline = Math.floor(input.expiresAt / 1000);
  return `sh -c '${WAIT_SCRIPT}' buildd-wait '${input.waitUrl}' '${input.capability}' ${deadline}`;
}
