// Cron endpoint: GET /api/cron/lease-expiry-guard
//
// Detects credential leases that have expired without renewal — a signal that the runner
// holding the lease died or the broker crashed without restarting within the 5-minute TTL.
//
// For each expired lease:
//   1. Alerts the team via notifyTeam (credentialExpired event).
//   2. If BUILDD_ALLOW_CONTROL_PLANE_REFRESH=true: attempts a one-shot control-plane refresh
//      as a fallback to keep the credential alive during the outage. This is OFF by default
//      because Vercel's rotating egress IP is the root cause of invalid_grant revocations —
//      the same tradeoff documented in the Phase 1 runner-offline guard. Only enable if the
//      runner is persistently offline and you accept the revocation risk.
//   3. Deletes the expired lease row so the alert fires only once per expiry and a runner that
//      comes back online can re-acquire the credential normally.
//
// Auth: Bearer CRON_SECRET. The only accepted credential.
//
// Two triggers, both in cron-manifest.json (see lib/cron-due-queue.ts):
//   - `?gate=due` every 5 minutes — reads the Redis due-queue and returns
//     without touching Postgres unless a lease has actually lapsed. A 5-minute
//     lease TTL renewed every 60s deserves minute-scale detection, and this is
//     how it gets it without keeping Neon's compute awake all day.
//   - no param, hourly — the unconditional floor tick. Queries regardless and
//     re-seeds the due-queue from the table, so a dropped write costs an hour
//     of latency instead of a permanently missed alert.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { credentialLeases } from '@buildd/core/db/schema';
import { eq, lt, sql } from 'drizzle-orm';
import { refreshClaudeCredential } from '@/lib/claude-credential';
import { refreshCodexCredential } from '@/lib/codex-credential';
import { notifyTeam } from '@/lib/notify';
import { gateOnDueQueue } from '@/lib/cron-due-queue';
import { reseedDue } from '@/lib/redis';
import { LEASE_DUE_QUEUE } from '@/lib/lease-due-queue';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const gate = await gateOnDueQueue(LEASE_DUE_QUEUE, req.nextUrl.searchParams);
  if (!gate.proceed) {
    return NextResponse.json({ checked: 0, alerted: 0, gated: true, reason: gate.reason });
  }

  const ALLOW_CONTROL_PLANE_REFRESH = process.env.BUILDD_ALLOW_CONTROL_PLANE_REFRESH === 'true';

  // Find all leases whose TTL has lapsed — the runner stopped heartbeating.
  const expiredLeases = await db.query.credentialLeases.findMany({
    where: lt(credentialLeases.expiresAt, sql`NOW()`),
    with: {
      credential: {
        columns: { id: true, teamId: true, purpose: true },
      },
    },
  });

  let alerted = 0;
  let refreshed = 0;
  let refreshErrors = 0;
  const details: Record<string, { runnerId: string; purpose: string; refreshOutcome?: string }> = {};

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';

  for (const lease of expiredLeases) {
    const { credential } = lease;
    if (!credential) continue;

    const purpose = credential.purpose as 'claude_credential' | 'codex_credential';
    let refreshOutcome: string | undefined;

    // Optional one-shot fallback: attempt a direct token-endpoint call from Vercel.
    // BUILDD_ALLOW_CONTROL_PLANE_REFRESH must be explicitly set — see the IP-mismatch
    // tradeoff documented at the top of this file.
    if (ALLOW_CONTROL_PLANE_REFRESH && (purpose === 'claude_credential' || purpose === 'codex_credential')) {
      const result = purpose === 'claude_credential'
        ? await refreshClaudeCredential(credential.id)
        : await refreshCodexCredential(credential.id);
      refreshOutcome = result;
      if (result === 'refreshed') {
        refreshed++;
      } else {
        refreshErrors++;
      }
    }

    // Notify the team regardless of whether the fallback refresh succeeded — the runner dying
    // is a structural event that warrants human awareness.
    const fallbackNote = ALLOW_CONTROL_PLANE_REFRESH
      ? `A one-shot control-plane refresh was attempted (outcome: ${refreshOutcome ?? 'n/a'}).`
      : 'No fallback refresh was attempted (BUILDD_ALLOW_CONTROL_PLANE_REFRESH is off).';

    await notifyTeam(credential.teamId, 'credentialExpired', {
      title: 'Credential lease expired — runner may be down',
      message: `The broker lease for a ${purpose} credential expired without renewal (runner: ${lease.heldByRunnerId}). The runner may have crashed. ${fallbackNote}`,
      url: `${appUrl}/app/settings`,
      urlTitle: 'Open settings',
      priority: 0,
    }).catch(err => console.error('[lease-expiry-guard] notify failed:', err));
    alerted++;

    details[credential.id] = {
      runnerId: lease.heldByRunnerId,
      purpose,
      ...(refreshOutcome !== undefined ? { refreshOutcome } : {}),
    };

    // Delete the expired lease so we don't alert again on the next cron tick.
    // A runner that restarts will re-acquire via the conditional INSERT in the lease endpoint.
    await db.delete(credentialLeases).where(eq(credentialLeases.id, lease.id));
  }

  // Floor tick only: rebuild the due-queue from the rows that survive, so a
  // write lost by the lease endpoint (Redis blip, half-configured client) is
  // healed within one floor interval. Runs after the deletes above, so expired
  // rows we just handled are not re-published.
  if (gate.reseed) {
    const live = await db.query.credentialLeases.findMany({
      columns: { credentialId: true, expiresAt: true },
    });
    // A non-finite score would be rejected by Redis and take the whole reseed
    // with it, so drop unparseable rows rather than poison the set.
    const entries = live
      .map(l => ({ member: l.credentialId, dueAtMs: new Date(l.expiresAt).getTime() }))
      .filter(e => Number.isFinite(e.dueAtMs));
    await reseedDue(LEASE_DUE_QUEUE, entries);
  }

  console.log(
    `[Cron] lease-expiry-guard: checked=${expiredLeases.length} alerted=${alerted}` +
    ` gate=${gate.reason}` +
    (ALLOW_CONTROL_PLANE_REFRESH ? ` refreshed=${refreshed} refreshErrors=${refreshErrors}` : ''),
  );

  return NextResponse.json({
    checked: expiredLeases.length,
    alerted,
    gate: gate.reason,
    ...(ALLOW_CONTROL_PLANE_REFRESH ? { refreshed, refreshErrors } : {}),
    details,
  });
}
