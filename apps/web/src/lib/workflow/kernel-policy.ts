/**
 * buildd's adapter for the kernel's `Policy` port (docs/specs/workflow-kernel-library.md
 * §2): the per-workspace knobs the kernel reads, passed in rather than queried
 * inside a kernel statement. The drain reads the §14 kill switch here (the
 * effect claim no longer joins `workspaces`), the conflict family its landing
 * lane mode and agent budget, the legacy hand-off whether the switch is still
 * off.
 *
 * One reading of `gitConfig`: `kernelEnabled` (authority.ts) for the switch,
 * `resolveLandingLaneMode` for the lane, the policy overrides for the
 * conflict budget.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { resolveLandingLaneMode } from '@buildd/workflow-kernel/landing-lane';
import type { KernelPolicy, Policy } from '@buildd/workflow-kernel/ports';
import { policyValue } from '@/lib/policy-overrides';
import { kernelEnabled } from './authority';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

/** The reducer's default round budget; a delivery records its own at open. */
const DEFAULT_MAX_ROUNDS = 3;

/** The knobs for a workspace whose `git_config` is `gitConfig` (null or absent: the defaults, kernel on). */
export function policyFromGitConfig(gitConfig: unknown): KernelPolicy {
  return {
    kernelEnabled: kernelEnabled(gitConfig),
    landingLane: resolveLandingLaneMode(gitConfig),
    maxRounds: DEFAULT_MAX_ROUNDS,
    maxConflictIterations: policyValue('maxConflictIterations'),
  };
}

export function workspacePolicySql(workspaceId: string): SQL {
  return sql`-- workflow:workspace_policy
SELECT git_config FROM workspaces WHERE id = ${workspaceId}::uuid`;
}

/** `Policy` over `workspaces.git_config`. No workspace row reads as the defaults (the delivery's own row decides). */
export function builddPolicy(exec: Exec = dbExec): Policy {
  return {
    async forWorkspace(workspaceId) {
      const row = ((await exec(workspacePolicySql(workspaceId))).rows ?? [])[0] as { git_config?: unknown } | undefined;
      return policyFromGitConfig(row?.git_config ?? null);
    },
  };
}
