import { db } from '@buildd/core/db';
import { missions, tasks, workspaces } from '@buildd/core/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { isBuildDeliverable } from '@buildd/core/mission-helpers';
import { TERMINAL_TASK_STATUSES, type LivingSpecGoalCriterion } from '@buildd/shared';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { pickEffectiveRole } from '@/lib/effective-roles';

/**
 * Acceptance tests come first (Living Specs "checking work against a spec",
 * R-76, AC-122). A mission that selects an outcome spec starts with one
 * acceptance-tests task; every building task depends on it; and its agent is
 * never a builder's: the role is chosen from roles that are not `builder`.
 */

export const ACCEPTANCE_TESTS_PREFIX = '[acceptance tests]';

/** Roles that may write the tests, in preference order. `builder` is never one. */
export function acceptanceRoleCandidates(): string[] {
  return ['tester', 'reviewer', 'researcher'];
}

type Prior = { id: string; status: string; specId: string | null };

/** Pure: reuse a live or finished acceptance-tests task for this spec, else file one. */
export function decideAcceptanceTests(prior: readonly Prior[], specId: string): { kind: 'open'; taskId: string } | { kind: 'file' } {
  const mine = prior.filter((p) => p.specId === specId);
  const kept = mine.find((p) => p.status === 'completed' || !(TERMINAL_TASK_STATUSES as readonly string[]).includes(p.status));
  return kept ? { kind: 'open', taskId: kept.id } : { kind: 'file' };
}

type Held = { id: string; status: string; taskClass?: string | null; title?: string | null; roleSlug?: string | null; context?: unknown; dependsOn?: string[] | null };

const isAcceptanceTests = (t: Held) => !!t.context && typeof t.context === 'object' && (t.context as Record<string, unknown>).acceptanceTests != null;

const isDeadAcceptanceTests = (t: Held) =>
  isAcceptanceTests(t) && t.status !== 'completed' && (TERMINAL_TASK_STATUSES as readonly string[]).includes(t.status);

/**
 * Pure: unstarted building tasks whose dependsOn must change so they wait for the acceptance-tests task.
 * A dependency on a failed or cancelled acceptance-tests task is swapped for the new id: claim never
 * clears a failed dependency, so leaving it would hold the builder forever.
 */
export function holdsForAcceptanceTests(rows: readonly Held[], acceptanceTaskId: string): Array<{ id: string; dependsOn: string[] }> {
  const dead = new Set(rows.filter((t) => t.id !== acceptanceTaskId && isDeadAcceptanceTests(t)).map((t) => t.id));
  const out: Array<{ id: string; dependsOn: string[] }> = [];
  for (const t of rows) {
    if (t.id === acceptanceTaskId || t.status !== 'pending' || isAcceptanceTests(t) || !isBuildDeliverable(t as any)) continue;
    const current = t.dependsOn ?? [];
    const kept = current.filter((d) => !dead.has(d));
    if (kept.includes(acceptanceTaskId) && kept.length === current.length) continue;
    out.push({ id: t.id, dependsOn: kept.includes(acceptanceTaskId) ? kept : [...kept, acceptanceTaskId] });
  }
  return out;
}

export type AcceptanceTests = { kind: 'open' | 'dispatched'; taskId: string } | { kind: 'unavailable'; reason: string };

export async function ensureAcceptanceTests(missionId: string, criterion: LivingSpecGoalCriterion, scopeIds: readonly string[]): Promise<AcceptanceTests> {
  const priorRows = await db.query.tasks.findMany({
    where: sqlWhere(and(eq(tasks.missionId, missionId), sql`${tasks.context}->'acceptanceTests' IS NOT NULL`)),
    columns: { id: true, status: true, context: true },
  });
  const prior: Prior[] = priorRows.map((r) => ({ id: r.id, status: r.status, specId: ((r.context as any)?.acceptanceTests?.specId as string) ?? null }));
  const decision = decideAcceptanceTests(prior, criterion.specId);

  let taskId: string;
  let dispatched = false;
  if (decision.kind === 'open') taskId = decision.taskId;
  else {
    const mission = await db.query.missions.findFirst({
      where: sqlWhere(eq(missions.id, missionId)),
      columns: { id: true, title: true, workspaceId: true, workingBranch: true, integrationBranchEnabled: true },
    });
    if (!mission?.workspaceId) return { kind: 'unavailable', reason: 'the mission has no workspace' };
    const workspace = await db.query.workspaces.findFirst({ where: sqlWhere(eq(workspaces.id, mission.workspaceId)) });
    if (!workspace) return { kind: 'unavailable', reason: 'workspace not found' };
    // The agent must not be a builder's. A role-less task could be claimed by a builder
    // runner and nothing at claim enforces `apartFrom`, so with no non-builder role we file nothing.
    const roleSlug = await pickEffectiveRole(mission.workspaceId, acceptanceRoleCandidates());
    if (!roleSlug) return { kind: 'unavailable', reason: `the workspace has no ${acceptanceRoleCandidates().join(', ')} role to write the tests apart from a builder` };
    const base = missionIntegrationBase(mission);
    const title = `${ACCEPTANCE_TESTS_PREFIX} ${criterion.label ?? `spec revision ${criterion.revision}`}`;
    const description = [
      `## Acceptance tests`,
      ``,
      `Mission: **${mission.title}**. Write the tests for ${criterion.label ?? 'the outcome spec'} before anyone builds. You do not build in this mission.`,
      ``,
      `In scope: ${scopeIds.join(', ') || 'every criterion'}.`,
      ``,
      `For each acceptance check that can be tested, write one test with the check's id in its name (for example \`AC-3: refuses a stale version\`) and record it in the spec's metadata \`verified_by\`, keyed by the check's id. The spec text, version and approval do not change.`,
      `Each test must fail on the mission's starting commit. For a check that cannot be tested, say why: the code reviewer or screenshots judge it instead.`,
      ``,
      `Run each test on the starting commit (\`bun run scripts/run-acceptance-tests.ts <check id> <test file>\`, from a checkout of that commit) and report the results: \`POST /api/missions/${missionId}/acceptance-tests\` with \`{ "results": [{ "checkId", "name", "startingResult": "fail" | "pass" | "inconclusive", "output" }] }\`. A test that passes there is sent back to you with its output; building starts only when every test fails.`,
    ].join('\n');
    const [task] = await db.insert(tasks).values({
      workspaceId: mission.workspaceId,
      title,
      description,
      priority: 5,
      status: 'pending',
      mode: 'execution',
      kind: 'engineering',
      taskClass: 'work',
      creationSource: 'orchestrator',
      missionId,
      roleSlug,
      outputRequirement: 'pr_required',
      context: {
        acceptanceTests: { missionId, specId: criterion.specId, specRevisionId: criterion.specRevisionId, apartFrom: 'builder' },
        ...(base ? { baseBranch: base } : {}),
      },
    } as any).returning({ id: tasks.id });
    if (!task) return { kind: 'unavailable', reason: 'the acceptance-tests task could not be filed' };
    taskId = task.id;
    dispatched = true;
    await announceTaskCreated(
      { id: task.id, title, description: null, workspaceId: mission.workspaceId, mode: 'execution', priority: 5, missionId },
      workspace as any,
    ).catch((e) => console.error(`[acceptance-tests] dispatch failed for task ${task.id}:`, e));
  }

  const rows = await db.query.tasks.findMany({
    where: sqlWhere(eq(tasks.missionId, missionId)),
    columns: { id: true, status: true, taskClass: true, title: true, roleSlug: true, context: true, dependsOn: true },
  });
  for (const h of holdsForAcceptanceTests(rows as Held[], taskId)) {
    await db.update(tasks).set({ dependsOn: h.dependsOn } as any).where(eq(tasks.id, h.id));
  }
  if (dispatched) await wakeTask(taskId, 'task.created');
  return { kind: dispatched ? 'dispatched' : 'open', taskId };
}

