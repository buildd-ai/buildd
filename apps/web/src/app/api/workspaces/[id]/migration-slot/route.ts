/**
 * POST /api/workspaces/[id]/migration-slot
 *
 * Atomically reserves the next Drizzle migration number for a workspace.
 * Two concurrent callers always get distinct numbers, preventing the
 * "0106_foo.sql and 0106_bar.sql both generated on different branches" collision.
 *
 * Auth: API key (worker or admin token).
 *
 * Body: { currentMax?: number }
 *   currentMax — the highest migration number the caller sees in the git journal.
 *   If the DB counter is lower than currentMax, it is bootstrapped to currentMax
 *   first (handles first-call bootstrap and repos that advanced without using this API).
 *
 * Response: { nextNumber: number, formatted: string }
 *   nextNumber  — integer to use for the new migration (e.g. 106)
 *   formatted   — zero-padded string (e.g. "0106")
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { authenticateApiKey } from '@/lib/api-auth';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '') || null;

  const account = await authenticateApiKey(apiKey);
  if (!account) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const currentMax: number | undefined =
      typeof body?.currentMax === 'number' ? Math.max(0, Math.floor(body.currentMax)) : undefined;

    // Atomically increment the counter. If the caller reports a currentMax that
    // exceeds the stored counter, bootstrap the counter to currentMax first so the
    // returned number is always > currentMax (handles initial bootstrap + repos
    // that advanced without using this API).
    //
    // Using a raw SQL expression with GREATEST(...) + 1 makes the whole operation
    // a single UPDATE — no separate SELECT + compare, race-safe under concurrent calls.
    const bootstrapFloor = currentMax !== undefined ? currentMax : 0;

    const [updated] = await db
      .update(workspaces)
      .set({
        lastMigrationNumber: sql`GREATEST(${workspaces.lastMigrationNumber}, ${bootstrapFloor}) + 1`,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId))
      .returning({ nextNumber: workspaces.lastMigrationNumber });

    if (!updated) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const nextNumber = updated.nextNumber;
    const formatted = String(nextNumber).padStart(4, '0');

    return NextResponse.json({ nextNumber, formatted });
  } catch (error) {
    console.error('[migration-slot] Failed to reserve slot:', error);
    return NextResponse.json({ error: 'Failed to reserve migration slot' }, { status: 500 });
  }
}
