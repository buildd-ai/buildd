/**
 * Mission task handoff injection — upstream dependency outcomes deterministically
 * handed to newly-claimed tasks at claim time.
 *
 * ORDER MATTERS. This runs BEFORE attachKnowledgeContext so handoff is
 * structured, high-precision, and cheap to read before the fuzzier retrieval-based
 * knowledge section arrives. The spec contract in docs/design/mission-task-handoff.md
 * §4 update reflects this ordering.
 */
import { db } from '@buildd/core/db';
import { tasks, workers, missions, missionNotes, artifacts } from '@buildd/core/db/schema';
import { eq, inArray, and, not, sql } from 'drizzle-orm';
import type { ClaimTasksResponse } from '@buildd/shared';
import type { TaskResult } from '@buildd/shared';

/** The claimed-task rows this block looks tasks up in. */
type ClaimedTask = { id: string; missionId?: string | null };

/** Budget constants for handoff rendering, mirroring workspace-state-context.ts conventions. */
const BUDGET_UPSTREAM_EDGES = 1200;
const BUDGET_MISSION_BRIEF = 400;
const BUDGET_ARTIFACTS = 400;
const BUDGET_MISSION_NOTES = 400;

/**
 * Render one handoff section for a claimed task with non-empty dependsOn.
 * Pure function, unit-testable with no DB access.
 */
function renderMissionHandoff(
  task: { id: string; title: string; dependsOn?: string[] | null },
  upstreamResults: Map<string, { title: string; status: string; result?: TaskResult | null; prUrl?: string | null; prNumber?: number | null; mergedAt?: string | null }>,
  missionBrief?: string,
  authoritative?: Array<{ title: string; key: string }>,
  missionNotesList?: Array<{ type: string; title: string; body?: string }>,
): string {
  if (!task.dependsOn || task.dependsOn.length === 0) return '';

  const lines: string[] = ['## Upstream Task Handoff'];
  let upstreamChars = 0;

  // Render upstream edges in declaration order (the order dependsOn lists them)
  for (const depId of task.dependsOn) {
    const upstream = upstreamResults.get(depId);
    if (!upstream) continue;

    const delivered = upstream.result?.structuredOutput?.handoff?.delivered
      ? String(upstream.result.structuredOutput.handoff.delivered).slice(0, 200)
      : `${upstream.title} (${upstream.status})`;

    let edgeLine = `- **${upstream.title}**: ${delivered}`;
    if (upstream.prNumber) {
      edgeLine += ` (#${upstream.prNumber})`;
    }

    if (upstreamChars + edgeLine.length + 1 > BUDGET_UPSTREAM_EDGES) {
      const remaining = task.dependsOn.length - task.dependsOn.indexOf(depId);
      lines.push(`... and ${remaining} more upstream task(s), not shown (budget)`);
      break;
    }
    lines.push(edgeLine);
    upstreamChars += edgeLine.length + 1;
  }

  // Render mission brief if present and applicable
  if (missionBrief && BUDGET_MISSION_BRIEF > 0) {
    lines.push('');
    lines.push('## Mission Status');
    lines.push(missionBrief.slice(0, BUDGET_MISSION_BRIEF));
  }

  // Render authoritative artifacts if present
  if (authoritative && authoritative.length > 0 && BUDGET_ARTIFACTS > 0) {
    lines.push('');
    lines.push('## Authoritative Artifacts');
    let artifactChars = 0;
    for (const art of authoritative) {
      const line = `- ${art.title} (\`${art.key}\`)`;
      if (artifactChars + line.length + 1 > BUDGET_ARTIFACTS) {
        const remaining = authoritative.length - authoritative.indexOf(art);
        lines.push(`... and ${remaining} more, not shown (budget)`);
        break;
      }
      lines.push(line);
      artifactChars += line.length + 1;
    }
  }

  // Render open mission notes if present
  if (missionNotesList && missionNotesList.length > 0 && BUDGET_MISSION_NOTES > 0) {
    lines.push('');
    lines.push('## Open Mission Notes');
    let noteChars = 0;
    for (const note of missionNotesList) {
      const line = `- [${note.type}] ${note.title}${note.body ? ': ' + note.body.slice(0, 100) : ''}`;
      if (noteChars + line.length + 1 > BUDGET_MISSION_NOTES) {
        const remaining = missionNotesList.length - missionNotesList.indexOf(note);
        lines.push(`... and ${remaining} more, not shown (budget)`);
        break;
      }
      lines.push(line);
      noteChars += line.length + 1;
    }
  }

  return lines.join('\n');
}

/**
 * Attach mission handoff context for claimed tasks with dependsOn set.
 *
 * For each claimed task with non-empty dependsOn:
 * 1. Batch-fetch the named dependency tasks in one query
 * 2. Batch-fetch the latest worker row per dependency task
 * 3. For mission-linked tasks, fetch mission rows once per distinct missionId
 * 4. Render via renderMissionHandoff and append to resolvedContextProviders
 *
 * Best-effort: a thrown error attaches nothing, the claim still succeeds.
 */
export async function attachMissionHandoff(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
  handoffExcludedSources?: Set<string>, // Sources already rendered by handoff to dedupe knowledge context
): Promise<void> {
  // Collect all dependsOn ids across the claimed batch
  const allDepIds = new Set<string>();
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if (!task || !Array.isArray((task as any).dependsOn)) continue;
    for (const depId of (task as any).dependsOn) {
      if (typeof depId === 'string') allDepIds.add(depId);
    }
  }

  if (allDepIds.size === 0) return;

  try {
    // Batch-fetch dependency tasks (status, result, missionId, missionPhaseLabel, pathManifest)
    const depTaskRows = await db.query.tasks.findMany({
      where: inArray(tasks.id, Array.from(allDepIds)),
      columns: {
        id: true,
        title: true,
        status: true,
        result: true,
        missionId: true,
        missionPhaseLabel: true,
        pathManifest: true,
      },
    });

    const depTasksMap = new Map(depTaskRows.map(t => [t.id, t]));

    // Batch-fetch latest worker row per dependency task (for prUrl/prNumber/mergedAt)
    if (depTaskRows.length > 0) {
      const depTaskIds = depTaskRows.map(t => t.id);
      const workerRows = await db
        .selectDistinct({ taskId: workers.taskId, prUrl: workers.prUrl, prNumber: workers.prNumber, mergedAt: workers.mergedAt })
        .from(workers)
        .where(and(inArray(workers.taskId, depTaskIds), not(inArray(workers.status, ['failed', 'error', 'cancelled']))))
        .orderBy(workers.createdAt);

      for (const wr of workerRows) {
        const depTask = depTasksMap.get(wr.taskId);
        if (depTask) {
          (depTask as any).prUrl = wr.prUrl;
          (depTask as any).prNumber = wr.prNumber;
          (depTask as any).mergedAt = wr.mergedAt;
        }
      }
    }

    // Collect distinct missions and batch-fetch them once
    const missionIds = new Set<string>();
    for (const depTask of depTaskRows) {
      if (depTask.missionId) missionIds.add(depTask.missionId);
    }

    const missionMap = new Map();
    if (missionIds.size > 0) {
      const missionRows = await db.query.missions.findMany({
        where: inArray(missions.id, Array.from(missionIds)),
        columns: { id: true, title: true, goalCriteriaState: true, missionPhaseLabel: true },
      });
      for (const m of missionRows) {
        missionMap.set(m.id, m);
      }

      // Batch-fetch artifacts and mission notes once per distinct mission
      const artifactRows = await db.query.artifacts.findMany({
        where: and(
          inArray(artifacts.missionId, Array.from(missionIds)),
          eq(artifacts.type, 'link'), // Authoritative artifacts marked as type 'link'
        ),
        columns: { missionId: true, title: true, key: true },
      });

      const notesRows = await db.query.missionNotes.findMany({
        where: and(
          inArray(missionNotes.missionId, Array.from(missionIds)),
          inArray(missionNotes.type, ['decision', 'question']),
        ),
        columns: { missionId: true, type: true, title: true, body: true },
      });

      for (const m of missionRows) {
        (m as any).artifacts = artifactRows.filter(a => a.missionId === m.id);
        (m as any).notes = notesRows.filter(n => n.missionId === m.id).sort((a, b) => (b.title > a.title ? 1 : -1));
      }
    }

    // Render handoff for each claimed worker with dependsOn
    for (const cw of claimedWorkers) {
      const task = claimedTasks.find(t => t.id === cw.taskId);
      if (!task || !Array.isArray((task as any).dependsOn) || (task as any).dependsOn.length === 0) continue;

      // Build upstream results map
      const upstreamResults = new Map();
      for (const depId of (task as any).dependsOn) {
        const depTask = depTasksMap.get(depId);
        if (depTask) {
          upstreamResults.set(depId, {
            title: depTask.title,
            status: depTask.status,
            result: depTask.result,
            prUrl: (depTask as any).prUrl,
            prNumber: (depTask as any).prNumber,
            mergedAt: (depTask as any).mergedAt,
          });
        }
      }

      // Get mission brief
      const mission = task.missionId ? missionMap.get(task.missionId) : null;
      let missionBrief = '';
      if (mission) {
        const goals = (mission as any).goalCriteriaState?.verdicts
          ?.filter((v: any) => v.verdict !== 'pass')
          .map((v: any) => `${v.label}: ${v.verdict}`)
          .join('; ') ?? '';
        missionBrief = `**${mission.title}** — Phase: ${mission.missionPhaseLabel ?? 'unknown'}${goals ? `, Goals: ${goals}` : ''}`;
      }

      const handoffBlock = renderMissionHandoff(
        { id: task.id, title: (task as any).title, dependsOn: (task as any).dependsOn },
        upstreamResults,
        missionBrief,
        mission ? (mission as any).artifacts : undefined,
        mission ? (mission as any).notes : undefined,
      );

      if (handoffBlock) {
        if (!cw.resolvedContextProviders) {
          cw.resolvedContextProviders = [];
        }
        cw.resolvedContextProviders.push({
          provider: 'mission-handoff',
          content: handoffBlock,
        });

        // Mirror into task.context
        if (!cw.context) cw.context = {};
        (cw.context as any).missionHandoff = handoffBlock;

        // Track rendered sources for knowledge dedupe
        if (handoffExcludedSources) {
          for (const depId of (task as any).dependsOn) {
            handoffExcludedSources.add(`task:${depId}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[attachMissionHandoff] Error building handoff context:', err);
    // Best-effort: error attaches nothing, claim still succeeds
  }
}
