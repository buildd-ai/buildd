// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The one typed presentation of a mission's state: `{ state, cause, action }`.
 *
 * Spec 8e137fdb I-13..I-16. Every member-facing state notice (header, Home and
 * list cards, Overview, Flow, History, `explain`) reads this, and this reads
 * the sealed `MissionStateView`. It adds NO derivation: precedence, gates and
 * holds are decided upstream. It only classifies the view's own output into a
 * small closed vocabulary, so two surfaces cannot word one state two ways, and
 * a cause nobody recorded cannot be invented (AC-18, AC-22).
 *
 * Pure: no I/O, no clock, no evaluation. Calling it is always a read.
 */
import { TERMS } from '@buildd/shared';
import type { MissionStateView, WaitingOnDescriptor } from './mission-state-view';

/** The bounded primary state (I-16). */
export type MissionPresentationState =
  | 'running'
  | 'queued'
  | 'interrupted'
  | 'waiting'
  | 'paused'
  | 'blocked'
  | 'needs_you'
  | 'verifying'
  | 'delivering'
  | 'failing'
  | 'idle'
  | 'complete';

/**
 * Why, in a closed set. `unknown` is a real answer: the view has no recorded
 * reason, and the surface says Waiting or Paused with no explanation.
 */
export type MissionPresentationCause =
  | 'executing'
  | 'queue'
  | 'dependency'
  /** Held behind another task's files or migration (Navigation R-14 `held: runs after <task>`). */
  | 'coordination'
  | 'capacity'
  | 'budget'
  | 'policy'
  | 'local_session'
  | 'human_approval'
  | 'intentional_pause'
  | 'interruption'
  | 'verification'
  | 'delivery'
  | 'failure'
  | 'unknown';

export interface MissionStatePresentation {
  readonly state: MissionPresentationState;
  /** Bounded label for the state chip. */
  readonly label: string;
  readonly cause: MissionPresentationCause | null;
  /** At most one short phrase; null when there is no recorded cause. */
  readonly causeText: string | null;
  /** The one next step, or null when it is not the reader's to take. */
  readonly action: string | null;
  /** True when the next step is a person's. */
  readonly needsYou: boolean;
  /** The sentence the situation notice shows: label plus cause, once. */
  readonly sentence: string;
}

const LABEL: Record<MissionPresentationState, string> = {
  running: TERMS['work.working'].word,
  queued: TERMS['work.ready'].word,
  interrupted: 'Interrupted',
  waiting: 'Waiting',
  paused: TERMS['work.paused'].word,
  blocked: TERMS['work.blocked'].word,
  needs_you: 'Your turn',
  verifying: 'Verifying',
  delivering: 'PR open',
  failing: 'Failing',
  idle: 'Idle',
  complete: TERMS['work.done'].word,
};

const CAPACITY_KEYS = new Set([
  'mission_concurrent',
  'codex_single_flight',
  'managed_concurrency',
  'ordered_behind',
]);
const BUDGET_KEYS = new Set(['mission_budget', 'budget_paused', 'managed_runner_hours', 'hosted_runner_hours']);
const POLICY_KEYS = new Set(['provider_not_allowed', 'tier_policy', 'routing_paused', 'no_personal_credential']);
/** Navigation R-14: held behind another task's files or migration. */
const COORDINATION_KEYS = new Set(['path_overlap', 'soft_overlap', 'advisory_manifest']);

function causeOfHold(key: string | undefined): MissionPresentationCause {
  if (!key) return 'unknown';
  if (key === 'dependency') return 'dependency';
  if (COORDINATION_KEYS.has(key)) return 'coordination';
  if (key === 'trunk_red') return 'delivery';
  if (CAPACITY_KEYS.has(key)) return 'capacity';
  if (BUDGET_KEYS.has(key)) return 'budget';
  if (POLICY_KEYS.has(key)) return 'policy';
  return 'queue';
}

interface Classified {
  state: MissionPresentationState;
  cause: MissionPresentationCause | null;
  causeText: string | null;
}

function classifyTask(d: Extract<WaitingOnDescriptor, { kind: 'task' }>): Classified {
  if (d.stranded || d.local) return { state: 'waiting', cause: 'local_session', causeText: 'waiting for your session to claim it' };
  if (d.interrupted) return { state: 'interrupted', cause: 'interruption', causeText: 'no agent is running it now' };
  if (d.attempt) return { state: 'waiting', cause: 'queue', causeText: d.attempt.claimed ? 'a fix is in progress' : 'a fix is queued' };
  if (d.blockedBy) return { state: 'waiting', cause: 'dependency', causeText: 'waiting on earlier work' };
  if (d.visualBlocked || d.visualQueued || d.visualRunning) {
    return { state: 'verifying', cause: 'verification', causeText: d.visualRunning ? 'visual review running' : d.visualBlocked ? 'visual review cannot run' : 'visual review queued' };
  }
  if (d.noRunner) return { state: 'queued', cause: 'queue', causeText: 'no runner is online' };
  if (d.hold) {
    const cause = causeOfHold(d.holdKey);
    return { state: 'queued', cause, causeText: d.hold };
  }
  if (d.nextInLine) return { state: 'queued', cause: 'queue', causeText: 'next in line for a runner' };
  if (d.waitingNoCause) return { state: 'waiting', cause: 'unknown', causeText: null };
  if (d.tone === 'neutral') return { state: 'running', cause: 'executing', causeText: null };
  // Open work, nothing executing it, and no recorded reason: say Waiting.
  return { state: 'waiting', cause: 'unknown', causeText: null };
}

function classify(view: MissionStateView): Classified {
  switch (view.kind) {
    case 'complete':
      return { state: 'complete', cause: null, causeText: null };
    case 'idle':
      return { state: 'idle', cause: null, causeText: null };
    case 'running':
      return { state: 'running', cause: 'executing', causeText: null };
    case 'held':
      return { state: 'paused', cause: 'intentional_pause', causeText: 'not started' };
    default:
  }
  const d = view.waitingOn;
  switch (d.kind) {
    case 'dependency':
      return { state: 'waiting', cause: 'dependency', causeText: 'an upstream mission has not met its gate' };
    case 'task':
      return classifyTask(d);
    case 'task_failed':
      return { state: 'failing', cause: 'failure', causeText: d.titles.length === 1 ? 'a task failed' : 'tasks failed' };
    case 'merge':
    case 'landing_blocked':
    case 'pr_closed_unmerged':
    case 'ci_red':
      return { state: view.kind === 'failing' ? 'failing' : 'delivering', cause: 'delivery', causeText: d.kind === 'ci_red' ? 'CI is failing on a PR' : null };
    case 'criterion_failing':
    case 'criterion_unverified':
      return { state: 'verifying', cause: 'verification', causeText: null };
    case 'human_decision':
      return { state: 'needs_you', cause: 'human_approval', causeText: null };
    case 'self_resolving_wait':
      return { state: 'waiting', cause: 'unknown', causeText: null };
    case 'claim_deferral': {
      const cause = causeOfHold(undefined);
      return { state: 'queued', cause, causeText: null };
    }
  }
}

/** Map the sealed view onto the closed presentation vocabulary. Pure. */
export function presentMissionState(view: MissionStateView): MissionStatePresentation {
  const c = classify(view);
  const label = LABEL[c.state];
  const action = view.waitingOn ? view.nextAction : view.nextAction ?? null;
  return {
    state: c.state,
    label,
    cause: c.cause,
    causeText: c.causeText,
    action,
    needsYou: c.state === 'needs_you' || c.state === 'failing' || c.state === 'delivering',
    sentence: c.causeText ? `${label}: ${c.causeText}` : label,
  };
}
