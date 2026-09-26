import { db } from '@buildd/core/db';
import { teamMembers } from '@buildd/core/db/schema';
import { and, eq } from 'drizzle-orm';
import { INITIATIVE_STATUSES, isInitiativeStatus, type InitiativeStatus } from './initiative-view';

/**
 * Validation for the human-set initiative fields, shared by POST
 * /api/initiatives and PATCH /api/initiatives/[id] so the two accept exactly
 * the same values.
 */
export type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseInitiativeStatus(value: unknown): FieldResult<InitiativeStatus> {
  return isInitiativeStatus(value)
    ? { ok: true, value }
    : { ok: false, error: `Invalid status: must be one of ${INITIATIVE_STATUSES.join(', ')}` };
}

/** 'YYYY-MM-DD' naming a real calendar day, or null to clear. */
export function parseTargetDate(value: unknown): FieldResult<string | null> {
  if (value === null || value === '') return { ok: true, value: null };
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value) return { ok: true, value };
  }
  return { ok: false, error: 'targetDate must be a calendar date (YYYY-MM-DD) or null' };
}

/** A user on the initiative's team, or null to fall back to the creator. */
export async function parseOwnerUserId(value: unknown, teamId: string): Promise<FieldResult<string | null>> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: 'ownerUserId must be a user id or null' };
  const member = await db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, value)),
    columns: { userId: true },
  });
  return member ? { ok: true, value } : { ok: false, error: "ownerUserId must be a member of the initiative's team" };
}
