import { VISUAL_AUDITOR_ROLE_SLUG } from '@buildd/shared';

/**
 * The in-session output-requirement nudge (workers.ts, turn_complete): which
 * message, if any, to push back into a session that is about to end.
 *
 * A visual-auditor task is never nudged. Its deliverable is screenshots checked
 * server-side (apps/web/src/lib/visual-audit-evidence.ts), not a PR, and the
 * generic "Create a PR (create_pr) or artifact" text would push a read-only
 * auditor to open one, including right after it parked on a boot-failure
 * question.
 *
 * `upload_artifact` counts as an artifact alongside `create_artifact`: both
 * write an artifact row the server's gate accepts.
 */
export function outputRequirementNudge(opts: {
  outputRequirement: string | null | undefined;
  roleSlug: string | null | undefined;
  hasPR: boolean;
  toolCalls: Array<{ name?: string; input?: any }> | undefined;
}): string | null {
  const outputReq = opts.outputRequirement || 'auto';
  if (outputReq !== 'pr_required' && outputReq !== 'artifact_required') return null;
  if (opts.roleSlug === VISUAL_AUDITOR_ROLE_SLUG) return null;
  const hasArtifact = (opts.toolCalls ?? []).some((tc) =>
    tc.name === 'mcp__buildd__buildd'
      && (tc.input?.action === 'create_artifact' || tc.input?.action === 'upload_artifact'));
  const unmet = outputReq === 'pr_required' ? !opts.hasPR : !opts.hasPR && !hasArtifact;
  if (!unmet) return null;
  return outputReq === 'pr_required'
    ? 'You are not done yet — this task requires a pull request. Create one using `buildd` action: create_pr, then call complete_task.'
    : 'You are not done yet — this task requires a deliverable. Create a PR (create_pr) or artifact (create_artifact), then call complete_task.';
}
