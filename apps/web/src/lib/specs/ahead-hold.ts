import { db } from '@buildd/core/db';
import { specs, tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

/**
 * The merge-to-trunk hold for work built ahead of approval (living-specs.md
 * §20, R-44). A provisional pin marks the work; this decides whether it may
 * reach trunk. A merge into a mission integration branch proceeds: the mission
 * reaches trunk through its own PR, which carries the same hold.
 */

type Pin = Record<string, unknown> | null | undefined;
export interface AheadHoldInput {
  pin: Pin;
  toMissionBranch: boolean;
  spec: { title: string; approvedRevision: number | null; headRevision: number } | null;
}
export type AheadHold = { hold: false } | { hold: true; reason: string };

export function decideAheadHold({ pin, toMissionBranch, spec }: AheadHoldInput): AheadHold {
  if (!pin || pin.provisional !== true || toMissionBranch) return { hold: false };
  const rev = typeof pin.revision === 'number' ? pin.revision : null;
  if (rev === null) return { hold: false };
  const name = spec?.title ?? 'its spec';
  const built = `built ahead of approval of ${name} rev ${rev}`;
  if (!spec) return { hold: true, reason: `${built}, and the spec could not be read; it cannot merge to trunk until its revision is approved` };
  if (spec.approvedRevision !== null && spec.approvedRevision === rev) return { hold: false };
  if (spec.approvedRevision !== null && spec.approvedRevision > rev) {
    return { hold: true, reason: `${built}; revision ${spec.approvedRevision} has since been approved. It merges once the work is re-pinned and re-graded against it` };
  }
  if (spec.headRevision > rev) {
    return { hold: true, reason: `${built}, superseded by revision ${spec.headRevision}. Re-pin it to revision ${spec.headRevision}, and it merges to trunk once a person approves that revision` };
  }
  return { hold: true, reason: `${built}; it merges to trunk once a person approves that revision (a mission branch may take it meanwhile)` };
}

/** The hold for a task's PR, from the task's pin and its spec as they stand now. */
export async function loadAheadHold(taskId: string | null, toMissionBranch: boolean): Promise<AheadHold> {
  if (!taskId || toMissionBranch) return { hold: false };
  const [t] = await db.select({ context: tasks.context }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const rawPin = (t?.context as { specSource?: unknown } | null)?.specSource;
  const pin = rawPin && typeof rawPin === 'object' ? (rawPin as Record<string, unknown>) : null;
  if (!pin || pin.provisional !== true || typeof pin.specId !== 'string') return { hold: false };
  const [spec] = await db.select({ title: specs.title, approvedRevision: specs.approvedRevision, headRevision: specs.headRevision })
    .from(specs).where(eq(specs.id, pin.specId)).limit(1);
  return decideAheadHold({ pin, toMissionBranch, spec: spec ?? null });
}
