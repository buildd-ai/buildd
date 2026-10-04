import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { decrypt } from '@buildd/core/secrets';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

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
 */
const PURPOSE = 'openai_api_key' as const;

export interface OpenAiApiKeyCredential {
  apiKey: string;
  secretId: string;
}

/**
 * Resolve the most-specific OpenAI API key visible to a task: workspace-scoped
 * beats account-scoped beats team-wide. Mirrors resolveCodexCredential's
 * precedence exactly, since both feed the same claim-time injection point.
 */
export async function resolveOpenAiApiKey(opts: {
  teamId: string;
  accountId?: string | null;
  workspaceId?: string | null;
}): Promise<OpenAiApiKeyCredential | null> {
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, opts.teamId),
      eq(secrets.purpose, PURPOSE),
      or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { id: true, encryptedValue: true, accountId: true, workspaceId: true, healthStatus: true },
  });
  if (rows.length === 0) return null;

  // A revoked row can't be the answer — same reasoning as resolveCodexCredential:
  // skip permanently-dead credentials so the claim route never hands one out.
  const liveRows = rows.filter((r) => (r.healthStatus as string) !== 'revoked');
  if (liveRows.length === 0) return null;

  // Specificity: workspace match (2) outranks account match (1) outranks team-wide (0).
  const score = (r: { accountId: string | null; workspaceId: string | null }) =>
    (r.workspaceId && r.workspaceId === opts.workspaceId ? 2 : 0) +
    (r.accountId && r.accountId === opts.accountId ? 1 : 0);
  const best = liveRows.reduce((a, b) => (score(b) > score(a) ? b : a));

  let apiKey: string;
  try {
    apiKey = decrypt(best.encryptedValue);
  } catch (err) {
    console.warn('[openai-credential] Failed to decrypt openai_api_key secret:', err instanceof Error ? err.message : 'unknown');
    return null;
  }
  if (!apiKey) return null;

  return { apiKey, secretId: best.id };
}

/** True when a live (non-revoked) team/workspace OpenAI API key exists for this scope. */
export async function hasOpenAiApiKey(opts: {
  teamId: string;
  /** `'any'` ignores account scoping — "could ANY runner in this team use it?". */
  accountId?: string | null | 'any';
  workspaceId?: string | null;
}): Promise<boolean> {
  const anyAccount = opts.accountId === 'any';
  const rows = await db.query.secrets.findMany({
    where: and(
      eq(secrets.teamId, opts.teamId),
      eq(secrets.purpose, PURPOSE),
      ...(anyAccount
        ? []
        : [or(isNull(secrets.accountId), opts.accountId ? eq(secrets.accountId, opts.accountId) : sql`false`)]),
      or(isNull(secrets.workspaceId), opts.workspaceId ? eq(secrets.workspaceId, opts.workspaceId) : sql`false`),
    ),
    columns: { healthStatus: true },
  });
  return rows.some((r) => (r.healthStatus as string) !== 'revoked');
}
