/**
 * Types for `@builddai/ai-kit/policy`: the standalone model-policy protocol.
 *
 * The caller contract is deliberately small: the app declares its `surface`
 * (`chat | coding`) and requests a `tier`; the policy picks provider, model
 * and effort. There is no workload or intent field: intent is inferred behind
 * the policy boundary when it is useful, and its vocabulary is free to change
 * there without breaking a caller.
 *
 * Policy credentials and provider credentials are separate things. Nothing
 * here carries a provider key: a decision names a provider, and the app calls
 * it with credentials it obtains on its own.
 */

import { KIT_PROVIDERS, KIT_TIERS, type KitProvider, type KitTier, type PlanEffort } from '../models/types';

export { KIT_PROVIDERS, KIT_TIERS };
export type { KitProvider, KitTier, PlanEffort };

/**
 * What the caller is, structurally. `coding` is buildd's `agent` surface under
 * a product-neutral name; `toPolicySurface` maps buildd's vocabulary onto it.
 */
export const POLICY_SURFACES = ['chat', 'coding'] as const;
export type PolicySurface = (typeof POLICY_SURFACES)[number];

export const POLICY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly PlanEffort[];

/**
 * Who serves a route: the kit's API providers, plus `openai-codex`, a
 * subscription-backed coding runtime (an agent runner signed in to Codex, not
 * an API key). It only makes sense on the `coding` surface; a chat app that
 * gets one back should treat it as unreachable and use its fallback.
 */
export const POLICY_PROVIDERS = [...KIT_PROVIDERS, 'openai-codex'] as const;
export type PolicyProvider = (typeof POLICY_PROVIDERS)[number];

/** One concrete model choice. */
export interface PolicyRoute {
  provider: PolicyProvider;
  model: string;
  effort?: PlanEffort;
}

// ── The policy document ─────────────────────────────────────────────────────

/** Who an override or experiment applies to. At least one field. */
export interface PolicyScope {
  app?: string;
  workspaceId?: string;
}

/** An app/workspace-scoped choice for one tier, optionally one surface. */
export interface PolicyOverride {
  match: PolicyScope;
  /** Omit to serve both surfaces. */
  surface?: PolicySurface;
  tier: KitTier;
  route: PolicyRoute;
}

/**
 * How an experiment treats traffic. None of them claims one arm is better.
 *
 * - `pinned`: every matching call goes to the one arm.
 * - `split`: deliberate allocation by weight (A/B, challenger).
 * - `shadow`: the call goes where the policy would send it anyway; the arm is
 *   named on the decision so the app may run it out of band. Routing the user
 *   sees never changes.
 * - `adaptive`: weights are moved automatically from an outcome signal. Only
 *   valid with a `signal` that is trustworthy for the surface
 *   (`TRUSTWORTHY_SIGNALS`); with no trustworthy signal, use split or shadow.
 */
export const EXPERIMENT_MODES = ['pinned', 'split', 'shadow', 'adaptive'] as const;
export type ExperimentMode = (typeof EXPERIMENT_MODES)[number];

export interface ExperimentArm {
  /** `[A-Za-z0-9][A-Za-z0-9_.-]{0,31}`. */
  name: string;
  route: PolicyRoute;
  /** Relative share for split/adaptive. Ignored for pinned and shadow. Default 1. */
  weight?: number;
}

export interface PolicyExperiment {
  /** Stable id; also salts allocation, so changing it reshuffles units. */
  key: string;
  mode: ExperimentMode;
  tier: KitTier;
  /** Omit to cover both surfaces. Adaptive must name one. */
  surface?: PolicySurface;
  match?: PolicyScope;
  /** pinned and shadow: exactly one. split and adaptive: two or more. */
  arms: ExperimentArm[];
  /** Required for adaptive: the outcome the weights follow. */
  signal?: OutcomeSignal;
}

/**
 * A model policy. Resolution, first match wins:
 *
 *   1. an `overrides` entry for the caller's app/workspace (+ surface) + tier
 *   2. `surfaces[surface][tier]`
 *   3. `tiers[tier]`
 *   4. the bundled fallback policy's answer (`DEFAULT_MODEL_POLICY`)
 *
 * Chat and coding are two mappings over one resolver, not two tier systems:
 * the caller always asks for the same four tiers.
 */
export interface ModelPolicy {
  /** Reported on every decision as `policyVersion`. */
  version: string;
  tiers: Partial<Record<KitTier, PolicyRoute>>;
  surfaces?: Partial<Record<PolicySurface, Partial<Record<KitTier, PolicyRoute>>>>;
  overrides?: PolicyOverride[];
  experiments?: PolicyExperiment[];
}

// ── Resolve: the wire protocol ──────────────────────────────────────────────

/**
 * `POST /v1/resolve`. Exactly these fields: no prompt, no messages, no
 * workload label, no credential.
 */
export interface PolicyRequest {
  surface: PolicySurface;
  tier: KitTier;
  /** Free attribution / scoping label, `[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`. */
  app?: string;
  workspaceId?: string;
}

/** Which layer answered. `cached` / `fallback` mean the remote policy did not. */
export type DecisionSource = 'override' | 'surface' | 'tier' | 'bundled' | 'experiment' | 'cached' | 'fallback';
export const DECISION_SOURCES = ['override', 'surface', 'tier', 'bundled', 'experiment', 'cached', 'fallback'] as const satisfies readonly DecisionSource[];

/** Optional, informational. An app may ignore it entirely. */
export interface DecisionExperiment {
  key: string;
  mode: ExperimentMode;
  /** The arm this call was given; `control` for a shadow experiment. */
  arm: string;
  /** Shadow only: what the challenger would have been. Never applied. */
  shadow?: { arm: string } & PolicyRoute;
}

/** The `POST /v1/resolve` answer. */
export interface PolicyDecision {
  provider: PolicyProvider;
  model: string;
  effort: PlanEffort | null;
  policyVersion: string;
  /** Key for outcome reports. NULL when no policy service issued the decision (local or fallback). */
  planId: string | null;
  surface: PolicySurface;
  tier: KitTier;
  source: DecisionSource;
  experiment?: DecisionExperiment;
}

// ── Outcomes: typed observations, no generic quality score ──────────────────

/**
 * Observations an app can report against a `planId`. Each keeps its own type;
 * nothing is folded into one score.
 *
 * Coding has strong signals (tests, goal criteria, review verdict, merge,
 * rework); chat has weaker ones (explicit feedback, regenerate, correction,
 * an app-local evaluator). Latency, duration and cost apply to both.
 */
export type PolicyObservation =
  | { type: 'tests'; passed: boolean }
  | { type: 'goal_criteria'; passed: boolean }
  | { type: 'review_verdict'; verdict: 'approve' | 'request_changes' | 'escalate' }
  | { type: 'merged'; merged: boolean }
  | { type: 'rework'; required: boolean }
  | { type: 'explicit_feedback'; value: 'up' | 'down' }
  | { type: 'regenerated' }
  | { type: 'user_correction' }
  | { type: 'evaluator'; source: 'app' | 'human'; verdict: 'pass' | 'fail' }
  | { type: 'latency'; ms: number }
  | { type: 'duration'; ms: number }
  | { type: 'cost'; usd: number };

export type OutcomeSignal = PolicyObservation['type'];

export const OUTCOME_SIGNALS = [
  'tests', 'goal_criteria', 'review_verdict', 'merged', 'rework',
  'explicit_feedback', 'regenerated', 'user_correction', 'evaluator',
  'latency', 'duration', 'cost',
] as const satisfies readonly OutcomeSignal[];

/** Observations that only exist on the coding surface. */
export const CODING_ONLY_SIGNALS = ['tests', 'goal_criteria', 'review_verdict', 'merged', 'rework'] as const satisfies readonly OutcomeSignal[];

/**
 * Signals an adaptive experiment may follow, per surface. Chat has none yet:
 * its signals are sparse and biased, so chat experiments stay split or shadow.
 * Cost and latency are never quality signals on their own.
 */
export const TRUSTWORTHY_SIGNALS: Record<PolicySurface, readonly OutcomeSignal[]> = {
  coding: ['tests', 'goal_criteria', 'review_verdict', 'merged', 'rework'],
  chat: [],
};

/** `POST /v1/outcomes`. */
export interface OutcomeReport {
  planId: string;
  surface: PolicySurface;
  observations: PolicyObservation[];
}
