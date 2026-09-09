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

// Actions that operate on a specific credential and therefore must prove the
// credential belongs to the caller's team. `bootstrap` proves it differently —
// via an active credential_leases row held by the calling runner.
const TEAM_SCOPED_ACTIONS = ['lock', 'commit', 'revoke', 'release'] as const;

/**
 * How long a rotation may stay "in flight" before we treat it as lost.
 *
 * `secrets.rotationStartedAt` is stamped when a rotation begins and cleared as
 * soon as its outcome is known — success, revocation, or a provider error we
 * actually received. Still set after this long means we never learned the
 * outcome (crash, kill, timeout), so the provider may have consumed the stored
 * refresh token and issued a replacement that never reached us. For a provider
 * that rotates the refresh token on every use, the stored token is then
 * permanently dead and every later attempt is a guaranteed invalid_grant.
 *
 * Deliberately duplicated (not shared) with lib/codex-credential.ts and
 * lib/claude-credential.ts so neither module has to import the other; keep the
 * three in sync.
 */
const ROTATION_LOST_AFTER_MS = 10 * 60 * 1000; // 10 minutes

const ROTATION_LOST_ERROR =
  'A previous token rotation never completed, so the stored refresh token may already ' +
  'have been consumed and replaced. It cannot be used again — reconnect the credential.';

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

  // ── tenancy ─────────────────────────────────────────────────────────────────
  //
  // Invariant: every action on a credential must verify the credential belongs to
  // the caller's team. A valid API key is authority over that team's credentials,
  // not over an arbitrary secret id. Same check, same shape, as the sibling route
  // /api/runner/credential-lease.

  let credential:
    | {
        id: string;
        teamId: string;
        healthStatus: string;
        encryptedValue: string;
        rotationStartedAt: Date | null;
      }
    | undefined;

  if ((TEAM_SCOPED_ACTIONS as readonly string[]).includes(action)) {
    credential = await db.query.secrets.findFirst({
      where: eq(secrets.id, secretId),
      columns: {
        id: true,
        teamId: true,
        healthStatus: true,
        encryptedValue: true,
        rotationStartedAt: true,
      },
    }) as typeof credential;
    if (!credential) {
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
    }
    if (credential.teamId !== account.teamId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // ── lock ────────────────────────────────────────────────────────────────────

  if (action === 'lock') {
    const owner = credential!;

    // Fail closed on a lost rotation. Checked before the lock is claimed so the
    // answer is the same whether or not the 60-minute window happens to be open:
    // the stored refresh token is dead either way, and retrying it just burns
    // another invalid_grant against the provider.
    const rotationStartedAt = owner.rotationStartedAt;
    if (
      rotationStartedAt &&
      Date.now() - new Date(rotationStartedAt).getTime() > ROTATION_LOST_AFTER_MS
    ) {
      // healthStatus has no dedicated terminal value for this; 'revoked' is the
      // existing terminal state and is exactly what resolveCodex/ClaudeCredential
      // already skip, so reuse it rather than widening the enum.
      await db
        .update(secrets)
        .set({
          healthStatus: 'revoked',
          tokenExpiresAt: null,
          lastVerificationError: ROTATION_LOST_ERROR,
          updatedAt: sql`NOW()`,
        })
        .where(and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)));

      // rotationStartedAt is deliberately NOT cleared: it is the evidence that
      // keeps every later attempt failing closed here instead of handing the dead
      // token out again. healthStatus gates the alert to the first transition.
      if (owner.healthStatus !== 'revoked') {
        await notifyTeam(owner.teamId, 'credentialExpired', {
          title: 'Credential needs reconnecting',
          message: `${purpose} credential: ${ROTATION_LOST_ERROR}`,
          priority: 0,
        });
      }

      return NextResponse.json({ locked: false, rotationLost: true });
    }

    // Atomically claim the refresh lock. Mirrors refreshClaudeCredential/refreshCodexCredential.
    const [claimed] = await db
      .update(secrets)
      .set({
        refreshLockedAt: sql`NOW()`,
        // COALESCE, not NOW(): if an earlier rotation left this set, preserve the
        // original start time. Overwriting it would erase the only evidence that
        // the earlier rotation was never resolved.
        rotationStartedAt: sql`COALESCE(${secrets.rotationStartedAt}, NOW())`,
        updatedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(secrets.id, secretId),
          eq(secrets.purpose, purpose as AllowedPurpose),
          or(
            isNull(secrets.refreshLockedAt),
            lt(secrets.refreshLockedAt, sql`NOW() - INTERVAL '60 minutes'`),
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

    // Reuse the already-loaded row so the new tokens are merged into the existing
    // blob, preserving extra fields (e.g. account_id, id_token for codex_credential).
    const blob = JSON.parse(decrypt(credential!.encryptedValue)) as Record<string, unknown>;
    const newBlob = { ...blob, access_token: accessToken, refresh_token: refreshToken };

    await db
      .update(secrets)
      .set({
        encryptedValue: encrypt(JSON.stringify(newBlob)),
        tokenExpiresAt: expiresAt ? new Date(expiresAt) : null,
        lastVerificationError: null,
        // The rotation resolved successfully: record the success and drop the
        // in-flight marker. refreshLockedAt is intentionally left alone so the
        // 60-minute cadence still applies after a successful refresh.
        lastRefreshedAt: sql`NOW()`,
        rotationStartedAt: null,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)));

    await recordCredentialAuthSuccess(secretId);
    return NextResponse.json({ ok: true });
  }

  // ── release ──────────────────────────────────────────────────────────────────
  //
  // The counterpart to `lock`, for the one failure the caller can be certain
  // about: it took the lock but never got the request to the provider (connect
  // refused, DNS failure), so nothing was rotated. Without this the marker would
  // stay set after a runner-side network blip and the credential would be
  // declared a lost rotation an hour later — killing a working credential.
  //
  // Callers MUST NOT use this once a provider response has been seen. From there
  // on a failure is post-rotation and the marker has to survive; that is what
  // makes a genuinely lost rotation detectable.

  if (action === 'release') {
    await db
      .update(secrets)
      .set({
        // Same walk-back as the libraries' transient path: retry in ~15 minutes
        // rather than holding a dead lock for the full window.
        refreshLockedAt: sql`NOW() - INTERVAL '45 minutes'`,
        rotationStartedAt: null,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)));

    // Deliberately no health transition: an unused lock is neither a successful
    // refresh nor an auth failure, and recording either would corrupt the signal.
    return NextResponse.json({ ok: true });
  }

  // ── revoke ───────────────────────────────────────────────────────────────────

  if (action === 'revoke') {
    const wasRevoked = credential!.healthStatus === 'revoked';

    // Track consecutive failures via the health state machine.
    await recordCredentialAuthFailure(secretId, reason);

    // Explicitly force final state regardless of failure severity classification.
    await db
      .update(secrets)
      .set({
        healthStatus: 'revoked',
        tokenExpiresAt: null,
        lastVerificationError: reason,
        // The rotation's outcome is known (terminal), so it is not a lost one.
        rotationStartedAt: null,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)));

    // Alert the team only on the first revocation transition.
    if (!wasRevoked) {
      await notifyTeam(credential!.teamId, 'credentialExpired', {
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

    const bootstrapped = await db.query.secrets.findFirst({
      where: and(eq(secrets.id, secretId), eq(secrets.purpose, purpose as AllowedPurpose)),
      columns: { encryptedValue: true, tokenExpiresAt: true },
    });
    if (!bootstrapped) {
      return NextResponse.json({ error: 'Secret not found' }, { status: 404 });
    }

    const blob = JSON.parse(decrypt(bootstrapped.encryptedValue)) as Record<string, unknown>;
    return NextResponse.json({
      accessToken: typeof blob.access_token === 'string' ? blob.access_token : null,
      refreshToken: typeof blob.refresh_token === 'string' ? blob.refresh_token : null,
      expiresAt: bootstrapped.tokenExpiresAt ? (bootstrapped.tokenExpiresAt as Date).toISOString() : null,
    });
  }

  return NextResponse.json(
    { error: 'Invalid action. Must be lock, commit, release, revoke, or bootstrap' },
    { status: 400 },
  );
}
