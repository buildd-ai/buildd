// GET /api/cron/jwks-rotation
//
// Weekly signing key rotation per spec §B.3:
//   1. Query all purpose='signing_key' rows.
//   2. If Active key age > 30d, generate a new keypair + insert as Active.
//   3. Move the old Active key to Retiring: tokenExpiresAt = NOW() + 10d.
//   4. Delete any key whose tokenExpiresAt < NOW() (Retiring window expired).
//   5. At most 2 keys in JWKS at any time.
//
// Forced rotation (?force=true, admin auth):
//   Sets the old Active key's tokenExpiresAt = NOW() + 10min instead of 10d,
//   making it absent from JWKS within minutes (immediate revocation path).
//
// Auth: Bearer token matching CRON_SECRET env var.
// Recommended schedule: weekly (every 7 days).

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { secrets } from '@buildd/core/db/schema';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { getSecretsProvider } from '@buildd/core/secrets';
import { generateSigningKeypair, type KeyPairJwk } from '@/lib/signing-keys';

function getSigningKeyTeamId(): string {
  const teamId = process.env.BUILDD_SIGNING_KEY_TEAM_ID;
  if (!teamId) throw new Error('BUILDD_SIGNING_KEY_TEAM_ID not configured');
  return teamId;
}

export const maxDuration = 60;

const ACTIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RETIRING_WINDOW_MS = 10 * 24 * 60 * 60 * 1000; // 10 days
const RETIRING_WINDOW_FORCE_MS = 10 * 60 * 1000;     // 10 minutes (forced revocation)

function makeKid(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `buildd-${y}-${m}`;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const force = req.nextUrl.searchParams.get('force') === 'true';
  const now = new Date();

  // ── Step 1: Query all signing key rows ─────────────────────────────────────
  const allKeys = await db.query.secrets.findMany({
    where: eq(secrets.purpose, 'signing_key'),
    columns: { id: true, label: true, tokenExpiresAt: true, createdAt: true },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  // ── Step 4: Delete expired Retiring keys (tokenExpiresAt < NOW()) ──────────
  let deleted = 0;
  for (const key of allKeys) {
    if (key.tokenExpiresAt && key.tokenExpiresAt < now) {
      const provider = getSecretsProvider();
      await provider.delete(key.id);
      deleted++;
    }
  }

  // Refresh list after deletions
  const liveKeys = allKeys.filter(k => !k.tokenExpiresAt || k.tokenExpiresAt >= now);
  const activeKey = liveKeys.find(k => k.tokenExpiresAt === null);

  // ── Step 2–3: Rotate if Active key is too old (or force=true) ────────────
  let rotated = false;
  let newKid: string | null = null;

  const shouldRotate = force || !activeKey ||
    (now.getTime() - activeKey.createdAt.getTime() > ACTIVE_MAX_AGE_MS);

  if (shouldRotate && activeKey) {
    const retireWindow = force ? RETIRING_WINDOW_FORCE_MS : RETIRING_WINDOW_MS;
    const retireAt = new Date(now.getTime() + retireWindow);

    // Generate new Active key
    newKid = makeKid(now);
    const kp: KeyPairJwk = await generateSigningKeypair(newKid);
    const provider = getSecretsProvider();
    await provider.set(null, JSON.stringify(kp), {
      teamId: getSigningKeyTeamId(),
      purpose: 'signing_key',
      label: newKid,
    });

    // Move old Active → Retiring
    await db.update(secrets)
      .set({ tokenExpiresAt: retireAt, updatedAt: now })
      .where(eq(secrets.id, activeKey.id));

    rotated = true;
    console.log(`[JWKSRotation] Rotated: new=${newKid}, old=${activeKey.label} retiring until ${retireAt.toISOString()}${force ? ' (FORCED)' : ''}`);
  } else if (shouldRotate && !activeKey) {
    // Bootstrap: no Active key exists
    newKid = makeKid(now);
    const kp: KeyPairJwk = await generateSigningKeypair(newKid);
    const provider = getSecretsProvider();
    await provider.set(null, JSON.stringify(kp), {
      teamId: getSigningKeyTeamId(),
      purpose: 'signing_key',
      label: newKid,
    });
    rotated = true;
    console.log(`[JWKSRotation] Bootstrap: created new Active key ${newKid}`);
  }

  return NextResponse.json({
    rotated,
    newKid,
    deletedExpiredKeys: deleted,
    activeKid: rotated ? newKid : (activeKey?.label ?? null),
    liveKeyCount: liveKeys.length + (rotated ? 1 : 0) - deleted,
  });
}
