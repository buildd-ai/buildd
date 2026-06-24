// Resolve a workspace's release configuration into a concrete, validated
// strategy. Pure (no I/O) so it's unit-testable and shared by both release
// entry points: the standalone `trigger_release` MCP action / route, and the
// auto-on-task-completion `executeRelease` path.
//
// buildd does not know what "release" means — the workspace declares it via
// `releaseConfig.strategy`. This function turns that declaration (plus optional
// per-call overrides) into a normalized object the dispatchers consume. The
// string "dev"/"release.yml" must never appear as a default here or anywhere
// else: an unconfigured workspace resolves to `not_configured`, not to buildd's
// own shape.

import type { WorkspaceReleaseConfig, ReleaseStrategy } from './db/schema';

export type ResolvedReleaseStrategy =
  | {
      kind: 'workflow_dispatch';
      workflowFile: string;
      ref: string;
      inputs: Record<string, string>;
    }
  | {
      kind: 'branch_merge';
      prodBranch: string;
      releaseBranch?: string;
      deployTarget?: WorkspaceReleaseConfig['deployTarget'];
      postDeployHooks?: WorkspaceReleaseConfig['postDeployHooks'];
      verificationUrl?: string;
    }
  | {
      kind: 'script';
      command: string;
      ref?: string;
    };

export type ReleaseStrategyResolution =
  | { ok: true; strategy: ResolvedReleaseStrategy }
  | { ok: false; reason: 'not_configured' | 'disabled' | 'invalid'; message: string };

// Per-call overrides accepted by the standalone trigger. They never introduce a
// strategy of their own — only refine the workspace's declared one.
export interface ReleaseOverrides {
  ref?: string;
  workflowFile?: string;
  inputs?: Record<string, string>;
  // Convenience for the common "force" workflow input — folded into `inputs.force`.
  force?: boolean;
}

// Absent strategy ⇒ legacy 'branch_merge' (the original pre-strategy shape).
export function effectiveStrategy(config: WorkspaceReleaseConfig): ReleaseStrategy {
  return config.strategy ?? 'branch_merge';
}

export function resolveReleaseStrategy(
  config: WorkspaceReleaseConfig | null | undefined,
  overrides: ReleaseOverrides = {},
): ReleaseStrategyResolution {
  if (!config) {
    return { ok: false, reason: 'not_configured', message: 'Workspace has no release config' };
  }
  if (!config.enabled) {
    return { ok: false, reason: 'disabled', message: 'Release config is disabled for this workspace' };
  }

  const kind = effectiveStrategy(config);

  switch (kind) {
    case 'workflow_dispatch': {
      const workflowFile = overrides.workflowFile ?? config.workflowFile;
      const ref = overrides.ref ?? config.ref;
      if (!workflowFile) {
        return { ok: false, reason: 'invalid', message: 'workflow_dispatch strategy requires releaseConfig.workflowFile' };
      }
      if (!ref) {
        return { ok: false, reason: 'invalid', message: 'workflow_dispatch strategy requires releaseConfig.ref' };
      }
      // Merge inputs: config defaults < per-call overrides < explicit force.
      const inputs: Record<string, string> = { ...(config.inputs ?? {}), ...(overrides.inputs ?? {}) };
      if (overrides.force !== undefined) inputs.force = overrides.force ? 'true' : 'false';
      return { ok: true, strategy: { kind, workflowFile, ref, inputs } };
    }

    case 'branch_merge': {
      const prodBranch = config.prodBranch;
      if (!prodBranch) {
        return { ok: false, reason: 'invalid', message: 'branch_merge strategy requires releaseConfig.prodBranch' };
      }
      return {
        ok: true,
        strategy: {
          kind,
          prodBranch,
          ...(config.releaseBranch ? { releaseBranch: config.releaseBranch } : {}),
          deployTarget: config.deployTarget,
          postDeployHooks: config.postDeployHooks,
          verificationUrl: config.verificationUrl,
        },
      };
    }

    case 'script': {
      const command = config.command;
      if (!command) {
        return { ok: false, reason: 'invalid', message: 'script strategy requires releaseConfig.command' };
      }
      return { ok: true, strategy: { kind, command, ref: overrides.ref ?? config.ref } };
    }

    default:
      return { ok: false, reason: 'invalid', message: `Unknown release strategy: ${String(kind)}` };
  }
}
