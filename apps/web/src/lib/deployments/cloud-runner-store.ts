/**
 * DB half of the Settings cloud runner deploy (./cloud-runner-deploy.ts): the
 * team's webhooks, the workspace webhook write, the runner key it mints, and
 * the audit rows for those buildd-side steps.
 */
import { randomBytes } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { accounts, accountWorkspaces, workspaces } from '@buildd/core/db/schema';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { TOKEN_PRESETS } from '@buildd/core/token-scopes';
import { mintApiKeyAccount } from '@/lib/api-key-mint';
import { clearWorkspaceSettingsCache } from '@/lib/team-cache';
import { recordDeploymentAudit } from './store';
import type { CloudRunnerDeployDeps, MintedRunnerKey, StoredWebhook } from './cloud-runner-deploy';

/** The name a minted runner key carries; how a later run finds it again. */
export function runnerKeyName(script: string): string {
  return `Cloud runner (${script})`;
}

export async function teamWebhooks(teamId: string): Promise<Array<{ workspaceId: string; webhookConfig: StoredWebhook | null }>> {
  const rows = await db.query.workspaces.findMany({
    where: sqlWhere(eq(workspaces.teamId, teamId)),
    columns: { id: true, webhookConfig: true },
  });
  return rows.map((r) => ({ workspaceId: r.id, webhookConfig: (r.webhookConfig ?? null) as StoredWebhook | null }));
}

/**
 * Merge the dispatch keys onto the stored webhook_config, keeping every other
 * key (the issue ingest keys live in the same column), like PATCH
 * /api/workspaces/[id] does.
 */
export async function saveWebhook(workspaceId: string, config: { url: string; token?: string; enabled: boolean; events: string[] }): Promise<void> {
  const row = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, workspaceId)), columns: { webhookConfig: true } });
  const stored = (row?.webhookConfig && typeof row.webhookConfig === 'object' ? row.webhookConfig : {}) as Record<string, unknown>;
  const token = config.token ?? (typeof stored.token === 'string' ? stored.token : '');
  if (config.enabled && !token) throw new Error('a dispatching webhook needs a token');
  const value = { ...stored, url: config.url, token, enabled: config.enabled, events: [...new Set(config.events)] };
  await db.update(workspaces).set({ webhookConfig: value as never, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
  await clearWorkspaceSettingsCache(workspaceId);
}

async function findRunnerKey(teamId: string, script: string): Promise<MintedRunnerKey | null> {
  const row = await db.query.accounts.findFirst({
    where: sqlWhere(and(eq(accounts.teamId, teamId), eq(accounts.name, runnerKeyName(script)))),
    orderBy: sqlOrderBy(desc(accounts.createdAt)),
    columns: { id: true, workspaceIds: true },
  });
  return row ? { id: row.id, workspaceIds: row.workspaceIds ?? null } : null;
}

async function mintRunnerKey(input: { teamId: string; userId: string; script: string; workspaceId: string; maxConcurrentWorkers: number }): Promise<string> {
  // A Task agent key (README: the dispatcher's key), worker level, limited to
  // the workspace. Its model spend is the team's own key, so `api`.
  const { plaintextKey } = await mintApiKeyAccount({
    name: runnerKeyName(input.script),
    type: 'service',
    level: 'worker',
    scopes: [...TOKEN_PRESETS.runner.scopes],
    workspaceIds: [input.workspaceId],
    authType: 'api',
    maxConcurrentWorkers: input.maxConcurrentWorkers,
    teamId: input.teamId,
    createdByUserId: input.userId,
  }, [input.workspaceId]);
  return plaintextKey;
}

async function widenRunnerKey(id: string, workspaceId: string): Promise<void> {
  const row = await db.query.accounts.findFirst({ where: sqlWhere(eq(accounts.id, id)), columns: { workspaceIds: true } });
  const ids = [...new Set([...(row?.workspaceIds ?? []), workspaceId])];
  await db.update(accounts).set({ workspaceIds: ids }).where(eq(accounts.id, id));
  await db.insert(accountWorkspaces).values({ accountId: id, workspaceId, canClaim: true, canCreate: true }).onConflictDoNothing();
}

async function removeRunnerKey(id: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.id, id));
}

/** The deps for one request, bound to the signed-in person and the workspace. */
export function cloudRunnerDeployStore(
  principal: { teamId: string; userId: string; workspaceId: string },
  target: { project: string; credentialRef: string },
): Omit<CloudRunnerDeployDeps, 'action' | 'loadRelease'> {
  return {
    teamWebhooks,
    saveWebhook,
    runnerKey: {
      // Only ever a key in the caller's own team.
      find: findRunnerKey,
      mint: mintRunnerKey,
      widen: widenRunnerKey,
      remove: removeRunnerKey,
    },
    audit: async (operation, outcome, reason, result) => {
      await recordDeploymentAudit({
        teamId: principal.teamId, workspaceId: principal.workspaceId, taskId: null, workerId: null, accountId: null,
        userId: principal.userId, principal: 'user', roleSlug: null, operation, capabilities: [], elevated: false,
        provider: 'cloudflare', project: target.project, environment: 'production', credentialRef: target.credentialRef,
        outcome, reason, result,
      });
    },
    randomToken: () => randomBytes(32).toString('base64url'),
  };
}
