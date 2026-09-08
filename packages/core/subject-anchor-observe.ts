import type { TaskSubjectAnchor } from '@buildd/shared';

export interface SubjectPolicy {
  mode?: 'observe' | 'propose' | 'enforce';
  dedupe?: 'suggest' | 'attach-system' | 'attach-all';
  proposalGraceHours?: number;
  conflictDeadDays?: number;
  autoCloseBuilddSupersededPrs?: boolean;
  priorWorkInjection?: boolean;
}

export const DEFAULT_SUBJECT_POLICY = {
  mode: 'observe',
  dedupe: 'attach-system',
  proposalGraceHours: 24,
  conflictDeadDays: 7,
  autoCloseBuilddSupersededPrs: false,
  priorWorkInjection: true,
} as const satisfies Required<SubjectPolicy>;

export function resolveSubjectPolicy(
  policy?: SubjectPolicy | null,
): Required<SubjectPolicy> {
  return { ...DEFAULT_SUBJECT_POLICY, ...policy };
}

export function projectSubjectAnchor(anchor: TaskSubjectAnchor) {
  return {
    subjectAnchor: anchor,
    subjectKind: anchor.kind,
    subjectPrNumber: anchor.prNumber ?? null,
    subjectHeadSha: anchor.headSha ?? null,
    subjectBranch: anchor.branch ?? null,
    subjectErrorSignature: anchor.errorSignature ?? null,
    subjectMissionId: anchor.subjectMissionId ?? null,
    subjectDedupeScope: 'active' as const,
  };
}

export function projectBackfilledSubjectAnchor(
  anchor: TaskSubjectAnchor,
  options: { terminal: boolean; historicHumanProse: boolean },
) {
  const backfilledAnchor: TaskSubjectAnchor = {
    ...anchor,
    source: 'backfill',
  };
  return {
    ...projectSubjectAnchor(backfilledAnchor),
    subjectDedupeScope: options.terminal || options.historicHumanProse
      ? 'none' as const
      : 'active' as const,
    requiresConfirmation: options.historicHumanProse,
    reason: options.historicHumanProse
      ? 'exact_same_repo_pr_url' as const
      : 'exact_structured_context' as const,
  };
}

export type SubjectMatchPredicate =
  | { kind: 'pr_generation'; prNumber: number; headSha: string }
  | { kind: 'pr_lineage'; prNumber: number }
  | { kind: 'error'; errorSignature: string; subjectMissionId: string | null }
  | { kind: 'mission'; subjectMissionId: string };

export function subjectMatchPredicate(
  anchor: TaskSubjectAnchor,
): SubjectMatchPredicate | null {
  if (
    anchor.kind === 'pull_request'
    && anchor.prNumber
    && anchor.headSha
    && anchor.headSha.length >= 40
  ) {
    return { kind: 'pr_generation', prNumber: anchor.prNumber, headSha: anchor.headSha };
  }
  if (anchor.kind === 'pull_request' && anchor.prNumber) {
    return { kind: 'pr_lineage', prNumber: anchor.prNumber };
  }
  if (anchor.kind === 'error' && anchor.errorSignature) {
    return {
      kind: 'error',
      errorSignature: anchor.errorSignature,
      subjectMissionId: anchor.subjectMissionId ?? null,
    };
  }
  if (anchor.kind === 'mission' && anchor.subjectMissionId) {
    return { kind: 'mission', subjectMissionId: anchor.subjectMissionId };
  }
  return null;
}

/**
 * The key types precise enough that a live match may STOP a filing.
 *
 * `pr_generation` is (PR, full head SHA) and `error` is a scanner slug — both
 * name the subject itself. Deliberately excluded:
 *
 *   - `pr_lineage` — same PR, unknown commit. A new failure on a new head is
 *     legitimately new work, so lineage proposes and never collapses
 *     (docs/design/task-subject-anchors.md §3).
 *   - `mission` — a bare `subjectMissionId` identifies the MISSION, not the
 *     work. EVERY task in a mission shares it, so acting on it would refuse
 *     every task after the first. Mission-scoped dedupe requires the
 *     planner-issued `normalizedIntentId` (the `mission_intent` key), which
 *     nothing currently issues.
 */
export const IDENTIFYING_SUBJECT_KEY_TYPES = ['pr_generation', 'error'] as const;

/** True when a live match on this key type is precise enough to stop a filing. */
export function isIdentifyingSubjectKeyType(keyType: string): boolean {
  return (IDENTIFYING_SUBJECT_KEY_TYPES as readonly string[]).includes(keyType);
}

export type SubjectFilingOrigin =
  | 'dashboard'
  | 'api'
  | 'mcp'
  | 'organizer'
  | 'watcher'
  | 'webhook'
  | 'friction'
  | 'backfill';

export function wouldBeSubjectOutcome(
  origin: SubjectFilingOrigin,
  policy: Required<SubjectPolicy>,
): 'suggest' | 'attach' {
  if (policy.dedupe === 'attach-all') return 'attach';
  if (policy.dedupe === 'suggest') return 'suggest';
  return origin === 'dashboard' || origin === 'api' || origin === 'backfill'
    ? 'suggest'
    : 'attach';
}
