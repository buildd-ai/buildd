/**
 * Advisory file reservations — prevents concurrent workers from editing the same files.
 *
 * This is advisory only: if the reservation system is unavailable (DB error, etc.),
 * workers should still proceed. The PreToolUse hook uses this to warn/deny when
 * another worker holds a reservation on a file path.
 */
import { db } from './db/client';
import { fileReservations } from './db/schema';
import { eq, and, gt, ne } from 'drizzle-orm';

const RESERVATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ReservationCheck {
  reserved: boolean;
  holderId?: string;
}

/**
 * Check if a file is reserved by another worker (ignoring expired reservations).
 * Returns { reserved: false } if unreserved or reserved by the same worker.
 */
export async function checkReservation(
  workspaceId: string,
  filePath: string,
  currentWorkerId: string,
): Promise<ReservationCheck> {
  const now = new Date();

  const existing = await db.query.fileReservations.findFirst({
    where: and(
      eq(fileReservations.workspaceId, workspaceId),
      eq(fileReservations.filePath, filePath),
      gt(fileReservations.expiresAt, now),
      ne(fileReservations.workerId, currentWorkerId),
    ),
  });

  if (existing) {
    return { reserved: true, holderId: existing.workerId };
  }
  return { reserved: false };
}

/**
 * Acquire or refresh a reservation on a file path.
 * If an expired reservation exists, it's replaced. If the current worker already
 * holds it, the TTL is refreshed.
 *
 * Uses DELETE-then-INSERT to handle the unique constraint on (workspaceId, filePath).
 * Returns true if acquired, false if held by another worker.
 */
export async function acquireReservation(
  workspaceId: string,
  filePath: string,
  workerId: string,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);

  // First check if another worker holds an active reservation
  const check = await checkReservation(workspaceId, filePath, workerId);
  if (check.reserved) {
    return false;
  }

  // Delete any existing reservation (expired or our own) and insert fresh
  await db.delete(fileReservations).where(
    and(
      eq(fileReservations.workspaceId, workspaceId),
      eq(fileReservations.filePath, filePath),
    ),
  );

  await db.insert(fileReservations).values({
    workspaceId,
    workerId,
    filePath,
    acquiredAt: now,
    expiresAt,
  });

  return true;
}

/**
 * Release all reservations held by a specific worker.
 * Called on worker completion, error, or cancellation.
 */
export async function releaseWorkerReservations(workerId: string): Promise<void> {
  await db.delete(fileReservations).where(
    eq(fileReservations.workerId, workerId),
  );
}
