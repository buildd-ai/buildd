import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets, credentialLeases } from '@buildd/core/db/schema';
import { encrypt, decrypt } from '@buildd/core/secrets';
import { eq, and, or, isNull, lt, gt, sql } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';
import { recordCredentialAuthSuccess, recordCredentialAuthFailure } from '@/lib/credential-health';
import { notifyTeam } from '@/lib/notify';

const ALLOWED_PURPOSES = ['claude_credential', 'codex_credential'] as const;
type AllowedPurpose = (typeof ALLOWED_PURPOSES)[number];

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') ?? null;
  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json() as {
    secretId?: string;
    action?: string;
    purpose?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    reason?: string;
    runnerId?: string;
  };

  const { secretId, action, purpose, accessToken, refreshToken, expiresAt } = body;
  const reason = body.reason ?? 'Revoked by runner';

  if (!ALLOWED_PURPOSES.includes(purpose as AllowedPurpose)) {
    return NextResponse.json(
      { error: `Invalid purpose. Must be one of: ${ALLOWED_PURPOSES.join(', ')}` },
      { status: 400 },
    );
  }

  if (!secretId || !action) {
    return NextResponse.json({ error: 'secretId and action are required' }, { status: 400 });
  }

  // ── lock ────────────────────────────────────────────────────────────────────

  if (action === 'lock') {
    // Atomically claim the refresh lock. Mirrors refreshClaudeCredential/refreshCodexCredential.
    const [claimed] = await db
      .update(secrets)
      .set({ lastRefreshedAt: sql`NOW()`, updatedAt: sql`NOW()` })
      .where(
        and(
          eq(secrets.id, secretId),
          eq(secrets.purpose, purpose as AllowedPurpose),
          or(
            isNull(secrets.lastRefreshedAt),
            lt(secrets.lastRefreshedAt, sql`NOW() - INTERVAL '60 minutes'`),
          ),
        ),
      )
      .returning();

    if (!claimed) {
      return NextResponse.json({ locked: false });
    }

    const blob = JSON.parse(decrypt(claimed.encryptedValue)) as Record<string, unknown>;
    return NextResponse.json({
      locked: true,
      refreshToken: typeof blob.refresh_token === 'string' ? blob.refresh_token : null,
      expiresAt: claimed.tokenExpiresAt ? (claimed.tokenExpiresAt as Date).toISOString() : null,
    });
  }

  // ── commit ───────────────────────────────────────────────────────────────────

  if (action === 'commit') {
    if (!accessToken || !refreshToken) {
      return NextResponse.json(
        { error: 'accessToken and refreshToken are required for commit' },
        { status: 400 },
      );
    }

    // Read existing blob to preserve extra fields (e.g. account_id, id_token for codex_credential).
    const existing = await db.query.secrets.findFirst({
      where: and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)),
      columns: { encryptedValue: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 });
    }

    const blob = JSON.parse(decrypt(existing.encryptedValue)) as Record<string, unknown>;
    const newBlob = { ...blob, access_token: accessToken, refresh_token: refreshToken };

    await db
      .update(secrets)
      .set({
        encryptedValue: encrypt(JSON.stringify(newBlob)),
        tokenExpiresAt: expiresAt ? new Date(expiresAt) : null,
        lastVerificationError: null,
        lastRefreshedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)));

    await recordCredentialAuthSuccess(secretId);
    return NextResponse.json({ ok: true });
  }

  // ── revoke ───────────────────────────────────────────────────────────────────

  if (action === 'revoke') {
    const existing = await db.query.secrets.findFirst({
      where: and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)),
      columns: { healthStatus: true, teamId: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 });
    }

    const wasRevoked = existing.healthStatus === 'revoked';

    // Track consecutive failures via the health state machine.
    await recordCredentialAuthFailure(secretId, reason);

    // Explicitly force final state regardless of failure severity classification.
    await db
      .update(secrets)
      .set({
        healthStatus: 'revoked',
        tokenExpiresAt: null,
        lastVerificationError: reason,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)));

    // Alert the team only on the first revocation transition.
    if (!wasRevoked) {
      await notifyTeam(existing.teamId, 'credentialExpired', {
        title: 'Credential revoked',
        message: `${purpose} credential was revoked: ${reason}`,
        priority: 0,
      });
    }

    return NextResponse.json({ ok: true });
  }

  // ── bootstrap ─────────────────────────────────────────────────────────────────
  //
  // Called by the broker after acquiring a Postgres lease to pull the current
  // credential into its in-memory cache. Only the runner that holds the active
  // lease may call this — the runnerId is checked against credential_leases.

  if (action === 'bootstrap') {
    const { runnerId } = body;
    if (!runnerId) {
      return NextResponse.json({ error: 'runnerId is required for bootstrap' }, { status: 400 });
    }

    const lease = await db.query.credentialLeases.findFirst({
      where: and(
        eq(credentialLeases.credentialId, secretId),
        eq(credentialLeases.heldByRunnerId, runnerId),
        gt(credentialLeases.expiresAt, sql`NOW()`),
      ),
      columns: { id: true },
    });
    if (!lease) {
      return NextResponse.json(
        { error: 'Forbidden: runner does not hold the active lease' },
        { status: 403 },
      );
    }

    const credential = await db.query.secrets.findFirst({
      where: and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)),
      columns: { encryptedValue: true, tokenExpiresAt: true },
    });
    if (!credential) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 });
    }

    const blob = JSON.parse(decrypt(credential.encryptedValue)) as Record<string, unknown>;
    return NextResponse.json({
      accessToken: typeof blob.access_token === 'string' ? blob.access_token : null,
      refreshToken: typeof blob.refresh_token === 'string' ? blob.refresh_token : null,
      expiresAt: credential.tokenExpiresAt ? (credential.tokenExpiresAt as Date).toISOString() : null,
    });
  }

  return NextResponse.json({ error: 'Invalid action. Must be lock, commit, revoke, or bootstrap' }, { status: 400 });
}
