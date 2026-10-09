/**
 * DB half of minted Cloudflare AI Gateway Run tokens
 * (@buildd/core/cloudflare-gateway-tokens): mint with the team's Cloudflare
 * credential, store one per scope, revoke at Cloudflare before deleting.
 *
 * Scopes: `personal` (the signed-in person's own, `userId` set) and `team`
 * (the agents token, no `userId`). The token value never leaves the server
 * through here; reads are masked.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { decrypt, getSecretsProvider } from '@buildd/core/secrets';
import {
  CLOUDFLARE_GATEWAY_TOKEN_PURPOSE,
  gatewayTokenExpired,
  mintGatewayRunToken,
  parseGatewayRunToken,
  revokeGatewayRunToken,
  serializeGatewayRunToken,
} from '@buildd/core/cloudflare-gateway-tokens';
import { decodeCloudflareValue, findCloudflareSecret, type FetchLike } from './cloudflare-credential';

export type GatewayTokenScope = 'personal' | 'team';

export interface MaskedGatewayToken {
  scope: GatewayTokenScope;
  tokenHint: string;
  expiresOn: string | null;
  expired: boolean;
  updatedAt: string;
}

type Refusal = { ok: false; status: number; error: string };

function scopeWhere(teamId: string, scope: GatewayTokenScope, userId: string) {
  return and(
    eq(secrets.teamId, teamId),
    eq(secrets.purpose, CLOUDFLARE_GATEWAY_TOKEN_PURPOSE),
    isNull(secrets.accountId),
    isNull(secrets.workspaceId),
    scope === 'personal' ? eq(secrets.userId, userId) : isNull(secrets.userId),
  );
}

async function rowAt(teamId: string, scope: GatewayTokenScope, userId: string) {
  const rows = await db.query.secrets.findMany({
    where: scopeWhere(teamId, scope, userId),
    columns: { id: true, userId: true, encryptedValue: true, updatedAt: true },
  });
  // Re-checked in code: never another person's row.
  return (rows ?? []).filter(r => (scope === 'personal' ? r.userId === userId : r.userId === null));
}

function read(encryptedValue: string) {
  try { return parseGatewayRunToken(decrypt(encryptedValue)); } catch { return null; }
}

function mask(scope: GatewayTokenScope, row: { encryptedValue: string; updatedAt: Date }): MaskedGatewayToken | null {
  const t = read(row.encryptedValue);
  if (!t) return null;
  return { scope, tokenHint: `…${t.token.slice(-4)}`, expiresOn: t.expiresOn, expired: gatewayTokenExpired(t), updatedAt: row.updatedAt.toISOString() };
}

/** The person's own token and the team's, masked. */
export async function listGatewayTokens(teamId: string, userId: string): Promise<{ personal: MaskedGatewayToken | null; team: MaskedGatewayToken | null }> {
  const [mine, team] = await Promise.all([rowAt(teamId, 'personal', userId), rowAt(teamId, 'team', userId)]);
  return { personal: mine[0] ? mask('personal', mine[0]) : null, team: team[0] ? mask('team', team[0]) : null };
}

async function teamCloudflare(teamId: string): Promise<{ apiToken: string; accountId: string } | Refusal> {
  const row = await findCloudflareSecret(teamId);
  const cred = row ? decodeCloudflareValue(row.encryptedValue) : null;
  if (!row || !cred) return { ok: false, status: 400, error: 'Add the team\'s Cloudflare credential first: tokens are created with it.' };
  if (row.healthStatus === 'revoked') return { ok: false, status: 400, error: 'The team\'s Cloudflare credential was rejected by Cloudflare. Update it first.' };
  return { apiToken: cred.apiToken, accountId: cred.accountId };
}

/**
 * Mint a token for this scope and store it, replacing (and revoking at
 * Cloudflare) the one it had. `label` names it in Cloudflare's dashboard.
 */
export async function createGatewayToken(
  input: { teamId: string; userId: string; scope: GatewayTokenScope; label: string },
  deps: { fetcher?: FetchLike; now?: number } = {},
): Promise<{ ok: true; token: MaskedGatewayToken } | Refusal> {
  const cf = await teamCloudflare(input.teamId);
  if ('ok' in cf) return cf;
  const minted = await mintGatewayRunToken(cf, { name: input.label, fetcher: deps.fetcher, now: deps.now });
  if (!minted.ok) return minted;

  const previous = await rowAt(input.teamId, input.scope, input.userId);
  await getSecretsProvider().replaceScoped(serializeGatewayRunToken(minted.value), {
    teamId: input.teamId,
    purpose: CLOUDFLARE_GATEWAY_TOKEN_PURPOSE,
    userId: input.scope === 'personal' ? input.userId : null,
  });
  // The replaced token stops working too; a failure here leaves it to expire.
  for (const p of previous) {
    const old = read(p.encryptedValue);
    if (old && old.tokenId !== minted.value.tokenId) {
      const r = await revokeGatewayRunToken(cf, old.tokenId, { fetcher: deps.fetcher });
      if (!r.ok) console.warn(`[cloudflare-gateway-tokens] could not revoke a replaced token: ${r.error}`);
    }
  }
  const t = minted.value;
  return {
    ok: true,
    token: { scope: input.scope, tokenHint: `…${t.token.slice(-4)}`, expiresOn: t.expiresOn, expired: false, updatedAt: new Date(deps.now ?? Date.now()).toISOString() },
  };
}

/**
 * Revoke the scope's token at Cloudflare, then delete the row. When Cloudflare
 * cannot be reached the row is kept, so the token is never forgotten while it
 * still works.
 */
export async function deleteGatewayToken(
  input: { teamId: string; userId: string; scope: GatewayTokenScope },
  deps: { fetcher?: FetchLike } = {},
): Promise<{ ok: true; deleted: boolean } | Refusal> {
  const rows = await rowAt(input.teamId, input.scope, input.userId);
  if (rows.length === 0) return { ok: true, deleted: false };
  const cf = await teamCloudflare(input.teamId);
  for (const r of rows) {
    const t = read(r.encryptedValue);
    if (t && !('ok' in cf)) {
      const revoked = await revokeGatewayRunToken(cf, t.tokenId, { fetcher: deps.fetcher });
      if (!revoked.ok) return { ok: false, status: 502, error: `Cloudflare did not revoke the token (${revoked.error}). Nothing was deleted.` };
    } else if (t) {
      return { ok: false, status: 400, error: 'The team\'s Cloudflare credential is needed to revoke the token. Nothing was deleted.' };
    }
    await getSecretsProvider().delete(r.id);
  }
  return { ok: true, deleted: true };
}
