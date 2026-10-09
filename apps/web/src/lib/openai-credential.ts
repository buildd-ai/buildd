import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { decrypt } from '@buildd/core/secrets';
import { eq, isNull, or, sql } from 'drizzle-orm';
import { agentKeyPurposes, agentKeyStorageIndex } from '@buildd/core/providers/agent-keys';
import { teamCredentialWhere } from '@buildd/core/secrets/team-scope';

/**
 * A plain team/workspace OpenAI API key for Codex agent tasks.
 *
 * This is the simple sibling of `codex_credential` (the ChatGPT OAuth / JSON-blob
 * connect flow in lib/codex-credential.ts): a single raw string, stored via
 * POST /api/secrets exactly like `anthropic_api_key`, for a team that just wants
 * to paste a key instead of connecting an account. See
 * docs/credentials-architecture.md for why this is a separate purpose rather
 * than reusing `inference_key` (chat/decision calls only) or `codex_credential`
 * (multi-field, OAuth-oriented, its own UI flow).
 *
 * Provider parity: the key's canonical storage is now `inference_key` / label
 * `openai`, the row chat reads, so one stored OpenAI key serves chat and Codex
 * runs. `openai_api_key` is the legacy alias, still read; within one scope the
 * canonical row wins. Team rows only (`user_id IS NULL`): a requester's own key
 * reaches a Codex run through claim/personal-credential-injection, never here.
 */
const PURPOSES = agentKeyPurposes('openai');

/** A team row (never personal) holding the OpenAI agent key, in canonical or legacy storage. */
function isTeamOpenAiKey(r: { purpose: string; label?: string | null; userId?: string | null }): boolean {
  return !r.userId && agentKeyStorageIndex(r, 'openai') >= 0;
}

export interface OpenAiApiKeyCredential {
  apiKey: string;
  secretId: string;
}

/**
 * Resolve the most-specific OpenAI API key visible to a task: workspace-scoped
 * beats account-scoped beats team-wide; within one scope canonical storage
 * beats the legacy alias. Mirrors resolveCodexCredential's precedence, since
 * both feed the same claim-time injection point.
 */
export async function resolveOpenAiApiKey(opts: {
  teamId: string;
  accountId?: string | null;
  workspaceId?: string | null;
}): Promise<OpenAiApiKeyCredential | null> {
  const rows = (await db.query.secrets.findMany({
    where: teamCredentialWhere(
      { teamId: opts.teamId, purpose: PURPOSES },
      or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { id: true, purpose: true, label: true, userId: true, encryptedValue: true, accountId: true, workspaceId: true, healthStatus: true },
  })).filter(isTeamOpenAiKey);
  if (rows.length === 0) return null;

  // A revoked row can't be the answer — same reasoning as resolveCodexCredential:
  // skip permanently-dead credentials so the claim route never hands one out.
  const liveRows = rows.filter((r) => (r.healthStatus as string) !== 'revoked');
  if (liveRows.length === 0) return null;

  // Specificity: workspace match (2) outranks account match (1) outranks team-wide (0).
  const score = (r: { accountId: string | null; workspaceId: string | null }) =>
    (r.workspaceId && r.workspaceId === opts.workspaceId ? 2 : 0) +
    (r.accountId && r.accountId === opts.accountId ? 1 : 0);
  // Within a scope, canonical (0) over legacy; otherwise the first row, as before.
  const storage = (r: { purpose: string; label?: string | null }) => agentKeyStorageIndex(r, 'openai');
  const best = liveRows.reduce((a, b) =>
    (score(b) > score(a) || (score(b) === score(a) && storage(b) < storage(a)) ? b : a));

  let apiKey: string;
  try {
    apiKey = decrypt(best.encryptedValue);
  } catch (err) {
    console.warn(`[openai-credential] Failed to decrypt ${best.purpose} secret:`, err instanceof Error ? err.message : 'unknown');
    return null;
  }
  if (!apiKey) return null;

  return { apiKey, secretId: best.id };
}

/** True when a live (non-revoked) team/workspace OpenAI API key exists for this scope, in either storage. */
export async function hasOpenAiApiKey(opts: {
  teamId: string;
  /** `'any'` ignores account scoping — "could ANY runner in this team use it?". */
  accountId?: string | null | 'any';
  workspaceId?: string | null;
}): Promise<boolean> {
  const anyAccount = opts.accountId === 'any';
  const rows = await db.query.secrets.findMany({
    where: teamCredentialWhere(
      { teamId: opts.teamId, purpose: PURPOSES },
      ...(anyAccount
        ? []
        : [or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`)]),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { purpose: true, label: true, userId: true, healthStatus: true },
  });
  return rows.some((r) => isTeamOpenAiKey(r) && (r.healthStatus as string) !== 'revoked');
}
