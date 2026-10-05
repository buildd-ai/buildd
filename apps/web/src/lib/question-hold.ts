/**
 * Held questions: parked without a ping, surfaced to a person later.
 *
 * The question gate (lib/question-gate-check.ts, packages/core/question-gate.ts)
 * can dispose an agent's question to `hold`: it did not look urgent enough to
 * interrupt someone right now. A held question parks exactly like an `ask`
 * (the worker sits in `waiting_input`, the dashboard shows the answer UI) but
 * nobody is notified when it parks. Two halves:
 *
 *  1. **Park** (`resolveHold`, called by PATCH /api/workers/[id]). The hold
 *     tag arrives on the runner's `waitingFor`; the server decides whether to
 *     honour it. It is honoured only when the gate could have produced it:
 *     the workspace gate is on, the workspace is not sensitive (a sensitive
 *     park stores no tag, so nothing could ever resurface it), and no hard
 *     rail applies to the task's pathManifest or the question's own text.
 *     The rail check repeats here on purpose: a rail-hit question is always
 *     an `ask`, whatever the runner sent. The deadline is clamped to at most
 *     `HOLD_RESURFACE_MS` from the first park, so a hold is never silent for
 *     longer than that, and a re-sent copy of the same question keeps its
 *     original deadline instead of pushing it out.
 *
 *  2. **Resurface** (`resurfaceHeldQuestions`, run from /api/cron/notify-away).
 *     A held question still unanswered at `resurfaceAt` is notified exactly as
 *     an `ask` would have been, once. One whose worker moved on (answered,
 *     resumed, ended, task closed) is dropped. No cron of its own: it rides the
 *     away-delivery route's two ticks — the Redis-gated `?gate=due` tick every
 *     2 minutes (reads `buildd:due:question-hold`, written at park time, and
 *     touches Postgres only when a hold is due) and the hourly floor tick
 *     (always queries, re-seeds the queue, so a lost write costs at most an
 *     hour). See docs/design/cron-wake-windows.md.
 *
 * Exactly-once: the settle UPDATE (`holdSettledAt IS NULL` → stamped) is the
 * claim, and only the run that wins it notifies. Claim before send, unlike
 * away delivery: a Pushover outage then loses one ping for a question that is
 * still on the dashboard and still reclaimed by the waiting-input sweep, while
 * send-before-claim would double-ping on every overlapping tick.
 */
import { sql, type SQL } from 'drizzle-orm';
import { HOLD_RESURFACE_MS, detectHardRail } from '@buildd/core/question-gate';
import { briefedQuestionText, questionNotificationText, withSanitizedBrief, type BriefedQuestion } from '@buildd/core/question-brief';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { gateEnabledFromGitConfig, hardRailContextFromGitConfig } from './question-gate-check';
import { notifyTeamOf } from './notify';
import { recordEvent, taskNeedsInputEvent } from './subscriptions';

/** Redis due-queue (`buildd:due:<name>`) of held questions; member = worker id, score = resurfaceAt. */
export const HOLD_QUEUE = 'question-hold';

/** Most held questions surfaced in one tick; the rest wait for the next one. */
export const RESURFACE_BATCH = 50;

type Q = Record<string, unknown>;

/** Strip the hold tags: what an honoured-as-ask question is stored as. */
export function withoutHold<T extends Q>(waitingFor: T): T {
  const { disposition: _d, holdReason: _r, resurfaceAt: _a, holdSettledAt: _s, holdOutcome: _o, ...rest } = waitingFor;
  return rest as T;
}

export interface HoldInput {
  /** The incoming (already brief-sanitized) question. */
  waitingFor: Q;
  /** What the worker row stores right now, for a re-sent copy of the same question. */
  stored: Q | null | undefined;
  sensitive: boolean;
  gitConfig: WorkspaceGitConfig | null | undefined;
  pathManifest: readonly string[] | null | undefined;
  nowMs: number;
}

export type HoldResolution =
  /** Store this and notify now (an ask, or a hold the server will not honour). */
  | { held: false; waitingFor: Q; rail?: string }
  /** Store this and do not notify; resurface at `resurfaceAtMs`. */
  | { held: true; waitingFor: Q; resurfaceAtMs: number }
  /** A re-send of a hold that already surfaced: store it as-is, do not notify again. */
  | { held: 'settled'; waitingFor: Q };

/** Pure: does the server honour this question's `hold`, and with what deadline? */
export function resolveHold(input: HoldInput): HoldResolution {
  const q = input.waitingFor;
  if (q.type !== 'question' || q.disposition !== 'hold') return { held: false, waitingFor: q };
  if (input.sensitive || !gateEnabledFromGitConfig(input.gitConfig)) return { held: false, waitingFor: withoutHold(q) };

  const rail = detectHardRail({
    ...hardRailContextFromGitConfig(input.gitConfig),
    pathManifest: input.pathManifest ?? null,
    questionText: briefedQuestionText(q as unknown as BriefedQuestion),
  });
  if (rail) return { held: false, waitingFor: withoutHold(q), rail };

  // The same question re-sent (the runner re-sends waitingFor after a 409 and
  // on its abort path): keep the first park's deadline and settlement.
  const stored = input.stored;
  const sameQuestion = !!stored && stored.type === 'question' && stored.disposition === 'hold' && stored.prompt === q.prompt;
  if (sameQuestion && typeof stored!.holdSettledAt === 'string') {
    return { held: 'settled', waitingFor: { ...q, resurfaceAt: stored!.resurfaceAt, holdSettledAt: stored!.holdSettledAt, holdOutcome: stored!.holdOutcome } };
  }

  const ceiling = input.nowMs + HOLD_RESURFACE_MS;
  const parse = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);
  const prior = sameQuestion ? parse(stored!.resurfaceAt) : NaN;
  const asked = parse(q.resurfaceAt);
  let at = Number.isFinite(prior) ? prior : Number.isFinite(asked) ? Math.min(asked, ceiling) : ceiling;
  if (at < input.nowMs && !Number.isFinite(prior)) at = input.nowMs;
  const { holdSettledAt: _s, holdOutcome: _o, ...rest } = q;
  return { held: true, waitingFor: { ...rest, resurfaceAt: new Date(at).toISOString() }, resurfaceAtMs: at };
}

/** Publish a held question's deadline to the due-queue. Never throws; the floor tick covers a lost write. */
export async function markHoldDue(workerId: string, resurfaceAtMs: number): Promise<void> {
  try {
    const { markDue } = await import('./redis');
    await markDue(HOLD_QUEUE, workerId, resurfaceAtMs);
  } catch {
    // Best effort by design.
  }
}

export interface ParkedQuestion {
  workspaceId: string;
  taskId: string | null;
  workerId: string;
  waitingFor: Q & { prompt?: unknown };
  sensitive: boolean;
}

/**
 * Tell a person a question is waiting: the team's Pushover channel, the
 * originating chat conversation, and the subscriptions ledger. The one notify
 * path for a parked question, shared by an immediate `ask` and a resurfaced
 * `hold`. Fire-and-forget: never throws, never awaits delivery.
 */
export function notifyParkedQuestion(p: ParkedQuestion, opts: { recordLedger: boolean }): void {
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
  const note = questionNotificationText(withSanitizedBrief(p.waitingFor) as unknown as BriefedQuestion, { sensitive: p.sensitive });
  const prompt = typeof p.waitingFor.prompt === 'string' ? p.waitingFor.prompt : undefined;
  void notifyTeamOf({ workspaceId: p.workspaceId }, 'needsAttention', {
    title: note.title,
    message: note.message,
    url: `${appBaseUrl}/app/tasks/${p.taskId}/respond`,
    urlTitle: 'Respond',
    priority: 0,
  });
  if (!p.taskId) return;
  const taskId = p.taskId;
  void import('./chat/mission-events')
    .then(m => m.postQuestionEvent({ taskId, workerId: p.workerId, prompt, sensitive: p.sensitive }))
    .catch(() => {});
  // recordEvent catches its own errors. The PATCH route records the ledger
  // row itself, after its worker write lands; the resurface sweep has already
  // won its claim, so it records here.
  if (opts.recordLedger) void recordEvent(taskNeedsInputEvent({ taskId, workerId: p.workerId, prompt }));
}

type Exec = (q: SQL) => Promise<{ rows?: unknown[] }>;

export interface ResurfaceDeps {
  exec?: Exec;
  now?: () => Date;
  notify?: (p: ParkedQuestion) => void;
  queue?: {
    clearThrough(nowMs: number): Promise<void>;
    reseed(entries: Array<{ member: string; dueAtMs: number }>): Promise<void>;
  };
}

export interface ResurfaceSummary {
  /** Held questions examined (due or, on the floor tick, still ahead). */
  held: number;
  /** Due and still unanswered: a person was notified. */
  resurfaced: number;
  /** Due, but the task closed underneath it: settled without a ping. */
  dropped: number;
  /** Not yet due (floor tick only: re-seeded into the queue). */
  ahead: number;
  /** Another tick settled it first. */
  lost: number;
  failed: number;
}

interface HeldRow {
  id: string;
  workspaceId: string;
  taskId: string | null;
  waitingFor: Q;
  resurfaceAt: string;
  taskStatus: string | null;
  dataClass: string | null;
}

const TERMINAL_TASK = ['completed', 'failed', 'cancelled'];

/**
 * Held, unsettled questions on workers still parked on them. A worker that
 * answered, resumed or ended no longer matches (its status left
 * `waiting_input`, or its waitingFor was replaced), which is how "the agent
 * moved on" drops a hold: nothing to surface, and its queue member is cleared.
 */
function heldSql(now: Date, onlyDue: boolean): SQL {
  return sql`
    SELECT w.id, w.workspace_id AS "workspaceId", w.task_id AS "taskId", w.waiting_for AS "waitingFor",
           w.waiting_for->>'resurfaceAt' AS "resurfaceAt", t.status AS "taskStatus", ws.data_class AS "dataClass"
    FROM workers w
    LEFT JOIN tasks t ON t.id = w.task_id
    LEFT JOIN workspaces ws ON ws.id = w.workspace_id
    WHERE w.status = 'waiting_input'
      AND w.waiting_for->>'type' = 'question'
      AND w.waiting_for->>'disposition' = 'hold'
      AND w.waiting_for->>'holdSettledAt' IS NULL
      AND w.waiting_for->>'resurfaceAt' IS NOT NULL
      ${onlyDue ? sql`AND (w.waiting_for->>'resurfaceAt')::timestamptz <= ${now.toISOString()}::timestamptz` : sql``}
    ORDER BY (w.waiting_for->>'resurfaceAt')::timestamptz
    LIMIT ${onlyDue ? RESURFACE_BATCH : RESURFACE_BATCH * 10}`;
}

/** The claim: stamp the settlement only if nobody has, on the same parked question. */
function settleSql(row: HeldRow, now: Date, outcome: 'resurfaced' | 'dropped'): SQL {
  return sql`
    UPDATE workers
    SET waiting_for = waiting_for || jsonb_build_object('holdSettledAt', ${now.toISOString()}::text, 'holdOutcome', ${outcome}::text)
    WHERE id = ${row.id}
      AND status = 'waiting_input'
      AND waiting_for->>'disposition' = 'hold'
      AND waiting_for->>'holdSettledAt' IS NULL
      AND waiting_for->>'resurfaceAt' = ${row.resurfaceAt}
    RETURNING id`;
}

async function dbExec(q: SQL): Promise<{ rows?: unknown[] }> {
  const { db } = await import('@buildd/core/db');
  return db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;
}

const defaultQueue: NonNullable<ResurfaceDeps['queue']> = {
  async clearThrough(nowMs) {
    const { clearDueThrough } = await import('./redis');
    await clearDueThrough(HOLD_QUEUE, nowMs);
  },
  async reseed(entries) {
    const { reseedDue } = await import('./redis');
    await reseedDue(HOLD_QUEUE, entries);
  },
};

/**
 * Surface every held question whose deadline passed. `floor` (the hourly
 * tick) also reads the holds still ahead and re-seeds the due-queue with them.
 */
export async function resurfaceHeldQuestions(opts: { floor: boolean }, deps: ResurfaceDeps = {}): Promise<ResurfaceSummary> {
  const exec = deps.exec ?? dbExec;
  const now = (deps.now ?? (() => new Date()))();
  const notify = deps.notify ?? (p => notifyParkedQuestion(p, { recordLedger: true }));
  const queue = deps.queue ?? defaultQueue;
  const summary: ResurfaceSummary = { held: 0, resurfaced: 0, dropped: 0, ahead: 0, lost: 0, failed: 0 };

  const rows = ((await exec(heldSql(now, !opts.floor))).rows ?? []) as HeldRow[];
  summary.held = rows.length;
  const ahead: Array<{ member: string; dueAtMs: number }> = [];

  for (const row of rows) {
    const dueAtMs = Date.parse(row.resurfaceAt);
    if (Number.isFinite(dueAtMs) && dueAtMs > now.getTime()) {
      summary.ahead++;
      ahead.push({ member: row.id, dueAtMs });
      continue;
    }
    const outcome = row.taskStatus && TERMINAL_TASK.includes(row.taskStatus) ? 'dropped' : 'resurfaced';
    try {
      const won = ((await exec(settleSql(row, now, outcome))).rows ?? []).length > 0;
      if (!won) { summary.lost++; continue; }
      if (outcome === 'dropped') { summary.dropped++; continue; }
      notify({
        workspaceId: row.workspaceId,
        taskId: row.taskId,
        workerId: row.id,
        waitingFor: row.waitingFor,
        sensitive: row.dataClass === 'sensitive',
      });
      summary.resurfaced++;
    } catch (err) {
      summary.failed++;
      console.error('[question-hold] resurface failed:', err instanceof Error ? err.message : 'unknown');
    }
  }

  // Everything due has been answered for (surfaced, dropped, or gone); a hold
  // still ahead is re-published by the floor tick, so the gated tick wakes on it.
  try {
    if (opts.floor) await queue.reseed(ahead);
    // A full batch may have left due holds behind: keep them in the queue so
    // the next gated tick takes them, rather than waiting for the floor.
    else if (rows.length < RESURFACE_BATCH) await queue.clearThrough(now.getTime());
  } catch {
    // Redis is an accelerator; the next floor tick re-seeds.
  }
  return summary;
}
