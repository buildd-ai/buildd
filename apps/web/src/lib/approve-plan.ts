import { db } from '@buildd/core/db';
import { missions, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { generateTaskBranchName, type BranchNameGitConfig } from '@buildd/core/branch-names';
import type { PlanStep, TaskSubjectAnchor } from '@buildd/shared';
import { classifyCoordinationIntent, coordinationDedupeKey, extractPrNumbers, type CoordinationIntent } from './coordination-intent';
import { proposalChildTaskTitle, buildProposalChildDescription } from '@buildd/core/spec-doc-fix';

/**
 * `tasks.context.specDocFix` — written by the doc-fix dispatch
 * (api/discrepancies/[id]/dispatch-doc-fix) and carried onto whatever the
 * human approves, so the code task that finalizes a proposal names the ledger
 * rows it exists to settle.
 */
export interface SpecDocFixContext {
  specPath: string;
  assertionIds?: string[];
  discrepancyIds?: string[];
  workspaceId?: string;
}

/**
 * A doc-fixer's net-enhancement proposal approves as exactly ONE child task.
 *
 * The proposal is a list of items about one document; approving it is one
 * decision, and the work it describes has to land together with the spec text
 * that will then describe the finished state — split across N tasks, N-1 of
 * them would re-open the discrepancy the doc fix just closed. The worker is
 * told to return a single step, and this makes that mechanical rather than a
 * matter of it complying: whatever shape the plan comes back in, one child is
 * minted and every item survives in its description. Nothing is dropped.
 */
export function collapseProposalPlan(plan: PlanStep[], docFix: SpecDocFixContext): PlanStep[] {
  if (plan.length === 0) return plan;

  const proposal = plan
    .map((step) => {
      const body = step.description?.trim();
      return body ? `### ${step.title}\n\n${body}` : `### ${step.title}`;
    })
    .join('\n\n');

  return [
    {
      ...plan[0],
      ref: 'proposal',
      title: proposalChildTaskTitle(docFix.specPath),
      description: buildProposalChildDescription({
        specPath: docFix.specPath,
        assertionIds: docFix.assertionIds ?? [],
        proposal,
      }),
      // Refs from the submitted steps no longer resolve once they are one step,
      // and a single child has nothing to depend on or stack behind anyway.
      dependsOn: undefined,
      baseBranch: undefined,
    },
  ];
}

// PlanStep is defined once in @buildd/shared (the planning contract). Re-exported
// here for the existing internal importers (task-dependencies, mission-loop, etc.).
export type { PlanStep } from '@buildd/shared';

/** Non-terminal statuses a sibling coordination task might be sitting in. */
const OPEN_TASK_STATUSES = ['pending', 'assigned', 'in_progress'] as const;

export interface DroppedPlanStep {
  ref: string;
  reason: 'coordination_intent' | 'exact_title';
  /** The existing task this step duplicated. Absent for an in-plan duplicate
   * dropped before any task existed to point at (see `survivorRef`). */
  matchedTaskId?: string;
  /** The ref of the surviving step within THIS plan that this one duplicated. */
  survivorRef?: string;
}

export interface ApprovePlanResult {
  taskIds: string[];
  /** Plan steps dropped as duplicates of existing or sibling coordination work — see Part 2 dedup. */
  droppedSteps?: DroppedPlanStep[];
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Create child execution tasks from a planning task's structured plan.
 *
 * Two-pass process:
 * 1. Create all tasks with empty dependsOn (to get IDs)
 * 2. Resolve ref→ID for dependsOn and baseBranch
 *
 * Throws on circular dependencies or if plan was already approved.
 */
export async function approvePlan(
  planningTaskId: string,
  plan: PlanStep[],
  options?: { autoApproved?: boolean }
): Promise<ApprovePlanResult> {
  // Fetch the planning task for workspace/mission context
  const task = await db.query.tasks.findFirst({
    where: eq(tasks.id, planningTaskId),
    columns: { id: true, workspaceId: true, missionId: true, context: true, pathManifest: true },
  });

  if (!task) {
    throw new Error(`Planning task ${planningTaskId} not found`);
  }

  // Fetch workspace git config for branch name prediction
  const workspace = task.workspaceId
    ? await db.query.workspaces.findFirst({
        where: eq(workspaces.id, task.workspaceId),
        columns: { gitConfig: true },
      })
    : null;

  const gitConfig = (workspace?.gitConfig as BranchNameGitConfig) || null;

  // Option A′: when the mission has opted into an integration branch, that
  // branch is the DEFAULT base for every child this plan creates. A step that
  // names a predecessor via `baseBranch` still stacks on it (resolved in the
  // second pass below) — this only fills in the base for steps that named none,
  // which today means trunk. Null for every mission that has not opted in, so
  // the context those children carry is byte-identical to before.
  const mission = task.missionId
    ? await db.query.missions.findFirst({
        where: eq(missions.id, task.missionId),
        columns: { workingBranch: true, integrationBranchEnabled: true },
      })
    : null;
  const integrationBase = missionIntegrationBase(mission);

  // Guard: prevent duplicate approval
  const existingChildren = await db.query.tasks.findMany({
    where: eq(tasks.parentTaskId, planningTaskId),
    columns: { id: true },
    limit: 1,
  });
  if (existingChildren.length > 0) {
    throw new Error('Plan already approved — child tasks exist');
  }

  // Validate: no circular dependencies. Checked against the FULL submitted plan
  // — a cycle is a planner bug regardless of what dedup below ends up dropping.
  const cycle = detectCircularDeps(plan);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle.join(' → ')}`);
  }

  // ── Coordination-task dedup ──────────────────────────────────────────────────
  // Successive heartbeat cycles on a blocked mission tend to re-propose the same
  // handful of coordination steps (wait for budget reset, monitor review, merge,
  // aggregate) under slightly different wording each time. Dedupe those by
  // (mission, intent, subject PR set) — read off the step's own title/description,
  // not a live query — rather than exact title text, which catches none of them.
  // A step whose title names no coordination intent falls back to exact-title
  // matching, the same behaviour this dedup replaces.
  const stepIntent = new Map<string, { intent: CoordinationIntent; prNumbers: number[] }>();
  const droppedSteps: DroppedPlanStep[] = [];
  let survivingPlan = plan;

  if (task.missionId) {
    const existingMissionTasks = await db.query.tasks.findMany({
      where: and(eq(tasks.missionId, task.missionId), inArray(tasks.status, [...OPEN_TASK_STATUSES])),
      columns: { id: true, title: true, subjectAnchor: true },
    });

    const seenKeys = new Map<string, string>(); // dedupe key -> surviving ref
    const seenTitles = new Map<string, string>(); // exact title -> surviving ref
    const kept: PlanStep[] = [];

    for (const step of plan) {
      const intent = classifyCoordinationIntent(step.title);
      if (intent) {
        const prNumbers = extractPrNumbers(`${step.title} ${step.description ?? ''}`);
        const key = coordinationDedupeKey(intent, prNumbers);

        const existingMatch = existingMissionTasks.find(t => {
          const anchor = t.subjectAnchor as TaskSubjectAnchor | null;
          return anchor?.kind === 'mission'
            && anchor.coordinationIntent === intent
            && arraysEqual(anchor.subjectPrNumbers ?? [], prNumbers);
        });
        if (existingMatch) {
          droppedSteps.push({ ref: step.ref, reason: 'coordination_intent', matchedTaskId: existingMatch.id });
          continue;
        }

        const survivorRef = seenKeys.get(key);
        if (survivorRef) {
          droppedSteps.push({ ref: step.ref, reason: 'coordination_intent', survivorRef });
          continue;
        }

        seenKeys.set(key, step.ref);
        stepIntent.set(step.ref, { intent, prNumbers });
        kept.push(step);
      } else {
        const existingMatch = existingMissionTasks.find(t => t.title === step.title);
        if (existingMatch) {
          droppedSteps.push({ ref: step.ref, reason: 'exact_title', matchedTaskId: existingMatch.id });
          continue;
        }

        const survivorRef = seenTitles.get(step.title);
        if (survivorRef) {
          droppedSteps.push({ ref: step.ref, reason: 'exact_title', survivorRef });
          continue;
        }

        seenTitles.set(step.title, step.ref);
        kept.push(step);
      }
    }

    survivingPlan = kept;
  }

  // A doc-fix task's plan is a net-enhancement PROPOSAL about one spec doc, not
  // a decomposition — it approves as exactly one child, carrying the ledger
  // rows it settles. Applied here (not only in the route) so the same rule
  // holds on every path into approvePlan.
  const docFix = ((task.context as Record<string, unknown> | null) ?? {}).specDocFix as
    | SpecDocFixContext
    | undefined;
  if (docFix?.specPath) {
    survivingPlan = collapseProposalPlan(survivingPlan, docFix);
  }

  // First pass: create all tasks with empty dependsOn to get their IDs
  const refToId: Record<string, string> = {};
  const refToTitle: Record<string, string> = {};
  const createdTaskIds: string[] = [];

  for (const step of survivingPlan) {
    const intentInfo = stepIntent.get(step.ref);
    const [created] = await db
      .insert(tasks)
      .values({
        workspaceId: task.workspaceId,
        title: step.title,
        description: step.description || null,
        parentTaskId: planningTaskId,
        missionId: task.missionId,
        mode: 'execution',
        taskClass: 'work',
        creationSource: options?.autoApproved ? 'orchestrator' : 'api',
        status: 'pending',
        priority: step.priority ?? 0,
        roleSlug: step.roleSlug || null,
        requiredCapabilities: step.requiredCapabilities ?? [],
        outputRequirement: step.outputRequirement as 'pr_required' | 'artifact_required' | 'none' | 'auto' | undefined,
        // A proposal child inherits the doc-fix task's scope so the §11
        // dispatch injection fires on the same document it is finalizing.
        ...(docFix?.specPath ? { pathManifest: task.pathManifest ?? [docFix.specPath] } : {}),
        dependsOn: [], // Updated in second pass
        ...(intentInfo ? {
          kind: 'coordination' as const,
          subjectAnchor: {
            version: 1,
            kind: 'mission',
            subjectMissionId: task.missionId ?? undefined,
            source: 'system',
            confidence: 'derived',
            coordinationIntent: intentInfo.intent,
            subjectPrNumbers: intentInfo.prNumbers,
          } satisfies TaskSubjectAnchor,
        } : {}),
        context: {
          ...(step.model ? { model: step.model } : {}),
          ...(step.skillSlugs?.length ? { skillSlugs: step.skillSlugs } : {}),
          ...(options?.autoApproved ? { autoApproved: true } : {}),
          // The link back to the ledger: this child exists to settle these rows,
          // and the spec text it updates is the one they name.
          ...(docFix?.specPath ? { specDocFix: docFix, finalizesProposal: true } : {}),
          ...(mission?.integrationBranchEnabled && mission?.workingBranch ? { headBranch: mission.workingBranch } : {}),
          ...(integrationBase ? { baseBranch: integrationBase } : {}),
        },
      })
      .returning();

    refToId[step.ref] = created.id;
    refToTitle[step.ref] = step.title;
    createdTaskIds.push(created.id);
  }

  // Second pass: resolve dependsOn refs and baseBranch to actual IDs/branch names
  for (const step of survivingPlan) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (step.dependsOn && step.dependsOn.length > 0) {
      const resolvedDeps = step.dependsOn
        .map((ref) => refToId[ref])
        .filter(Boolean);
      if (resolvedDeps.length > 0) {
        updates.dependsOn = resolvedDeps;
      }
    }

    // Resolve baseBranch ref to the dependency's actual branch
    if (step.baseBranch && refToId[step.baseBranch]) {
      const resolvedBase = await resolveDependencyBranch(
        refToId[step.baseBranch],
        refToTitle[step.baseBranch],
        gitConfig,
      );

      // Merge baseBranch into existing context
      const existingCtx = (await db.query.tasks.findFirst({
        where: eq(tasks.id, refToId[step.ref]),
        columns: { context: true },
      }))?.context as Record<string, unknown> || {};

      updates.context = { ...existingCtx, baseBranch: resolvedBase };
    }

    if (Object.keys(updates).length > 1) { // more than just updatedAt
      await db
        .update(tasks)
        .set(updates as any)
        .where(eq(tasks.id, refToId[step.ref]));
    }
  }

  return { taskIds: createdTaskIds, ...(droppedSteps.length > 0 ? { droppedSteps } : {}) };
}

/**
 * The branch a plan step should stack on top of: the branch of the dependency
 * task it named via `baseBranch`.
 *
 * Read, do not re-derive. In order:
 *
 *  1. `workers.branch` — the observed branch. Once a worker row exists this is
 *     the branch that IS checked out, including names no formula reproduces:
 *     the claim route's shared mission branch, or the runner's
 *     `<branch>-w<workerId8>` fallback when the requested branch was already
 *     held by another worktree (`git-operations.ts` shared-branch guard).
 *  2. `context.headBranch` — the shared mission working branch (seeded from
 *     `missions.workingBranch`). The claim route uses it verbatim and never
 *     consults the generator, so reading the dependency's persisted context is
 *     how the mission branch is honoured. When a mission has opted into an
 *     integration branch (integrationBranchEnabled=true), all child tasks are
 *     created with headBranch set to the mission's working branch so they all
 *     work on the shared branch. The organizer's planning task does not get
 *     headBranch set (even for A′ missions) — it stays on its own task branch.
 *  3. Only if neither exists: predict, via the SAME generator the claim route
 *     calls. This is genuinely unavoidable here — pass 1 has only just created
 *     the dependency, so no worker can exist yet — but it is now one function,
 *     not a copy that can drift.
 */
async function resolveDependencyBranch(
  depTaskId: string,
  depTitle: string,
  gitConfig: BranchNameGitConfig | null,
): Promise<string> {
  const worker = await db.query.workers.findFirst({
    where: eq(workers.taskId, depTaskId),
    orderBy: desc(workers.createdAt),
    columns: { branch: true },
  });
  if (worker?.branch) return worker.branch;

  return generateTaskBranchName({
    taskId: depTaskId,
    title: depTitle,
    gitConfig,
  });
}

/**
 * Detect circular dependencies in plan steps using DFS.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCircularDeps(
  steps: Array<{ ref: string; dependsOn?: string[] }>
): string[] | null {
  const graph = new Map<string, string[]>();
  for (const step of steps) {
    graph.set(step.ref, step.dependsOn ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of graph.get(node) ?? []) {
      if (graph.has(dep)) {
        const cycle = dfs(dep, path);
        if (cycle) return cycle;
      }
    }

    path.pop();
    inStack.delete(node);
    return null;
  }

  for (const ref of graph.keys()) {
    const cycle = dfs(ref, []);
    if (cycle) return cycle;
  }
  return null;
}
