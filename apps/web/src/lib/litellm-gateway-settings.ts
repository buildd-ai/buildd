/**
 * The team's LiteLLM gateway as Settings → Model providers manages it (see
 * @buildd/core/litellm-gateway for storage and resolution). The key never
 * leaves the server: callers get the base URL, the key's last four characters
 * and health.
 */
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { decrypt, getSecretsProvider } from '@buildd/core/secrets';
import { maskKeyLast4 } from '@buildd/core/inference-keys';
import type { LookupAll } from '@buildd/core/net/public-address';
import {
  LITELLM_LABEL, gatewayUrlProblem, normalizeGatewayUrl, parseGateway, serializeGateway, verifyGateway,
} from '@buildd/core/litellm-gateway';
import { sanitizeProviderKey } from './provider-keys';

export interface MaskedGateway {
  baseURL: string;
  last4: string;
  health: 'healthy' | 'revoked' | 'unknown';
  lastVerificationError: string | null;
  updatedAt: string;
}

/** The team-wide row this API owns: workspace, account and user NULL. */
const teamRow = (teamId: string) => and(
  eq(secrets.teamId, teamId),
  eq(secrets.purpose, 'inference_key'),
  eq(secrets.label, LITELLM_LABEL),
  isNull(secrets.workspaceId),
  isNull(secrets.accountId),
  isNull(secrets.userId),
);

export async function getTeamGateway(teamId: string): Promise<MaskedGateway | null> {
  const row = await db.query.secrets.findFirst({
    where: teamRow(teamId),
    columns: { encryptedValue: true, healthStatus: true, lastVerificationError: true, updatedAt: true },
  });
  if (!row) return null;
  let g = null;
  try { g = parseGateway(decrypt(row.encryptedValue)); } catch { /* shown as unreadable */ }
  return {
    baseURL: g?.baseURL ?? '',
    last4: g ? maskKeyLast4(g.apiKey) : '',
    health: (row.healthStatus as MaskedGateway['health']) ?? 'unknown',
    lastVerificationError: g ? row.lastVerificationError ?? null : 'stored gateway could not be read',
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
/** Test seam: DNS for the verification call's public-address check. */
type VerifyDeps = { fetcher?: Fetcher; lookup?: LookupAll };

/** Check, then store. A gateway that rejects the key is never saved. */
export async function setTeamGateway(
  input: { teamId: string; baseUrl: unknown; apiKey: unknown },
  deps: VerifyDeps = {},
): Promise<{ ok: true; gateway: MaskedGateway } | { ok: false; status: number; error: string }> {
  if (typeof input.baseUrl !== 'string' || typeof input.apiKey !== 'string') {
    return { ok: false, status: 400, error: 'baseUrl and apiKey are required.' };
  }
  const urlProblem = gatewayUrlProblem(input.baseUrl);
  if (urlProblem) return { ok: false, status: 400, error: urlProblem };
  const apiKey = sanitizeProviderKey(input.apiKey);
  if (!apiKey || /\s/.test(apiKey)) return { ok: false, status: 400, error: 'That doesn\'t look like a key.' };

  const gateway = { baseURL: normalizeGatewayUrl(input.baseUrl), apiKey };
  const check = await verifyGateway(gateway, { fetcher: deps.fetcher, lookup: deps.lookup });
  if (check.health === 'revoked') return { ok: false, status: 400, error: `The gateway rejected this key. ${check.error ?? ''}`.trim() };
  if (check.blocked) return { ok: false, status: 400, error: `This gateway URL can't be used: ${check.error}.` };

  const id = await getSecretsProvider().replaceScoped(serializeGateway(gateway), {
    teamId: input.teamId, purpose: 'inference_key', label: LITELLM_LABEL, userId: null,
  });
  const now = new Date();
  await db.update(secrets).set({
    healthStatus: check.health,
    lastVerifiedAt: now,
    lastVerificationError: check.error,
    ...(check.health === 'healthy' ? { lastSuccessAt: now } : {}),
    updatedAt: now,
  }).where(eq(secrets.id, id));

  return {
    ok: true,
    gateway: { baseURL: gateway.baseURL, last4: maskKeyLast4(apiKey), health: check.health, lastVerificationError: check.error, updatedAt: now.toISOString() },
  };
}

export async function deleteTeamGateway(teamId: string): Promise<boolean> {
  const deleted = await db.delete(secrets).where(teamRow(teamId)).returning({ id: secrets.id });
  return deleted.length > 0;
}
