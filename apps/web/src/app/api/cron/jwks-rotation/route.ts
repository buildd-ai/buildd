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
import { generateSigningKeypair, makeKid, type KeyPairJwk } from '@/lib/signing-keys';
import { reportOps } from '@buildd/core/report-ops';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import {
  ACTIVE_MAX_AGE_MS,
  RETIRING_WINDOW_MS,
  RETIRING_WINDOW_FORCE_MS,
} from '@/lib/signing-key-windows';

function getSigningKeyTeamId(): string {
  const teamId = process.env.BUILDD_SIGNING_KEY_TEAM_ID;
  if (!teamId) throw new Error('BUILDD_SIGNING_KEY_TEAM_ID not configured');
  return teamId;
}

export const maxDuration = 60;

async function rotate(req: NextRequest, report: CronReport) {
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

  const ageDays = activeKey
    ? Math.floor((now.getTime() - activeKey.createdAt.getTime()) / 86_400_000)
    : null;

  const result = {
    rotated,
    newKid,
    activeKeyAgeDays: ageDays,
    deletedExpiredKeys: deleted,
    activeKid: rotated ? newKid : (activeKey?.label ?? null),
    liveKeyCount: liveKeys.length + (rotated ? 1 : 0) - deleted,
  };
  // Most runs correctly rotate nothing — the key is not old enough yet — so
  // `changed: 0` here is the healthy case and must not read as failure. Only a
  // run that errors AND changes nothing is a problem.
  report({ processed: liveKeys.length, changed: (rotated ? 1 : 0) + deleted, errors: 0, result });
  return NextResponse.json(result);
}

/**
 * A rotation failure must be audible.
 *
 * This route was staged dark from the day it shipped, so signing keys never
 * rotated and nothing anywhere said so. Now that it fires weekly, the next
 * version of that failure is a rotation that runs and throws — a 500 into a
 * cron provider's log that nobody reads. Turn it into an ops alert.
 *
 * Severity is `critical`: keys that stop rotating fail silently for weeks and
 * the symptom only appears when a verifier rejects an assertion, long after
 * the cause.
 */
export async function GET(req: NextRequest) {
  return withCronRun('jwks-rotation', req, report => runCronJob(req, report));
}

async function runCronJob(req: NextRequest, report: CronReport): Promise<NextResponse> {
  try {
    return await rotate(req, report);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await reportOps({
      source: 'jwks-rotation',
      message: 'signing key rotation failed',
      severity: 'critical',
      detail,
    }).catch(() => {});
    console.error('[JWKSRotation] failed:', detail);
    return NextResponse.json({ error: 'rotation failed', detail }, { status: 500 });
  }
}

/**
 * The design doc (§B.3) describes forced rotation as POST, and a state-changing
 * call should not be a GET. But the external scheduler can only issue GET, so
 * GET stays for the weekly tick and POST is accepted for the operator path —
 * same handler, same Bearer auth.
 */
export const POST = GET;
