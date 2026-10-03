/**
 * Supersession — one reconciler and one rule table for "this queued or running
 * work is obsolete now".
 *
 * Before this module the decision lived in point fixes, each with its own
 * query and its own side effects: an approve cancelled in-flight review fixes,
 * a merge cancelled a live reviewer, a closed/merged PR reconciled its
 * anchored tasks. Every door that observed a subject event called whichever
 * helper its author knew about. This file is the single place that decides:
 *
 *   reconcileSubjectEvent(event)  — cancel mode: load the tasks bound to the
 *                                   event's subject, run the table, cancel.
 *   checkDispatch(proposal)       — skip_dispatch mode: run the table against a
 *                                   task about to be created, before it exists.
 *   guardDispatchedTask(...)      — the same check after an insert, cancelling
 *                                   the inserted row if the world moved.
 *
 * RULES ARE PURE. `SUPERSESSION_RULES` is an ordered list of functions from
 * (event, task, facts) to keep | cancel and from (proposal, facts) to keep |
 * skip_dispatch. Everything they read is loaded up front by the store; the
 * first rule that does not say keep wins and its id is what the ledger records.
 *
 * BOUNDS (checked before any rule, see `boundFor`):
 *   - only BINDING keys load or match a task: reviewerRetryPrNumber,
 *     ciRetryPrNumber, a binding subject anchor (isBindingSubjectAnchor),
 *     context.reviewerFor, and parentTaskId. A PR number scraped from prose is
 *     advisory and never cancels anything.
 *   - a human-filed task (creationSource dashboard/github that is not a system
 *     retry) is never cancelled.
 *   - a task whose own live PR is not the subject is never cancelled — it is
 *     delivering something else.
 *   - one event cancelling more than MAX_CANCELS_PER_EVENT tasks cancels none:
 *     the would-cancel set is recorded and a note is posted instead.
 *   - nothing here closes a PR.
 *
 * COLLISION PROOF: every cancel is a CAS on the task status. Exactly one caller
 * wins a given row, and only the winner writes the `supersession` ledger row
 * and the activity entry. Two doors observing the same approve (or an old
 * helper and the reconciler) yield one cancellation and one ledger row.
 *
 * The DB lives in `supersession-store.ts`, loaded lazily so the rules and the
 * orchestration stay importable (and testable) without a database.
 */

import { isBindingSubjectAnchor } from './subject-gate-contract';

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const SUPERSESSION_RULE_IDS = [
  'approve_supersedes_fix',
  'merge_supersedes_review',
  'merge_supersedes_fix',
  'close_reconciles_subject',
  'close_supersedes_fix',
  'newer_verdict_supersedes_fix',
  'parent_done_supersedes_retry',
  'cancel_supersedes_retry',
] as const;
export type SupersessionRuleId = (typeof SUPERSESSION_RULE_IDS)[number];

/** A single event cancelling more than this many tasks cancels none. */
export const MAX_CANCELS_PER_EVENT = 10;

/** Where to write the PR activity entry, when the door knows. */
export interface PrCoords {
  installationId: number;
  repoFullName: string;
}

interface EventBase {
  workspaceId: string;
  /** The door that observed the event — the ledger row's `surface`. */
  door: string;
  pr?: PrCoords | null;
}

export type ReviewVerdict = 'approve' | 'request-changes' | 'escalate';

/** A reviewer verdict was recorded for a PR. */
export interface VerdictEvent extends EventBase {
  kind: 'verdict';
  prNumber: number;
  verdict: ReviewVerdict;
  /** The reviewer task whose verdict this is (absent from legacy callers). */
  reviewerTaskId?: string | null;
  /** The head the verdict was reached at. */
  headSha?: string | null;
  /** When that review round was created — fixes dispatched before it are older. */
  roundCreatedAt?: Date | null;
  /** The task that owns the PR (the reviewer's `context.reviewerFor`). */
  originalTaskId?: string | null;
}

/**
 * A PR merged, closed unmerged, or is being re-checked (`subject_check`: a
 * retry completed, the hourly reconcile, dead-PR shutdown). `subject_check`
 * only reconciles anchored tasks of a PR that is already dead — it never
 * cancels a fix or a review on its own.
 */
export interface PrEvent extends EventBase {
  kind: 'merged' | 'closed' | 'subject_check';
  prNumber: number;
  originalTaskId?: string | null;
}

/** A task's work landed (its PR merged); its open retries are moot. */
export interface ParentDoneEvent extends EventBase {
  kind: 'parent_done';
  parentTaskId: string;
  prNumber?: number | null;
}

/** A task was cancelled; its open retries go with it. */
export interface CancelledEvent extends EventBase {
  kind: 'cancelled';
  taskId: string;
}

export type SubjectEvent = VerdictEvent | PrEvent | ParentDoneEvent | CancelledEvent;
export type SubjectEventKind = SubjectEvent['kind'];

/** A loaded task, with exactly the fields the rules read. */
export interface SupersessionCandidate {
  id: string;
  workspaceId: string;
  missionId: string | null;
  status: string;
  parentTaskId: string | null;
  category: string | null;
  taskClass: string | null;
  creationSource: string | null;
  reviewerRetryPrNumber: number | null;
  reviewerRetryHeadSha: string | null;
  ciRetryPrNumber: number | null;
  subjectPrNumber: number | null;
  subjectAnchor: { source?: string | null; confidence?: string | null } | null;
  subjectResolution: string | null;
  context: Record<string, unknown> | null;
  createdAt: Date | null;
  /** The newest PR this task's own workers opened that is still open, if any. */
  ownLivePrNumber: number | null;
}

/** Event-level facts the store reads once, before the rules run. */
export interface EventFacts {
  /**
   * Whether any member of the subject PR's retry chain still has an open PR.
   * Only read for closed/merged/subject_check; `undefined` means not loaded,
   * which `close_reconciles_subject` treats as "do not reconcile".
   */
  subjectHasLiveSuccessor?: boolean;
}

export type CancelVerdict = 'keep' | 'cancel';
export type DispatchVerdict = 'keep' | 'skip_dispatch';

/** A task about to be created. */
export interface DispatchProposal {
  kind: 'fix' | 'reviewer' | 'ci_retry' | 'retry';
  workspaceId: string;
  door: string;
  prNumber?: number | null;
  parentTaskId?: string | null;
  /** For a review fix: the round whose request-changes verdict it answers. */
  triggeringReviewTaskId?: string | null;
}

export interface DispatchFacts {
  /** The subject PR's lifecycle: open, merged, closed (unmerged), or unknown. */
  prState?: 'open' | 'merged' | 'closed' | null;
  newestReviewTaskId?: string | null;
  /** The newest round's verdict, null while it is still running. */
  newestReviewVerdict?: ReviewVerdict | null;
  parentStatus?: string | null;
  /** The parent task's own PR merged — its work landed. */
  parentMerged?: boolean;
}

export interface SupersessionRule {
  id: SupersessionRuleId;
  /** One line, for the PR activity entry and the ledger. */
  label: string;
  cancel(event: SubjectEvent, task: SupersessionCandidate, facts: EventFacts): CancelVerdict;
  dispatch(proposal: DispatchProposal, facts: DispatchFacts): DispatchVerdict;
  /**
   * Statuses the CAS accepts for this rule. Defaults to every open status; the
   * rules that only take not-yet-started work narrow it so a task a worker
   * picked up between the read and the write is left alone.
   */
  casStatuses?: readonly string[];
  /** Extra columns the cancelling write stamps (e.g. subjectResolution). */
  stamp?: Record<string, unknown>;
}

export const OPEN_STATUSES = ['pending', 'assigned', 'in_progress'] as const;
const NOT_STARTED = ['pending', 'assigned'] as const;

// ── Binding keys (pure) ──────────────────────────────────────────────────────

function eventPr(event: SubjectEvent): number | null {
  if (event.kind === 'verdict' || event.kind === 'merged' || event.kind === 'closed' || event.kind === 'subject_check') {
    return event.prNumber;
  }
  if (event.kind === 'parent_done') return event.prNumber ?? null;
  return null;
}

function eventOriginalTask(event: SubjectEvent): string | null {
  if (event.kind === 'verdict' || event.kind === 'merged' || event.kind === 'closed' || event.kind === 'subject_check') {
    return event.originalTaskId ?? null;
  }
  return null;
}

function eventParent(event: SubjectEvent): string | null {
  if (event.kind === 'parent_done') return event.parentTaskId;
  if (event.kind === 'cancelled') return event.taskId;
  return null;
}

const isAttempt = (t: SupersessionCandidate) => t.taskClass === 'attempt';

/** A review-fix attempt bound to the event's PR. */
function isReviewFixFor(t: SupersessionCandidate, pr: number | null): boolean {
  return pr != null && isAttempt(t) && t.reviewerRetryPrNumber === pr;
}

/** Any fix attempt (review fix or CI fix) bound to the event's PR. */
function isFixFor(t: SupersessionCandidate, pr: number | null): boolean {
  return pr != null && isAttempt(t) && (t.reviewerRetryPrNumber === pr || t.ciRetryPrNumber === pr);
}

/** A reviewer task for the event's PR, by `context.reviewerFor` or its system anchor. */
function isReviewerFor(t: SupersessionCandidate, event: SubjectEvent): boolean {
  if (t.category !== 'review') return false;
  const reviewerFor = typeof t.context?.reviewerFor === 'string' ? t.context.reviewerFor : null;
  if (!reviewerFor) return false;
  const original = eventOriginalTask(event);
  if (original && (reviewerFor === original || t.parentTaskId === original)) return true;
  const pr = eventPr(event);
  return pr != null && t.subjectPrNumber === pr && isBindingSubjectAnchor(t.subjectAnchor);
}

function isAnchoredTo(t: SupersessionCandidate, pr: number | null): boolean {
  return pr != null && t.subjectPrNumber === pr && isBindingSubjectAnchor(t.subjectAnchor);
}

function isRetryOf(t: SupersessionCandidate, parentId: string | null): boolean {
  return parentId != null && isAttempt(t) && t.parentTaskId === parentId;
}

/**
 * Machinery-created follow-up work: an attempt (CI/review/conflict retry) or a
 * reviewer task. Only these may be cancelled when a person filed them.
 */
export function isSystemRetry(t: Pick<SupersessionCandidate, 'taskClass' | 'reviewerRetryPrNumber' | 'ciRetryPrNumber' | 'category' | 'context'>): boolean {
  if (t.taskClass === 'attempt') return true;
  if (t.reviewerRetryPrNumber != null || t.ciRetryPrNumber != null) return true;
  return t.category === 'review' && typeof t.context?.reviewerFor === 'string';
}

const HUMAN_SOURCES = new Set(['dashboard', 'github']);

export type BoundReason = 'human_filed' | 'own_live_pr' | 'not_open';

/** The bound that protects this task from any rule, or null when none does. */
export function boundFor(event: SubjectEvent, task: SupersessionCandidate): BoundReason | null {
  if (!(OPEN_STATUSES as readonly string[]).includes(task.status)) return 'not_open';
  if (task.creationSource && HUMAN_SOURCES.has(task.creationSource) && !isSystemRetry(task)) return 'human_filed';
  if (task.ownLivePrNumber != null && task.ownLivePrNumber !== eventPr(event)) return 'own_live_pr';
  return null;
}

// ── The table ────────────────────────────────────────────────────────────────

const KEEP = 'keep' as const;
const CANCEL = 'cancel' as const;
const SKIP = 'skip_dispatch' as const;

const notStarted = (t: SupersessionCandidate) => (NOT_STARTED as readonly string[]).includes(t.status);

export const SUPERSESSION_RULES: readonly SupersessionRule[] = [
  {
    // An approve makes every outstanding review fix for that PR stale: it can
    // only push a commit that forces a re-review of an approved PR.
    id: 'approve_supersedes_fix',
    label: 'fix cancelled · already approved',
    cancel: (e, t) =>
      e.kind === 'verdict' && e.verdict === 'approve' && isReviewFixFor(t, e.prNumber) ? CANCEL : KEEP,
    dispatch: (p, f) =>
      p.kind === 'fix' && f.newestReviewVerdict === 'approve' ? SKIP : KEEP,
  },
  {
    // A merged PR needs no review: the verdict can no longer change anything.
    id: 'merge_supersedes_review',
    label: 'review cancelled · already merged',
    cancel: (e, t) => (e.kind === 'merged' && isReviewerFor(t, e) ? CANCEL : KEEP),
    dispatch: (p, f) => (p.kind === 'reviewer' && f.prState === 'merged' ? SKIP : KEEP),
  },
  {
    // Nor a fix: there is no branch left to push to that matters.
    id: 'merge_supersedes_fix',
    label: 'fix cancelled · already merged',
    cancel: (e, t) => (e.kind === 'merged' && isFixFor(t, e.prNumber) ? CANCEL : KEEP),
    dispatch: (p, f) =>
      (p.kind === 'fix' || p.kind === 'ci_retry') && f.prState === 'merged' ? SKIP : KEEP,
  },
  {
    // The subject PR is dead (closed or merged) and nothing in its retry chain
    // still has an open PR: anchored work that has not started is moot. The row
    // is stamped `reconciled` so the subject gate keeps it out of the queue.
    // Formerly `sweepSubjectAnchoredTasks`, which is now a wrapper over this.
    id: 'close_reconciles_subject',
    label: 'task cancelled · PR closed',
    cancel: (e, t, f) =>
      (e.kind === 'closed' || e.kind === 'merged' || e.kind === 'subject_check')
        && isAnchoredTo(t, e.prNumber)
        && notStarted(t)
        && t.subjectResolution !== 'reconciled'
        && f.subjectHasLiveSuccessor === false
        ? CANCEL
        : KEEP,
    dispatch: (p, f) => (p.kind === 'reviewer' && f.prState === 'closed' ? SKIP : KEEP),
    casStatuses: NOT_STARTED,
    stamp: { subjectResolution: 'reconciled' },
  },
  {
    // A PR closed without merging takes its unstarted fixes with it. A fix
    // already running is left alone: a retry that opens a fresh PR closes its
    // ancestor on the way, and that retry is the live successor, not waste.
    id: 'close_supersedes_fix',
    label: 'fix cancelled · PR closed',
    cancel: (e, t) => (e.kind === 'closed' && isFixFor(t, e.prNumber) && notStarted(t) ? CANCEL : KEEP),
    dispatch: (p, f) =>
      (p.kind === 'fix' || p.kind === 'ci_retry') && f.prState === 'closed' ? SKIP : KEEP,
    casStatuses: NOT_STARTED,
  },
  {
    // A newer review round answered a different head: a not-yet-started fix
    // dispatched off an OLDER round's verdict is answering a question nobody is
    // asking any more. At dispatch time: a fix whose triggering round is no
    // longer the newest is not created at all.
    id: 'newer_verdict_supersedes_fix',
    label: 'fix cancelled · newer review',
    cancel: (e, t) =>
      e.kind === 'verdict'
        && isReviewFixFor(t, e.prNumber)
        && notStarted(t)
        && !!e.headSha
        && t.reviewerRetryHeadSha !== e.headSha
        && !!e.roundCreatedAt && !!t.createdAt
        && t.createdAt.getTime() < e.roundCreatedAt.getTime()
        ? CANCEL
        : KEEP,
    dispatch: (p, f) =>
      p.kind === 'fix'
        && !!p.triggeringReviewTaskId
        && f.newestReviewTaskId !== undefined
        && f.newestReviewTaskId !== p.triggeringReviewTaskId
        ? SKIP
        : KEEP,
    casStatuses: NOT_STARTED,
  },
  {
    // The parent's work landed: its open retries have nothing left to deliver.
    id: 'parent_done_supersedes_retry',
    label: 'retry cancelled · work landed',
    cancel: (e, t) => (e.kind === 'parent_done' && isRetryOf(t, e.parentTaskId) ? CANCEL : KEEP),
    dispatch: (p, f) => (p.kind !== 'reviewer' && f.parentMerged === true ? SKIP : KEEP),
  },
  {
    // The parent was cancelled: retrying it contradicts that decision.
    id: 'cancel_supersedes_retry',
    label: 'retry cancelled · task cancelled',
    cancel: (e, t) => (e.kind === 'cancelled' && isRetryOf(t, eventParent(e)) ? CANCEL : KEEP),
    dispatch: (p, f) => (p.kind !== 'reviewer' && f.parentStatus === 'cancelled' ? SKIP : KEEP),
  },
];

export function ruleById(id: SupersessionRuleId): SupersessionRule {
  const rule = SUPERSESSION_RULES.find(r => r.id === id);
  if (!rule) throw new Error(`unknown supersession rule ${id}`);
  return rule;
}

export interface CancelDecision {
  task: SupersessionCandidate;
  verdict: CancelVerdict;
  rule: SupersessionRuleId | null;
  bound: BoundReason | null;
}

/** Run the table over loaded tasks. Pure. */
export function decideCancellations(
  event: SubjectEvent,
  candidates: readonly SupersessionCandidate[],
  facts: EventFacts,
  only?: readonly SupersessionRuleId[],
): CancelDecision[] {
  const rules = only ? SUPERSESSION_RULES.filter(r => only.includes(r.id)) : SUPERSESSION_RULES;
  return candidates.map(task => {
    const bound = boundFor(event, task);
    if (bound) return { task, verdict: KEEP, rule: null, bound };
    for (const rule of rules) {
      if (rule.cancel(event, task, facts) === CANCEL) return { task, verdict: CANCEL, rule: rule.id, bound: null };
    }
    return { task, verdict: KEEP, rule: null, bound: null };
  });
}

export interface DispatchDecision {
  verdict: DispatchVerdict;
  rule: SupersessionRuleId | null;
}

/** Run the table in skip_dispatch mode against a task about to be created. Pure. */
export function decideDispatch(proposal: DispatchProposal, facts: DispatchFacts): DispatchDecision {
  for (const rule of SUPERSESSION_RULES) {
    if (rule.dispatch(proposal, facts) === SKIP) return { verdict: SKIP, rule: rule.id };
  }
  return { verdict: KEEP, rule: null };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** The I/O the reconciler needs. `supersession-store.ts` is the real one. */
export interface SupersessionStore {
  /** Open tasks bound to the event's subject through a binding key. */
  loadCandidates(event: SubjectEvent): Promise<SupersessionCandidate[]>;
  loadEventFacts(event: SubjectEvent): Promise<EventFacts>;
  loadDispatchFacts(proposal: DispatchProposal): Promise<DispatchFacts>;
  /**
   * CAS the task to cancelled. True only for the caller whose write changed the
   * row — that caller, and only that caller, then runs the side effects.
   */
  casCancel(task: SupersessionCandidate, rule: SupersessionRule): Promise<boolean>;
  /** Stop the task's workers, release its claims, broadcast. Winner only. */
  applyCancelEffects(task: SupersessionCandidate, rule: SupersessionRule, event: SubjectEvent): Promise<void>;
  /** One `supersession` ledger row and one activity entry. Winner only. */
  recordSupersession(task: SupersessionCandidate, rule: SupersessionRule, event: SubjectEvent): Promise<void>;
  /** The over-limit refusal: ledger row with the would-cancel set, and a note. */
  recordBulkRefusal(event: SubjectEvent, wouldCancel: CancelDecision[]): Promise<void>;
}

export interface ReconcileOptions {
  /** Restrict to these rules (the legacy wrappers each own one). */
  rules?: readonly SupersessionRuleId[];
  /** Restrict to these task ids (cancel one just-inserted row). */
  taskIds?: readonly string[];
  store?: SupersessionStore;
}

export interface ReconcileResult {
  /** Tasks this call cancelled (won the CAS for). */
  cancelled: Array<{ taskId: string; rule: SupersessionRuleId }>;
  /** Decided cancel but another caller won the CAS first. */
  lostRace: string[];
  /** Set when the bulk bound fired: nothing was cancelled. */
  refused?: { wouldCancel: Array<{ taskId: string; rule: SupersessionRuleId }> };
  decisions: CancelDecision[];
}

async function defaultStore(): Promise<SupersessionStore> {
  const { supersessionStore } = await import('./supersession-store');
  return supersessionStore;
}

function needsFacts(event: SubjectEvent, only?: readonly SupersessionRuleId[]): boolean {
  if (only && !only.includes('close_reconciles_subject')) return false;
  return event.kind === 'closed' || event.kind === 'merged' || event.kind === 'subject_check';
}

/**
 * Cancel mode. Load the tasks bound to the event's subject, run the table, and
 * cancel what it says to — each through its own CAS, the winner writing the
 * ledger. Never throws: a door that observed an event must not fail because
 * cleanup did.
 */
export async function reconcileSubjectEvent(
  event: SubjectEvent,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const empty: ReconcileResult = { cancelled: [], lostRace: [], decisions: [] };
  try {
    const store = opts.store ?? (await defaultStore());
    let candidates = await store.loadCandidates(event);
    if (opts.taskIds) candidates = candidates.filter(c => opts.taskIds!.includes(c.id));
    if (candidates.length === 0) return empty;

    const facts = needsFacts(event, opts.rules) ? await store.loadEventFacts(event) : {};
    const decisions = decideCancellations(event, candidates, facts, opts.rules);
    const toCancel = decisions.filter(d => d.verdict === CANCEL && d.rule);

    if (toCancel.length > MAX_CANCELS_PER_EVENT) {
      await store.recordBulkRefusal(event, toCancel);
      return {
        ...empty,
        decisions,
        refused: { wouldCancel: toCancel.map(d => ({ taskId: d.task.id, rule: d.rule! })) },
      };
    }

    const result: ReconcileResult = { cancelled: [], lostRace: [], decisions };
    for (const d of toCancel) {
      const rule = ruleById(d.rule!);
      try {
        const won = await store.casCancel(d.task, rule);
        if (!won) {
          result.lostRace.push(d.task.id);
          continue;
        }
        result.cancelled.push({ taskId: d.task.id, rule: rule.id });
        await store.applyCancelEffects(d.task, rule, event);
        await store.recordSupersession(d.task, rule, event);
      } catch (err) {
        console.error(`[supersession] ${rule.id} failed for task ${d.task.id}:`, err);
      }
    }
    if (result.cancelled.length > 0) {
      console.log(
        `[supersession] ${event.kind} via ${event.door}: cancelled ${result.cancelled.length} task(s)`,
        result.cancelled.map(c => `${c.taskId}:${c.rule}`),
      );
    }
    return result;
  } catch (err) {
    console.error(`[supersession] reconcile ${event.kind} via ${event.door} failed:`, err);
    return empty;
  }
}

/**
 * skip_dispatch mode. Call right before creating a fix, reviewer or retry: a
 * `skip_dispatch` verdict means the table would cancel the task the moment it
 * existed, so do not create it. Fails open (keep) on a read error — a missed
 * skip is caught by the cancel-mode reconcile; a false skip loses real work.
 */
export async function checkDispatch(
  proposal: DispatchProposal,
  opts: { store?: SupersessionStore } = {},
): Promise<DispatchDecision> {
  try {
    const store = opts.store ?? (await defaultStore());
    const facts = await store.loadDispatchFacts(proposal);
    const decision = decideDispatch(proposal, facts);
    if (decision.verdict === SKIP) {
      console.log(`[supersession] skip_dispatch ${proposal.kind} via ${proposal.door}: ${decision.rule}`);
    }
    return decision;
  } catch (err) {
    console.error(`[supersession] dispatch check for ${proposal.kind} via ${proposal.door} failed:`, err);
    return { verdict: KEEP, rule: null };
  }
}

/**
 * The post-insert half of the dispatch guard: the row exists now, and the
 * world may have moved between `checkDispatch` and the insert. Re-run the
 * check and, if it now says skip, cancel exactly this row through the same CAS
 * and ledger as every other supersession. Returns true when the row was
 * cancelled (by this call or a concurrent one) and must not be dispatched.
 */
export async function guardDispatchedTask(
  proposal: DispatchProposal,
  taskId: string,
  event: SubjectEvent,
  opts: { store?: SupersessionStore } = {},
): Promise<boolean> {
  const decision = await checkDispatch(proposal, opts);
  if (decision.verdict !== SKIP || !decision.rule) return false;
  try {
    const store = opts.store ?? (await defaultStore());
    const [task] = (await store.loadCandidates(event)).filter(c => c.id === taskId);
    if (!task) return true; // already terminal: someone else cancelled it
    const rule = ruleById(decision.rule);
    // The dispatch decision is the rule's verdict on this row; only the status
    // CAS can still lose.
    if (await store.casCancel(task, { ...rule, casStatuses: OPEN_STATUSES })) {
      await store.applyCancelEffects(task, rule, event);
      await store.recordSupersession(task, rule, event);
    }
    return true;
  } catch (err) {
    console.error(`[supersession] post-insert guard for task ${taskId} failed:`, err);
    return false;
  }
}
