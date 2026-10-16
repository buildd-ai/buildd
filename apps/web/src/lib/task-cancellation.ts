/**
 * Why a task was cancelled (failure-incident-recovery §18.5).
 *
 * An API cancel MUST say why: `cancelReason`, or `supersededBy` when the work
 * landed elsewhere (another task, or a PR). A dashboard cancel is the person's
 * own act and records the actor with a default reason. Stored as
 * `context.cancellation`; explain and the task page read it back as one line.
 *
 * Pure.
 */

export type CancellationSupersededBy = { taskId: string } | { prNumber: number };

export interface TaskCancellation {
  reason: string;
  supersededBy?: CancellationSupersededBy;
  /** `user:<id>` (dashboard) or `account:<id>` (API key / MCP). */
  actor: string;
  at: string;
}

export const DASHBOARD_CANCEL_REASON = 'Cancelled by a person from the dashboard';
const MAX_REASON = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CancellationParse =
  | { ok: true; cancellation: TaskCancellation }
  | { ok: false; code: 'cancel_reason_required' | 'invalid_cancel_reason' | 'invalid_superseded_by'; error: string };

function parseSupersededBy(raw: unknown): CancellationSupersededBy | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return 'invalid';
  const r = raw as Record<string, unknown>;
  if (typeof r.taskId === 'string' && UUID.test(r.taskId)) return { taskId: r.taskId.toLowerCase() };
  if (typeof r.prNumber === 'number' && Number.isInteger(r.prNumber) && r.prNumber > 0) return { prNumber: r.prNumber };
  return 'invalid';
}

export function supersededByText(s: CancellationSupersededBy): string {
  return 'prNumber' in s ? `PR #${s.prNumber}` : `task ${s.taskId.slice(0, 8)}`;
}

/** Validate a cancel's reason. `byPerson`: a dashboard session, whose own act needs no typed reason. */
export function parseCancellation(input: {
  cancelReason?: unknown;
  supersededBy?: unknown;
  actor: string;
  byPerson: boolean;
  now?: string;
}): CancellationParse {
  const supersededBy = parseSupersededBy(input.supersededBy);
  if (supersededBy === 'invalid') {
    return { ok: false, code: 'invalid_superseded_by', error: 'supersededBy must be { taskId: <full task UUID> } or { prNumber: <positive integer> }.' };
  }
  let reason: string | null = null;
  if (input.cancelReason !== undefined && input.cancelReason !== null) {
    if (typeof input.cancelReason !== 'string' || input.cancelReason.trim().length < 3) {
      return { ok: false, code: 'invalid_cancel_reason', error: 'cancelReason must be a sentence of at least 3 characters.' };
    }
    reason = input.cancelReason.trim().slice(0, MAX_REASON);
  }
  if (!reason && supersededBy) reason = `Superseded by ${supersededByText(supersededBy)}`;
  if (!reason && input.byPerson) reason = DASHBOARD_CANCEL_REASON;
  if (!reason) {
    return {
      ok: false,
      code: 'cancel_reason_required',
      error: 'Cancelling a task needs a reason: pass cancelReason (why it is no longer needed), or supersededBy ({ taskId } or { prNumber }) when its work landed elsewhere. Nothing was changed.',
    };
  }
  return {
    ok: true,
    cancellation: { reason, ...(supersededBy ? { supersededBy } : {}), actor: input.actor, at: input.now ?? new Date().toISOString() },
  };
}

export function readCancellation(context: unknown): TaskCancellation | null {
  const c = (context as { cancellation?: unknown } | null | undefined)?.cancellation as TaskCancellation | undefined;
  return c && typeof c === 'object' && typeof c.reason === 'string' ? c : null;
}

/** One plain line for a cancelled task; null when none was recorded. */
export function cancellationLine(context: unknown): string | null {
  const c = readCancellation(context);
  if (!c) return null;
  if (c.supersededBy) {
    const by = supersededByText(c.supersededBy);
    return c.reason.startsWith('Superseded by') ? `Cancelled: superseded by ${by}.` : `Cancelled: superseded by ${by}. ${c.reason}`;
  }
  return `Cancelled: ${c.reason}`;
}
