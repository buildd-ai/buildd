import { criterionBindings, type VerifierRegistry } from '@buildd/spec-contract/verification-bindings';
import type { MissionTarget, MissionVerdictRow } from './mission-outcome-fold';
import { planRegisteredChecks, type PlannedRegisteredCheck, type RegisteredOutcome } from './registered-verification';

/**
 * The mission path of registered verification (spec "Registered requirement
 * verification" r1, R-7/R-8, AC-2/AC-4), pure. A mission that selects an
 * outcome spec plans its registered checks with the task path's planner,
 * against its integrated target and nothing else: a constituent PR's head is
 * never the mission's target. Outcomes enter foldMissionSpec as rows carrying
 * their actual method, and the criteria listed by requiredRegisteredCriteria
 * go in as `required`, so a required model check stays in the completion
 * decision as a review, never relabelled a test.
 */

export function missionRegisteredChecks(input: {
  missionId: string;
  workspaceId: string;
  selection: { specRevisionId: string; criteria: readonly string[]; waived: readonly string[] };
  body: string;
  target: MissionTarget;
  registry: VerifierRegistry;
}): { ok: true; runs: PlannedRegisteredCheck[] } | { ok: false; reason: string } {
  if (input.target.kind === 'unknown') return { ok: false, reason: `no integrated target: ${input.target.reason}` };
  // A direct mission has no single head; the caller names the trunk commit that holds every merged PR.
  if (input.target.kind !== 'integration') return { ok: false, reason: 'no single integrated head to verify; name the commit that holds every merged mission PR' };
  const waived = new Set(input.selection.waived);
  return {
    ok: true,
    runs: planRegisteredChecks({
      subject: { kind: 'mission', missionId: input.missionId },
      workspaceId: input.workspaceId,
      specRevisionId: input.selection.specRevisionId,
      body: input.body,
      target: { headSha: input.target.headSha },
      registry: input.registry,
      criteria: input.selection.criteria.filter((c) => !waived.has(c)),
    }),
  };
}

/** In-scope criteria with an accepted `mode=required` binding, in body order. */
export function requiredRegisteredCriteria(body: string, registry: VerifierRegistry, scope: readonly string[]): string[] {
  const ids = criterionBindings(body, registry).bindings
    .filter((b) => b.mode === 'required' && scope.includes(b.criterionId))
    .map((b) => b.criterionId);
  return [...new Set(ids)];
}

/**
 * A registered outcome as a mission verdict row: a review, with its real method. The caller stamps `at`.
 * The mission standing reads stored rows through this too (mission-outcome.ts), so a live outcome and a
 * stored one fold the same way.
 */
export function registeredMissionRow(
  id: string,
  outcome: Pick<RegisteredOutcome, 'criterionId' | 'verdict' | 'targetSha' | 'method' | 'fingerprint'> & { provenance: Pick<RegisteredOutcome['provenance'], 'evidenceFingerprint'> },
): Omit<MissionVerdictRow, 'at'> {
  return {
    id,
    criterionId: outcome.criterionId,
    verdict: outcome.verdict,
    headSha: outcome.targetSha,
    source: 'review',
    method: outcome.method,
    evidence: { kind: 'registered', fingerprint: outcome.fingerprint, evidenceFingerprint: outcome.provenance.evidenceFingerprint },
  };
}
