/**
 * The system's own "this change has no visual impact" decision, logged as a
 * mission note so it survives a reload and reads apart from a person's waiver
 * (which is `Surface audit waived`, authored by a user). One line per head
 * commit; a new head is a new decision.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { missionNotes } from '@buildd/core/db/schema';
import { postMissionFeedEvent, systemActor } from '@/lib/mission-feed';
import type { AutoImpactDecision } from './visual-review-state';

export const AUTO_DECISION_NOTE_TITLE = 'Visual review not needed';

export function formatAutoDecisionBody(basis: AutoImpactDecision['basis'], headSha: string | null): string {
  return `basis: ${basis}\nhead: ${headSha ?? 'unknown'}`;
}

export function parseAutoDecisionBody(body: string | null | undefined): { basis: AutoImpactDecision['basis']; headSha: string | null } | null {
  const basis = /^basis: (rule|model|policy)$/m.exec(body ?? '')?.[1] as AutoImpactDecision['basis'] | undefined;
  if (!basis) return null;
  const head = /^head: ([0-9a-f]{7,40})$/m.exec(body ?? '')?.[1];
  return { basis, headSha: head ?? null };
}

/** Record a no-impact decision once per head. Never throws: a failed log must not stall the scheduler. */
export async function logAutoImpactDecision(missionId: string, basis: AutoImpactDecision['basis'], headSha: string | null): Promise<void> {
  try {
    const prior = await loadAutoImpactDecision(missionId);
    if (prior && prior.headSha === headSha && prior.basis === basis) return;
    await postMissionFeedEvent({
      missionId,
      type: 'update',
      title: AUTO_DECISION_NOTE_TITLE,
      body: formatAutoDecisionBody(basis, headSha),
      actor: systemActor('visual-impact'),
    });
  } catch (err) {
    console.error('[visual-review] could not log the no-impact decision:', err);
  }
}

export async function loadAutoImpactDecision(missionId: string): Promise<AutoImpactDecision | null> {
  const [row] = await db.query.missionNotes.findMany({
    where: and(eq(missionNotes.missionId, missionId), eq(missionNotes.title, AUTO_DECISION_NOTE_TITLE), eq(missionNotes.authorType, 'system')),
    columns: { body: true, createdAt: true },
    orderBy: [desc(missionNotes.createdAt)],
    limit: 1,
  });
  const parsed = row ? parseAutoDecisionBody(row.body) : null;
  return row && parsed ? { ...parsed, at: new Date(row.createdAt).toISOString() } : null;
}
