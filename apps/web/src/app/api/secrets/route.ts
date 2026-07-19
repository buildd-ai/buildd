import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { accounts } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentUser } from '@/lib/auth-helpers';
import { hashApiKey } from '@/lib/api-auth';
import { getUserTeamIds } from '@/lib/team-access';
import { getSecretsProvider } from '@buildd/core/secrets';
import { requeueAuthFailedTasks } from '@/lib/credential-recovery';

/** Backend-auth purposes whose (re)store should recover auth-failed tasks. */
const CLAUDE_CREDENTIAL_PURPOSES = new Set(['oauth_token', 'anthropic_api_key', 'claude_credential']);

/**
 * Purposes whose value is a raw credential string (not a JSON blob). Values pasted
 * for these are frequently wrapped in quotes (e.g. `"sk-ant-oat01-…"`), which makes a
 * valid 108-char token 110 chars and gets it rejected by Anthropic with a
 * `401 Invalid bearer token` hours later. We strip a single wrapping quote pair before
 * encrypting. JSON-blob credentials (e.g. `claude_credential`, written via the
 * connected-account route) must NOT be quote-stripped.
 */
const RAW_STRING_PURPOSES = new Set([
  'anthropic_api_key',
  'oauth_token',
  'webhook_token',
  'custom',
  'mcp_credential',
  'vercel_token',
]);

/** Required prefixes for Claude credential purposes. */
const REQUIRED_PREFIXES: Record<string, string> = {
  oauth_token: 'sk-ant-oat',
  anthropic_api_key: 'sk-ant-api',
};

/**
 * Sanitize a raw secret value before encryption: trim whitespace, and for raw-string
 * purposes strip a single pair of wrapping quotes (single or double). Enforced
 * server-side regardless of what the client sends.
 */
function sanitizeSecretValue(raw: string, purpose: string): string {
  let v = raw.trim();
  if (RAW_STRING_PURPOSES.has(purpose) && v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}

/**
 * Dual auth: API key (Bearer token) or session cookie.
 * Returns the list of team IDs the caller belongs to.
 */
async function authenticateAndGetTeamIds(req: NextRequest): Promise<{ teamIds: string[]; accountId?: string } | null> {
  // Try API key auth first
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  if (apiKey) {
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.apiKey, hashApiKey(apiKey)),
    });
    if (account) {
      return { teamIds: [account.teamId], accountId: account.id };
    }
  }

  // Fall back to session auth
  if (process.env.NODE_ENV === 'development') {
    return { teamIds: [] };
  }

  const user = await getCurrentUser();
  if (user) {
    const teamIds = await getUserTeamIds(user.id);
    return { teamIds };
  }

  return null;
}

// POST /api/secrets — store an encrypted secret (session or API key auth, team-scoped)
export async function POST(req: NextRequest) {
  const auth = await authenticateAndGetTeamIds(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (auth.teamIds.length === 0) {
    return NextResponse.json({ error: 'No team found' }, { status: 403 });
  }

  const body = await req.json();
  const { value, purpose, label, accountId, workspaceId, teamId } = body;

  if (!value || !purpose) {
    return NextResponse.json({ error: 'value and purpose are required' }, { status: 400 });
  }

  const validPurposes = ['anthropic_api_key', 'oauth_token', 'claude_credential', 'webhook_token', 'custom', 'mcp_credential', 'vercel_token'];
  if (!validPurposes.includes(purpose)) {
    return NextResponse.json({ error: `Invalid purpose. Must be one of: ${validPurposes.join(', ')}` }, { status: 400 });
  }

  // MCP credentials require a label (env var name)
  if (purpose === 'mcp_credential' && !label) {
    return NextResponse.json({ error: 'label is required for mcp_credential secrets' }, { status: 400 });
  }

  // Sanitize the raw value: trim, and strip wrapping quotes for raw-string purposes.
  // This is the fix for pasted Claude tokens arriving as `"sk-ant-oat01-…"`.
  const sanitizedValue = sanitizeSecretValue(String(value), purpose);
  if (!sanitizedValue) {
    return NextResponse.json({ error: 'value is required' }, { status: 400 });
  }

  // Validate format for Claude credential purposes so we fail loudly instead of
  // silently storing a token that will 401 hours later.
  const requiredPrefix = REQUIRED_PREFIXES[purpose];
  if (requiredPrefix && !sanitizedValue.startsWith(requiredPrefix)) {
    return NextResponse.json(
      { error: `Token must start with ${requiredPrefix}…` },
      { status: 400 },
    );
  }

  // Verify the requested team belongs to the caller
  const targetTeamId = teamId || auth.teamIds[0];
  if (!auth.teamIds.includes(targetTeamId)) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const provider = getSecretsProvider();
    // replaceScoped (not set(null)): a re-save REPLACES the existing credential at
    // the same scope instead of appending a duplicate row. Duplicates are a real
    // hazard here — the claim-time resolver picks one row per (team, purpose) with
    // no ordering, so a stale/revoked leftover could be handed to a worker while a
    // fresh token sits unused. See docs/credentials-architecture.md.
    const id = await provider.replaceScoped(sanitizedValue, {
      teamId: targetTeamId,
      // MCP credentials are team-wide (shared with all runners), so don't scope to account
      accountId: (purpose === 'mcp_credential' ? (accountId ?? null) : (accountId || auth.accountId)) ?? undefined,
      workspaceId,
      purpose,
      label,
    });

    // Storing a healthy backend credential recovers tasks that failed on the old
    // (revoked/expired) one — self-heal instead of a manual re-run slog. Best-effort.
    let requeued = 0;
    if (CLAUDE_CREDENTIAL_PURPOSES.has(purpose)) {
      try {
        requeued = (await requeueAuthFailedTasks(targetTeamId)).requeued.length;
      } catch (err) {
        console.warn('[secrets] requeue-on-recovery failed (non-fatal):', err);
      }
    }

    return NextResponse.json({ id, requeued });
  } catch (error) {
    console.error('Create secret error:', error);
    return NextResponse.json({ error: 'Failed to create secret' }, { status: 500 });
  }
}

// GET /api/secrets — list secret metadata (never values)
export async function GET(req: NextRequest) {
  const auth = await authenticateAndGetTeamIds(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (auth.teamIds.length === 0) {
    return NextResponse.json({ secrets: [] });
  }

  const teamId = req.nextUrl.searchParams.get('teamId') || auth.teamIds[0];
  if (!auth.teamIds.includes(teamId)) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 });
  }

  try {
    const provider = getSecretsProvider();
    const secrets = await provider.list(teamId);
    return NextResponse.json({ secrets });
  } catch (error) {
    console.error('List secrets error:', error);
    return NextResponse.json({ error: 'Failed to list secrets' }, { status: 500 });
  }
}

// DELETE /api/secrets?id=xxx — remove a secret
export async function DELETE(req: NextRequest) {
  const auth = await authenticateAndGetTeamIds(req);
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (auth.teamIds.length === 0) {
    return NextResponse.json({ error: 'No team found' }, { status: 403 });
  }

  const id = req.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  try {
    // Verify the secret belongs to one of the caller's teams by listing first
    const provider = getSecretsProvider();
    for (const teamId of auth.teamIds) {
      const teamSecrets = await provider.list(teamId);
      if (teamSecrets.some(s => s.id === id)) {
        await provider.delete(id);
        return NextResponse.json({ success: true });
      }
    }

    return NextResponse.json({ error: 'Secret not found' }, { status: 404 });
  } catch (error) {
    console.error('Delete secret error:', error);
    return NextResponse.json({ error: 'Failed to delete secret' }, { status: 500 });
  }
}
