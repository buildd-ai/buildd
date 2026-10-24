/**
 * What the server said about this runner's last claim of each task, and about
 * its last broad claim (spec c7410e76 R-25). claims.log already records every
 * outcome for grep; this keeps the latest ones in memory so `buildd top` can
 * say what really holds a waiting task (a plan limit and when it lifts, a
 * cooldown, a local-session mission, another runner) instead of "ready".
 *
 * Structured fields only, as the claim response carries them: the diagnostic
 * reason, the exclusion code and its end time, and the budget walls with their
 * reset times. The prose `detail` rides along for a code `top` has no words for.
 */
import type { ClaimBudgetWall, ClaimDeferredTask, ClaimDiagnostics } from '@buildd/shared';

export interface ClaimOutcome {
  /** When the runner received it (ms). */
  at: number;
  /** The server's diagnostic reason; `refused` for an HTTP error; `context_paused` for the runner's own breaker. */
  reason: string;
  /** The gate that excluded a named task (ClaimTaskExclusionCode). */
  exclusion?: string;
  /** The server's sentence for that gate. */
  detail?: string;
  /** When the hold ends, when known (ISO). */
  until?: string | null;
  /** The budget and rate-limit walls that held the claim, with when each lifts. */
  walls?: ClaimBudgetWall[];
  /** The walls as one or two sentences for a person. */
  summary?: string;
  /** Broad claim: why every candidate was deferred, by reason. */
  deferrals?: Record<string, number>;
  /** Broad claim: the tasks it turned away, each with its code (absent from an older server). */
  deferredTasks?: ClaimDeferredTask[];
  /** Broad claim that took work: how many agents it started. */
  started?: number;
  /** The task a refused overlap waits for (the server's field, else the id its sentence names). */
  holderTaskId?: string;
  /** HTTP refusals. */
  status?: number;
  refusal?: string;
}

export interface ClaimOutcomeSnapshot {
  tasks: Record<string, ClaimOutcome>;
  broad: ClaimOutcome | null;
}

const OVERLAP_CODES = new Set(['soft_overlap', 'path_overlap']);
/** A task id as the sentence prints it (hex and hyphens), never a word like "finishes". */
const TASK_ID = /\btask ([0-9a-f][0-9a-f-]{7,})(?=[\s,.]|$)/i;

/** A server from before `holderTaskId` names the holder only in its sentence ("overlaps in-flight task <id>"). */
export function taskIdInSentence(detail: string | undefined): string | null {
  return detail?.match(TASK_ID)?.[1] ?? null;
}

export function outcomeFromDiagnostics(diagnostics: ClaimDiagnostics | null | undefined, now: number): ClaimOutcome {
  if (!diagnostics) return { at: now, reason: 'no_pending_tasks' };
  const o: ClaimOutcome = { at: now, reason: diagnostics.reason };
  const ex = diagnostics.taskExclusion;
  if (ex?.code) {
    o.exclusion = ex.code;
    if (ex.detail) o.detail = ex.detail;
    if (ex.until) o.until = ex.until;
    const holder = ex.holderTaskId ?? (OVERLAP_CODES.has(ex.code) ? taskIdInSentence(ex.detail) : null);
    if (holder) o.holderTaskId = holder;
  }
  if (diagnostics.budgetBlock?.walls?.length) {
    o.walls = diagnostics.budgetBlock.walls.map(w => ({ kind: w.kind, backend: w.backend, resetsAt: w.resetsAt ?? null }));
    if (diagnostics.budgetBlock.summary) o.summary = diagnostics.budgetBlock.summary;
  }
  if (diagnostics.deferrals) {
    const nonZero = Object.fromEntries(Object.entries(diagnostics.deferrals).filter(([, n]) => typeof n === 'number' && n > 0));
    if (Object.keys(nonZero).length > 0) o.deferrals = nonZero as Record<string, number>;
  }
  if (diagnostics.deferredTasks?.length) o.deferredTasks = diagnostics.deferredTasks;
  return o;
}

/** The per-task outcomes a broad claim's `deferredTasks` stand for. */
export function taskOutcomesFromBroad(o: Pick<ClaimOutcome, 'at' | 'reason' | 'deferredTasks'>): Record<string, ClaimOutcome> {
  const out: Record<string, ClaimOutcome> = {};
  for (const d of o.deferredTasks ?? []) {
    if (!d || typeof d.taskId !== 'string' || typeof d.code !== 'string') continue;
    out[d.taskId] = { at: o.at, reason: o.reason, exclusion: d.code, ...(d.until ? { until: d.until } : {}) };
  }
  return out;
}

/**
 * The provider limits a new broad outcome should still carry: the previous
 * ones that have not lifted. The server reports limits only on a claim that
 * takes nothing, so a claim that took some task (a Codex one, say) says
 * nothing about a Claude limit; only an empty claim that names no wall means
 * the wall lifted (R-25, AC-11).
 */
export function carryBroadWalls(prev: ClaimOutcome | null | undefined, next: ClaimOutcome): ClaimOutcome {
  if (!prev?.walls?.length) return next;
  const silent = next.reason === 'claimed' || next.reason === 'refused' || next.reason === 'context_paused';
  if (!silent && !next.walls?.length) return next;
  const have = new Set((next.walls ?? []).map(w => w.backend));
  const kept = prev.walls.filter(w => {
    if (have.has(w.backend)) return false;
    const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    return !Number.isNaN(t) && t > next.at;
  });
  if (kept.length === 0) return next;
  const out: ClaimOutcome = { ...next, walls: [...(next.walls ?? []), ...kept] };
  if (!out.summary && prev.summary) out.summary = prev.summary;
  return out;
}

export function outcomeFromRefusal(status: number, refusal: string, now: number): ClaimOutcome {
  return { at: now, reason: 'refused', status, refusal };
}

/** Does this outcome name a hold that is still ahead (a wall or an end time)? */
function holdStillAhead(o: ClaimOutcome, now: number): boolean {
  const ahead = (iso: string | null | undefined) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t > now;
  };
  return ahead(o.until) || (o.walls ?? []).some(w => ahead(w.resetsAt));
}

export class ClaimOutcomeStore {
  private tasks = new Map<string, ClaimOutcome>();
  private broad: ClaimOutcome | null = null;
  private readonly maxTasks: number;
  private readonly maxAgeMs: number;

  constructor(opts: { maxTasks?: number; maxAgeMs?: number } = {}) {
    this.maxTasks = opts.maxTasks ?? 500;
    this.maxAgeMs = opts.maxAgeMs ?? 60 * 60_000;
  }

  recordTask(taskId: string, outcome: ClaimOutcome): void {
    this.tasks.delete(taskId);
    this.tasks.set(taskId, outcome);
    while (this.tasks.size > this.maxTasks) {
      const oldest = this.tasks.keys().next().value;
      if (oldest === undefined) break;
      this.tasks.delete(oldest);
    }
  }

  /** Keep the broad outcome (with any provider limit that has not lifted) and return what was kept. */
  recordBroad(outcome: ClaimOutcome): ClaimOutcome {
    this.broad = carryBroadWalls(this.broad, outcome);
    for (const [id, t] of Object.entries(taskOutcomesFromBroad(outcome))) this.recordTask(id, t);
    return this.broad;
  }

  /** A worker started on it: nothing holds it any more. */
  clearTask(taskId: string): void {
    this.tasks.delete(taskId);
  }

  private fresh(o: ClaimOutcome, now: number): boolean {
    return now - o.at <= this.maxAgeMs || holdStillAhead(o, now);
  }

  snapshot(now: number = Date.now()): ClaimOutcomeSnapshot {
    const tasks: Record<string, ClaimOutcome> = {};
    for (const [id, o] of this.tasks) {
      if (this.fresh(o, now)) tasks[id] = o;
      else this.tasks.delete(id);
    }
    const broad = this.broad && this.fresh(this.broad, now) ? this.broad : null;
    return { tasks, broad };
  }
}
