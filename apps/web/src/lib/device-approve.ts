/**
 * Approving a device code with the workspaces the person picked (spec "One
 * runner for every team you run", R-1). Shared by the runner consent page for
 * `buildd login --device` (/api/auth/device/consent) and the JSON approve
 * endpoint (/api/auth/device/approve).
 *
 * Invariant kept from before: a device code is approved only by an explicit
 * act of the signed-in person, and approving never rotates or returns an
 * existing account's key.
 */
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { deviceCodes } from '@buildd/core/db/schema';
import { parseKeyLevel } from './key-level-policy';
import { mintRunnerKey } from './runner-picks';
import { trackEvent } from './axiom';

export type DeviceApproveResult =
  | { ok: true; accountId: string; level: string; teamId: string }
  | { ok: false; status: 400 | 403 | 500; message: string };

/** A refused pick hands the code back (pending), so the person can pick again. */
export async function approveDeviceCode(args: {
  userId: string;
  code: string;
  workspaceIds: unknown;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<DeviceApproveResult> {
  const normalizedCode = args.code.trim().toUpperCase();

  // Atomic update: find pending, non-expired device code and approve it
  const [updated] = await db
    .update(deviceCodes)
    .set({ status: 'approved', userId: args.userId })
    .where(and(
      eq(deviceCodes.userCode, normalizedCode),
      eq(deviceCodes.status, 'pending'),
      gt(deviceCodes.expiresAt, new Date()),
    ))
    .returning();
  if (!updated) return { ok: false, status: 400, message: 'Invalid or expired code. Check the code and try again.' };

  // Race guard: expired between the read and the write.
  if (new Date() > updated.expiresAt) {
    await db.update(deviceCodes).set({ status: 'expired' }).where(eq(deviceCodes.id, updated.id));
    return { ok: false, status: 400, message: 'Code has expired' };
  }

  const accountName = updated.clientName || 'CLI';
  const minted = await mintRunnerKey({
    userId: args.userId,
    workspaceIds: args.workspaceIds,
    name: accountName,
    requestedLevel: parseKeyLevel(updated.level) || 'worker',
  });
  if (!minted.ok) {
    // Hand the code back so the person can pick again from the same terminal.
    await db.update(deviceCodes).set({ status: 'pending', userId: null }).where(eq(deviceCodes.id, updated.id));
    return minted.status === 500 ? minted : { ok: false, status: minted.status, message: minted.message };
  }

  // Store plaintext in device code record for CLI to retrieve
  await db.update(deviceCodes).set({ apiKey: minted.plaintextKey }).where(eq(deviceCodes.id, updated.id));

  const audit = {
    deviceCodeId: updated.id,
    userId: args.userId,
    teamId: minted.teamId,
    accountId: minted.accountId,
    clientName: accountName,
    level: minted.level,
    workspaceCount: minted.workspaceIds.length,
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
  };
  console.info('[device-approve]', JSON.stringify(audit));
  trackEvent('api.auth.device.approve', audit);
  return { ok: true, accountId: minted.accountId, level: minted.level, teamId: minted.teamId };
}
