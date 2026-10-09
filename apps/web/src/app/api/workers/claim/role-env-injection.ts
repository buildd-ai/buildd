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
 *
 * `runRoleEnvPreFilter` is the claim-loop half: it finds candidate tasks whose
 * declared env NO delivery channel can satisfy, so the claim route defers them
 * instead of claiming a worker that can only run degraded or fail at
 * provisioning. The channels, all known server-side (see `unsatisfiedRoleEnv`):
 *  - a `role_env_secret` row under the mapped label (delivered by this file),
 *  - an `mcp_credential` row labelled with the env name itself (delivered as
 *    `mcpSecrets` by credential-injection.ts, expanded into MCP headers; not
 *    for Codex tasks, which get no mcpSecrets),
 *  - a var the runner always holds itself (RUNNER_PROVIDED_ROLE_ENV).
 * A runner's own process env is NOT a channel: the agent env is built from an
 * allowlist of non-secret names (apps/runner/src/agent-env.ts), so no runner
 * can satisfy a declared secret the server cannot. That is why this gate lives
 * on the server and needs no runner advertisement.
 */
import { db } from '@buildd/core/db';
import { secrets, type WorkspaceGitConfig } from '@buildd/core/db/schema';
import { eq, isNull, or } from 'drizzle-orm';
import type { ClaimTasksResponse } from '@buildd/shared';
import { getSecretsProvider } from '@buildd/core/secrets';
import { loadRoleCandidateRows, resolveRoleRow } from './skill-and-role-injection';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';

/** The claim-candidate rows this block looks tasks up in. */
type ClaimedTask = { id: string; workspaceId: string };

type SecretRow = { id: string; label: string | null; purpose?: string | null; accountId: string | null; workspaceId: string | null; updatedAt: Date | null };

/** Purposes whose rows can put a value where a role's declared env var is read. */
const ENV_DELIVERING_PURPOSES = ['role_env_secret', 'mcp_credential'] as const;

/**
 * Env vars every runner supplies itself, whatever the secrets table holds.
 * BUILDD_API_KEY is the key the runner authenticates the claim with; it is
 * baked into the buildd MCP server header at session start. Every seeded
 * default role declares it (default-roles.ts), so reporting it missing flagged
 * every reviewer/organizer task as degraded.
 */
export const RUNNER_PROVIDED_ROLE_ENV: ReadonlySet<string> = new Set(['BUILDD_API_KEY']);

/**
 * Pure: the declared env names (ENV_NAME -> secret label) that no delivery
 * channel satisfies. `roleEnvLabels` = labels with a usable role_env_secret
 * row; `mcpLabels` = labels with an mcp_credential row (matched against the
 * env NAME, because mcpSecrets reach header expansion keyed by label).
 */
export function unsatisfiedRoleEnv(
  mapping: Record<string, string>,
  available: { roleEnvLabels: ReadonlySet<string>; mcpLabels: ReadonlySet<string> },
  opts: { codex?: boolean } = {},
): string[] {
  return Object.keys(mapping).filter(envName =>
    !RUNNER_PROVIDED_ROLE_ENV.has(envName) &&
    !available.roleEnvLabels.has(mapping[envName]) &&
    !(!opts.codex && available.mcpLabels.has(envName)),
  );
}

/** Workspace-wide default under the role's own mapping; role wins on a shared ENV_NAME. */
function declaredMapping(task: any, role: { requiredEnvVars?: unknown } | undefined): Record<string, string> {
  const workspaceMapping = (task?.workspace?.gitConfig as WorkspaceGitConfig | null | undefined)?.envMapping;
  const roleMapping = role?.requiredEnvVars as Record<string, string> | null | undefined;
  return { ...(workspaceMapping || {}), ...(roleMapping || {}) };
}

/** A row is visible to this claim if team-wide, or scoped to this account / this workspace. */
function inScope(row: SecretRow, accountId: string, wsId: string): boolean {
  return (row.accountId === null || row.accountId === accountId) && (row.workspaceId === null || row.workspaceId === wsId);
}

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

/** Rows without a purpose are treated as role_env_secret (the only purpose this file read before). */
const isRoleEnvRow = (r: SecretRow) => !r.purpose || r.purpose === 'role_env_secret';
const isMcpRow = (r: SecretRow) => r.purpose === 'mcp_credential';

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
    if (!wsId || !teamId) continue;

    try {
      // A role-less task still gets the workspace-wide default (e.g. the
      // NODE_AUTH_TOKEN a repo's registry config reads for every task).
      const role = roleSlug ? await resolveRoleRow(roleSlug, teamId, wsId, accountId, task) : undefined;
      const mapping = declaredMapping(task, role);
      const envNames = Object.keys(mapping);
      if (envNames.length === 0) continue;

      const labels = [...new Set([...Object.values(mapping), ...envNames])];
      const rows = await db.query.secrets.findMany({
        where: teamCredentialWhere(
          { teamId, purpose: ENV_DELIVERING_PURPOSES, label: labels },
          or(isNull(secrets.accountId), eq(secrets.accountId, accountId)),
          or(isNull(secrets.workspaceId), eq(secrets.workspaceId, wsId)),
        ),
        columns: { id: true, label: true, purpose: true, accountId: true, workspaceId: true, updatedAt: true },
      }) as SecretRow[];
      const bestByLabel = pickBestPerLabel(rows.filter(isRoleEnvRow));
      const mcpLabels = new Set(rows.filter(isMcpRow).map(r => r.label).filter((l): l is string => !!l));

      const provider = getSecretsProvider();
      const resolved: Record<string, string> = {};
      const resolvedLabels = new Set<string>();
      for (const envName of envNames) {
        const row = bestByLabel.get(mapping[envName]);
        const val = row ? await provider.get(row.id).catch(() => null) : null;
        if (val) {
          resolved[envName] = val;
          resolvedLabels.add(mapping[envName]);
        }
      }
      // Missing = what no channel supplies, not merely "no role_env_secret row".
      const missing = unsatisfiedRoleEnv(mapping, { roleEnvLabels: resolvedLabels, mcpLabels }, { codex: task.backend === 'codex' });

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

/** One candidate the claim loop must not dispatch: its declared env cannot be met. */
export type RoleEnvGap = { roleSlug: string | null; missing: string[] };

/**
 * Claim-loop pre-filter: candidate task id -> the declared env vars no
 * delivery channel can satisfy. Read-only, existence-only (no decryption: an
 * undecryptable row still reads as present here and surfaces as roleEnvMissing
 * at injection time). One role lookup per distinct (role, team, workspace) —
 * the same `resolveRoleRow` precedence attachRoleEnvSecrets uses — and one
 * secrets query for the whole candidate set, skipped entirely when every
 * declared var is runner-provided (the default-role case).
 *
 * Fails open (returns an empty map) without ENCRYPTION_KEY — nothing could be
 * delivered, and gating would strand every declared role — and on any error.
 */
export async function runRoleEnvPreFilter(
  filteredTasks: readonly any[],
  accountId: string,
): Promise<Map<string, RoleEnvGap>> {
  const gaps = new Map<string, RoleEnvGap>();
  if (!process.env.ENCRYPTION_KEY) return gaps;

  try {
    // Candidate rows are cached per (team, slug, workspace); the winner is
    // picked per task, since a personal role depends on who the task is for.
    const candidateCache = new Map<string, ReturnType<typeof loadRoleCandidateRows>>();
    const plans = await Promise.all(filteredTasks.map(async (task) => {
      const wsId = task?.workspaceId as string | undefined;
      const teamId = task?.workspace?.teamId as string | undefined;
      const roleSlug = (task?.roleSlug as string | null | undefined) ?? null;
      if (!wsId || !teamId) return null;
      let role;
      if (roleSlug) {
        const key = `${teamId}|${roleSlug}|${wsId}`;
        if (!candidateCache.has(key)) candidateCache.set(key, loadRoleCandidateRows(roleSlug, teamId, wsId));
        role = await resolveRoleRow(roleSlug, teamId, wsId, accountId, task, await candidateCache.get(key));
      }
      const mapping = declaredMapping(task, role);
      const needs = Object.keys(mapping).filter(n => !RUNNER_PROVIDED_ROLE_ENV.has(n));
      if (needs.length === 0) return null;
      return { task, wsId, teamId, roleSlug, mapping };
    }));
    const needy = plans.filter((p): p is NonNullable<typeof p> => p !== null);
    if (needy.length === 0) return gaps;

    const teamIds = [...new Set(needy.map(p => p.teamId))];
    const labels = [...new Set(needy.flatMap(p => [...Object.values(p.mapping), ...Object.keys(p.mapping)]))];
    const rows = await db.query.secrets.findMany({
      where: teamCredentialWhere(
        { teamId: teamIds, purpose: ENV_DELIVERING_PURPOSES, label: labels },
        or(isNull(secrets.accountId), eq(secrets.accountId, accountId)),
      ),
      columns: { id: true, label: true, purpose: true, accountId: true, workspaceId: true, updatedAt: true, teamId: true },
    }) as Array<SecretRow & { teamId?: string }>;

    for (const p of needy) {
      const visible = rows.filter(r => (!r.teamId || r.teamId === p.teamId) && inScope(r, accountId, p.wsId) && r.label);
      const missing = unsatisfiedRoleEnv(
        p.mapping,
        {
          roleEnvLabels: new Set(visible.filter(isRoleEnvRow).map(r => r.label!)),
          mcpLabels: new Set(visible.filter(isMcpRow).map(r => r.label!)),
        },
        { codex: p.task.backend === 'codex' },
      );
      if (missing.length > 0) gaps.set(p.task.id, { roleSlug: p.roleSlug, missing });
    }
  } catch (err) {
    console.warn('[claim] Role env pre-filter failed (not gating):', err);
    return new Map();
  }
  return gaps;
}
