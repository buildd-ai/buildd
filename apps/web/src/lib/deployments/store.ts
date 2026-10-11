/**
 * DB half of deployment actions (./action.ts): the audit trail and the
 * credential lookup by reference. Only this file and the provider adapter
 * ever hold a decrypted deploy credential, and neither returns it to a caller.
 */
import { db } from '@buildd/core/db';
import { deploymentAuditEvents, secrets } from '@buildd/core/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { CLOUDFLARE_PURPOSE } from '../cloudflare-credential-shared';
import { decodeCloudflareValue } from '../cloudflare-credential';
import type { DeploymentAuditInput, DeploymentDeps, DeploymentProvider } from './action';

/**
 * The reference a stored credential answers to: its label, lower-cased and
 * trimmed, or the provider's name when it has no label. A team's single
 * unlabelled Cloudflare token is therefore `cloudflare`.
 */
export function credentialRefOf(label: string | null | undefined, provider: DeploymentProvider): string {
  const l = label?.trim().toLowerCase();
  return l ? l : provider;
}

const PURPOSE: Record<DeploymentProvider, typeof CLOUDFLARE_PURPOSE> = { cloudflare: CLOUDFLARE_PURPOSE };

export async function recordDeploymentAudit(row: DeploymentAuditInput): Promise<string> {
  const [inserted] = await db
    .insert(deploymentAuditEvents)
    .values({ ...row, completedAt: row.outcome === 'started' ? null : new Date() })
    .returning({ id: deploymentAuditEvents.id });
  return inserted.id;
}

export async function settleDeploymentAudit(
  id: string,
  outcome: 'succeeded' | 'failed',
  reason: string | null,
  result: Record<string, unknown> | null,
): Promise<void> {
  await db
    .update(deploymentAuditEvents)
    .set({ outcome, reason: reason?.slice(0, 500) ?? null, result, completedAt: new Date() })
    .where(and(eq(deploymentAuditEvents.id, id), eq(deploymentAuditEvents.outcome, 'started')));
}

/** The team-wide credential whose reference is `credentialRef`, decrypted, or null. */
export async function resolveDeploymentCredential(teamId: string, provider: DeploymentProvider, credentialRef: string) {
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, teamId),
      eq(secrets.purpose, PURPOSE[provider]),
      isNull(secrets.workspaceId),
      isNull(secrets.userId),
    ),
    orderBy: desc(secrets.updatedAt),
    columns: { label: true, encryptedValue: true },
  });
  const ref = credentialRef.trim().toLowerCase();
  const row = rows.find(r => credentialRefOf(r.label, provider) === ref);
  return row ? decodeCloudflareValue(row.encryptedValue) : null;
}

export const deploymentStore: DeploymentDeps = {
  recordAudit: recordDeploymentAudit,
  settleAudit: settleDeploymentAudit,
  resolveCredential: resolveDeploymentCredential,
};
