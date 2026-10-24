/**
 * Start anyway (Living Spec 36df686b "Start anyway: assess, coordinate and
 * continue"; Health › Queue R-20): a person starts a task whose declared
 * prerequisites are unfinished. The task's agent assesses what can proceed,
 * coordinates, then works or parks (the existing wait exit,
 * apps/web/src/lib/task-wait-exit.ts) and resumes by the existing dependency
 * wake.
 *
 * This module is the pure decision core and owns no machinery. The person's
 * request is the existing force-start intent (`context.forceStart`, kind
 * `dep_declared`, naming `assessDependsOn`): one authoritative start path.
 * The dependsOn edges are never edited; the intent admits one claim.
 *
 * Pure and dependency-free: client components and the runner import it.
 */
import { isLiveWorkerStatus } from '@buildd/shared';

export const START_ANYWAY_EVENTS = ['requested', 'claimed', 'assessed', 'coordinated', 'parked', 'woken', 'delivered'] as const;
export type StartAnywayEvent = (typeof START_ANYWAY_EVENTS)[number];

/** Times the assessment may re-park on a prerequisite; a dead one cannot loop the task. */
export const START_ANYWAY_MAX_PARKS = 3;
/** How long an accepted request is kept for a runner that is offline or missed the wake. */
export const START_ANYWAY_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const START_ANYWAY_SURFACES = ['task_page', 'task_sheet', 'queue', 'explain', 'runner'] as const;
export const SURFACES = START_ANYWAY_SURFACES;
/** What the wake waits for. */
export const PARK_WAKE_EVENT = 'task.completed+merged';

export type StartAnywayPhase = 'requested' | 'assessing' | 'blocked';

// ── Admission ───────────────────────────────────────────────────────────────

/**
 * Admission needs only that the caller may start the task (R-13): no Jev call,
 * confidence, provider availability or explanation from the person.
 */
export function authorizeStartAnyway(i: { canStartTask: boolean; note?: string | null; jevAvailable?: boolean }): { allowed: boolean; consults: string[] } {
  return { allowed: i.canStartTask, consults: [] };
}

/** Whether an accepted intent admits this declared edge for the claim (R-3, R-16). */
export function admitsDeclaredEdge(i: { intent: { assessDependsOn?: string[]; expiresAt: string } | null; edgeId: string; now?: Date }): boolean {
  if (!i.intent) return false;
  const exp = Date.parse(i.intent.expiresAt);
  if (!Number.isFinite(exp) || exp <= (i.now ?? new Date()).getTime()) return false;
  return (i.intent.assessDependsOn ?? []).includes(i.edgeId);
}

/** Start anyway never starts dependants, and ordinary release is unchanged (R-16). */
export function startsDependants(): boolean {
  return false;
}

const NEVER_AUTHORISED_BY_START = new Set(['merge', 'release', 'deploy', 'destructive', 'credential', 'permission']);

/**
 * A protected mutation is allowed by its own precondition, never by the start
 * (AC-18): an unmet data-preservation precondition stays unmet, and release,
 * merge, credentials and destructive work are not scheduling exceptions.
 */
export function authorizeProtectedMutation(i: { mutation: string; preconditionMet: boolean; startAnywayIntent: boolean }): { allowed: boolean } {
  if (NEVER_AUTHORISED_BY_START.has(i.mutation)) return { allowed: false };
  return { allowed: i.preconditionMet };
}

/**
 * What assessment may touch (R-7, AC-13). Reads claim no paths and displace no
 * writer; an edit needs real ownership and is refused while another writer holds it.
 */
export function assessmentAccess(i: { kind: 'read' | 'edit'; paths: readonly string[]; activeWriter: string | null }) {
  if (i.kind === 'read') return { allowed: true, claimsPaths: [] as string[], displacesWriter: false, requiresOwnership: [] as string[], grants: [] as string[] };
  return { allowed: i.activeWriter == null, claimsPaths: [] as string[], displacesWriter: false, requiresOwnership: [...i.paths], grants: [] as string[] };
}

/** A person's override is recorded as a preference and grades no model wrong (R-15). */
export function humanOverrideGrade(i: { executionSucceeded: boolean; deliveryVerified: boolean }) {
  return { humanPreference: 'recorded' as const, labelsModelWrong: false, executionSucceeded: i.executionSucceeded, deliveryVerified: i.deliveryVerified };
}

// ── Assessment ──────────────────────────────────────────────────────────────

export interface PrerequisiteInput {
  id: string;
  title: string;
  status: string;
  worker?: { id: string; status: string } | null;
  pr?: { url?: string | null; number?: number | null; merged?: boolean } | null;
}

export const REQUIRED_ASSESSMENT_FIELDS = ['needs', 'canProceed', 'uncertainty', 'nextStep'] as const;
export const ASSESSMENT_FORBIDS = ['mark_prerequisite_satisfied', 'delete_dependency', 'start_duplicate_worker', 'rewrite_upstream_scope', 'release_or_merge'] as const;

type Progress = 'active' | 'finished' | 'unknown';

function progressOf(p: PrerequisiteInput, recovered: boolean): Progress {
  if (p.status === 'completed') return 'finished';
  if (p.worker && isLiveWorkerStatus(p.worker.status)) return 'active';
  if (p.pr?.url) return 'active';
  return recovered ? 'active' : 'unknown';
}

/**
 * The assessment section of the worker prompt (R-4): live prerequisite state,
 * missing evidence left unknown, what to record before the first edit, and the
 * boundaries that stay (R-7, AC-18).
 */
export function buildAssessmentBrief(i: {
  task: { id: string; title: string; specId?: string | null };
  prerequisites: readonly PrerequisiteInput[];
  recoveryOutcomes: readonly { summary: string }[];
}) {
  const facts = i.prerequisites.map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    worker: p.worker ?? null,
    pr: p.pr ?? null,
    progress: progressOf(p, i.recoveryOutcomes.length > 0),
  }));
  const lines = facts.map(f =>
    `- ${f.title} (task ${f.id}): ${f.status}${f.worker ? `, agent ${f.worker.status}` : ', no agent attached'}${f.pr?.url ? `, PR ${f.pr.url}${f.pr.merged ? ' (merged)' : ' (open)'}` : ''}${f.progress === 'unknown' ? ' — progress unknown' : ''}`);
  const text = [
    '## Start anyway: assess before you build',
    'A person started this task before its declared prerequisites finished. They have not been marked complete or satisfied, and the dependency edges are unchanged:',
    ...lines,
    ...(i.recoveryOutcomes.length ? ['', 'Existing recovery outcomes:', ...i.recoveryOutcomes.map(o => `- ${o.summary}`)] : []),
    '',
    'Before making any edits:',
    '1. Read your pinned spec, the relevant knowledge and code, and what each prerequisite has produced so far (its task, worker, branch and PR). Missing evidence is unknown: an assigned status or an age alone shows neither progress nor a stall.',
    '2. Establish what you need from the prerequisite, what can proceed without it, and the uncertainty. Record it with `update_progress { assessment: { needs, canProceed, uncertainty, nextStep } }` before your first edit: file claims are refused until it is recorded.',
    '3. If an agent is working on the prerequisite and an interface, branch or ownership boundary needs agreeing, send ONE concrete request with `send_worker_message` and record the answer. Do not start another worker or task, repeat the request, or rewrite its scope.',
    '4. Then either do the useful work that does not need the unfinished prerequisite (normal file ownership: path claims for what you edit), or, if nothing useful can proceed, park: call `complete_task` with `blockedOnTaskId` set to the prerequisite, a `summary` stating your assessment and the next step, and the same `assessment`. The task returns to the queue holding no slot and resumes by itself on the same branch when that prerequisite merges.',
    '',
    'This start admits your assessment only. It does not grant file or lane ownership another agent holds, does not unlock migration generation or any existing data-preservation precondition, and does not authorise release, merge, credentials or destructive work. Scope or requirement changes follow the normal spec and approval rules.',
  ].join('\n');
  return { text, facts, requiredAssessmentFields: [...REQUIRED_ASSESSMENT_FIELDS], forbids: [...ASSESSMENT_FORBIDS] };
}

/** The resume section after a park: what was assessed and what was waited on. */
export function resumeInstruction(wait: { blockerTaskId: string; reason: string; at?: string; assessment?: AssessmentFields | null }): string {
  return [
    '## Start anyway: resuming',
    `This task parked on prerequisite ${wait.blockerTaskId}${wait.at ? ` at ${wait.at}` : ''} and was woken because it resolved. Your earlier assessment:`,
    wait.reason,
    ...(wait.assessment ? REQUIRED_ASSESSMENT_FIELDS.map(k => `- ${k}: ${wait.assessment![k]}`) : []),
    "Continue on the existing branch with that assessment. Re-check the prerequisite's merged result before building on it.",
  ].join('\n');
}

export interface CoordinationRequest { workerId: string; need: string; answeredAt: string | null }

/**
 * One concrete message to the existing upstream agent through existing task
 * messaging (R-5, AC-10). A request already sent is awaited, never repeated;
 * with no live upstream agent there is nobody to message. Never a new worker
 * or task, never a rewrite of the upstream's scope.
 */
export function planCoordination(i: { prerequisite: PrerequisiteInput; need: string; priorRequests: readonly CoordinationRequest[] }) {
  const base = { createsWorker: false as const, createsTask: false as const, rewritesUpstream: false as const };
  const w = i.prerequisite.worker;
  const live = !!w && isLiveWorkerStatus(w.status);
  if (!live) return { ...base, action: 'record_need' as const, workerId: null, message: null };
  const prior = i.priorRequests.find(r => r.workerId === w!.id && r.need === i.need);
  if (prior) return { ...base, action: 'await_existing_request' as const, workerId: w!.id, message: null };
  return {
    ...base,
    action: 'message_upstream_worker' as const,
    workerId: w!.id,
    message: `A dependent task needs this from you, if it fits your scope: ${i.need}. Reply when it is available or say what blocks it. No change to your task is requested.`,
  };
}

export interface AssessmentFields { needs: string; canProceed: string; uncertainty: string; nextStep: string }

/** What the assessment decided to do next (R-6, AC-9). */
export function decideAssessment(i: {
  outcome: 'independent_work' | 'park';
  scopeChange: boolean;
  remaining: readonly { prerequisiteId: string; reason: string }[];
  boundaryRecorded?: boolean;
  ownershipAcquired?: boolean;
}) {
  const base = { dependencyStillValid: i.remaining.length > 0, marksPrerequisiteSatisfied: false as const };
  if (i.scopeChange) return { ...base, next: 'needs_authority' as const };
  if (i.outcome === 'park') return { ...base, next: 'park' as const };
  if (i.boundaryRecorded === false) return { ...base, next: 'record_boundary_first' as const };
  if (i.ownershipAcquired === false) return { ...base, next: 'acquire_ownership_first' as const };
  return { ...base, next: 'work' as const };
}

// ── Park, wake, resume ──────────────────────────────────────────────────────

export interface ParkWake { event: typeof PARK_WAKE_EVENT; taskId: string; observedVersion: number }

/**
 * The park (R-8, AC-11): the same task goes back to the queue with its
 * assessment and one named wake condition. It holds no executing slot and no
 * unused edit ownership, and nothing polls with a model.
 */
export function planPark(i: { assessment: AssessmentFields; prerequisite: { id: string; title: string; status: string; version: number } }) {
  const wake: ParkWake = { event: PARK_WAKE_EVENT, taskId: i.prerequisite.id, observedVersion: i.prerequisite.version };
  return {
    wake,
    assessment: i.assessment,
    releasesExecutionSlot: true,
    releasesUnusedEditOwnership: true,
    pollsWithModel: false,
    taskStatusAfter: 'pending' as const,
    readableNextStep: `Waiting on ${i.prerequisite.title}: ${i.assessment.nextStep}`,
    persist: { assessment: i.assessment, wake },
  };
}

/** Subscribe-and-recheck at park time (R-9): a prerequisite that finished meanwhile resumes instead of parking. */
export function settlePark(i: { wake: ParkWake; current: { status: string; merged: boolean; version: number } }): { decision: 'resume' | 'park' | 'reassess' } {
  if (i.current.status === 'completed' && i.current.merged) return { decision: 'resume' };
  if (i.current.version > i.wake.observedVersion) return { decision: 'reassess' };
  return { decision: 'park' };
}

export interface ParkedState {
  taskId: string;
  phase: 'parked' | 'resumed' | 'blocked';
  wake: ParkWake;
  resumes: number;
  reparks?: number;
  blockedReason?: string;
}
export interface WakeEvent { type: string; taskId: string; version: number; id: string }
export interface WakeEffect { kind: 'resume'; taskId: string; carries: string[] }

/**
 * A prerequisite event against a parked task (AC-12, R-11): the merge resumes
 * the same logical task exactly once whatever the delivery count; a failed or
 * missing prerequisite is an explicit block, with no recovery task; progress
 * events re-park at most START_ANYWAY_MAX_PARKS times.
 */
export function reduceWake(state: ParkedState, event: WakeEvent): { state: ParkedState; effects: WakeEffect[] } {
  if (state.phase !== 'parked' || event.taskId !== state.wake.taskId) return { state, effects: [] };
  if (event.type === 'task.completed+merged') {
    return {
      state: { ...state, phase: 'resumed', resumes: state.resumes + 1 },
      effects: [{ kind: 'resume', taskId: state.taskId, carries: ['assessment', 'coordinationHistory'] }],
    };
  }
  if (event.type === 'task.failed' || event.type === 'task.cancelled' || event.type === 'task.missing') {
    return { state: { ...state, phase: 'blocked', blockedReason: `Prerequisite ${event.taskId} ${event.type.replace('task.', '')}; it will not merge` }, effects: [] };
  }
  const reparks = state.reparks ?? 0;
  if (event.version > state.wake.observedVersion && reparks < START_ANYWAY_MAX_PARKS) {
    return { state: { ...state, reparks: reparks + 1, wake: { ...state.wake, observedVersion: event.version } }, effects: [] };
  }
  return { state, effects: [] };
}

export function parkAllowed(parksSoFar: number): boolean {
  return parksSoFar < START_ANYWAY_MAX_PARKS;
}

/** The resume path (R-10, AC-17): the same task, session if valid else a new attempt with the saved context. */
export function planResume(i: { saved: { taskId: string; assessment: unknown; history: unknown; sessionId: string | null }; sessionValid: boolean }) {
  return {
    mode: (i.sessionValid ? 'continue_session' : 'new_attempt') as 'continue_session' | 'new_attempt',
    taskId: i.saved.taskId,
    createsReplacementTask: false as const,
    context: { assessment: i.saved.assessment, history: i.saved.history },
    refreshCredentials: true as const,
    revalidateEditOwnership: true as const,
  };
}

// ── Observed state (R-12, AC-16) ────────────────────────────────────────────

export function countsAsExecuting(i: { phase: string }): boolean {
  return i.phase === 'assessing' || i.phase === 'working';
}

/** The one derivation every surface renders from facts: requested is never running, parked holds no slot. */
export function startAnywayPhase(i: {
  intent: { id: string } | null;
  claimed: boolean;
  parked: boolean;
  executing: boolean;
  prerequisite?: { title: string } | null;
  nextStep?: string | null;
  surface?: string;
}): { phase: StartAnywayPhase; label: string; taskStatus: 'pending' | 'in_progress' } {
  if (i.parked) {
    return {
      phase: 'blocked',
      label: `Blocked on ${i.prerequisite?.title ?? 'its prerequisite'}${i.nextStep ? `: ${i.nextStep}` : ''}`,
      taskStatus: 'pending',
    };
  }
  if (!i.claimed) return { phase: 'requested', label: 'Start requested, waiting for a runner', taskStatus: 'pending' };
  return { phase: 'assessing', label: 'Assessing what can start', taskStatus: 'in_progress' };
}

// ── Queue rows (Health › Queue R-20, AC-13) ─────────────────────────────────

export type QueueRowKind = 'declared' | 'lane' | 'limit' | 'restriction';

export interface QueueRowAction {
  action: 'start_anyway' | 'force_start' | 'fix';
  label: string;
  /** Lane rows only: assessment is admitted, lane ownership is not granted. */
  grantsOwnership?: false;
}

/** The one action a Queue row (and the same task page/sheet action) offers. */
export function queueRowAction(kind: QueueRowKind): QueueRowAction {
  switch (kind) {
    case 'declared': return { action: 'start_anyway', label: 'Start anyway' };
    case 'lane': return { action: 'start_anyway', label: 'Start anyway', grantsOwnership: false };
    case 'limit': return { action: 'force_start', label: 'Force start' };
    default: return { action: 'fix', label: 'Fix' };
  }
}

// ── The agent's recorded assessment and the park record ─────────────────────

/** Context key of the claim-time brief `{ at, text, facts }` (written by the claim, lib/start-anyway.ts). */
export const START_ANYWAY_BRIEF_KEY = 'startAnywayAssessment' as const;
/** Context key of the assessment the agent recorded `{ assessment, at, workerId }` (update_progress { assessment }). */
export const START_ANYWAY_ASSESSED_KEY = 'startAnywayAssessed' as const;
/** Context key of the last park `{ assessment, wake, at }` (the wait exit, R-8). */
export const START_ANYWAY_PARK_KEY = 'startAnywayPark' as const;

const ASSESSMENT_FIELD_MAX = 1000;

/** A well-formed assessment from untrusted input, or the first problem with it. */
export function parseAssessment(raw: unknown): { ok: true; assessment: AssessmentFields } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'assessment must be { needs, canProceed, uncertainty, nextStep }' };
  const out: Partial<AssessmentFields> = {};
  for (const k of REQUIRED_ASSESSMENT_FIELDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== 'string' || !v.trim()) return { ok: false, error: `assessment.${k} is required: say "unknown" when nothing tells you` };
    out[k] = v.trim().slice(0, ASSESSMENT_FIELD_MAX);
  }
  return { ok: true, assessment: out as AssessmentFields };
}

const atOf = (v: unknown): string | null => {
  const at = (v as { at?: unknown } | null | undefined)?.at;
  return typeof at === 'string' ? at : null;
};

/**
 * True while a task a person started anyway has its claim-time brief but has
 * recorded no assessment since: neither `update_progress { assessment }` nor a
 * park (whose summary is the assessment it resumes with). Edits wait on it
 * (R-4, AC-9); reads never do.
 */
export function needsAssessmentBeforeEdit(context: Record<string, unknown> | null | undefined): boolean {
  const briefAt = atOf(context?.[START_ANYWAY_BRIEF_KEY]);
  if (!briefAt) return false;
  const recorded = [atOf(context?.[START_ANYWAY_ASSESSED_KEY]), atOf(context?.[START_ANYWAY_PARK_KEY]), atOf(context?.waitExit)];
  return !recorded.some(at => at !== null && at >= briefAt);
}

/** The path-claim refusal while `needsAssessmentBeforeEdit`, else null. */
export function startAnywayEditRefusal(context: Record<string, unknown> | null | undefined): { code: string; message: string } | null {
  if (!needsAssessmentBeforeEdit(context)) return null;
  return {
    code: 'assessment_required',
    message: 'This task was started before its prerequisites finished. Record your assessment first (update_progress { assessment: { needs, canProceed, uncertainty, nextStep } }), then claim the files you will edit.',
  };
}
