/**
 * Findings that ship with a mission under Visual Review policy `automatic`.
 *
 * When the automatic fix rounds run out, the mission PR merges anyway. What the
 * review still sees open is filed as `[surface fix]` tasks on trunk (no mission,
 * so no integration branch), one per route, and listed in the completion record.
 * Strict keeps the owner gate; ask and off never reach here.
 */
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { surfaceFixTitle } from '@buildd/core/surface-audit';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import type { OpenVisualFinding } from '@/lib/visual-review-model';

const TITLE_MAX = 140;

export interface CarriedFix { route: string; title: string; taskId: string | null }

/** The finding groups by route; both viewports of a route share one fix. */
export function carriedFixTitles(findings: readonly OpenVisualFinding[]): Array<{ route: string; title: string; findings: OpenVisualFinding[] }> {
  const byRoute = new Map<string, OpenVisualFinding[]>();
  for (const f of findings) byRoute.set(f.route, [...(byRoute.get(f.route) ?? []), f]);
  return [...byRoute].map(([route, fs]) => {
    const text = fs.find(f => f.finding)?.finding || 'a screen the visual review left open';
    const title = surfaceFixTitle(route, text);
    return { route, title: title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 3).trimEnd()}...`, findings: fs };
  });
}

/** The completion record lines for what shipped open. Plain words, no ids. */
export function carriedFindingsLines(fixes: readonly CarriedFix[]): string[] {
  if (fixes.length === 0) return [];
  return [
    `Open on the visual review: ${fixes.length} ${fixes.length === 1 ? 'screen' : 'screens'}, shipped with the mission and filed as fix tasks on trunk`,
    ...fixes.map(f => `- ${f.route}${f.taskId ? '' : ' (not filed yet)'}`),
  ];
}

/**
 * File one trunk `[surface fix]` per route that is not already open under the
 * same title. Never throws: the mission is done, so a failure leaves the route
 * listed as not filed and the next sweep may file it.
 */
export async function fileCarriedSurfaceFixes(opts: {
  missionId: string;
  workspace: { id: string };
  findings: readonly OpenVisualFinding[];
}): Promise<CarriedFix[]> {
  const out: CarriedFix[] = [];
  for (const g of carriedFixTitles(opts.findings)) {
    try {
      const open = await db.select({ id: tasks.id }).from(tasks).where(and(
        eq(tasks.workspaceId, opts.workspace.id),
        isNull(tasks.missionId),
        eq(tasks.title, g.title),
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      )).limit(1) as Array<{ id: string }>;
      if (open[0]) { out.push({ route: g.route, title: g.title, taskId: open[0].id }); continue; }
      const description = [
        `The visual review of mission ${opts.missionId.slice(0, 8)} ran out of automatic rounds with \`${g.route}\` still open. The mission merged under the automatic policy; this fix lands on trunk.`,
        '',
        ...g.findings.map(f => `- ${f.viewport}${f.variant ? ` (${f.variant})` : ''}, artifact ${f.artifactId}: ${f.finding || '(no finding)'}`),
      ].join('\n');
      const [task] = await db.insert(tasks).values({
        workspaceId: opts.workspace.id,
        missionId: null,
        title: g.title,
        description,
        taskClass: 'work',
        kind: 'engineering',
        creationSource: 'orchestrator',
        context: { surfaceFix: { origin: 'carried', route: g.route, artifactIds: g.findings.map(f => f.artifactId), fromMission: opts.missionId } },
      }).returning() as Array<{ id: string; title: string; description: string | null; workspaceId: string; missionId: string | null; taskClass: string; pathManifest: string[] | null }>;
      await announceTaskCreated(task, opts.workspace as Parameters<typeof announceTaskCreated>[1]).catch(err => console.error('[visual-review-carry] dispatch failed:', err));
      await wakeTask(task.id, 'task.created').catch(() => {});
      out.push({ route: g.route, title: g.title, taskId: task.id });
    } catch (err) {
      console.error(`[visual-review-carry] ${opts.missionId.slice(0, 8)} could not file a fix for ${g.route}:`, err);
      out.push({ route: g.route, title: g.title, taskId: null });
    }
  }
  return out;
}
