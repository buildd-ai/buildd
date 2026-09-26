import { db } from '@buildd/core/db';
import { initiatives, missions } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { buildMissionCardView, summarizeMissionForCard, type BlockingTask, type MissionCardRow } from './mission-card-view';
import { buildMissionListCard, type ListMissionRow } from './mission-list-card';
import { MISSION_BASE_COLUMNS, MISSION_TASK_BASE_COLUMNS, MISSION_WORKER_BASE_COLUMNS } from './missions-query';
import { buildMissionWithInitiativeUrl } from './initiative-breadcrumb';
import {
  buildInitiativeCard,
  isInitiativeStatus,
  type InitiativeCardModel,
  type InitiativeMissionInput,
} from './initiative-view';

/**
 * Load initiatives as cards (lib/initiative-view.ts) for the Initiatives list
 * and the initiative page. One loader for both, so the card that links to a
 * page and the page itself count the same missions the same way.
 *
 * Each child mission is reduced by the missions-list card model with the same
 * query columns the Missions tab uses, so "needs you", "held" and n/N read the
 * same on both tabs. Archived initiatives are left out of the list; the page
 * still loads one by id.
 */
export interface LoadedInitiative {
  card: InitiativeCardModel;
  teamId: string;
  workspaceId: string | null;
  workspace: { id: string; name: string } | null;
  ownerUserId: string | null;
  targetDate: string | null;
}

export async function loadInitiativeCards(opts: {
  teamIds: string[];
  /** Load exactly this initiative (any status). */
  initiativeId?: string;
  now?: number;
}): Promise<LoadedInitiative[]> {
  const { teamIds, initiativeId } = opts;
  const now = opts.now ?? Date.now();
  if (teamIds.length === 0 && !initiativeId) return [];

  const where: SQL | undefined = initiativeId
    ? eq(initiatives.id, initiativeId)
    : and(inArray(initiatives.teamId, teamIds), ne(initiatives.status, 'archived'));

  const rows = await db.query.initiatives.findMany({
    where,
    orderBy: [desc(initiatives.priority), desc(initiatives.createdAt)],
    columns: { id: true, title: true, description: true, status: true, teamId: true, workspaceId: true, ownerUserId: true, targetDate: true },
    with: {
      workspace: { columns: { id: true, name: true } },
      ownerUser: { columns: { name: true, email: true } },
      createdByUser: { columns: { name: true, email: true } },
    },
  });
  if (rows.length === 0) return [];

  const missionRows = (await db.query.missions.findMany({
    where: inArray(missions.initiativeId, rows.map((r) => r.id)),
    orderBy: [desc(missions.priority), desc(missions.createdAt)],
    columns: MISSION_BASE_COLUMNS,
    with: {
      schedule: { columns: { id: true, nextRunAt: true, lastRunAt: true, cronExpression: true, lastDeferralReason: true, lastDeferredAt: true, maxConcurrentFromSchedule: true, totalRuns: true } },
      tasks: {
        columns: { ...MISSION_TASK_BASE_COLUMNS, roleSlug: true, missionPhaseIndex: true, missionPhaseLabel: true, label: true },
        orderBy: (t: any, { desc: d }: any) => [d(t.updatedAt)],
        with: {
          workers: {
            columns: { ...MISSION_WORKER_BASE_COLUMNS, exitCause: true, waitingFor: true },
            limit: 5,
            orderBy: (w: any, { desc: d }: any) => [d(w.startedAt), d(w.updatedAt)],
          },
        },
      },
    },
  } as any)) as any[];

  // `dependsOn` crosses mission boundaries: one index over every loaded task.
  const taskIndex = new Map<string, BlockingTask>();
  for (const m of missionRows) for (const t of m.tasks ?? []) taskIndex.set(t.id, t as BlockingTask);

  const byInitiative = new Map<string, InitiativeMissionInput[]>();
  for (const m of missionRows) {
    const row = m as MissionCardRow;
    const summary = summarizeMissionForCard(row, { now });
    const view = buildMissionCardView(row, { from: 'missions', now, summary, taskIndex });
    const list = buildMissionListCard(m as ListMissionRow, view, summary, { now });
    const input: InitiativeMissionInput = {
      id: m.id,
      title: m.title,
      status: m.status,
      href: buildMissionWithInitiativeUrl(m.id, m.initiativeId),
      kind: list.kind,
      statusLabel: list.status.label,
      tone: list.status.tone,
      done: list.counts.done,
      total: list.counts.total,
      failed: list.counts.failed,
      criteria: list.criteria,
      question: list.question ? { label: list.question.label, href: list.question.href, prompt: list.question.prompt } : null,
      ask: list.ask,
      phases: list.phases,
      inlineQuestion: list.question,
    };
    const bucket = byInitiative.get(m.initiativeId) ?? [];
    bucket.push(input);
    byInitiative.set(m.initiativeId, bucket);
  }

  return rows.map((r: any) => {
    const person = r.ownerUser ?? r.createdByUser ?? null;
    const ownerName = person ? person.name || person.email : null;
    return {
      teamId: r.teamId,
      workspaceId: r.workspaceId,
      workspace: r.workspace ?? null,
      ownerUserId: r.ownerUserId ?? null,
      targetDate: r.targetDate ?? null,
      card: buildInitiativeCard(
        {
          id: r.id,
          title: r.title,
          description: r.description,
          status: isInitiativeStatus(r.status) ? r.status : 'active',
          targetDate: r.targetDate ?? null,
          owner: ownerName ? { name: ownerName } : null,
          missions: byInitiative.get(r.id) ?? [],
        },
        { now },
      ),
    };
  });
}
