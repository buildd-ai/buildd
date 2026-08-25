import { db } from '@buildd/core/db';
import { missions, tasks, pathClaims, workers, initiatives, teams } from '@buildd/core/db/schema';
import { eq, and, ne, isNull, isNotNull, sql, desc } from 'drizzle-orm';
import type { InitiativeKPIState } from '@buildd/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * What triggered this organizer pass. Determines which sections are rendered.
 *
 * Section matrix:
 * | Cause                   | What landed | Conflict | Siblings | Claims | PRs | Initiative | Budget |
 * |-------------------------|-------------|----------|----------|--------|-----|------------|--------|
 * | task_completed          |     ✓       |          |          |        |     |            |        |
 * | pr_merged               |     ✓       |          |          |        |     |            |        |
 * | conflict_escalation     |             |    ✓     |          |        |     |            |        |
 * | claim_409               |             |    ✓     |          |        |     |            |        |
 * | mission_evaluate        |             |          |    ✓     |   ✓    |  ✓  |     ✓      |   ✓    |
 * | first_decomposition     |             |          |    ✓     |   ✓    |  ✓  |     ✓      |   ✓    |
 * | fallback                |             |          |    ✓     |   ✓    |     |            |        |
 *
 * Character budget per section:
 * - Header: 80 chars
 * - What landed: 400 chars
 * - Conflict block: 400 chars
 * - Sibling missions: 600 chars (≤5 missions shown)
 * - Held path claims: 400 chars (≤10 paths shown)
 * - Open PRs: 400 chars (≤5 PRs shown)
 * - Parent initiative: 200 chars
 * - Budget: 100 chars
 */
export type OrganizerCause =
  | 'task_completed'
  | 'pr_merged'
  | 'conflict_escalation'
  | 'claim_409'
  | 'mission_evaluate'
  | 'first_decomposition'
  | 'fallback';

/** Caller-supplied structured cause data, scoped to relevant fields per cause. */
export interface WorkspaceStateCauseData {
  // task_completed / pr_merged
  taskId?: string;
  taskTitle?: string;
  prNumber?: number;
  pathsReleased?: string[];
  unblockedTaskIds?: string[];
  // conflict_escalation / claim_409
  blockingTaskId?: string;
  blockingTaskTitle?: string;
  /** null = same mission, string = different mission id */
  blockingMissionId?: string | null;
  waiterQueuePosition?: number;
  blockingPaths?: string[];
}

export interface SiblingMission {
  id: string;
  title: string;
  status: string;
  isHeld: boolean;
  pacingMode: string;
  progress: number;
}

export interface HeldClaim {
  path: string;
  taskId: string;
  taskTitle: string | null;
  missionId: string | null;
  claimedAt: Date;
}

export interface OpenPR {
  prNumber: number | null;
  prUrl: string;
  lifecycleStatus: string | null;
  createdAt: Date;
}

export interface InitiativeBrief {
  id: string;
  title: string;
  status: string;
  progress: number;
  description: string | null;
  kpiSummary: string | null;
}

/**
 * Injectable querier interface. The default implementation queries the DB
 * directly. Tests inject a mock to avoid live DB dependencies.
 *
 * Each method makes exactly ONE query — never N+1.
 */
export interface WorkspaceStateQuerier {
  getSiblingMissions(workspaceId: string, excludeMissionId: string): Promise<SiblingMission[]>;
  getHeldClaims(workspaceId: string): Promise<HeldClaim[]>;
  getOpenPRs(workspaceId: string): Promise<OpenPR[]>;
  getInitiativeBrief(initiativeId: string): Promise<InitiativeBrief | null>;
  getBudgetLine(teamId: string, workspaceId: string): Promise<string | null>;
}

export interface BuildWorkspaceStateContextParams {
  missionId: string;
  workspaceId: string;
  teamId: string;
  initiativeId?: string | null;
  cause: OrganizerCause;
  causeData?: WorkspaceStateCauseData;
  /** Injectable querier for tests. Defaults to DB-backed implementation. */
  querier?: WorkspaceStateQuerier;
}

// ── Character budgets (chars) ─────────────────────────────────────────────────

const BUDGET_WHAT_LANDED = 400;
const BUDGET_CONFLICT = 400;
const BUDGET_SIBLING_MISSIONS = 600;
const BUDGET_HELD_CLAIMS = 400;
const BUDGET_OPEN_PRS = 400;
const BUDGET_INITIATIVE = 200;
const BUDGET_BUDGET = 100;

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgoShort(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

// ── Section renderers ─────────────────────────────────────────────────────────

function renderWhatLanded(causeData: WorkspaceStateCauseData): string {
  const lines: string[] = ['### What landed'];
  if (causeData.taskTitle) {
    let line = `Task: "${causeData.taskTitle}"`;
    if (causeData.prNumber) line += ` → PR #${causeData.prNumber} merged`;
    lines.push(line);
  } else if (causeData.prNumber) {
    lines.push(`PR #${causeData.prNumber} merged`);
  }
  if (causeData.pathsReleased?.length) {
    lines.push(`Paths released: ${causeData.pathsReleased.slice(0, 5).join(', ')}`);
  }
  if (causeData.unblockedTaskIds?.length) {
    lines.push(`Unblocked tasks: ${causeData.unblockedTaskIds.slice(0, 3).join(', ')}`);
  }
  return cap(lines.join('\n'), BUDGET_WHAT_LANDED);
}

function renderConflict(causeData: WorkspaceStateCauseData): string {
  const lines: string[] = ['### Blocking claim'];
  if (causeData.blockingTaskId) {
    let line = `Holder: task \`${causeData.blockingTaskId}\``;
    if (causeData.blockingTaskTitle) line += ` "${causeData.blockingTaskTitle}"`;
    lines.push(line);
  }
  if (causeData.blockingMissionId !== undefined) {
    if (causeData.blockingMissionId) {
      lines.push(`Mission: different mission \`${causeData.blockingMissionId}\` — escalate to organizer`);
    } else {
      lines.push('Mission: same mission — add dependsOn edge');
    }
  }
  if (causeData.blockingPaths?.length) {
    lines.push(`Paths: ${causeData.blockingPaths.slice(0, 5).join(', ')}`);
  }
  if (causeData.waiterQueuePosition !== undefined) {
    lines.push(`Queue position: ${causeData.waiterQueuePosition}`);
  }
  return cap(lines.join('\n'), BUDGET_CONFLICT);
}

function renderSiblingMissions(siblings: SiblingMission[]): string {
  if (siblings.length === 0) return '';
  const lines: string[] = [`### Sibling missions (${siblings.length} active)`];
  for (const m of siblings.slice(0, 5)) {
    let line = `[${m.progress}%] ${m.title} · ${m.status} · ${m.pacingMode}`;
    if (m.isHeld) line += ' [HELD]';
    lines.push(line);
  }
  return cap(lines.join('\n'), BUDGET_SIBLING_MISSIONS);
}

function renderHeldClaims(claims: HeldClaim[], currentMissionId: string): string {
  if (claims.length === 0) return '';
  const lines: string[] = [`### Held path claims (${claims.length})`];
  for (const c of claims.slice(0, 10)) {
    const age = timeAgoShort(c.claimedAt);
    const missionNote = c.missionId === currentMissionId
      ? '(same mission)'
      : `(mission: ${c.missionId ?? 'unknown'})`;
    const titleNote = c.taskTitle ? ` "${c.taskTitle}"` : '';
    lines.push(`${c.path} → task \`${c.taskId}\`${titleNote} ${missionNote} — ${age}`);
  }
  return cap(lines.join('\n'), BUDGET_HELD_CLAIMS);
}

function renderOpenPRs(prs: OpenPR[]): string {
  if (prs.length === 0) return '';
  const lines: string[] = [`### Open PRs (${prs.length})`];
  for (const pr of prs.slice(0, 5)) {
    const age = timeAgoShort(new Date(pr.createdAt));
    const status = pr.lifecycleStatus ? ` [${pr.lifecycleStatus}]` : '';
    lines.push(`PR #${pr.prNumber ?? '?'}: ${pr.prUrl}${status} (${age})`);
  }
  return cap(lines.join('\n'), BUDGET_OPEN_PRS);
}

function renderInitiative(brief: InitiativeBrief): string {
  let text = `### Parent initiative: ${brief.title} [${brief.status}, ${brief.progress}%]`;
  if (brief.kpiSummary) text += `\n${brief.kpiSummary}`;
  return cap(text, BUDGET_INITIATIVE);
}

function renderBudget(budgetLine: string): string {
  return cap(`### Budget\n${budgetLine}`, BUDGET_BUDGET);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Build the organizer's situational awareness block. Scoped to the trigger
 * cause so prompt cost stays bounded — a cron fallback gets less than a
 * targeted conflict escalation.
 *
 * Every section is wrapped in try/catch; a source failure degrades to omitting
 * that section, never blocking context assembly.
 */
export async function buildWorkspaceStateContext(
  params: BuildWorkspaceStateContextParams,
): Promise<string> {
  const { missionId, workspaceId, teamId, initiativeId, cause, causeData = {} } = params;
  const q = params.querier ?? createDefaultQuerier();

  const header = `## Workspace Situational Awareness [cause: ${cause}]`;

  // task_completed / pr_merged — only "what landed"
  if (cause === 'task_completed' || cause === 'pr_merged') {
    try {
      return [header, renderWhatLanded(causeData)].join('\n');
    } catch {
      return header;
    }
  }

  // conflict_escalation / claim_409 — only conflict block
  if (cause === 'conflict_escalation' || cause === 'claim_409') {
    try {
      return [header, renderConflict(causeData)].join('\n');
    } catch {
      return header;
    }
  }

  // mission_evaluate / first_decomposition / fallback — workspace-wide state
  const isFull = cause === 'mission_evaluate' || cause === 'first_decomposition';

  const [siblingsResult, claimsResult, prsResult, initiativeResult, budgetResult] =
    await Promise.allSettled([
      q.getSiblingMissions(workspaceId, missionId),
      q.getHeldClaims(workspaceId),
      isFull ? q.getOpenPRs(workspaceId) : Promise.resolve<OpenPR[]>([]),
      isFull && initiativeId ? q.getInitiativeBrief(initiativeId) : Promise.resolve<InitiativeBrief | null>(null),
      isFull ? q.getBudgetLine(teamId, workspaceId) : Promise.resolve<string | null>(null),
    ]);

  const siblings = siblingsResult.status === 'fulfilled' ? siblingsResult.value : [];
  const claims = claimsResult.status === 'fulfilled' ? claimsResult.value : [];
  const prs = prsResult.status === 'fulfilled' ? prsResult.value : [];
  const initiative = initiativeResult.status === 'fulfilled' ? initiativeResult.value : null;
  const budget = budgetResult.status === 'fulfilled' ? budgetResult.value : null;

  const parts: string[] = [header];

  const siblingSection = renderSiblingMissions(siblings);
  if (siblingSection) parts.push(siblingSection);

  const claimsSection = renderHeldClaims(claims, missionId);
  if (claimsSection) parts.push(claimsSection);

  if (isFull) {
    const prsSection = renderOpenPRs(prs);
    if (prsSection) parts.push(prsSection);

    if (initiative) parts.push(renderInitiative(initiative));
    if (budget) parts.push(renderBudget(budget));
  }

  return parts.join('\n');
}

// ── Default querier (DB-backed) ───────────────────────────────────────────────

function createDefaultQuerier(): WorkspaceStateQuerier {
  return {
    async getSiblingMissions(workspaceId, excludeMissionId) {
      const rows = await db
        .select({
          id: missions.id,
          title: missions.title,
          status: missions.status,
          isHeld: missions.isHeld,
          pacingMode: missions.pacingMode,
          completedTasks: sql<number>`COUNT(${tasks.id}) FILTER (WHERE ${tasks.status} = 'completed')::int`,
          totalTasks: sql<number>`COUNT(${tasks.id}) FILTER (WHERE ${tasks.status} != 'cancelled')::int`,
        })
        .from(missions)
        .leftJoin(tasks, eq(tasks.missionId, missions.id))
        .where(and(
          eq(missions.workspaceId, workspaceId),
          ne(missions.id, excludeMissionId),
          eq(missions.status, 'active'),
        ))
        .groupBy(
          missions.id,
          missions.title,
          missions.status,
          missions.isHeld,
          missions.pacingMode,
        )
        .limit(5);

      return rows.map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
        isHeld: r.isHeld,
        pacingMode: r.pacingMode,
        progress: r.totalTasks > 0
          ? Math.round((r.completedTasks / r.totalTasks) * 100)
          : 0,
      }));
    },

    async getHeldClaims(workspaceId) {
      const rows = await db
        .select({
          path: pathClaims.path,
          taskId: pathClaims.taskId,
          claimedAt: pathClaims.claimedAt,
          taskTitle: tasks.title,
          missionId: tasks.missionId,
        })
        .from(pathClaims)
        .leftJoin(tasks, eq(pathClaims.taskId, tasks.id))
        .where(and(
          eq(pathClaims.workspaceId, workspaceId),
          isNull(pathClaims.releasedAt),
        ))
        .orderBy(desc(pathClaims.claimedAt))
        .limit(10);

      return rows.map(r => ({
        path: r.path,
        taskId: r.taskId,
        claimedAt: r.claimedAt,
        taskTitle: r.taskTitle ?? null,
        missionId: r.missionId ?? null,
      }));
    },

    async getOpenPRs(workspaceId) {
      const rows = await db
        .select({
          prNumber: workers.prNumber,
          prUrl: workers.prUrl,
          lifecycleStatus: workers.prLifecycleStatus,
          createdAt: workers.createdAt,
        })
        .from(workers)
        .where(and(
          eq(workers.workspaceId, workspaceId),
          isNotNull(workers.prUrl),
          isNull(workers.mergedAt),
          sql`${workers.prLifecycleStatus} IS DISTINCT FROM 'merged'`,
          sql`${workers.prLifecycleStatus} IS DISTINCT FROM 'closed'`,
        ))
        .orderBy(desc(workers.createdAt))
        .limit(5);

      return rows
        .filter(r => r.prUrl != null)
        .map(r => ({
          prNumber: r.prNumber,
          prUrl: r.prUrl!,
          lifecycleStatus: r.lifecycleStatus ?? null,
          createdAt: r.createdAt ?? new Date(),
        }));
    },

    async getInitiativeBrief(initiativeId) {
      const row = await db.query.initiatives.findFirst({
        where: eq(initiatives.id, initiativeId),
        columns: {
          id: true,
          title: true,
          status: true,
          description: true,
          progressCache: true,
          kpiState: true,
        },
      });
      if (!row) return null;

      const progress = (row.progressCache as { progress?: number } | null)?.progress ?? 0;

      let kpiSummary: string | null = null;
      const kpiState = row.kpiState as InitiativeKPIState | null;
      if (kpiState?.kpis?.length) {
        const met = kpiState.kpis.filter(k => k.verdict === 'pass').length;
        kpiSummary = `KPIs: ${met}/${kpiState.kpis.length} met`;
      }

      return {
        id: row.id,
        title: row.title,
        status: row.status,
        progress,
        description: row.description ?? null,
        kpiSummary,
      };
    },

    async getBudgetLine(teamId) {
      const team = await db.query.teams.findFirst({
        where: eq(teams.id, teamId),
        columns: {
          monthlyBudgetUsd: true,
          monthlyCostUsd: true,
        },
      });
      if (!team?.monthlyBudgetUsd) return null;

      const budgetUsd = parseFloat(team.monthlyBudgetUsd as string);
      if (!budgetUsd || budgetUsd <= 0) return null;

      const spentUsd = parseFloat((team.monthlyCostUsd as string) ?? '0');
      const pctUsed = Math.round((spentUsd / budgetUsd) * 100);
      return `monthly: ${pctUsed}% used`;
    },
  };
}
