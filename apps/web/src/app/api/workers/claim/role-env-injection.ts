/**
 * Role/workspace env-secret injection — resolves a role's (or workspace's)
 * declared ENV_NAME -> secret label mapping against the `secrets` table
 * (purpose='role_env_secret') and delivers the resolved values inline on the
 * claim response, so the runner can merge them into the worker's role env
 * (see `WorkerManager.resolveWorkerRoleEnv` / `resolveRoleEnv` in roles.ts).
 *
 * A new purpose rather than reusing `mcp_credential`: mcp_credential values
 * are deliberately kept OUT of the agent env (header-expansion only, see
 * credential-injection.ts). These ARE meant to reach an arbitrary env var —
 * e.g. a private registry token a repo's own .npmrc/bunfig.toml reads.
 *
 * The declaring mapping can come from two places, merged (role wins on a
 * shared key):
 *  - `workspaceSkills.requiredEnvVars` on the task's resolved role row
 *  - `workspace.gitConfig.envMapping` — a workspace-wide default
 *
 * Every failure here is non-fatal: a claim must still succeed with nothing
 * attached (the caller falls back to whatever local env-mapping.json/process
 * env resolution already provides, which today is nothing).
 */
import { db } from '@buildd/core/db';
import { secrets, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { ClaimTasksResponse } from '@buildd/shared';
import { getSecretsProvider } from '@buildd/core/secrets';
import { resolveRoleRow } from './skill-and-role-injection';

/** The claim-candidate rows this block looks tasks up in. */
type ClaimedTask = { id: string; workspaceId: string };

type SecretRow = { id: string; label: string | null; accountId: string | null; workspaceId: string | null; updatedAt: Date | null };

/** Most specific scope wins: workspace-scoped > account-scoped > team-wide. */
function specificity(row: SecretRow): number {
  return row.workspaceId ? 2 : row.accountId ? 1 : 0;
}

/** Picks the most specific row per label, tie-broken by most recently updated. */
function pickBestPerLabel(rows: SecretRow[]): Map<string, SecretRow> {
  const best = new Map<string, SecretRow>();
  for (const row of rows) {
    if (!row.label) continue;
    const cur = best.get(row.label);
    if (
      !cur ||
      specificity(row) > specificity(cur) ||
      (specificity(row) === specificity(cur) && (row.updatedAt?.getTime() ?? 0) > (cur.updatedAt?.getTime() ?? 0))
    ) {
      best.set(row.label, row);
    }
  }
  return best;
}

export async function attachRoleEnvSecrets(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  accountId: string,
): Promise<void> {
  if (!process.env.ENCRYPTION_KEY) return;

  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId) as any;
    const wsId = task?.workspaceId;
    const teamId = task?.workspace?.teamId as string | undefined;
    const roleSlug = task?.roleSlug as string | null | undefined;
    if (!wsId || !teamId || !roleSlug) continue;

    try {
      const role = await resolveRoleRow(roleSlug, teamId, wsId, accountId);
      const workspaceMapping = (task.workspace?.gitConfig as WorkspaceGitConfig | null | undefined)?.envMapping;
      const roleMapping = role?.requiredEnvVars as Record<string, string> | null | undefined;
      // Role-declared keys win over the workspace-wide default for the same ENV_NAME.
      const mapping: Record<string, string> = { ...(workspaceMapping || {}), ...(roleMapping || {}) };
      const envNames = Object.keys(mapping);
      if (envNames.length === 0) continue;

      const labels = [...new Set(Object.values(mapping))];
      const rows = await db.query.secrets.findMany({
        where: and(
          eq(secrets.teamId, teamId),
          eq(secrets.purpose, 'role_env_secret'),
          inArray(secrets.label, labels),
          or(isNull(secrets.accountId), eq(secrets.accountId, accountId)),
          or(isNull(secrets.workspaceId), eq(secrets.workspaceId, wsId)),
        ),
        columns: { id: true, label: true, accountId: true, workspaceId: true, updatedAt: true },
      });
      const bestByLabel = pickBestPerLabel(rows);

      const provider = getSecretsProvider();
      const resolved: Record<string, string> = {};
      const missing: string[] = [];
      for (const envName of envNames) {
        const row = bestByLabel.get(mapping[envName]);
        const val = row ? await provider.get(row.id).catch(() => null) : null;
        if (val) resolved[envName] = val;
        else missing.push(envName);
      }

      if (Object.keys(resolved).length > 0) {
        (cw as any).roleEnvSecrets = resolved;
        console.log(`[claim] Injected ${Object.keys(resolved).length} role env secret(s) for worker ${cw.id}: ${Object.keys(resolved).join(', ')}`);
      }
      if (missing.length > 0) {
        (cw as any).roleEnvMissing = missing;
      }
    } catch (err) {
      console.warn(`[claim] Failed to resolve role env secrets for workspace ${wsId}:`, err);
    }
  }
}
