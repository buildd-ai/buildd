import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { credentialLeases, secrets } from '@buildd/core/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';

// Lease TTL — broker must heartbeat within this window or the lease becomes stealable.
const LEASE_TTL_SECONDS = 5 * 60; // 5 minutes

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') ?? null;
  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json() as {
    credentialId?: string;
    runnerId?: string;
    action?: string;
  };

  const { credentialId, runnerId, action } = body;

  if (!credentialId || !runnerId || !action) {
    return NextResponse.json(
      { error: 'credentialId, runnerId, and action are required' },
      { status: 400 },
    );
  }

  if (!['acquire', 'heartbeat', 'release'].includes(action)) {
    return NextResponse.json(
      { error: 'action must be acquire, heartbeat, or release' },
      { status: 400 },
    );
  }

  // Verify the credential exists and belongs to this account's team.
  const credential = await db.query.secrets.findFirst({
    where: eq(secrets.id, credentialId),
    columns: { id: true, teamId: true },
  });
  if (!credential) {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
  if (credential.teamId !== account.teamId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── acquire ─────────────────────────────────────────────────────────────────
  //
  // Uses a conditional INSERT … ON CONFLICT DO UPDATE to atomically acquire or
  // steal an expired lease. The WHERE clause on the DO UPDATE ensures we only
  // overwrite when the current lease has already expired — so a live broker
  // cannot be displaced by a racing broker.
  //
  // Returns { acquired: true, leaseId } if this runner now holds the lease,
  // or { acquired: false } if another runner holds a non-expired lease.

  if (action === 'acquire') {
    const result = await db.execute(sql`
      INSERT INTO credential_leases (credential_id, held_by_runner_id, acquired_at, heartbeat_at, expires_at)
      VALUES (
        ${credentialId}::uuid,
        ${runnerId},
        NOW(),
        NOW(),
        NOW() + INTERVAL '${sql.raw(String(LEASE_TTL_SECONDS))} seconds'
      )
      ON CONFLICT (credential_id) DO UPDATE
        SET held_by_runner_id = EXCLUDED.held_by_runner_id,
            acquired_at       = NOW(),
            heartbeat_at      = NOW(),
            expires_at        = NOW() + INTERVAL '${sql.raw(String(LEASE_TTL_SECONDS))} seconds'
        WHERE credential_leases.expires_at < NOW()
      RETURNING id
    `);

    const rows = result.rows as Array<{ id: string }>;
    if (rows.length === 0) {
      return NextResponse.json({ acquired: false });
    }
    return NextResponse.json({ acquired: true, leaseId: rows[0].id });
  }

  // ── heartbeat ────────────────────────────────────────────────────────────────
  //
  // Renews the lease expiry. Returns 404 if the lease was stolen (another runner
  // acquired it after ours expired), so the broker knows to stop managing this credential.

  if (action === 'heartbeat') {
    const rows = await db
      .update(credentialLeases)
      .set({
        heartbeatAt: sql`NOW()`,
        expiresAt: sql`NOW() + INTERVAL '${sql.raw(String(LEASE_TTL_SECONDS))} seconds'`,
      })
      .where(
        and(
          eq(credentialLeases.credentialId, credentialId),
          eq(credentialLeases.heldByRunnerId, runnerId),
        ),
      )
      .returning({ id: credentialLeases.id });

    if (rows.length === 0) {
      return NextResponse.json({ ok: false, stolen: true }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  // ── release ──────────────────────────────────────────────────────────────────
  //
  // Removes the lease row. Best-effort — silently succeeds even if the lease was
  // already expired and overwritten by another runner.

  if (action === 'release') {
    await db
      .delete(credentialLeases)
      .where(
        and(
          eq(credentialLeases.credentialId, credentialId),
          eq(credentialLeases.heldByRunnerId, runnerId),
        ),
      );
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unreachable' }, { status: 500 });
}
