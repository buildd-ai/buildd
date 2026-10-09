/**
 * Escalation gate: the pure half (knowledge-base buildd/design/human-question-gate.md,
 * slice 3: landing and reviewer escalations, the escalation inbox and Home's
 * review queue).
 *
 * The question gate (./question-gate.ts) already stands between an agent's
 * question and a person. This is the same gate for the other thing that pages
 * the owner: a PR that stopped moving. Before such a PR becomes a Needs You
 * card, a badge count or a push, its state is decided once:
 *
 *  1. **Rules, no model call** (`escalationRule`). Buildd still acting, red
 *     CI, a live conflict, a migration number collision, a landing stranded by
 *     a moving base and CI not green yet are Buildd's (`owner: 'buildd'`, with
 *     the named next step). A protected path, a data migration, an
 *     irreversible action and a reviewer escalation on a mission's ship PR are
 *     the person's (`owner: 'person'`, with the rail).
 *  2. **Jev, only on a concern** (./escalation-gate-decision.ts): a reviewer
 *     escalation no rule answers is the one place a model's judgment helps.
 *     Anything else no rule answers is the person's by rule, with no call.
 *     Jev answers: act (Buildd
 *     takes a named machine action), hold (Buildd waits until a deadline), or
 *     ask (the person, with a one-line reason). Live: no shadow phase, no
 *     experiment, no switch. A failed or unsure answer asks (`by: 'fallback'`),
 *     so nothing is ever silenced by a model error.
 *
 * Pure (no I/O). Uses node:crypto for the fingerprint, so server-only.
 */
import { createHash } from 'node:crypto';
import type { DecisionRun } from '@builddai/ai-kit/decide';
import type { ESCALATION_GATE_QUESTIONS } from './escalation-gate-decision';
import { detectIrreversibleAction } from './question-gate';

/** Why a PR reached the inbox before the gate looked at it. */
export type EscalationWhy =
  | 'reviewer_escalated'
  | 'review_exhausted'
  | 'approved_needs_merge'
  | 'human_tier'
  | 'landing_handoff'
  | 'conflict_fixes_spent'
  | 'kernel_needs_you';

export type CiState = 'green' | 'running' | 'red' | 'unknown';

/** Everything the gate reads about one PR. No tenant text beyond `title` and `detail`. */
export interface EscalationSubject {
  /** `pr:<workspaceId>:<prNumber>` (or the task when there is no PR number). */
  key: string;
  workspaceId: string;
  prNumber: number | null;
  taskId: string | null;
  missionId: string | null;
  title: string;
  why: EscalationWhy;
  ci: CiState;
  /** The PR conflicts with its base. */
  conflict: boolean;
  /** A conflict repair, CI or review fix, running checks or a reviewer agent is live. */
  machineActing: boolean;
  /** `missionPrRoleOf`: the mission's ship PR (integration → trunk) or a refresh PR (trunk → integration). */
  missionPrRole: 'ship' | 'refresh' | null;
  /** Landing's own `needs_human` cause and reason, when that is why it stopped. */
  handoffCause?: string | null;
  handoffReason?: string | null;
  /** The escalation's own words (reviewer reason, kernel detail), as a person would read them. */
  detail?: string | null;
  /** The PR's migration number collides with another open PR's. */
  migrationCollision?: boolean;
  /** Landing gave up for now because the base kept moving under the approved PR. */
  landingStranded?: boolean;
  /** The PR head the state was read at; part of the fingerprint, so a new push is a new look. */
  headSha?: string | null;
  /** Risk classes the PR's paths fall in (policyConfig risk classes: destructive_schema_change, ci_deploy_config, ...). */
  riskClasses?: readonly string[];
  /** The escalation is the policy's alone (a hard rule on paths), not the reviewer's judgment of the change. */
  policyOnly?: boolean;
  /** The reviewed head is still the PR's head (false: pushed since the verdict). */
  headIsCurrent?: boolean | null;
  draft?: boolean;
  /** The diff is extra large (the merge-advice XL bucket). */
  sizeXl?: boolean;
}

/** A named next step Buildd takes instead of asking. */
export type EscalationAction =
  | 'wait_machine'
  | 'wait_ci'
  | 'ci_fix'
  | 'conflict_fix'
  | 'renumber_migration'
  | 'retry_landing'
  | 're_review'
  | 'address_review'
  | 'policy_merge'
  | 'hold';

/**
 * The actions Jev may pick: only machine fixes. Jev never merges or approves
 * (offline backtest, knowledge-base buildd/reports/merge-readiness-backtest/:
 * it is weak at "merge as-is?"); merging is a rule's call (`policy_merge`).
 */
export const JEV_ACTIONS = ['re_review', 'address_review', 'ci_fix', 'conflict_fix'] as const;
export type JevAction = (typeof JEV_ACTIONS)[number];

export type EscalationRail = 'protected_path' | 'data_migration' | 'security' | 'mission_ship_escalation' | 'irreversible' | 'no_next_step';

export type EscalationVerdict =
  | { owner: 'person'; by: 'rule' | 'jev' | 'fallback'; rail?: EscalationRail; reason: string }
  | { owner: 'buildd'; by: 'rule' | 'jev'; action: EscalationAction; reason: string; holdUntil?: string };

/** How long a Jev `hold` keeps a PR out of the inbox before it is the person's again. */
export const ESCALATION_HOLD_MS = 2 * 60 * 60_000;
export const ESCALATION_GATE_MIN_CONFIDENCE = 0.7;
export const ESCALATION_GATE_PROMPT_VERSION = 'eg3';
/** Jev's p50 in the merge-readiness backtest was ~0.2 s; past this the person is asked. */
export const ESCALATION_GATE_DECISION_TIMEOUT_MS = 800;
/** The ledger capability every escalation look is filed under. */
export const ESCALATION_GATE_CAPABILITY = 'escalation_gate';

/** What each action means, in the words the "also in progress" line and the ledger use. */
export const ACTION_WORDS: Record<EscalationAction, string> = {
  wait_machine: 'Buildd is still working on it',
  wait_ci: 'waiting for CI to finish',
  ci_fix: 'Buildd is fixing the failing checks',
  conflict_fix: 'Buildd is resolving the conflict',
  renumber_migration: 'Buildd is renumbering a migration that collides with another PR',
  retry_landing: 'Buildd retries the merge once the base settles',
  re_review: 'Buildd asked for a fresh review of the current head',
  address_review: 'Buildd is addressing the reviewer\'s feedback',
  policy_merge: 'Buildd lands it under the merge policy: the escalation was policy only and every gate holds',
  hold: 'held for now; it comes back if nothing changes',
};

const RAIL_WORDS: Record<EscalationRail, string> = {
  protected_path: 'It touches a protected path, so only a person can merge it.',
  data_migration: 'It runs a data migration, so a person decides.',
  security: 'The reviewer raised a security concern, so a person decides.',
  mission_ship_escalation: 'The reviewer escalated the mission\'s ship PR, the one human gate for this mission.',
  irreversible: 'It names an action that can\'t be undone.',
  no_next_step: 'Buildd has no next step of its own for it and the reviewer raised nothing to weigh, so it comes to you.',
};

/** Paths only a person merges, whatever else holds: CI/deploy config and auth/secrets. */
const HARD_RISK_CLASSES: ReadonlySet<string> = new Set(['ci_deploy_config', 'auth_and_secrets']);
/** Risk classes a policy-only escalation may carry and still land by rule (no reverts or prod failures in the backtest window). */
const POLICY_MERGE_CLASSES: ReadonlySet<string> = new Set(['destructive_schema_change', 'public_api_contract', 'dependency_bump']);
const SECURITY = /\bsecurity (?:concern|risk|issue|hole|scope|review|sensitive)|\bsecurity-sensitive\b|\bvulnerab|\bprivilege escalation\b|\bauth(?:entication|orization)? bypass\b|\bleaks? (?:a |the )?(?:secret|token|credential)/i;
const COLLISION = /\bmigration (?:number|index) collision\b|\bcollides with (?:open )?pr\b|\brenumber/i;
const DATA_MIGRATION = /\bdata migration\b|\bdestructive (?:schema|migration)\b|\bdrops? (?:a |the )?(?:table|column)s?\b/i;
const STRANDED_CAUSES: ReadonlySet<string> = new Set(['refresh_exhausted', 'refresh_failed', 'base_rewritten']);
const PROTECTED_CAUSES: ReadonlySet<string> = new Set(['deny_path']);

const buildd = (action: EscalationAction): EscalationVerdict => ({ owner: 'buildd', by: 'rule', action, reason: ACTION_WORDS[action] });
const person = (rail: EscalationRail): EscalationVerdict => ({ owner: 'person', by: 'rule', rail, reason: RAIL_WORDS[rail] });

/** The texts an irreversible-action or data-migration rule reads. */
function textsOf(s: EscalationSubject): string[] {
  return [s.detail, s.handoffReason].filter((t): t is string => !!t);
}

/** The escalations Jev weighs: the reviewer's judgment of the change. Everything else is rules only. */
export function isReviewerConcern(s: EscalationSubject): boolean {
  return s.why === 'reviewer_escalated' || s.why === 'review_exhausted';
}

/**
 * The deterministic verdict, or null when Jev decides: a reviewer escalation
 * no rule answers. Anything else no rule answers is the person's, by rule.
 * Order matters: Buildd's own in-flight work first (reviewing a diff about to
 * change is wasted), then repairs Buildd can start itself, then the person's
 * rails, then the waits.
 */
export function escalationRule(s: EscalationSubject): EscalationVerdict | null {
  if (s.machineActing) return buildd('wait_machine');
  if (s.ci === 'red') return buildd('ci_fix');
  if (s.conflict && s.why !== 'conflict_fixes_spent') return buildd('conflict_fix');
  if (s.migrationCollision || textsOf(s).some(t => COLLISION.test(t))) return buildd('renumber_migration');

  if (s.handoffCause && PROTECTED_CAUSES.has(s.handoffCause)) return person('protected_path');
  if ((s.riskClasses ?? []).some(c => HARD_RISK_CLASSES.has(c))) return person('protected_path');
  if (textsOf(s).some(t => DATA_MIGRATION.test(t))) return person('data_migration');
  if (textsOf(s).some(t => SECURITY.test(t))) return person('security');
  // Landing's own words only: a reviewer's prose says "safe to merge this" far more often than it names an irreversible step.
  if (detectIrreversibleAction([s.handoffReason])) return person('irreversible');
  if (s.missionPrRole === 'ship' && (s.why === 'reviewer_escalated' || s.why === 'review_exhausted')) return person('mission_ship_escalation');

  if (s.landingStranded || (s.handoffCause && STRANDED_CAUSES.has(s.handoffCause))) return buildd('retry_landing');
  if (s.ci === 'running' || s.ci === 'unknown') return buildd('wait_ci');
  if (isPolicyMerge(s)) return buildd('policy_merge');
  return isReviewerConcern(s) ? null : person('no_next_step');
}

/**
 * A policy-only escalation whose gates all hold lands by rule, not by a
 * person: CI green, the reviewed head is the live head, not a draft, not XL,
 * and every risk class it carries is one that landed cleanly in the backtest
 * (schema/migration, public API, dependency bump). About 3 in 4 such cards
 * merged as-is there.
 */
export function isPolicyMerge(s: EscalationSubject): boolean {
  const classes = s.riskClasses ?? [];
  return !!s.policyOnly
    // Not `human_tier`: there the workspace merge policy itself says a person merges.
    && (s.why === 'reviewer_escalated' || s.why === 'review_exhausted')
    && s.ci === 'green' && s.headIsCurrent !== false && !s.draft && !s.sizeXl
    && classes.length > 0 && classes.every(c => POLICY_MERGE_CLASSES.has(c));
}

/**
 * A hash of the state the verdict was made on. A refresh of the same state
 * reuses the stored verdict; a new push, a CI change or a new reason is a new
 * look. The title's wording is not state.
 */
export function escalationFingerprint(s: EscalationSubject): string {
  const state = {
    v: ESCALATION_GATE_PROMPT_VERSION,
    key: s.key, why: s.why, ci: s.ci, conflict: s.conflict, acting: s.machineActing, role: s.missionPrRole,
    cause: s.handoffCause ?? null, collision: !!s.migrationCollision, stranded: !!s.landingStranded, head: s.headSha ?? null,
    detail: s.detail ?? null, handoff: s.handoffReason ?? null,
    classes: [...(s.riskClasses ?? [])].sort(), policy: !!s.policyOnly, current: s.headIsCurrent ?? null, draft: !!s.draft, xl: !!s.sizeXl,
  };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
}

export type EscalationDisposition = 'act' | 'hold' | 'ask';

export interface EscalationAnswer {
  disposition: EscalationDisposition;
  dispositionConfidence: number;
  action: JevAction | null;
  actionConfidence: number | null;
}

/** Jev's answer as a verdict. Unsure, or "act" without a confident action, asks (fallback). */
export function resolveEscalationAnswer(answer: EscalationAnswer, minConfidence: number, nowMs: number): EscalationVerdict {
  const unsure: EscalationVerdict = { owner: 'person', by: 'fallback', reason: 'Jev wasn\'t sure Buildd could handle it alone.' };
  if (answer.dispositionConfidence < minConfidence) return unsure;
  if (answer.disposition === 'ask') {
    return { owner: 'person', by: 'jev', reason: 'Jev judged this a call only a person can make.' };
  }
  if (answer.disposition === 'hold') {
    return { owner: 'buildd', by: 'jev', action: 'hold', reason: ACTION_WORDS.hold, holdUntil: new Date(nowMs + ESCALATION_HOLD_MS).toISOString() };
  }
  if (!answer.action || answer.actionConfidence == null || answer.actionConfidence < minConfidence) return unsure;
  return { owner: 'buildd', by: 'jev', action: answer.action, reason: ACTION_WORDS[answer.action] };
}

/** A stored verdict as of `nowMs`: an expired hold is the person's again. */
export function verdictAt(v: EscalationVerdict, nowMs: number): EscalationVerdict {
  if (v.owner === 'buildd' && v.action === 'hold' && v.holdUntil && Date.parse(v.holdUntil) <= nowMs) {
    return { owner: 'person', by: 'jev', reason: 'Held earlier and still waiting, so it is yours now.' };
  }
  return v;
}

/** The ledger's `appliedAnswer` for a verdict, and back. Round-trips through the decision ledger. */
export function verdictCode(v: EscalationVerdict): string {
  if (v.owner === 'person') return `person:${v.by}:${v.rail ?? ''}`;
  return `buildd:${v.by}:${v.action}:${v.holdUntil ?? ''}`;
}

export function verdictFromCode(code: string | null | undefined): EscalationVerdict | null {
  if (!code) return null;
  const [owner, by, a, ...rest] = code.split(':');
  if (owner === 'person' && (by === 'rule' || by === 'jev' || by === 'fallback')) {
    const rail = (a || undefined) as EscalationRail | undefined;
    return rail && RAIL_WORDS[rail]
      ? { owner: 'person', by, rail, reason: RAIL_WORDS[rail] }
      : { owner: 'person', by, reason: by === 'fallback' ? 'Jev wasn\'t sure Buildd could handle it alone.' : 'Jev judged this a call only a person can make.' };
  }
  if (owner === 'buildd' && (by === 'rule' || by === 'jev') && a && a in ACTION_WORDS) {
    const holdUntil = rest.join(':') || undefined;
    return { owner: 'buildd', by, action: a as EscalationAction, reason: ACTION_WORDS[a as EscalationAction], ...(holdUntil ? { holdUntil } : {}) };
  }
  return null;
}

// ── What Jev reads, and its answer (the definition is ./escalation-gate-decision.ts) ──

const WHY_WORDS: Record<EscalationSubject['why'], string> = {
  reviewer_escalated: 'the reviewer agent escalated it to a person',
  review_exhausted: 'review rounds ran out without an approval',
  approved_needs_merge: 'the reviewer approved it and the merge policy leaves the merge to a person',
  human_tier: 'the workspace merge policy says a person merges',
  landing_handoff: 'the automatic merge stopped and handed it to a person',
  conflict_fixes_spent: 'automatic conflict fixes were all used up',
  kernel_needs_you: 'the delivery workflow says a person owns the next move',
};

/** The record Jev reads: the PR as the owner's card would describe it. */
export function buildEscalationGateState(s: EscalationSubject): Record<string, unknown> {
  return {
    pr: {
      title: s.title,
      why: WHY_WORDS[s.why],
      detail: s.detail ?? null,
      landingStopped: s.handoffReason ?? null,
      checks: s.ci,
      conflictsWithBase: s.conflict,
      missionPr: s.missionPrRole,
    },
  };
}

/** The disposition and action a run answered, or why it has none. */
export function readEscalationGateRun(run: DecisionRun<typeof ESCALATION_GATE_QUESTIONS>): EscalationAnswer | { error: string } {
  const d = run.outcomes.disposition;
  if (!run.ok || !d || d.status === 'skipped') {
    return { error: !run.result.ok ? run.result.error.kind : 'no_answer' };
  }
  const a = run.outcomes.action;
  const action = a && a.status !== 'skipped' && (JEV_ACTIONS as readonly string[]).includes(String(a.value)) ? (a.value as JevAction) : null;
  return {
    disposition: d.value as EscalationDisposition,
    dispositionConfidence: d.confidence,
    action,
    actionConfidence: action && a && a.status !== 'skipped' ? a.confidence : null,
  };
}
