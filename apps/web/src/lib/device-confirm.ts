import { db } from '@buildd/core/db';
import { deviceCodes, teams, users } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { getUserDefaultTeamId } from '@/lib/team-access';

/**
 * Everything the device confirm page shows before the user approves a code.
 *
 * Invariant: a device code is approved only by an explicit confirm. This
 * module is read-only on purpose — loading the confirm page (even with the
 * code in the URL) must never change a device code's state. Approval lives
 * in POST /api/auth/device/approve and requires `confirm: true`.
 */
export type DeviceConfirmDetails = {
  userCode: string;
  clientName: string;
  level: string;
  requestedAt: string; // ISO
  expiresAt: string; // ISO
  accountEmail: string | null;
  teamName: string | null;
};

export type DeviceConfirmLookup =
  | { ok: true; details: DeviceConfirmDetails }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' };

export function normalizeUserCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function lookupDeviceCodeForConfirm(
  rawCode: string,
  userId: string,
  now: Date = new Date(),
): Promise<DeviceConfirmLookup> {
  const userCode = normalizeUserCode(rawCode);
  if (!userCode) return { ok: false, reason: 'not_found' };

  const row = await db.query.deviceCodes.findFirst({
    where: eq(deviceCodes.userCode, userCode),
    columns: { userCode: true, status: true, clientName: true, level: true, createdAt: true, expiresAt: true },
  });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') {
    return { ok: false, reason: row.status === 'expired' ? 'expired' : 'already_used' };
  }
  if (now > row.expiresAt) return { ok: false, reason: 'expired' };

  // Same team the approve route will mint the key in.
  const teamId = await getUserDefaultTeamId(userId);
  const [team, user] = await Promise.all([
    teamId ? db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { name: true } }) : null,
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { email: true } }),
  ]);

  return {
    ok: true,
    details: {
      userCode: row.userCode,
      clientName: row.clientName || 'CLI',
      level: row.level,
      requestedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      accountEmail: user?.email ?? null,
      teamName: team?.name ?? null,
    },
  };
}
