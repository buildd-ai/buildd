/**
 * Visual review reliability (spec 072de598 I-19, AC-27): the share of missions
 * with UI work that finished visual review without a "The review is wrong or
 * stuck" Skip, over 7 and 30 days, with the causes those Skips named.
 *
 * A mission finished visual review in the window when its audit completed or a
 * person skipped it there. Skips are the `visual_review_skip` rows of the gate
 * ledger (`visual-review-skip-record.ts`); nothing new is stored. Read over MCP
 * (get_failure_analytics) and on Health, from the one function below.
 */
import { VISUAL_REVIEW_SKIP_CAUSE_TEXT, type VisualReviewSkipCause } from './visual-review-skip-record';

export interface ReliabilityInputs {
  /** Audits that completed: one row per audit task. */
  finishedAudits: ReadonlyArray<{ missionId: string; at: string }>;
  /** `visual_review_skip` gate rows. */
  skips: ReadonlyArray<{ missionId: string; at: string; skipReason: string | null; cause: string | null }>;
}

export interface ReliabilityWindow {
  days: 7 | 30;
  /** Missions that finished visual review in the window. */
  missions: number;
  /** Of those, missions with no wrong-or-stuck Skip. */
  reliable: number;
  wrongOrStuck: number;
  shipAnyway: number;
  /** reliable / missions; null with no missions. */
  share: number | null;
  /** Wrong-or-stuck causes, most frequent first (counted per Skip). */
  causes: Array<{ cause: string; text: string; count: number }>;
}

export interface VisualReviewReliability { windows: [ReliabilityWindow, ReliabilityWindow] }

const DAY_MS = 86_400_000;

function windowOf(inputs: ReliabilityInputs, days: 7 | 30, now: number): ReliabilityWindow {
  const since = now - days * DAY_MS;
  const inWindow = (at: string) => { const t = new Date(at).getTime(); return t >= since && t <= now; };
  const finished = new Set<string>();
  const wrong = new Set<string>();
  const ship = new Set<string>();
  const causes = new Map<string, number>();
  for (const a of inputs.finishedAudits) if (inWindow(a.at)) finished.add(a.missionId);
  for (const s of inputs.skips) {
    if (!inWindow(s.at)) continue;
    finished.add(s.missionId);
    if (s.skipReason === 'wrong_or_stuck') {
      wrong.add(s.missionId);
      const c = s.cause ?? 'unknown';
      causes.set(c, (causes.get(c) ?? 0) + 1);
    } else if (s.skipReason === 'ship_anyway') {
      ship.add(s.missionId);
    }
  }
  const missions = finished.size;
  const reliable = missions - wrong.size;
  return {
    days,
    missions,
    reliable,
    wrongOrStuck: wrong.size,
    shipAnyway: ship.size,
    share: missions > 0 ? reliable / missions : null,
    causes: [...causes.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([cause, count]) => ({ cause, count, text: VISUAL_REVIEW_SKIP_CAUSE_TEXT[cause as VisualReviewSkipCause] ?? cause.replace(/_/g, ' ') })),
  };
}

export function visualReviewReliability(inputs: ReliabilityInputs, now = Date.now()): VisualReviewReliability {
  return { windows: [windowOf(inputs, 7, now), windowOf(inputs, 30, now)] };
}

/** "2 of 3 missions finished visual review without a wrong-or-stuck Skip". */
export function reliabilityLine(w: ReliabilityWindow): string {
  if (w.missions === 0) return `No mission finished visual review in the last ${w.days} days.`;
  return `${w.reliable} of ${w.missions} ${w.missions === 1 ? 'mission' : 'missions'} finished visual review without a wrong-or-stuck Skip in the last ${w.days} days.`;
}

/** The readout as text, for get_failure_analytics. */
export function formatVisualReviewReliability(r: VisualReviewReliability): string {
  const lines = ['Visual review reliability'];
  for (const w of r.windows) {
    lines.push(`- ${reliabilityLine(w)}${w.shipAnyway ? ` ${w.shipAnyway} shipped anyway over open findings.` : ''}`);
    for (const c of w.causes) lines.push(`    ${c.count} × ${c.text} (cause ${c.cause})`);
  }
  return lines.join('\n');
}

/** Read both windows for these workspaces. Null when nothing could be read. */
export async function getVisualReviewReliability(workspaceIds: readonly string[], now = Date.now()): Promise<VisualReviewReliability | null> {
  if (workspaceIds.length === 0) return null;
  try {
    const [{ db }, { tasks, gateEvents }, { and, eq, gte, inArray, isNotNull, like, or }, { VISUAL_AUDITOR_ROLE_SLUG }, { GATE_SLUGS }, { SURFACE_AUDIT_TITLE_PREFIX }] = await Promise.all([
      import('@buildd/core/db'),
      import('@buildd/core/db/schema'),
      import('drizzle-orm'),
      import('@buildd/shared'),
      import('@buildd/core/gate-slugs'),
      import('@buildd/core/surface-audit'),
    ]);
    const since = new Date(now - 30 * DAY_MS);
    const [audits, skips] = await Promise.all([
      db.select({ missionId: tasks.missionId, at: tasks.updatedAt })
        .from(tasks)
        .where(and(
          inArray(tasks.workspaceId, [...workspaceIds]),
          eq(tasks.status, 'completed'),
          isNotNull(tasks.missionId),
          gte(tasks.updatedAt, since),
          or(like(tasks.title, `${SURFACE_AUDIT_TITLE_PREFIX}%`), eq(tasks.roleSlug, VISUAL_AUDITOR_ROLE_SLUG)),
        )),
      db.select({ missionId: gateEvents.missionId, at: gateEvents.occurredAt, detail: gateEvents.detail })
        .from(gateEvents)
        .where(and(
          eq(gateEvents.gate, GATE_SLUGS.VISUAL_REVIEW_SKIP),
          inArray(gateEvents.workspaceId, [...workspaceIds]),
          gte(gateEvents.occurredAt, since),
        )),
    ]);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return visualReviewReliability({
      finishedAudits: audits.filter(a => a.missionId).map(a => ({ missionId: a.missionId!, at: new Date(a.at).toISOString() })),
      skips: skips.filter(s => s.missionId).map(s => ({
        missionId: s.missionId!,
        at: new Date(s.at).toISOString(),
        skipReason: str((s.detail as Record<string, unknown> | null)?.skipReason),
        cause: str((s.detail as Record<string, unknown> | null)?.cause),
      })),
    }, now);
  } catch (err) {
    console.error('[visual-review-reliability] read failed:', err);
    return null;
  }
}
