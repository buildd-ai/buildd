/**
 * Start anyway: assess, coordinate and continue (Living Spec 36df686b r1,
 * docs/specs/force-start.md).
 *
 * A person starts a task before its declared prerequisites finish. The task's
 * own agent assesses what can proceed, coordinates with live upstream work
 * through existing messaging, then works or parks on the prerequisite and
 * resumes the same task when it lands. Nothing here marks a prerequisite
 * satisfied, edits a dependency edge or starts upstream work.
 *
 * This module is the pure decision core every caller reads: `/start`
 * (authorization), the claim (the record and the assessment brief), the wait
 * exit (park), the dependency wake (resume) and every view (one phase, one
 * label). It reads nothing and writes nothing, and client components import
 * it, so it stays dependency-free.
 *
 * Durable state lives in `tasks.context`:
 *  - `forceStart` — the person's unclaimed request (lib/force-start.ts), with
 *    `assessDependsOn` naming the declared edges the claim admits;
 *  - `startAnyway` — this lifecycle once claimed: the assessment, the wake
 *    condition, and the request/claim/assess/park/wake facts.
 */

/** Context key of the Start anyway lifecycle record (`StartAnywayRecord`). */
export const START_ANYWAY_CONTEXT_KEY = 'startAnyway' as const;

/**
 * How long an accepted, unclaimed Start anyway request admits its named edges.
 * Long enough to outlast a missed wake or a runner that is offline for a
 * while (dispatch repair re-wakes it meanwhile); bounded so an old request
 * never admits a task days later. Other force kinds keep FORCE_START_TTL_MS.
 */
export const START_ANYWAY_TTL_MS = 24 * 60 * 60 * 1000;

/** A park after this many on one lifecycle is refused: a person decides. */
export const MAX_REPARKS = 3;

/** The facts recorded against the task, each distinct (R-15). */
export const START_ANYWAY_EVENTS = ['requested', 'claimed', 'assessed', 'coordinated', 'parked', 'woken', 'delivered'] as const;
export type StartAnywayEvent = (typeof START_ANYWAY_EVENTS)[number];

/** Every surface that shows the phase. One derivation, one label (AC-16). */
export const SURFACES = ['task_page', 'task_sheet', 'queue', 'explain', 'runner', 'activity'] as const;
export type StartAnywaySurface = (typeof SURFACES)[number];

/** What the agent records before it edits (R-4). */
export const ASSESSMENT_FIELDS = ['needs', 'canProceed', 'uncertainty', 'nextStep'] as const;
export interface Assessment {
  /** What this task needs from the prerequisite. */
  needs: string;
  /** What can proceed now, within this task's scope. */
  canProceed: string;
  /** What is not known. Missing evidence stays unknown. */
  uncertainty: string;
  /** The next step, in words a person reads on the task. */
  nextStep: string;
}

/** Things the assessment never does, named in the brief. */
export const ASSESSMENT_FORBIDS = [
  'mark_prerequisite_satisfied',
  'edit_dependency_edges',
  'rewrite_upstream_task',
  'start_upstream_worker',
  'protected_mutation',
] as const;

/** Worker statuses that mean an agent is live on the task (mirrors LIVE_WORKER_STATUSES in @buildd/shared). */
const LIVE_WORKER = new Set(['idle', 'running', 'starting', 'waiting_input']);
/** Prerequisite statuses that mean it will not land without a person. */
const DEAD_STATUSES = new Set(['failed']);
const ASSESSMENT_FIELD_MAX = 1000;
const HISTORY_MAX = 20;

// ── The live prerequisite and the brief ─────────────────────────────────────

export interface PrerequisiteState {
  id: string;
  title: string;
  status: string;
  worker: { id: string; status: string; currentAction?: string | null } | null;
  pr: { number?: number | null; url?: string | null; merged?: boolean } | null;
  /** The upstream task's last change, as epoch ms: the version a park observes. */
  version?: number | null;
}

/** Observed progress only. `unknown` when nothing observed says otherwise: age or status alone never does. */
export type PrerequisiteProgress = 'done' | 'pr_open' | 'active' | 'unknown';

export interface PrerequisiteFact {
  id: string;
  title: string;
  status: string;
  workerId: string | null;
  workerStatus: string | null;
  prNumber: number | null;
  progress: PrerequisiteProgress;
}

export function prerequisiteProgress(p: PrerequisiteState): PrerequisiteProgress {
  if (p.status === 'completed' && (!p.pr || p.pr.merged !== false)) return 'done';
  if (p.pr && p.pr.merged === false) return 'pr_open';
  if (p.worker && LIVE_WORKER.has(p.worker.status)) return 'active';
  return 'unknown';
}

const quoted = (title: string) => `“${title.replace(/^[“"]+|[”"]+$/g, '')}”`;

export interface AssessmentBrief {
  text: string;
  facts: PrerequisiteFact[];
  requiredAssessmentFields: readonly string[];
  forbids: readonly string[];
}

/**
 * The instruction the claimed agent reads first (R-4), with each
 * prerequisite's live task, worker and PR state. Recovery outcomes (existing
 * investigations or repairs) are listed as they are; none is invented.
 */
export function buildAssessmentBrief(input: {
  task: { id: string; title: string; specId?: string | null };
  prerequisites: PrerequisiteState[];
  recoveryOutcomes: Array<{ taskId: string; title: string; status: string; summary?: string | null }>;
  /** Set when this claim resumes a parked lifecycle. */
  resumed?: { assessment: Assessment | null; parkedOn: string | null; history: string[] } | null;
}): AssessmentBrief {
  const facts: PrerequisiteFact[] = input.prerequisites.map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    workerId: p.worker?.id ?? null,
    workerStatus: p.worker?.status ?? null,
    prNumber: p.pr?.number ?? null,
    progress: prerequisiteProgress(p),
  }));
  const lines: string[] = [];
  lines.push('## Started anyway: assess before you edit');
  lines.push('');
  lines.push(input.resumed
    ? 'A prerequisite this task parked on changed, so this task resumed. Re-read its live state below, check your saved assessment still holds, then carry on.'
    : 'A person started this task before its declared prerequisites finished. The dependency still stands: nothing marked it satisfied, and nothing will.');
  lines.push('');
  lines.push('### Prerequisites, as observed now');
  for (const f of facts) {
    const worker = f.workerId ? `agent ${f.workerId.slice(0, 8)} ${f.workerStatus}` : 'no agent';
    const pr = f.prNumber ? `PR #${f.prNumber}` : 'no PR';
    const progress = f.progress === 'unknown' ? 'progress unknown (nothing observed either way)' : `progress: ${f.progress.replace('_', ' ')}`;
    lines.push(`- ${quoted(f.title)} (task ${f.id}): status ${f.status}; ${worker}; ${pr}; ${progress}.`);
  }
  if (input.recoveryOutcomes.length > 0) {
    lines.push('');
    lines.push('### Existing investigations and repairs');
    for (const r of input.recoveryOutcomes) lines.push(`- ${quoted(r.title)} (task ${r.taskId}): ${r.status}${r.summary ? `. ${r.summary}` : ''}`);
  }
  if (input.resumed?.assessment) {
    lines.push('');
    lines.push('### Your saved assessment');
    for (const k of ASSESSMENT_FIELDS) lines.push(`- ${k}: ${input.resumed.assessment[k]}`);
  }
  if (input.resumed?.history.length) {
    lines.push('');
    lines.push(`Earlier: ${input.resumed.history.join(' → ')}.`);
  }
  lines.push('');
  lines.push('### Before any edit');
  lines.push(`1. Read the pinned spec${input.task.specId ? ` (${input.task.specId})` : ''}, recall the relevant knowledge, the current code and each prerequisite's task, PR and outcome. Learn what the dependency is for.`);
  lines.push('2. Record your assessment with `update_progress { assessment: { needs, canProceed, uncertainty, nextStep } }`: what you need from each prerequisite, what can proceed now inside this task\'s scope, what you do not know, and your next step. Say "unknown" where nothing tells you.');
  lines.push('3. Then choose one:');
  lines.push('   - **Work**: implement the part that does not need the prerequisite. Edits take the usual file ownership (path claims); a file another agent holds stays refused until it is released.');
  lines.push('   - **Coordinate**: when a prerequisite has a live agent and one interface, branch or ownership boundary would unblock you, send that agent one concrete message: `send_worker_message { recipientTaskId: <prerequisite task id>, type: "question", body: { text } }`. Its answer reaches you as a message. Do not repeat it, do not start or file upstream work, and do not change the upstream task.');
  lines.push('   - **Park**: when nothing useful can proceed, end with `complete_task { blockedOnTaskId, summary, assessment }`. The task goes back to the queue, frees its slot and its file claims, and starts again by itself when that prerequisite completes and merges. Do not wait in a loop.');
  lines.push('');
  lines.push('Never: mark a prerequisite done, edit dependency edges, change the scope or requirements yourself (a person and the spec revision rules decide), or perform a protected mutation whose precondition is unmet. A migration that needs the prerequisite\'s schema waits for it: earlier independent work does not.');
  return {
    text: lines.join('\n'),
    facts,
    requiredAssessmentFields: ASSESSMENT_FIELDS,
    forbids: ASSESSMENT_FORBIDS,
  };
}

// ── Coordination ────────────────────────────────────────────────────────────

export interface CoordinationPlan {
  action: 'message_upstream_worker' | 'await_existing_request' | 'park_on_prerequisite';
  workerId: string | null;
  message: string | null;
  createsWorker: false;
  createsTask: false;
  rewritesUpstream: false;
}

/**
 * One concrete request to the live upstream agent, through existing task
 * messaging (R-5, AC-10). An unanswered identical request is awaited, never
 * resent. With no live agent there is nobody to ask: park on the prerequisite.
 */
export function planCoordination(input: {
  prerequisite: PrerequisiteState;
  need: string;
  priorRequests: Array<{ workerId: string; need: string; answeredAt: string | null }>;
}): CoordinationPlan {
  const base = { createsWorker: false, createsTask: false, rewritesUpstream: false } as const;
  const w = input.prerequisite.worker;
  if (!w || !LIVE_WORKER.has(w.status)) {
    return { ...base, action: 'park_on_prerequisite', workerId: null, message: null };
  }
  const need = input.need.trim();
  if (input.priorRequests.some(r => r.workerId === w.id && r.need.trim() === need && !r.answeredAt)) {
    return { ...base, action: 'await_existing_request', workerId: w.id, message: null };
  }
  return {
    ...base,
    action: 'message_upstream_worker',
    workerId: w.id,
    message: `A task that depends on ${quoted(input.prerequisite.title)} started early to do the work that does not need it. One concrete request: ${need}. Reply with what you can commit to (interface, branch or files), or say it is not possible.`,
  };
}

// ── Assessment outcome ──────────────────────────────────────────────────────

export type AssessmentOutcome = 'independent_work' | 'coordinate' | 'park';
export interface AssessmentDecision {
  next: 'work' | 'record_boundary_first' | 'acquire_ownership_first' | 'coordinate' | 'park' | 'needs_authority';
  dependencyStillValid: boolean;
  marksPrerequisiteSatisfied: false;
}

/**
 * What the agent may do after assessing (R-6, AC-9). Work starts only once
 * the boundary is recorded and ownership acquired; a scope change goes to the
 * existing authority, never the agent.
 */
export function decideAssessment(input: {
  outcome: AssessmentOutcome;
  scopeChange: boolean;
  remaining: Array<{ prerequisiteId: string; reason: string }>;
  boundaryRecorded?: boolean;
  ownershipAcquired?: boolean;
}): AssessmentDecision {
  const base = { dependencyStillValid: input.remaining.length > 0 || input.outcome !== 'independent_work', marksPrerequisiteSatisfied: false as const };
  if (input.scopeChange) return { ...base, next: 'needs_authority' };
  if (input.outcome === 'park') return { ...base, next: 'park' };
  if (input.outcome === 'coordinate') return { ...base, next: 'coordinate' };
  if (input.boundaryRecorded === false) return { ...base, next: 'record_boundary_first' };
  if (input.ownershipAcquired === false) return { ...base, next: 'acquire_ownership_first' };
  return { ...base, next: 'work' };
}

/** A well-formed assessment from untrusted input, or the first problem with it. */
export function parseAssessment(raw: unknown): { ok: true; assessment: Assessment } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'assessment must be { needs, canProceed, uncertainty, nextStep }' };
  const out: Partial<Assessment> = {};
  for (const k of ASSESSMENT_FIELDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== 'string' || !v.trim()) return { ok: false, error: `assessment.${k} is required: say "unknown" when nothing tells you` };
    out[k] = v.trim().slice(0, ASSESSMENT_FIELD_MAX);
  }
  return { ok: true, assessment: out as Assessment };
}

// ── Park, wake and resume ───────────────────────────────────────────────────

export interface WakeCondition {
  event: 'task.completed+merged';
  taskId: string;
  observedVersion: number | null;
}

export interface ParkPlan {
  wake: WakeCondition;
  assessment: Assessment;
  releasesExecutionSlot: true;
  releasesUnusedEditOwnership: true;
  pollsWithModel: false;
  taskStatusAfter: 'pending';
  readableNextStep: string;
  persist: { assessment: Assessment; wake: WakeCondition };
}

/** The park the wait exit applies (R-8): the same task, back to pending, slot and leases freed. */
export function planPark(input: {
  assessment: Assessment;
  prerequisite: { id: string; title: string; status: string; version?: number | null };
}): ParkPlan {
  const wake: WakeCondition = { event: 'task.completed+merged', taskId: input.prerequisite.id, observedVersion: input.prerequisite.version ?? null };
  return {
    wake,
    assessment: input.assessment,
    releasesExecutionSlot: true,
    releasesUnusedEditOwnership: true,
    pollsWithModel: false,
    taskStatusAfter: 'pending',
    readableNextStep: `Waiting on ${quoted(input.prerequisite.title)} · next: ${input.assessment.nextStep}`,
    persist: { assessment: input.assessment, wake },
  };
}

export type ExecutionPhase = 'requested' | 'assessing' | 'working' | 'parked' | 'blocked';

/** Capacity counts executing work only (R-12, AC-11): a parked or requested task holds no slot. */
export function countsAsExecuting(s: { phase: string }): boolean {
  return s.phase === 'assessing' || s.phase === 'working';
}

/**
 * Subscribe-and-recheck (R-9): after the park is written, the prerequisite is
 * read again. Satisfied while parking: resume now. Unchanged: stay parked.
 * Changed but not satisfied: reassess against the new version.
 */
export function settlePark(input: {
  wake: WakeCondition;
  current: { status: string; merged: boolean; version: number | null } | null;
}): { decision: 'resume' | 'park' | 'reassess' | 'blocked' } {
  const c = input.current;
  if (!c) return { decision: 'blocked' };
  if ((c.status === 'completed' && c.merged) || c.status === 'cancelled') return { decision: 'resume' };
  if (DEAD_STATUSES.has(c.status)) return { decision: 'blocked' };
  if (input.wake.observedVersion == null || c.version == null || c.version === input.wake.observedVersion) return { decision: 'park' };
  return { decision: 'reassess' };
}

export interface ParkedState {
  taskId: string;
  phase: string;
  wake: WakeCondition;
  resumes: number;
  reparks?: number;
  seenEventIds?: string[];
  blockedReason?: string;
}
export interface WakeEvent { type: string; taskId: string; version: number; id?: string }
export type WakeEffect =
  | { kind: 'resume'; taskId: string; carries: string[] }
  | { kind: 'reassess'; taskId: string };

/**
 * One prerequisite event against a parked task (R-9, R-11, AC-12). Exactly
 * one resume per park however often the event is delivered; a dead
 * prerequisite blocks explicitly and files nothing; a changing-but-unfinished
 * prerequisite is reassessed at most MAX_REPARKS times.
 */
export function reduceWake(state: ParkedState, event: WakeEvent): { state: ParkedState; effects: WakeEffect[] } {
  if (event.taskId !== state.wake.taskId) return { state, effects: [] };
  const seen = state.seenEventIds ?? [];
  if (event.id && seen.includes(event.id)) return { state, effects: [] };
  const next: ParkedState = { ...state, seenEventIds: event.id ? [...seen, event.id].slice(-HISTORY_MAX) : seen };
  if (state.phase !== 'parked' && state.phase !== 'blocked') return { state: next, effects: [] };
  if (event.type === state.wake.event || event.type === 'task.cancelled') {
    return {
      state: { ...next, phase: 'resumed', resumes: state.resumes + 1, blockedReason: undefined },
      effects: [{ kind: 'resume', taskId: state.taskId, carries: ['assessment', 'coordinationHistory', 'branch'] }],
    };
  }
  if (event.type === 'task.failed' || event.type === 'task.deleted') {
    return {
      state: { ...next, phase: 'blocked', blockedReason: `Prerequisite ${event.taskId} ${event.type === 'task.failed' ? 'failed' : 'no longer exists'}; it resumes only if that task is retried and lands, or a person removes the dependency.` },
      effects: [],
    };
  }
  const reparks = state.reparks ?? 0;
  if (state.phase === 'blocked' || reparks >= MAX_REPARKS) return { state: next, effects: [] };
  if (state.wake.observedVersion != null && event.version <= state.wake.observedVersion) return { state: next, effects: [] };
  return {
    state: { ...next, reparks: reparks + 1, wake: { ...state.wake, observedVersion: event.version } },
    effects: [{ kind: 'reassess', taskId: state.taskId }],
  };
}

export interface ResumePlan {
  mode: 'continue_session' | 'new_attempt';
  taskId: string;
  sessionId: string | null;
  createsReplacementTask: false;
  context: { assessment: unknown; history: unknown[] };
  refreshCredentials: true;
  revalidateEditOwnership: true;
}

/**
 * Resume keeps the task's identity (R-10, AC-17). A valid session continues;
 * otherwise a new attempt under the same task gets the saved assessment and
 * history. Either way credentials are minted fresh and file ownership is
 * re-acquired at edit time: nothing a park released is assumed still held.
 */
export function planResume(input: {
  saved: { taskId: string; assessment: unknown; history: unknown[]; sessionId: string | null };
  sessionValid: boolean;
}): ResumePlan {
  const cont = input.sessionValid && !!input.saved.sessionId;
  return {
    mode: cont ? 'continue_session' : 'new_attempt',
    taskId: input.saved.taskId,
    sessionId: cont ? input.saved.sessionId : null,
    createsReplacementTask: false,
    context: { assessment: input.saved.assessment, history: input.saved.history },
    refreshCredentials: true,
    revalidateEditOwnership: true,
  };
}

// ── What every view shows ───────────────────────────────────────────────────

export interface PhaseFacts {
  /** An accepted, unexpired, unclaimed request. */
  intent: { id: string } | null;
  claimed: boolean;
  parked: boolean;
  /** A live worker is executing the task now. */
  executing: boolean;
  /** The assessment is recorded (work proceeds). */
  assessed?: boolean;
  prerequisite?: { title: string; status?: string } | null;
  nextStep?: string | null;
  surface?: StartAnywaySurface | string;
}

export interface PhaseView {
  phase: ExecutionPhase;
  label: string;
  /** The public task status: unchanged by Start anyway. */
  taskStatus: 'pending' | 'in_progress';
}

/**
 * The one observed phase and label (R-12, AC-16). A request is never shown as
 * running before a claim; a park names its prerequisite and next step. The
 * label does not depend on the surface.
 */
export function startAnywayPhase(f: PhaseFacts): PhaseView {
  const prereq = f.prerequisite?.title ? quoted(f.prerequisite.title) : 'its prerequisite';
  if (f.executing) {
    return f.assessed
      ? { phase: 'working', label: `Agent working on what does not need ${prereq}`, taskStatus: 'in_progress' }
      : { phase: 'assessing', label: `Agent assessing what can proceed before ${prereq}`, taskStatus: 'in_progress' };
  }
  if (f.parked || f.claimed) {
    if (f.prerequisite?.status && DEAD_STATUSES.has(f.prerequisite.status)) {
      return { phase: 'blocked', label: `Blocked: ${prereq} ${f.prerequisite.status} · a person decides what happens next`, taskStatus: 'pending' };
    }
    return { phase: 'blocked', label: `Blocked on ${prereq}${f.nextStep ? ` · next: ${f.nextStep}` : ''}`, taskStatus: 'pending' };
  }
  return { phase: 'requested', label: 'Start requested · waiting for a runner to pick it up', taskStatus: 'pending' };
}

// ── Authorization and access ────────────────────────────────────────────────

/**
 * Admission is the person's authority to start the task, nothing more (R-13,
 * AC-15): no model call, confidence, provider or explanation is consulted.
 */
export function authorizeStartAnyway(input: { canStartTask: boolean; note?: string | null; jevAvailable?: boolean }): { allowed: boolean; consults: string[] } {
  return { allowed: input.canStartTask, consults: [] };
}

/** What scheduling admission never grants (R-7). */
const NEVER_GRANTED = ['credential', 'permission', 'release', 'merge', 'destructive'] as const;

/**
 * Assessment reads claim nothing and displace no writer; an edit needs the
 * ordinary ownership of its paths, refused while another writer holds them
 * (R-7, R-14, AC-13). Admission grants nothing in NEVER_GRANTED.
 */
export function assessmentAccess(input: { kind: 'read' | 'edit'; paths: string[]; activeWriter: string | null }): {
  allowed: boolean; claimsPaths: string[]; requiresOwnership: string[]; displacesWriter: false; grants: string[];
} {
  if (input.kind === 'read') return { allowed: true, claimsPaths: [], requiresOwnership: [], displacesWriter: false, grants: [] };
  return { allowed: input.activeWriter == null, claimsPaths: [], requiresOwnership: [...input.paths], displacesWriter: false, grants: [] };
}

/**
 * A protected mutation follows its own precondition, never the Start anyway
 * intent (AC-18): a migration that needs the prerequisite's schema waits for
 * it; release, merge, credentials, permissions and destructive work are never
 * authorized by scheduling admission.
 */
export function authorizeProtectedMutation(input: { mutation: string; preconditionMet: boolean; startAnywayIntent: boolean }): { allowed: boolean; reason: string } {
  if ((NEVER_GRANTED as readonly string[]).includes(input.mutation)) {
    return { allowed: false, reason: `${input.mutation} is never authorized by starting a task; it follows its own review and permission rules.` };
  }
  return input.preconditionMet
    ? { allowed: true, reason: 'its own precondition is met' }
    : { allowed: false, reason: 'its precondition is unmet; Start anyway does not lift it' };
}

/** A human override records a preference; it grades no model (R-15). */
export function humanOverrideGrade(input: { executionSucceeded: boolean; deliveryVerified: boolean }) {
  return { humanPreference: 'recorded' as const, labelsModelWrong: false as const, executionSucceeded: input.executionSucceeded, deliveryVerified: input.deliveryVerified };
}

/** Starting one task never starts its dependants (R-16). */
export function startsDependants(): false {
  return false;
}

/**
 * Whether a request admits one dependency edge for assessment: the TS twin of
 * the claim's SQL arm (claim/deps-gate.ts). Only an unexpired request naming
 * exactly that edge; it never satisfies the edge.
 */
export function admitsDeclaredEdge(input: { intent: { assessDependsOn?: string[]; expiresAt: string } | null; edgeId: string; now?: Date }): boolean {
  const i = input.intent;
  if (!i || !Array.isArray(i.assessDependsOn) || !i.assessDependsOn.includes(input.edgeId)) return false;
  const exp = Date.parse(i.expiresAt);
  return Number.isFinite(exp) && exp > (input.now ?? new Date()).getTime();
}

// ── The durable record ──────────────────────────────────────────────────────

export interface StartAnywayFact { fact: StartAnywayEvent; at: string; workerId?: string | null; detail?: string }

export interface StartAnywayRecord {
  intentId: string;
  requestedBy: string | null;
  requestedAt: string;
  prerequisiteIds: string[];
  phase: 'assessing' | 'parked';
  claimedAt: string | null;
  assessment: Assessment | null;
  wake: WakeCondition | null;
  parkedAt: string | null;
  /** The parked worker's session, kept for continuation when the runner still holds it. */
  sessionId: string | null;
  reparks: number;
  resumes: number;
  facts: StartAnywayFact[];
}

export function readStartAnyway(context: Record<string, unknown> | null | undefined): StartAnywayRecord | null {
  const raw = context?.[START_ANYWAY_CONTEXT_KEY] as Partial<StartAnywayRecord> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.intentId !== 'string' || !Array.isArray(raw.prerequisiteIds)) return null;
  return {
    intentId: raw.intentId,
    requestedBy: raw.requestedBy ?? null,
    requestedAt: raw.requestedAt ?? '',
    prerequisiteIds: raw.prerequisiteIds,
    phase: raw.phase === 'parked' ? 'parked' : 'assessing',
    claimedAt: raw.claimedAt ?? null,
    assessment: raw.assessment ?? null,
    wake: raw.wake ?? null,
    parkedAt: raw.parkedAt ?? null,
    sessionId: raw.sessionId ?? null,
    reparks: typeof raw.reparks === 'number' ? raw.reparks : 0,
    resumes: typeof raw.resumes === 'number' ? raw.resumes : 0,
    facts: Array.isArray(raw.facts) ? raw.facts : [],
  };
}

const withFact = (r: StartAnywayRecord, f: StartAnywayFact): StartAnywayFact[] => [...r.facts, f].slice(-HISTORY_MAX);

/**
 * The record a claim writes. A request naming declared edges opens a new
 * lifecycle (`requested` + `claimed`); a claim of a parked lifecycle is its
 * resume (`woken` + `claimed`), keeping the assessment; any other claim of an
 * open lifecycle (a retried attempt) records the claim. Null: no lifecycle.
 */
export function startAnywayOnClaim(
  context: Record<string, unknown>,
  intent: { id: string; at: string; userId: string | null; assessDependsOn?: string[] } | null,
  at: Date,
): StartAnywayRecord | null {
  const now = at.toISOString();
  const prior = readStartAnyway(context);
  if (intent?.assessDependsOn?.length) {
    const base: StartAnywayRecord = {
      intentId: intent.id,
      requestedBy: intent.userId,
      requestedAt: intent.at,
      prerequisiteIds: [...intent.assessDependsOn],
      phase: 'assessing',
      claimedAt: now,
      assessment: prior?.assessment ?? null,
      wake: null,
      parkedAt: null,
      sessionId: null,
      reparks: prior?.reparks ?? 0,
      resumes: prior?.resumes ?? 0,
      facts: prior?.facts ?? [],
    };
    return { ...base, facts: withFact({ ...base, facts: withFact(base, { fact: 'requested', at: intent.at }) }, { fact: 'claimed', at: now }) };
  }
  if (!prior) return null;
  if (prior.phase === 'parked') {
    const resumed = { ...prior, phase: 'assessing' as const, claimedAt: now, resumes: prior.resumes + 1 };
    return { ...resumed, facts: withFact({ ...resumed, facts: withFact(resumed, { fact: 'woken', at: now, detail: prior.wake?.taskId }) }, { fact: 'claimed', at: now }) };
  }
  return { ...prior, claimedAt: now, facts: withFact(prior, { fact: 'claimed', at: now }) };
}

/** The record after the agent saves its assessment (`assessed`). */
export function recordAssessment(r: StartAnywayRecord, assessment: Assessment, at: Date, workerId: string | null): StartAnywayRecord {
  return { ...r, assessment, facts: withFact(r, { fact: 'assessed', at: at.toISOString(), workerId }) };
}

/** The record after a park (`parked`), from `planPark`. */
export function recordPark(r: StartAnywayRecord, park: ParkPlan, at: Date, worker: { id: string | null; sessionId: string | null }): StartAnywayRecord {
  return {
    ...r,
    phase: 'parked',
    assessment: park.assessment,
    wake: park.wake,
    parkedAt: at.toISOString(),
    sessionId: worker.sessionId,
    reparks: r.reparks + 1,
    facts: withFact(r, { fact: 'parked', at: at.toISOString(), workerId: worker.id, detail: park.wake.taskId }),
  };
}

/**
 * Why a Start anyway park is refused before anything is written, or null. A
 * lifecycle that already parked MAX_REPARKS times stops looping (R-11).
 */
export function parkRefusal(r: StartAnywayRecord | null): { code: string; error: string } | null {
  if (r && r.reparks >= MAX_REPARKS) {
    return { code: 'repark_limit', error: `This task has parked ${r.reparks} times; it does not park again on its own. Ask a person (AskUserQuestion) what to do about the prerequisite.` };
  }
  return null;
}

/** The facts as a short readable chain for the brief: "requested → claimed → parked". */
export function factChain(r: StartAnywayRecord | null): string[] {
  return (r?.facts ?? []).map(f => f.fact);
}

/**
 * Why a Start anyway task may not take file ownership yet, or null: it is
 * assessing and has not recorded its assessment. Reads need no ownership, so
 * this only gates edits; another writer's lease still refuses on its own.
 */
export function startAnywayEditRefusal(context: unknown): { code: string; message: string } | null {
  const r = readStartAnyway((context ?? {}) as Record<string, unknown>);
  if (!r || r.phase !== 'assessing' || r.assessment) return null;
  return {
    code: 'assessment_required',
    message: 'This task was started before its prerequisites finished. Record your assessment first (update_progress { assessment: { needs, canProceed, uncertainty, nextStep } }), then claim the files you will edit.',
  };
}
