/**
 * Findings the automatic fix rounds did not settle (spec 072de598 AC-14, AC-33).
 * Under policy `automatic` they stop blocking the mission PR, so nothing may
 * let them vanish: each screen is filed as a `[surface fix]` task against
 * trunk (no mission, the mission has merged), and the completion record lists
 * them. Filing is idempotent per mission and screen.
 */
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { surfaceFixTitle } from '@buildd/core/surface-audit';
import type { VisualReviewExhaustedFinding } from '@buildd/shared';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { loadVisualReview } from '@/lib/visual-review-load';

const TITLE_MAX = 200;
const VIEWPORT_WORD = { mobile: 'phone', desktop: 'desktop' } as const;
const oneLine = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export interface ExhaustedFixDraft {
  /** The screen's cell key: the idempotency key with the mission id. */
  key: string;
  route: string;
  title: string;
  description: string;
  artifactIds: string[];
}

/** One draft per route: a route's phone and desktop findings are one fix. Pure. */
export function planExhaustedFixes(missionId: string, findings: readonly VisualReviewExhaustedFinding[]): ExhaustedFixDraft[] {
  const byRoute = new Map<string, VisualReviewExhaustedFinding[]>();
  for (const f of findings) byRoute.set(f.route, [...(byRoute.get(f.route) ?? []), f]);
  return [...byRoute.entries()].map(([route, group]) => {
    const text = oneLine(group[0].finding) || 'the automatic fixes did not settle this screen';
    const title = surfaceFixTitle(route, text);
    return {
      key: route,
      route,
      title: title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 3).trimEnd()}...`,
      artifactIds: group.map(f => f.artifactId),
      description: [
        `Left open by mission ${missionId.slice(0, 8)}'s visual review: the automatic fix rounds ran out and \`${route}\` still looked wrong when its PR merged.`,
        '',
        ...group.map(f => `- ${VIEWPORT_WORD[f.viewport]}${f.variant ? ` (${f.variant})` : ''}, artifact ${f.artifactId}: ${oneLine(f.finding) || '(no finding)'}`),
        '',
        `Fix \`${route}\` at the viewports above.`,
      ].join('\n'),
    };
  });
}

export interface ExhaustedFollowUp { id: string; title: string; status: string }

const fromMission = (missionId: string) =>
  sql`${tasks.context} -> 'surfaceFix' ->> 'exhaustedFromMission' = ${missionId}`;

/** The follow-up tasks already filed for a mission: the completion record's list. */
export async function listExhaustedFollowUps(missionId: string): Promise<ExhaustedFollowUp[]> {
  const rows = await db.select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks).where(fromMission(missionId)) as Array<{ id: string; title: string; status: string }>;
  return rows;
}

/**
 * File the mission's exhausted findings as `[surface fix]` tasks against trunk.
 * Best-effort and idempotent: a route that already has a follow-up is skipped.
 * Returns the tasks filed by this call.
 */
export async function fileExhaustedFindings(
  mission: { id: string; workspaceId: string | null },
): Promise<ExhaustedFollowUp[]> {
  if (!mission.workspaceId) return [];
  const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, mission.workspaceId)) });
  if (!workspace) return [];
  const model = await loadVisualReview(mission);
  const drafts = planExhaustedFixes(mission.id, model.exhaustedFindings ?? []);
  if (drafts.length === 0) return [];
  const existing = await db.select({ context: tasks.context }).from(tasks)
    .where(and(fromMission(mission.id), isNull(tasks.missionId))) as Array<{ context: { surfaceFix?: { route?: string } } | null }>;
  const done = new Set(existing.map(r => r.context?.surfaceFix?.route));
  const filed: ExhaustedFollowUp[] = [];
  for (const d of drafts) {
    if (done.has(d.route)) continue;
    const [task] = await db.insert(tasks).values({
      workspaceId: mission.workspaceId,
      title: d.title,
      description: d.description,
      taskClass: 'work',
      kind: 'engineering',
      creationSource: 'orchestrator',
      context: { surfaceFix: { origin: 'exhausted', exhaustedFromMission: mission.id, route: d.route, artifactIds: d.artifactIds } },
    }).returning() as Array<{ id: string; title: string; status: string; workspaceId: string; description: string | null }>;
    filed.push({ id: task.id, title: task.title, status: task.status });
    await announceTaskCreated(task as Parameters<typeof announceTaskCreated>[0], workspace as Parameters<typeof announceTaskCreated>[1]).catch(err => console.error('[visual-review] follow-up dispatch failed:', err));
    await wakeTask(task.id, 'task.created').catch(() => {});
  }
  return filed;
}
