/**
 * Provider keys for API-token model calls (chat, inference, decisions), as the
 * settings UI manages them: a personal key per user, and a team key set by an
 * owner/admin. Values never leave the server; callers get `MaskedProviderKey`.
 *
 * Storage is plain `secrets` rows (purpose `inference_key`, label = provider),
 * resolved at call time by `resolveInferenceKey` in @buildd/core/inference-keys.
 * See docs/design/agent-chat.md → Credentials.
 */

import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decrypt, getSecretsProvider } from '@buildd/core/secrets';
import { maskKeyLast4, verifyProviderKey } from '@buildd/core/inference-keys';
import {
  CHAT_PROVIDERS,
  type ChatProvider,
  type ListProviderKeysResponse,
  type MaskedProviderKey,
  type ProviderKeyHealth,
  type ProviderKeySummary,
} from '@buildd/shared';

type Source = MaskedProviderKey['source'];

/** Purposes that already serve a provider's calls, canonical first. */
const SOURCES: Record<ChatProvider, Source[]> = {
  anthropic: ['inference_key', 'anthropic_api_key'],
  openai: ['inference_key'],
  openrouter: ['inference_key', 'decision_key'],
};

interface KeyRow {
  id: string;
  purpose: string;
  label: string | null;
  encryptedValue: string;
  accountId: string | null;
  userId: string | null;
  healthStatus: string;
  lastVerifiedAt: Date | null;
  lastVerificationError: string | null;
  updatedAt: Date;
}

function rowProvider(r: KeyRow): ChatProvider | null {
  if (r.purpose === 'anthropic_api_key') return 'anthropic';
  if (r.purpose === 'decision_key') return 'openrouter';
  const label = (r.label ?? '').toLowerCase();
  return (CHAT_PROVIDERS as readonly string[]).includes(label) ? (label as ChatProvider) : null;
}

function toMasked(r: KeyRow, provider: ChatProvider, scope: 'user' | 'team'): MaskedProviderKey {
  let last4 = '';
  try { last4 = maskKeyLast4(decrypt(r.encryptedValue) ?? ''); } catch { /* undecryptable: show no digits */ }
  return {
    id: r.id,
    provider,
    scope,
    last4,
    health: (r.healthStatus as ProviderKeyHealth) ?? 'unknown',
    lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
    lastVerificationError: r.lastVerificationError ?? null,
    updatedAt: r.updatedAt.toISOString(),
    source: r.purpose as Source,
  };
}

async function loadRows(teamId: string): Promise<KeyRow[]> {
  return (await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, teamId),
      inArray(secrets.purpose, ['inference_key', 'anthropic_api_key', 'decision_key']),
      isNull(secrets.workspaceId),
    ),
    columns: {
      id: true, purpose: true, label: true, encryptedValue: true, accountId: true, userId: true,
      healthStatus: true, lastVerifiedAt: true, lastVerificationError: true, updatedAt: true,
    },
  })) as KeyRow[];
}

/** Team card key: the row the resolver would pick at team scope for this provider. */
function pickTeamRow(rows: KeyRow[], provider: ChatProvider): KeyRow | null {
  const order = SOURCES[provider];
  return rows
    .filter(r => r.userId == null && rowProvider(r) === provider && order.includes(r.purpose as Source))
    .sort((a, b) =>
      (a.accountId ? 1 : 0) - (b.accountId ? 1 : 0) ||
      order.indexOf(a.purpose as Source) - order.indexOf(b.purpose as Source) ||
      (a.healthStatus === 'revoked' ? 1 : 0) - (b.healthStatus === 'revoked' ? 1 : 0) ||
      b.updatedAt.getTime() - a.updatedAt.getTime(),
    )[0] ?? null;
}

export async function listProviderKeys(
  teamId: string,
  userId: string,
  canManageTeamKeys: boolean,
): Promise<ListProviderKeysResponse> {
  const rows = await loadRows(teamId);
  const providers: ProviderKeySummary[] = CHAT_PROVIDERS.map(provider => {
    const team = pickTeamRow(rows, provider);
    const mine = rows.find(r => r.userId === userId && r.purpose === 'inference_key' && rowProvider(r) === provider);
    const others = new Set(
      rows.filter(r => r.userId && r.purpose === 'inference_key' && rowProvider(r) === provider).map(r => r.userId),
    );
    return {
      provider,
      team: team ? toMasked(team, provider, 'team') : null,
      mine: mine ? toMasked(mine, provider, 'user') : null,
      membersWithOwnKey: canManageTeamKeys ? others.size : null,
    };
  });
  return { teamId, canManageTeamKeys, providers };
}

/** Trim, and strip one pair of wrapping quotes (pasted keys often carry them). */
export function sanitizeProviderKey(raw: string): string {
  let v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/** A reason this value can't be a key for this provider, or null. */
export function providerKeyProblem(provider: ChatProvider, value: string): string | null {
  if (value.length < 20 || /\s/.test(value)) return 'That doesn\'t look like an API key.';
  if (provider === 'anthropic' && value.startsWith('sk-ant-oat')) {
    return 'That is a Claude subscription token. Chat needs an Anthropic API key (sk-ant-api…).';
  }
  return null;
}

type SetResult =
  | { ok: true; key: MaskedProviderKey }
  | { ok: false; status: number; error: string };

export async function setProviderKey(input: {
  teamId: string;
  userId: string;
  provider: ChatProvider;
  scope: 'user' | 'team';
  value: string;
}): Promise<SetResult> {
  const value = sanitizeProviderKey(input.value);
  const problem = providerKeyProblem(input.provider, value);
  if (problem) return { ok: false, status: 400, error: problem };

  // Check before storing: a key the provider rejects is never saved, so it
  // can't shadow a working team key for this user.
  const check = await verifyProviderKey(input.provider, value);
  if (check.health === 'revoked') {
    return { ok: false, status: 400, error: `The provider rejected this key. ${check.error ?? ''}`.trim() };
  }

  const id = await getSecretsProvider().replaceScoped(value, {
    teamId: input.teamId,
    purpose: 'inference_key',
    label: input.provider,
    userId: input.scope === 'user' ? input.userId : null,
  });

  const now = new Date();
  const [row] = await db.update(secrets)
    .set({
      healthStatus: check.health,
      lastVerifiedAt: now,
      lastVerificationError: check.error,
      ...(check.health === 'healthy' ? { lastSuccessAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(secrets.id, id))
    .returning({
      id: secrets.id, purpose: secrets.purpose, label: secrets.label, encryptedValue: secrets.encryptedValue,
      accountId: secrets.accountId, userId: secrets.userId, healthStatus: secrets.healthStatus,
      lastVerifiedAt: secrets.lastVerifiedAt, lastVerificationError: secrets.lastVerificationError,
      updatedAt: secrets.updatedAt,
    });

  return { ok: true, key: toMasked(row as KeyRow, input.provider, input.scope) };
}

/** Exact scope of a key this API owns: purpose inference_key, workspace/account NULL. */
function ownedScope(input: { teamId: string; userId: string; provider: ChatProvider; scope: 'user' | 'team' }) {
  return and(
    eq(secrets.teamId, input.teamId),
    eq(secrets.purpose, 'inference_key'),
    eq(secrets.label, input.provider),
    isNull(secrets.workspaceId),
    isNull(secrets.accountId),
    input.scope === 'user' ? eq(secrets.userId, input.userId) : isNull(secrets.userId),
  );
}

export async function deleteProviderKey(input: {
  teamId: string;
  userId: string;
  provider: ChatProvider;
  scope: 'user' | 'team';
}): Promise<boolean> {
  const deleted = await db.delete(secrets).where(ownedScope(input)).returning({ id: secrets.id });
  return deleted.length > 0;
}

export async function reverifyProviderKey(input: {
  teamId: string;
  userId: string;
  provider: ChatProvider;
  scope: 'user' | 'team';
}): Promise<MaskedProviderKey | null> {
  const row = (await db.query.secrets.findFirst({
    where: ownedScope(input),
    columns: {
      id: true, purpose: true, label: true, encryptedValue: true, accountId: true, userId: true,
      healthStatus: true, lastVerifiedAt: true, lastVerificationError: true, updatedAt: true,
    },
  })) as KeyRow | undefined;
  if (!row) return null;

  let value = '';
  try { value = decrypt(row.encryptedValue) ?? ''; } catch { /* treated as unknown below */ }
  const check = value
    ? await verifyProviderKey(input.provider, value)
    : { health: 'unknown' as const, error: 'stored key could not be decrypted' };

  const now = new Date();
  await db.update(secrets)
    .set({
      healthStatus: check.health,
      lastVerifiedAt: now,
      lastVerificationError: check.error,
      ...(check.health === 'healthy' ? { lastSuccessAt: now } : {}),
    })
    .where(eq(secrets.id, row.id));

  return toMasked(
    { ...row, healthStatus: check.health, lastVerifiedAt: now, lastVerificationError: check.error },
    input.provider,
    input.scope,
  );
}
