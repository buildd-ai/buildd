/**
 * Visual QA's evidence-slot policy (lib/completion-policy.ts). A
 * visual-auditor task (a mission's [surface audit]) is judged on its own
 * evidence, which replaces the output-requirement gates: a summary, a PR or a
 * sibling's mission artifact must not pass an audit that never looked. See
 * lib/visual-audit-evidence.ts for what counts.
 */
import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';
import type { EvidenceInput, EvidenceVerdict } from '@/lib/completion-policy';
import { loadVisualAuditEvidence, formatVisualEvidenceRejection } from '@/lib/visual-audit-evidence';

export async function visualAuditEvidencePolicy(input: EvidenceInput): Promise<EvidenceVerdict> {
  if (input.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG) return null;
  const evidence = await loadVisualAuditEvidence({
    workerId: input.workerId,
    taskId: input.taskId,
    missionId: input.missionId,
    workspaceId: input.workspaceId,
    workerStartedAt: input.workerStartedAt,
  });
  if (!evidence.ok) return { kind: 'fail', reason: formatVisualEvidenceRejection(evidence), hint: 'visual_evidence' };
  return { kind: 'pass' };
}
