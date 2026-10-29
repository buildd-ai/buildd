/**
 * The terms catalog: the one word every surface shows for a state.
 *
 * The web dashboard, `buildd top`, runner CLI output, MCP replies, PR activity
 * comments and notifications read their state words from here, so one
 * internal fact reads the same everywhere. Internal names (kernel delivery
 * states, `tasks.status`, worker status, mission stage steps, waiting kinds,
 * strip display states) are never renamed: each term lists the values it maps
 * from, and `termFor` resolves any of them.
 *
 * Pure, no DB, no runtime imports: the runner and client components import it.
 * `packages/shared/__tests__/terms.test.ts` proves every enum value resolves,
 * `scripts/copy-check.ts` (rule `catalog-word`) bans the words in
 * BANNED_WORDS, and `bun run terms:doc` writes docs/design/terms.md from it.
 * Design: knowledge-base artifact `copy-terminology-catalog`.
 */

import type { MissionStageStep } from './types';

/** Every MissionStageStep at runtime; the type check below fails if the union grows. */
export const MISSION_STAGE_STEPS = ['building', 'verifying', 'delivering', 'delivered', 'on_hold', 'planning'] as const satisfies readonly MissionStageStep[];
type _EveryStageListed = Exclude<MissionStageStep, (typeof MISSION_STAGE_STEPS)[number]> extends never ? true : never;
const _everyStageListed: _EveryStageListed = true;
void _everyStageListed;

/** Hue family, the same names as the web pill (components/ui/states.ts `StateTone`). */
export type TermTone = 'ok' | 'run' | 'act' | 'bad' | 'q' | 'dec';

/** Which internal vocabulary a value comes from. */
export type InternalKind =
  | 'kernel'          // workflow-kernel DELIVERY_STATES
  | 'task.status'     // tasks.status
  | 'worker.status'   // workers.status
  | 'mission.stage'   // MissionStageStep
  | 'mission.gate'    // missions.isHeld, read with armedAt
  | 'waiting'         // core WaitingKind
  | 'strip'           // web strip / pill StateKey
  | 'runner'          // runner-level states (buildd hold)
  | 'release'         // a release's deploy state
  | 'mission.executor' // missions.executor
  | 'worker.runner';  // workers.runner: `mcp` is an interactive session's claim

/**
 * One internal value. `when` narrows it: `task.status completed` reads Merged
 * when its PR merged and Done otherwise.
 */
export interface InternalRef {
  kind: InternalKind;
  value: string;
  when?: string;
}

export type TermKey =
  // Mission start gate (missions.isHeld)
  | 'mission.not_started'
  | 'mission.paused'
  | 'mission.planning'
  | 'mission.building'
  | 'mission.verifying'
  | 'mission.done'
  | 'mission.your_session'
  // One task's work
  | 'work.ready'
  | 'work.blocked'
  | 'work.working'
  | 'work.has_question'
  | 'work.paused'
  | 'work.done'
  | 'work.failed'
  | 'work.cancelled'
  | 'work.replaced'
  | 'work.recovering'
  | 'work.your_session'
  // A PR (kernel delivery)
  | 'pr.waiting_push'
  | 'pr.in_review'
  | 'pr.checking'
  | 'pr.changes_requested'
  | 'pr.fixing'
  | 'pr.ci_failed'
  | 'pr.blocked_on_base'
  | 'pr.ready_to_merge'
  | 'pr.merging'
  | 'pr.merged'
  | 'pr.merged_elsewhere'
  | 'pr.closed'
  | 'decision.waiting_on_you'
  | 'decision.your_decision'
  | 'decision.approval_required'
  // Why something has not started
  | 'wait.scheduled'
  | 'wait.usage_limit'
  | 'wait.budget'
  | 'wait.lane'
  | 'wait.files'
  | 'wait.slot'
  | 'wait.runner'
  | 'wait.no_runner'
  | 'wait.unknown'
  | 'wait.agent'
  | 'wait.checks'
  | 'wait.review'
  // Queue (Health › Queue): tabs, reasons and the row words around them
  | 'queue.blocked'
  | 'queue.lane'
  | 'queue.limit'
  | 'queue.dependency'
  | 'queue.needs_review'
  | 'queue.retrying'
  | 'queue.retried'
  // Runner, release, totals
  | 'runner.paused'
  | 'release.releasing'
  | 'release.released'
  | 'total.done_this_week';

export interface Term {
  key: TermKey;
  /** Sentence case. A surface may append detail ("Merged · #4955"), never a synonym. */
  word: string;
  /** Terminal form. May shorten the word, never re-word it. */
  short: string;
  /** One plain sentence: what is true. Shown on hover and `?` in top. */
  means: string;
  glyph?: string;
  tone: TermTone;
  /** What ends this state, when a person or time can. */
  liftedBy?: string;
  from: InternalRef[];
}

const k = (value: string, when?: string): InternalRef => ({ kind: 'kernel', value, ...(when ? { when } : {}) });
const ts = (value: string, when?: string): InternalRef => ({ kind: 'task.status', value, ...(when ? { when } : {}) });
const ws = (value: string): InternalRef => ({ kind: 'worker.status', value });
const st = (value: string, when?: string): InternalRef => ({ kind: 'mission.stage', value, ...(when ? { when } : {}) });
const wk = (...values: string[]): InternalRef[] => values.map((value) => ({ kind: 'waiting' as const, value }));
const sk = (value: string): InternalRef => ({ kind: 'strip', value });

const TERM_LIST: Term[] = [
  // ── Missions ──────────────────────────────────────────────────────────────
  { key: 'mission.not_started', word: 'Not started', short: 'not started', tone: 'q', glyph: '□',
    means: 'Nobody has started this mission; its tasks wait for Start.', liftedBy: 'Start the mission',
    from: [{ kind: 'mission.gate', value: 'held', when: 'neverStarted' }, st('on_hold', 'neverStarted'), { kind: 'waiting', value: 'mission_held', when: 'neverStarted' }] },
  { key: 'mission.paused', word: 'Paused', short: 'paused', tone: 'q', glyph: '‖',
    means: 'A person paused the mission; Resume lets its tasks start again.', liftedBy: 'Resume the mission',
    from: [{ kind: 'mission.gate', value: 'held' }, st('on_hold'), ...wk('mission_held')] },
  { key: 'mission.planning', word: 'Planning', short: 'planning', tone: 'run',
    means: 'An agent is choosing the next tasks.', from: [st('planning')] },
  { key: 'mission.building', word: 'Building', short: 'building', tone: 'act',
    means: 'Agents are working on the mission’s tasks.', from: [st('building')] },
  { key: 'mission.verifying', word: 'Verifying', short: 'verifying', tone: 'run',
    means: 'The mission’s checks are running on its outcome.', from: [st('verifying')] },
  { key: 'mission.done', word: 'Done', short: 'done', tone: 'ok', glyph: '■',
    means: 'Every task is finished and the mission’s checks passed.', from: [st('delivered')] },
  { key: 'mission.your_session', word: 'Run from your session', short: 'your session', tone: 'q',
    means: 'Its tasks start from a person’s own Claude Code session, not a runner.', liftedBy: 'Claim a task from your session',
    from: [...wk('mission_local'), { kind: 'mission.executor', value: 'local' }] },

  // ── A task's work ─────────────────────────────────────────────────────────
  { key: 'work.ready', word: 'Queued', short: 'queued', tone: 'q', glyph: '□',
    means: 'Nothing stops it; it starts when a slot frees.',
    from: [ts('pending'), ws('idle'), sk('ready'), ...wk('eligible_no_runner')] },
  { key: 'work.blocked', word: 'Waiting on a task', short: 'waiting on a task', tone: 'q', glyph: '▦',
    means: 'It waits on another task and starts by itself when that one finishes.',
    from: [sk('blocked'), sk('queued'), ...wk('dep_declared', 'ordered_behind')] },
  { key: 'work.working', word: 'Running', short: 'running', tone: 'act', glyph: '▶',
    means: 'An agent is working on it.',
    from: [k('WORKING'), ts('assigned'), ts('in_progress'), ws('starting'), ws('running'), sk('running')] },
  { key: 'work.has_question', word: 'Has a question', short: 'question', tone: 'act', glyph: '◇',
    means: 'The agent stopped to ask something; it continues when someone answers.', liftedBy: 'Answer the question',
    from: [ws('waiting_input'), sk('waiting')] },
  { key: 'work.paused', word: 'Paused', short: 'paused', tone: 'q', glyph: '‖',
    means: 'A person paused this task; Resume continues it.', liftedBy: 'Resume the task',
    from: [ws('paused'), ...wk('task_held')] },
  { key: 'work.done', word: 'Done', short: 'done', tone: 'ok', glyph: '■',
    means: 'The task finished; it had nothing to merge.',
    from: [ts('completed'), ws('completed'), ws('done')] },
  { key: 'work.failed', word: 'Failed', short: 'failed', tone: 'bad', glyph: '⊠',
    means: 'The task stopped without a change to merge.',
    from: [k('FAILED'), ts('failed'), ws('failed'), ws('error'), sk('failed')] },
  { key: 'work.cancelled', word: 'Cancelled', short: 'cancelled', tone: 'q', glyph: '✕',
    means: 'A person cancelled the task.', from: [ts('cancelled')] },
  { key: 'work.replaced', word: 'Replaced', short: 'replaced', tone: 'q',
    means: 'Another task took over this work.', from: [ws('superseded')] },
  { key: 'work.recovering', word: 'Recovering', short: 'recovering', tone: 'q', glyph: '⊘',
    means: 'A check can’t run; buildd is restoring it.', from: [sk('recovering')] },
  { key: 'work.your_session', word: 'Running in your session', short: 'your session', tone: 'act', glyph: '▶',
    means: 'A person claimed it from their own Claude Code session; buildd does not run or stop it.',
    from: [{ kind: 'worker.runner', value: 'mcp' }] },

  // ── A PR ──────────────────────────────────────────────────────────────────
  { key: 'pr.waiting_push', word: 'Waiting for push', short: 'waiting for push', tone: 'run',
    means: 'The agent finished; its commits are not on the PR yet.', from: [k('AWAITING_PUSH')] },
  { key: 'pr.in_review', word: 'In review', short: 'in review', tone: 'run', glyph: '◐',
    means: 'An agent is reviewing the PR.', from: [k('AWAITING_REVIEW'), ts('review'), sk('review')] },
  { key: 'pr.checking', word: 'Checking', short: 'checking', tone: 'run', glyph: '◐',
    means: 'Required checks are running on the current revision.', from: [] },
  { key: 'pr.changes_requested', word: 'Changes requested', short: 'changes requested', tone: 'act',
    means: 'The review asked for changes; a fix starts next.', from: [k('CHANGES_REQUESTED')] },
  { key: 'pr.fixing', word: 'Fixing', short: 'fixing', tone: 'act', glyph: '↻',
    means: 'An agent is fixing a failed check, a conflict or review comments.',
    from: [k('FIXING'), k('REPAIRING'), sk('fixing')] },
  { key: 'pr.ci_failed', word: 'CI failed', short: 'CI failed', tone: 'bad', glyph: '⊗',
    means: 'A required check failed on the current revision.', from: [sk('ci_failed')] },
  { key: 'pr.blocked_on_base', word: 'Blocked on base', short: 'blocked on base', tone: 'q',
    means: 'The target branch is red; the PR waits until it is green.', from: [k('BLOCKED_ON_TRUNK')] },
  { key: 'pr.ready_to_merge', word: 'Ready to merge', short: 'ready to merge', tone: 'dec',
    means: 'Approved with checks green; a person merges it.', liftedBy: 'Merge the PR', from: [k('APPROVED', 'humanMerges')] },
  { key: 'pr.merging', word: 'Merging', short: 'merging', tone: 'ok', glyph: '▲',
    means: 'Approved with checks green; buildd is merging it now.',
    from: [k('LANDING'), k('APPROVED'), sk('landing'), st('delivering')] },
  { key: 'pr.merged', word: 'Merged', short: 'merged', tone: 'ok', glyph: '■',
    means: 'The PR is merged into its target branch.',
    from: [k('MERGED'), ts('completed', 'hasMergedPr'), sk('landed')] },
  { key: 'pr.merged_elsewhere', word: 'Merged in another PR', short: 'merged in #N', tone: 'ok', glyph: '■',
    means: 'The change reached the branch through another PR.', from: [k('SUPERSEDED')] },
  { key: 'pr.closed', word: 'Closed without merging', short: 'closed', tone: 'bad', glyph: '✕',
    means: 'The PR closed and its change did not merge.',
    from: [k('CLOSED_UNMERGED'), k('ABANDONED'), sk('not_landed'), ...wk('subject_dead')] },
  { key: 'decision.approval_required', word: 'Approval required', short: 'approval required', tone: 'dec', glyph: '!',
    means: 'A policy gate only a person can clear: a migration, a human merge or an escalation.', liftedBy: 'Approve or decline it',
    from: [] },
  { key: 'decision.waiting_on_you', word: 'Waiting on you', short: 'waiting on you', tone: 'dec', glyph: '!',
    means: 'A decision only a person can make.', liftedBy: 'Answer the decision', from: [k('ESCALATED'), sk('needs_you')] },
  // The task row's word for the same state (Navigation R-14): the mission's task list and its summary line.
  { key: 'decision.your_decision', word: 'Your decision', short: 'your decision', tone: 'dec', glyph: '!',
    means: 'An agent asked a question only a person can answer; the work waits for the answer.', liftedBy: 'Answer the question', from: [] },

  // ── Why it has not started ────────────────────────────────────────────────
  { key: 'wait.scheduled', word: 'Scheduled', short: 'scheduled', tone: 'q',
    means: 'Starts by itself at its start time.', liftedBy: 'starts at its start time', from: wk('start_deferred', 'workspace_paused') },
  { key: 'wait.usage_limit', word: 'Usage limit', short: 'usage limit', tone: 'q',
    means: 'The provider’s usage limit is reached; it starts when the limit resets.', liftedBy: 'the limit resets',
    from: [...wk('budget_paused', 'managed_entitlement'), { kind: 'runner', value: 'budget_exhausted' }] },
  { key: 'wait.budget', word: 'Budget reached', short: 'budget reached', tone: 'q',
    means: 'The mission spent its budget; it starts when someone raises it.', liftedBy: 'Raise the mission budget',
    from: wk('mission_budget') },
  { key: 'wait.lane', word: 'Waiting in line', short: 'in line', tone: 'q',
    means: 'Schema, migration and other one-at-a-time work runs one task at a time, first come; it starts when the task holding the line lands and the tasks ahead of it have gone.',
    from: wk('lane', 'lease_stale', 'serialized_surface') },
  { key: 'wait.files', word: 'Waiting for files', short: 'same files', tone: 'q',
    means: 'Another task is changing the same files; it starts when that task finishes.',
    from: [] },
  { key: 'wait.slot', word: 'Waiting for a free slot', short: 'no free slot', tone: 'q',
    means: 'Every slot it may use is in use; it starts when one frees.',
    from: wk('mission_concurrent', 'account_slots', 'codex_single_flight', 'dispatch_undelivered', 'runner_cooldown') },
  { key: 'wait.runner', word: 'Waiting for its runner', short: 'waiting for its runner', tone: 'q',
    means: 'It asked for one runner; it starts when that runner is online.', from: wk('runner_preference') },
  { key: 'wait.no_runner', word: 'No runner can run it', short: 'no runner can run it', tone: 'bad',
    means: 'No online runner has the role, provider or setup it needs.', liftedBy: 'Fix the runner or the task setup',
    from: wk('provider_unavailable', 'role_unavailable', 'capability_mismatch') },
  { key: 'wait.unknown', word: 'Not started: reason unknown', short: 'reason unknown', tone: 'q',
    means: 'The server did not say why it has not started.', from: wk('unknown') },
  { key: 'wait.agent', word: 'Waiting for an agent', short: 'waiting for an agent', tone: 'q',
    means: 'The work is filed; it starts when an agent picks it up.', from: [] },
  { key: 'wait.checks', word: 'Waiting for checks', short: 'waiting for checks', tone: 'q',
    means: 'Nothing is running here; the PR waits on its required checks.', from: [] },
  { key: 'wait.review', word: 'Waiting for review', short: 'waiting for review', tone: 'q',
    means: 'The PR waits for a reviewer to pick it up.', from: [] },

  // ── Queue (Health › Queue). Tabs: Queued, Blocked, Scheduled, Paused. Reasons: Lane, Limit, Dependency.
  // Display words only: the internal values stay mapped by the terms above.
  { key: 'queue.blocked', word: 'Blocked', short: 'blocked', tone: 'q',
    means: 'The task cannot start yet; its reason (Lane, Limit or Dependency) says why.', from: [] },
  { key: 'queue.lane', word: 'Lane', short: 'lane', tone: 'q',
    means: 'Another task holds the lane it needs: the same files or the same runner.', from: [] },
  { key: 'queue.limit', word: 'Limit', short: 'limit', tone: 'q',
    means: 'A cap is reached: slots, budget or the provider’s usage limit.', from: [] },
  { key: 'queue.dependency', word: 'Dependency', short: 'dependency', tone: 'q',
    means: 'It waits on another task and starts by itself when that one finishes.', from: [] },
  { key: 'queue.needs_review', word: 'Needs review', short: 'needs review', tone: 'act',
    means: 'The PR is open and waits for a reviewer.', from: [] },
  { key: 'queue.retrying', word: 'Retrying', short: 'retrying', tone: 'run',
    means: 'A new attempt at this work is running.', from: [] },
  { key: 'queue.retried', word: 'Retried', short: 'retried', tone: 'q',
    means: 'A later attempt took over this work.', from: [] },

  // ── Runners, releases, totals ─────────────────────────────────────────────
  { key: 'runner.paused', word: 'Paused', short: 'paused', tone: 'q', glyph: '‖',
    means: 'This runner starts nothing new; running agents finish.', liftedBy: 'buildd resume',
    from: [{ kind: 'runner', value: 'hold' }] },
  { key: 'release.releasing', word: 'Releasing', short: 'releasing', tone: 'run',
    means: 'The release is deploying to production.', from: [{ kind: 'release', value: 'deploying' }] },
  { key: 'release.released', word: 'Released', short: 'released', tone: 'ok',
    means: 'The change is live in production.', from: [{ kind: 'release', value: 'deployed' }] },
  { key: 'total.done_this_week', word: 'Done this week', short: 'Done this week', tone: 'ok',
    means: 'Tasks that finished this week.', from: [] },
];

export const TERMS: Readonly<Record<TermKey, Term>> = Object.freeze(
  Object.fromEntries(TERM_LIST.map((t) => [t.key, Object.freeze(t)])) as Record<TermKey, Term>,
);

const refId = (kind: string, value: string, when?: string) => `${kind}\u0000${value}\u0000${when ?? ''}`;
const INDEX = new Map<string, Term>();
for (const t of TERM_LIST) {
  for (const r of t.from) {
    const id = refId(r.kind, r.value, r.when);
    if (INDEX.has(id)) throw new Error(`terms: ${r.kind} ${r.value}${r.when ? ` (${r.when})` : ''} maps to two terms`);
    INDEX.set(id, t);
  }
}

/** The term for an internal value, or undefined when the catalog has none. */
export function findTerm(ref: InternalRef): Term | undefined {
  return (ref.when ? INDEX.get(refId(ref.kind, ref.value, ref.when)) : undefined) ?? INDEX.get(refId(ref.kind, ref.value));
}

/**
 * The term for an internal value. Total over every enum the catalog covers
 * (the totality test enforces it); a value it has never seen reads
 * "Not started: reason unknown" rather than leaking the raw enum.
 */
export function termFor(ref: InternalRef): Term {
  return findTerm(ref) ?? TERMS['wait.unknown'];
}

/** The finished Deliver stage's line (Navigation R-15, AC-9): `Delivered into <branch>`. Lives here because the ratchet bans the literal word outside the catalog. */
export const deliveredInto = (branch: string): string => `Delivered into ${branch}`;
/** A word, by key. */
export const termWord = (key: TermKey): string => TERMS[key].word;
/** A terminal form, by key. */
export const termShort = (key: TermKey): string => TERMS[key].short;

/**
 * Runner capacity is a stat row, not a sentence: `Running 3/9`, `Runners 2/3`,
 * `Sessions 2`, Peak, Avg. `short` is the terminal header form.
 */
export function runningOfCap(running: number, cap: number, form: 'long' | 'short' = 'long'): string {
  return form === 'short' ? `${running}/${cap}` : `Running ${running}/${cap}`;
}

/**
 * @deprecated "N of M slots in use" is retired wording; read `runningOfCap`.
 * Kept only until the surfaces that still call it move over.
 */
export function slotsInUse(used: number, total: number, form: 'long' | 'short' = 'long'): string {
  return form === 'short' ? `${used}/${total} in use` : `${used} of ${total} ${total === 1 ? 'slot' : 'slots'} in use`;
}

/** The mission start gate in words: Not started until it first runs, Paused after. */
export function missionGateTerm(m: { armedAt?: Date | string | null }): Term {
  return TERMS[m.armedAt ? 'mission.paused' : 'mission.not_started'];
}

/**
 * The nouns for what runs the work (§2.7). "Worker" is the internal row and
 * "seat" an old billing word: neither is shown to a person.
 */
export const NOUNS = Object.freeze({
  runner: { word: 'runner', means: 'A machine that runs agents.' },
  slot: { word: 'slot', means: 'Room for one agent on a runner.' },
  agent: { word: 'agent', means: 'The AI working on a task.' },
  session: { word: 'your session', means: 'A person’s own Claude Code session, which claims tasks without a runner.' },
} as const);

/** Who reads a string: a person (the default), or an agent reading an MCP reply. */
export type Reader = 'person' | 'agent';

/**
 * Words never shown to a person as a state, and what to say instead.
 * `scripts/copy-check.ts` counts them (rule `catalog-word`) on the web, in
 * `top`, runner CLI output, MCP replies, the kernel's display table and PR
 * activity comments. It is a ratchet: each slice of the migration lowers it.
 * `agentsMay` marks a word an agent reading an MCP reply needs (it passes
 * `workerId`), so MCP replies are not counted for it.
 */
export const BANNED_WORDS: ReadonlyArray<{ word: RegExp; use: string; why: string; agentsMay?: true }> = [
  // `held: runs after <task>` is Navigation R-14's own cause for a queued task behind another task's files: it names the cause, so it is not the bare word.
  { word: /\bheld\b(?!: runs after )|\bon hold\b|\bstart mode\b/i, use: 'Not started, Paused, Scheduled, Usage limit, Waiting for files, Queued · held: runs after <task>, or Waiting + the reason',
    why: '"Held" covers a person’s pause, a schedule, a usage limit and a file lock, each with a different way out. Name the cause.' },
  { word: /\bnot landed\b|\blanded\b|\blanding\b/i, use: 'Merging, Merged, Merged in #N, Closed without merging',
    why: 'GitHub says Merged. "Landed" is the team’s own metaphor and reads differently on every screen.' },
  { word: /\bshipped\b/i, use: 'Merged, Merged in #N, Done, Released',
    why: 'One merged PR read Shipped, Landed, Merged and Completed depending on the screen.' },
  { word: /\bdeliver(?:ed|ing)\b/i, use: 'Done, Merging, Done this week',
    why: '"Delivery" is the kernel’s internal noun for a PR’s journey.' },
  { word: /\bauditing\b|\bin audit\b|\brepairing\b/i, use: 'In review, Checking, Fixing',
    why: 'Review was Auditing, In audit or In review, and a fix was Repairing on the web and Fixing everywhere else.' },
  { word: /^(?:Pending|Never started|Assigned|Starting|Running now)$/, use: 'Queued, Waiting on <task>, Running, Not started',
    why: 'Pending and Queued named one row; Assigned, Starting and Running now all meant an agent is on it. The task words are Navigation R-14\'s.' },
  // Retired Queue words (Health › Queue r9). Bare Ready and Waiting are retired too, but surfaces still render them; they join this list as each moves to the new words.
  { word: /^(?:Parked|Declared)$/, use: 'Queued, Blocked, Scheduled, Paused · Lane, Limit, Dependency',
    why: 'Parked and Declared named queue states the Queue tabs (Queued, Blocked, Scheduled, Paused) and reasons (Lane, Limit, Dependency) now say.' },
  { word: /\bwaiting for a worker\b/i, use: 'Waiting for an agent',
    why: '"Worker" is the platform’s internal noun for one agent session.' },
  { word: /\b(?:of|\/)\s*\S+\s+busy\b|\bslots? (?:is |are )?busy\b|\bevery slot is busy\b/i, use: 'Running 3/9',
    why: 'Capacity read busy, running or working; those are state words.' },
  { word: /^completed$|\bcompleted this week\b/i, use: 'Done, Merged',
    why: 'A task marked Completed drew the merged glyph even when it had no PR.' },
  { word: /\blocal[- ]sessions?\b|\[LOCAL\b|^LOCAL$|\bbuilding locally\b/i, use: 'Your session, Run from your session, Running in your session',
    why: 'One claim read LOCAL, local session, Your sessions and claimed. It is the person’s own session; say so.' },
  { word: /(?<![/.])\bworkers?\b(?!\.)|^\[?Workers?\b(?! (?:URL|upload|AI|Scripts)\b)/, use: 'runner, slot, agent', agentsMay: true,
    why: '"Worker" is the internal row behind an agent. A person sees runners, their slots and the agents in them.' },
  { word: /\bseats?\b/i, use: 'slot, plan, sign-in, plan limit',
    why: '"Seat" was a billing word for a subscription sign-in. Say the plan, the sign-in or the slot.' },
];

/** Every banned word a string uses. An agent reading an MCP reply may see the words marked `agentsMay`. */
export function bannedWordsIn(text: string, opts?: { reader?: Reader }): Array<(typeof BANNED_WORDS)[number]> {
  const agent = opts?.reader === 'agent';
  return BANNED_WORDS.filter((b) => !(agent && b.agentsMay) && b.word.test(text));
}

/**
 * Retry and fix tasks carry a machine key in their title
 * (`[builder · after CI #1] Fix the thing`, apps/web/src/lib/task-title.ts).
 * The key stays in the stored title; a person reads the original title plus
 * a short attempt label.
 */
const ATTEMPT_PREFIX = /^\s*\[[^\]·]*·\s*after (CI|review|conflict)\s*#(\d+)\]\s*/i;
const ATTEMPT_WORDS: Record<string, string> = { ci: 'CI failed', review: 'review asked for changes', conflict: 'merge conflict' };

export function displayTitle(title: string | null | undefined): { title: string; attempt?: string } {
  title ??= '';
  let rest = title;
  let attempt: string | undefined;
  for (let m = ATTEMPT_PREFIX.exec(rest); m; m = ATTEMPT_PREFIX.exec(rest)) {
    attempt ??= `Fix ${m[2]} · ${ATTEMPT_WORDS[m[1].toLowerCase()]}`;
    rest = rest.slice(m[0].length);
  }
  return attempt ? { title: rest.trim() || title, attempt } : { title };
}

/**
 * The plain-text form of `displayTitle` for surfaces with no room for a chip
 * (`buildd top`, MCP replies, PR comments, notifications): the title, then the
 * attempt as appended detail. Never the machine key.
 */
export function titleWithAttempt(title: string | null | undefined): string {
  const d = displayTitle(title);
  return d.attempt ? `${d.title} · ${d.attempt}` : d.title;
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const;
/** A count in words, up to ten ("two"); a figure above that. Copy rule: counts are words. */
export const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

/**
 * The review-escalation decision's labels, one wording on the task page, get_pr and the
 * PR activity comment (spec r7 §7, AC-43).
 */
export const DECISION_LABELS = Object.freeze({
  open: 'Still open',
  awaitingVerification: 'Fixed, waiting for a review',
  choicesOnTaskPage: 'Open on the task page',
});

/**
 * GitHub's formal review states on a PR, in GitHub's own words, printed beside buildd's
 * verdict and never in its place (spec r7 §7, AC-24). One basis for all three: each
 * reviewer counts once, by their latest Approved or Changes requested review, else
 * Commented when every review they left is a comment.
 */
export function githubReviewStatesLine(r: { approved?: number; changesRequested?: number; commented?: number } | null | undefined): string | null {
  if (!r) return null;
  const parts = ([[r.approved ?? 0, 'Approved'], [r.changesRequested ?? 0, 'Changes requested'], [r.commented ?? 0, 'Commented']] as const)
    .filter(([n]) => n > 0)
    .map(([n, state], i) => (i === 0 ? `${countWord(n)} ${n === 1 ? 'review' : 'reviews'} ${state}` : `${countWord(n)} ${state}`));
  return parts.length > 0 ? `On GitHub: ${parts.join(', ')}` : null;
}

/** GitHub reviews counted on githubReviewStatesLine's basis: one per reviewer. */
export function githubReviewCounts(reviews: ReadonlyArray<{ user?: { login?: string } | null; state?: string }>): { approved: number; changesRequested: number; pending: number; commented: number } {
  const latest = new Map<string, string>();
  const commenters = new Set<string>();
  for (const r of reviews) {
    const who = r.user?.login;
    if (!who || !r.state) continue;
    if (r.state === 'COMMENTED') commenters.add(who);
    else if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED' || r.state === 'PENDING') latest.set(who, r.state);
  }
  const states = [...latest.values()];
  return {
    approved: states.filter((s) => s === 'APPROVED').length,
    changesRequested: states.filter((s) => s === 'CHANGES_REQUESTED').length,
    pending: states.filter((s) => s === 'PENDING').length,
    commented: [...commenters].filter((who) => !latest.has(who)).length,
  };
}
