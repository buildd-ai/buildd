/**
 * `buildd.mission_scope`: does a task added to an existing mission fit the
 * mission's contract, change it, or need a person? A first-party decision kind
 * on the shared substrate (`decision-kinds.ts`, `decision-policy.ts`). It owns
 * the decision contract only; what the answer does (an auditable amendment, a
 * hold) is the workflow kernel's (`packages/workflow-kernel/src/scope-amendments.ts`).
 *
 * - **Output**: `in_scope | amend_scope | ask`.
 * - **Fallback**: `in_scope` (a decomposition of the contract), so a model
 *   that cannot answer never puts a person in front of ordinary task filing.
 *   An amendment that would weaken a completion criterion is held by the
 *   kernel whatever this answers.
 * - **Features**: the mission's own words (title, description, criteria
 *   labels) and the task's, each bounded; a delivery count. No code, no logs.
 */
import { choice } from '@buildd/ai-kit/decide';
import type { DecisionKindConfig, FeatureParse } from '@buildd/ai-kit/decide';
import { defineBuilddDecisionKind, type BuilddDecisionKindBinding } from './decision-kinds';

export const MISSION_SCOPE_KIND = 'buildd.mission_scope' as const;
export const MISSION_SCOPE_DECISIONS = ['in_scope', 'amend_scope', 'ask'] as const;
export type MissionScopeDecision = (typeof MISSION_SCOPE_DECISIONS)[number];

const TEXT_MAX = 2_000;
const LABELS_MAX = 20;

export interface MissionScopeFeatures {
  missionTitle: string;
  missionDescription: string;
  criteria: string[];
  taskTitle: string;
  taskDescription: string;
  deliveriesMerged: number;
  proposed: boolean;
}

const text = (v: unknown, n = TEXT_MAX): string | null => (typeof v === 'string' ? v.slice(0, n) : null);

export function parseMissionScopeFeatures(input: unknown): FeatureParse<MissionScopeFeatures> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'features must be an object' };
  const f = input as Record<string, unknown>;
  const missionTitle = text(f.missionTitle, 300);
  const missionDescription = text(f.missionDescription);
  const taskTitle = text(f.taskTitle, 300);
  const taskDescription = text(f.taskDescription);
  if (missionTitle == null || missionDescription == null || taskTitle == null || taskDescription == null) {
    return { ok: false, message: 'missionTitle, missionDescription, taskTitle and taskDescription must be strings' };
  }
  if (!Array.isArray(f.criteria) || !f.criteria.every((c) => typeof c === 'string')) return { ok: false, message: 'criteria must be strings' };
  if (typeof f.deliveriesMerged !== 'number' || !Number.isFinite(f.deliveriesMerged) || f.deliveriesMerged < 0) return { ok: false, message: 'deliveriesMerged must be a count' };
  if (typeof f.proposed !== 'boolean') return { ok: false, message: 'proposed must be a boolean' };
  return {
    ok: true,
    features: {
      missionTitle, missionDescription, taskTitle, taskDescription,
      criteria: (f.criteria as string[]).slice(0, LABELS_MAX).map((c) => c.slice(0, 200)),
      deliveriesMerged: Math.min(Math.round(f.deliveriesMerged), 1_000),
      proposed: f.proposed,
    },
  };
}

const questions = {
  decision: choice(
    'A task is being added to a mission that is already under way. Read the mission\'s goal and its completion criteria, then the task. Does the task fit the outcome the mission already promises (a step, a fix, a follow-up of that outcome), does it change or extend what the mission will deliver, or can you not tell?',
    {
      in_scope: 'It is part of the outcome the mission already describes',
      amend_scope: 'It adds to or changes what the mission will deliver',
      ask: 'It is unclear what the mission should now deliver',
    },
  ),
};

export const MISSION_SCOPE_CONFIG: DecisionKindConfig<
  typeof MISSION_SCOPE_KIND, MissionScopeFeatures, MissionScopeDecision, typeof questions
> = {
  kind: MISSION_SCOPE_KIND,
  policyVersion: 'mscope-2026-10-15.a',
  featureSchemaVersion: 'mscope-features-v1',
  decisions: MISSION_SCOPE_DECISIONS,
  parseFeatures: parseMissionScopeFeatures,
  override: () => null,
  questions,
  state: (f) => ({ ...f }),
  interpret: (a) => ({ decision: a.decision.choice, confidence: a.decision.confidence, reasonCode: `scope_${a.decision.choice}` }),
  // Not yet measured on a held-out set: only a confident answer changes the contract.
  minConfidence: 0.7,
  fallback: (_f, cause) => ({ decision: 'in_scope', reasonCode: `fallback_${cause}` }),
};

/** Built in: its fallback files the task as filed. Rollback: `mode: 'shadow'`. */
export const MISSION_SCOPE_BINDING: BuilddDecisionKindBinding = {
  capability: 'mission_scope',
  mode: 'live',
};

export const missionScopeKind = defineBuilddDecisionKind(MISSION_SCOPE_CONFIG, MISSION_SCOPE_BINDING);
