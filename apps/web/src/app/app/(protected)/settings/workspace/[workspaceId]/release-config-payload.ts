import type { ReleaseStrategy, ReleaseTrigger, WorkspaceReleaseConfig } from '@buildd/core/db/schema';

export interface ReleaseFormState {
  strategy: ReleaseStrategy | 'none';
  prodBranch: string;
  ref: string;
  workflowFile: string;
  trigger: ReleaseTrigger;
  /** Frozen release candidates on/off, and the three comma-separated fields. */
  candidateEnabled: boolean;
  candidateBranches: string;
  candidateSource: string;
  candidateAuthors: string;
}

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * The releaseConfig the form saves. The config endpoint REPLACES the whole
 * object, so every field this form does not edit (releaseBranch, inputs,
 * deployTarget, postDeployHooks, verificationUrl, command) is carried over from
 * what was loaded; before, a save from this form silently dropped them, and a
 * workflow_dispatch save also dropped prodBranch.
 */
export function buildReleaseConfigPayload(
  loaded: WorkspaceReleaseConfig | null,
  f: ReleaseFormState,
): Record<string, unknown> {
  if (f.strategy === 'none') return { strategy: 'none' }; // API treats 'none' as enabled: false
  if (f.strategy !== 'branch_merge' && f.strategy !== 'workflow_dispatch') return { enabled: false };

  const { candidate: _loadedCandidate, ...kept } = loaded ?? ({} as Partial<WorkspaceReleaseConfig>);
  const base: Record<string, unknown> = {
    ...kept,
    enabled: true,
    strategy: f.strategy,
    prodBranch: f.prodBranch.trim() || 'main',
    ref: f.ref.trim() || 'dev',
    trigger: f.trigger,
  };
  if (f.strategy === 'workflow_dispatch') base.workflowFile = f.workflowFile.trim() || 'release.yml';
  // No defaults: an enabled candidate policy is exactly what was typed, and the
  // server refuses an incomplete one rather than guessing.
  if (f.candidateEnabled) {
    base.candidate = {
      branches: list(f.candidateBranches),
      sourceBranch: f.candidateSource.trim(),
      authors: list(f.candidateAuthors),
    };
  }
  return base;
}
