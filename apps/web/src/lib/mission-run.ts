import { db } from '@buildd/core/db';
import { missions, tasks, workspaces, missionNotes, workers } from '@buildd/core/db/schema';
import { eq, and, not, isNotNull, inArray, sql, isNull } from 'drizzle-orm';
import { findBlockingPr, pathsOverlap, REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import { buildMissionContext as _buildMissionContext } from '@/lib/mission-context';
import { dispatchNewTask as _dispatchNewTask } from '@/lib/task-dispatch';
import { getOrCreateCoordinationWorkspace as _getOrCreateCoordinationWorkspace } from '@/lib/orchestrator-workspace';
import { getMissionSpendUsd as _getMissionSpendUsd, exhaustMissionBudget as _exhaustMissionBudget } from '@/lib/mission-budget';
import { notifyMissionPrReady } from '@/lib/mission-notifications';
import { isMissionBlocked } from '@/lib/mission-dependency';
import { ensureMissionIntegrationBranch } from '@/lib/mission-integration-branch';
import { generateMissionBranchName } from '@buildd/core/branch-names';
import { triggerEvent as _triggerEvent, channels, events } from '@/lib/pusher';
import {
  prepareSubjectFiling,
  recordSubjectMatchObserved,
} from '@/lib/subject-anchor-observer';

// One durable note per mission, not one per organizer cycle. Matched by
// title, so this string is load-bearing — the dedupe query reads it.
const INTEGRATION_BRANCH_NOTE_TITLE = 'Integration branch unavailable';

async function recordOrganizerDuplicate(
  task: typeof tasks.$inferSelect,
  subjectMissionId: string,
  recordMatch: typeof recordSubjectMatchObserved,
) {
  await recordMatch({
    workspaceId: task.workspaceId,
    origin: 'organizer',
    anchor: {
      version: 1,
      kind: 'mission',
      subjectMissionId,
      source: 'system',
      confidence: 'exact',
    },
    match: {
      taskId: task.id,
      matchedOrigin: task.creationSource ?? 'orchestrator',
      outcome: 'attach',
      keyType: 'mission',
    },
  });
}

/**
 * Worker states in which a PR row still represents an open PR. Same set the
 * claim route's path-overlap backstop uses (`api/workers/claim/route.ts`), so
 * "open PR" means one thing at planning time and at claim time.
 */
const OPEN_PR_WORKER_STATUSES = ['running', 'idle', 'starting', 'waiting_input', 'completed'] as const;

/** Task states whose declared paths are work this mission has not landed yet. */
const REMAINING_TASK_STATUSES = new Set(['pending', 'assigned', 'in_progress']);

export interface MissionOpenPrGate {
  /** True when planning must pause. */
  paused: boolean;
  /** Every open, unmerged PR under this mission — not just `primaryPrNumber`. */
  openPrCount: number;
  /**
   * Why the gate decided as it did. `scope_unknown` is the honest-uncertainty
   * verdict: PRs are open but the remaining work declares no concrete paths, so
   * no overlap claim can be made either way.
   */
  reason: 'overlap' | 'no_open_prs' | 'scope_unknown' | 'no_overlap';
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  /** The declared paths that the blocking PR also touches. */
  overlapPaths: string[];
}

/**
 * Decide whether an open PR should pause this mission's planning.
 *
 * WHY THIS IS NOT KEYED ON `missions.primaryPrNumber` (B7/P3): that column means
 * "the first PR any task of this mission opened", not "the mission's PR". Gating
 * on it halted decomposition for whichever sibling PR happened to be first —
 * while the mission's other open PRs went uncounted — and under any mission-PR
 * model the primary PR is open for the mission's whole life, so the organizer
 * would never plan again.
 *
 * The rule is now the one P3 asks for: pause on **an open PR whose paths overlap
 * the next planned task**, answered with the same path-claim machinery the claim
 * route uses (`findBlockingPr`, so the sentinel/advisory rules cannot diverge —
 * see packages/core/path-overlap.ts).
 *
 * THE KNOWN LIMIT: the organizer's *next* task does not exist yet at gate time,
 * so its paths are unknowable. The proxy is the mission's already-declared
 * remaining scope (its pending/assigned/in_progress tasks). When that scope is
 * undeclared — `null`, `[]`, or the `'**'` sentinel — this returns
 * `scope_unknown` and does NOT pause: an honest "I cannot tell" beats halting
 * every mission. The safety property that survives is narrower but real:
 *
 *   the organizer never fans out a planning cycle while an open PR of this
 *   mission already owns a concrete path that the mission's own remaining work
 *   has declared.
 *
 * What that costs: when the remaining scope is undeclared, task *creation* is no
 * longer gated and the only protection left is claim time — layer 1
 * (`findBlockingPr`), layer 2 (`path_claims`), and the mission advisory-manifest
 * deferral. Those serialize execution, not creation, so a mission can accumulate
 * pending tasks that then sit deferred. That is a WIP-visibility cost, not a
 * conflicting-edit cost.
 *
 * Openness is read from worker rows (DB only, no GitHub round-trip), so a stale
 * `workers.mergedAt` can delay one cycle; the next retrigger re-evaluates.
 * `prLifecycleStatus` of `closed`/`merged` is excluded outright.
 */
export async function evaluateMissionOpenPrGate(missionId: string): Promise<MissionOpenPrGate> {
  const idle: MissionOpenPrGate = {
    paused: false, openPrCount: 0, reason: 'no_open_prs',
    prNumber: null, prUrl: null, headSha: null, overlapPaths: [],
  };

  const missionTasks = (await db.query.tasks.findMany({
    where: eq(tasks.missionId, missionId),
    columns: { id: true, status: true, pathManifest: true },
  })) ?? [];
  if (missionTasks.length === 0) return idle;

  const openPrWorkers = (await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, missionTasks.map(t => t.id)),
      isNotNull(workers.prUrl),
      isNull(workers.mergedAt),
      inArray(workers.status, [...OPEN_PR_WORKER_STATUSES]),
    ),
    columns: { taskId: true, prNumber: true, prUrl: true, lastCommitSha: true, prLifecycleStatus: true },
  })) ?? [];
  const activeOpenPrWorkers = openPrWorkers.filter(
    w => w.prLifecycleStatus !== 'closed' && w.prLifecycleStatus !== 'merged',
  );
  if (activeOpenPrWorkers.length === 0) return idle;

  const manifestByTask = new Map(
    missionTasks.map(t => [t.id, (t.pathManifest as string[] | null) ?? null]),
  );
  const prTaskIds = new Set(activeOpenPrWorkers.map(w => w.taskId).filter(Boolean) as string[]);
  const openPrTasks = activeOpenPrWorkers.map(w => ({
    pathManifest: w.taskId ? manifestByTask.get(w.taskId) ?? null : null,
    prNumber: w.prNumber ?? null,
    prUrl: w.prUrl ?? null,
    headSha: w.lastCommitSha ?? null,
  }));
  const openPrCount = openPrTasks.length;

  // Remaining scope: concrete paths declared by mission tasks that have not
  // landed. Tasks that own one of the open PRs are excluded — a PR cannot block
  // itself. The '**' sentinel is stripped rather than treated as a veto: it says
  // "scope not fully declared", which is no reason to discard the parts that are
  // (same reading as the claim route's layer-2 backstop).
  const remainingScope = [...new Set(
    missionTasks
      .filter(t => REMAINING_TASK_STATUSES.has(t.status) && !prTaskIds.has(t.id))
      .flatMap(t => ((t.pathManifest as string[] | null) ?? []))
      .filter(p => p && p !== REPO_WIDE_SENTINEL),
  )];
  if (remainingScope.length === 0) {
    return { ...idle, openPrCount, reason: 'scope_unknown' };
  }

  const blocking = findBlockingPr(remainingScope, openPrTasks);
  if (!blocking) {
    return { ...idle, openPrCount, reason: 'no_overlap' };
  }

  const blockingEntry = openPrTasks.find(
    t => t.prNumber === blocking.prNumber && t.prUrl === blocking.prUrl,
  );
  const blockingManifest = blockingEntry?.pathManifest ?? [];
  return {
    paused: true,
    openPrCount,
    reason: 'overlap',
    prNumber: blocking.prNumber,
    prUrl: blocking.prUrl,
    headSha: blockingEntry?.headSha ?? null,
    overlapPaths: remainingScope.filter(p => pathsOverlap([p], blockingManifest)),
  };
}

export interface RunMissionResult {
  task: typeof tasks.$inferSelect | null;
  /** True when an in-flight planning task was returned instead of creating a new one */
  deduped?: boolean;
  /** True when planning was skipped because an open PR owns paths the mission's remaining work needs */
  skippedPrOpen?: boolean;
  /** The PR that caused skippedPrOpen, when it could be identified */
  blockingPrNumber?: number;
  /** True when planning was skipped because an upstream mission's gate condition is not yet met */
  skippedBlocked?: boolean;
  /** Human-readable reason for skippedBlocked (e.g. "Waiting for mission X to merge") */
  blockedReason?: string;
  /** True when spawning was blocked because the mission's cost budget is exhausted */
  skippedBudgetExhausted?: boolean;
}

export interface CycleContext {
  cycleNumber: number;
  triggerChainId: string;
  triggerSource: 'cron' | 'manual' | 'retrigger' | 'auto_retry';
}

export interface RunMissionOptions {
  manualRun?: boolean;
  cycleContext?: CycleContext;
  /** Corrective feedback from the retrigger loop when a planning cycle created 0 tasks */
  stuckPlanningFeedback?: string;
}

/** Overridable deps for testing without mock.module pollution */
export interface RunMissionDeps {
  buildMissionContext?: typeof _buildMissionContext;
  dispatchNewTask?: typeof _dispatchNewTask;
  getOrCreateCoordinationWorkspace?: typeof _getOrCreateCoordinationWorkspace;
  getMissionSpendUsd?: (missionId: string) => Promise<number>;
  exhaustMissionBudget?: (missionId: string, title: string, spendUsd: number, budgetUsd: number) => Promise<void>;
  prepareSubjectFiling?: typeof prepareSubjectFiling;
  recordSubjectMatchObserved?: typeof recordSubjectMatchObserved;
  triggerEvent?: typeof _triggerEvent;
}

/**
 * Trigger an immediate planning task for a mission.
 * Builds rich mission context (task history, active tasks, failures)
 * and creates + dispatches a planning task.
 *
 * Used by manual run endpoint, auto-start after mission creation, and closed-loop re-triggers.
 */
export async function runMission(
  missionId: string,
  options?: RunMissionOptions,
  deps?: RunMissionDeps,
): Promise<RunMissionResult> {
  const buildMissionContext = deps?.buildMissionContext ?? _buildMissionContext;
  const dispatchNewTask = deps?.dispatchNewTask ?? _dispatchNewTask;
  const getOrCreateCoordinationWorkspace = deps?.getOrCreateCoordinationWorkspace ?? _getOrCreateCoordinationWorkspace;
  const getMissionSpendUsd = deps?.getMissionSpendUsd ?? _getMissionSpendUsd;
  const exhaustMissionBudget = deps?.exhaustMissionBudget ?? _exhaustMissionBudget;
  const prepareSubject = deps?.prepareSubjectFiling ?? prepareSubjectFiling;
  const recordSubjectMatch = deps?.recordSubjectMatchObserved ?? recordSubjectMatchObserved;
  const triggerEvent = deps?.triggerEvent ?? _triggerEvent;

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    with: { schedule: true },
  });

  if (!mission) {
    throw new Error('Mission not found');
  }

  if (mission.status !== 'active') {
    throw new Error(`Cannot run mission with status: ${mission.status}. Only active missions can be run.`);
  }

  // Dependency gate: don't plan if the upstream mission's gate condition isn't met
  const blockStatus = await isMissionBlocked({
    id: mission.id,
    dependsOnMissionId: mission.dependsOnMissionId ?? null,
    gateCondition: mission.gateCondition,
    dependencyMetAt: mission.dependencyMetAt ?? null,
  });
  if (blockStatus.blocked) {
    console.log(`[runMission] Mission ${missionId} blocked: ${blockStatus.reason}`);
    return { task: null, skippedBlocked: true, blockedReason: blockStatus.reason };
  }

  // Budget gate: check aggregate spend before spawning a new planning task
  if (mission.costBudgetUsd != null) {
    const spendUsd = await getMissionSpendUsd(missionId);
    const budgetUsd = parseFloat(mission.costBudgetUsd as string);
    if (spendUsd >= budgetUsd) {
      await exhaustMissionBudget(missionId, mission.title, spendUsd, budgetUsd);
      return { task: null, skippedBudgetExhausted: true };
    }
  }

  // Dedupe: if a planning task for this mission is already in-flight, return it
  // instead of creating another. Prevents double-runs from stale client state (e.g.
  // iOS Pusher missing a cron-fired run, user taps Run, two parallel planners start).
  // Safe for other callers: cron path creates tasks directly (not via runMission),
  // retrigger runs only after the prior planner is in a terminal state, and mission
  // auto-start happens at creation when no tasks exist yet.
  const inFlight = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.missionId, missionId),
      eq(tasks.mode, 'planning'),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  if (inFlight) {
    await recordOrganizerDuplicate(inFlight, mission.id, recordSubjectMatch);
    return { task: inFlight, deduped: true };
  }

  // Also dedupe against cron-created tasks for the same schedule. For heartbeat
  // missions, the cron creates tasks with mode='execution' (not 'planning'), so
  // the check above misses them. A manual run arriving while a cron task is active
  // would otherwise start a concurrent planning cycle that duplicates execution tasks.
  if (mission.scheduleId) {
    const cronInFlight = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.missionId, missionId),
        eq(tasks.scheduleId, mission.scheduleId),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    if (cronInFlight) {
      await recordOrganizerDuplicate(cronInFlight, mission.id, recordSubjectMatch);
      return { task: cronInFlight, deduped: true };
    }
  }

  // Resolve workspace: use mission's workspace or auto-create an orchestrator workspace
  const workspaceId = mission.workspaceId
    || (await getOrCreateCoordinationWorkspace(mission.teamId)).id;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });

  // Open-PR planning gate. Pauses planning only when an open PR of this mission
  // touches paths the mission's remaining work has already declared — see
  // evaluateMissionOpenPrGate for why `primaryPrNumber` is the wrong key.
  const prGate = await evaluateMissionOpenPrGate(missionId);
  if (prGate.paused) {
    if (prGate.prNumber && prGate.prUrl) {
      await notifyMissionPrReady(missionId, {
        title: `Mission PR awaiting review`,
        prUrl: prGate.prUrl,
        prNumber: prGate.prNumber,
        headSha: prGate.headSha || String(prGate.prNumber),
        reason: 'awaiting_review',
        message: `${mission.title} — PR #${prGate.prNumber} is open and owns files the next planned work needs (${prGate.overlapPaths.join(', ')}). Planning paused until it merges.`,
      });
    }
    console.log(`[runMission] Mission ${missionId} planning paused: PR #${prGate.prNumber ?? '?'} overlaps ${prGate.overlapPaths.join(', ')}`);
    return { task: null, skippedPrOpen: true, blockingPrNumber: prGate.prNumber ?? undefined };
  }
  if (prGate.openPrCount > 0) {
    // Deliberately not a pause. Recorded so "the organizer planned while N PRs
    // were open" is answerable after the fact.
    console.log(`[runMission] Mission ${missionId}: ${prGate.openPrCount} open PR(s), planning anyway (${prGate.reason})`);
  }

  // Generate a shared mission working branch on first task. All mission tasks
  // push commits to this branch so a single PR tracks the entire mission.
  let workingBranch = mission.workingBranch;
  if (!workingBranch && workspace?.repo) {
    const candidate = generateMissionBranchName({ missionId: mission.id, title: mission.title });
    const [updated] = await db
      .update(missions)
      .set({ workingBranch: candidate, updatedAt: new Date() })
      .where(and(eq(missions.id, missionId), isNull(missions.workingBranch)))
      .returning({ workingBranch: missions.workingBranch });
    workingBranch = updated?.workingBranch
      ?? (await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
        columns: { workingBranch: true },
      }))?.workingBranch
      ?? candidate;
  }

  // Option A′: an opted-in mission's integration branch has to exist on the
  // remote before any task PR can target it — GitHub rejects a PR whose base
  // ref is absent. Doing it here (rather than only at opt-in time) covers the
  // mission that was opted in before it had a `workingBranch` at all, which is
  // the common case: the branch name is generated a few lines above, on the
  // first organizer pass.
  if (workingBranch && mission.integrationBranchEnabled) {
    const ensured = await ensureMissionIntegrationBranch(missionId);
    if (!ensured.ok) {
      console.error(
        `[runMission] Mission ${missionId}: integration branch ${workingBranch} unavailable (${ensured.reason}${ensured.detail ? `: ${ensured.detail}` : ''})`,
      );
      const noteBody = `This mission uses an integration branch (\`${workingBranch}\`), but it could not be created on the remote (${ensured.reason}${ensured.detail ? `: ${ensured.detail}` : ''}). Task PRs cannot open against a base that does not exist, so this blocks the mission's deliverable work until it is resolved.`;
      // Post once, not once per organizer cycle: repeating a durable failure
      // every heartbeat would bury the mission feed.
      const existingNote = await db.query.missionNotes.findFirst({
        where: and(
          eq(missionNotes.missionId, missionId),
          eq(missionNotes.title, INTEGRATION_BRANCH_NOTE_TITLE),
          eq(missionNotes.status, 'open'),
        ),
        columns: { id: true },
      });
      if (!existingNote) {
        await db.insert(missionNotes).values({
          missionId,
          authorType: 'system',
          type: 'decision',
          title: INTEGRATION_BRANCH_NOTE_TITLE,
          body: noteBody,
          status: 'open',
        });
      } else {
        // Still broken, and possibly for a DIFFERENT reason than the one on the
        // open note. "Post once" must not mean "report the first reason forever":
        // refresh the body in place so the one open blocker note always describes
        // the current failure, rather than dropping the new reason on the floor.
        // Same shape as the dead-PR escalation note.
        await db
          .update(missionNotes)
          .set({ body: noteBody })
          .where(eq(missionNotes.id, existingNote.id));
      }
    } else {
      // ── Resolve the blocker note now that the branch exists ────────────────
      // Nothing used to clear this note, and because the dedupe above keys on
      // `status='open'`, a stale one did more than linger: it SUPPRESSED the next
      // genuine failure, which is the report an operator actually needs. So a
      // success closes it.
      //
      // 'superseded' rather than 'dismissed': dismissal is the human/API action
      // (see VALID_STATUSES in the notes routes), while 'superseded' is what the
      // system uses when an event makes a note untrue — the same status
      // escalation-supersession and dead-pr-shutdown set. The row stays as an
      // audit trail. `supersededByPrNumber` is left null: there is no successor
      // PR here, the condition simply resolved.
      //
      // One atomic UPDATE with the "still open" predicate in the WHERE, so a note
      // a human has already answered or dismissed is not reopened or relabelled,
      // and .returning() is the did-anything-change signal.
      try {
        const resolved = await db
          .update(missionNotes)
          .set({ status: 'superseded' })
          .where(and(
            eq(missionNotes.missionId, missionId),
            eq(missionNotes.title, INTEGRATION_BRANCH_NOTE_TITLE),
            eq(missionNotes.status, 'open'),
          ))
          .returning({ id: missionNotes.id });
        if (resolved.length > 0) {
          console.log(
            `[runMission] Mission ${missionId}: integration branch ${ensured.branch} available — resolved ${resolved.length} open '${INTEGRATION_BRANCH_NOTE_TITLE}' note(s)`,
          );
        }
      } catch (err) {
        // Never fail an organizer pass over feed bookkeeping. A missed resolution
        // is retried on the next pass, since this runs on every cycle.
        console.error(`[runMission] Mission ${missionId}: failed to resolve integration-branch note:`, err);
      }
    }
  }

  const baseBranch = workspace?.gitConfig?.defaultBranch || 'main';

  // Get template context from schedule if available
  const templateContext = (mission.schedule as any)?.taskTemplate?.context as Record<string, unknown> | undefined;

  // Build cycle context — default to cycle 1 with new chain if not provided
  const cycleCtx: CycleContext = options?.cycleContext || {
    cycleNumber: 1,
    triggerChainId: crypto.randomUUID(),
    triggerSource: 'manual',
  };

  // Pre-filed task detection — fires on first organizer evaluation only.
  // If the mission already has ≥1 non-orchestrator task linked before the organizer's
  // first decomposition pass, persist decompositionSkipped=true and post a decision note.
  // Subsequent runs read the persisted flag instead of re-querying.
  let decompositionSkipped = mission.decompositionSkipped ?? false;
  if (!decompositionSkipped && mission.orchestrationMode !== 'manual') {
    const [preFiledRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(
        eq(tasks.missionId, missionId),
        not(eq(tasks.creationSource, 'orchestrator')),
        not(eq(tasks.mode, 'planning')),
      ));
    const preFiledCount = preFiledRow?.count ?? 0;
    if (preFiledCount > 0) {
      decompositionSkipped = true;
      await db
        .update(missions)
        .set({ decompositionSkipped: true, updatedAt: new Date() })
        .where(eq(missions.id, missionId));
      await db.insert(missionNotes).values({
        missionId,
        authorType: 'system',
        type: 'decision',
        title: 'Decomposition skipped — pre-filed tasks detected',
        body: `Found ${preFiledCount} pre-filed task(s) linked to this mission before the organizer's first evaluation. Switching to coordinate-only mode: the organizer will coordinate existing tasks but will not create new ones except for retry children of failed tasks.`,
        status: 'open',
      });
      console.log(`[runMission] Mission ${missionId}: ${preFiledCount} pre-filed task(s) detected — coordinate-only mode`);
    }
  }

  // Build rich mission context (pass cycle info so context builder can surface it)
  const missionContext = await buildMissionContext(missionId, {
    ...templateContext,
    cycleNumber: cycleCtx.cycleNumber,
    triggerChainId: cycleCtx.triggerChainId,
    triggerSource: cycleCtx.triggerSource,
    decompositionSkipped,
  });

  const taskTitle = `Mission: ${mission.title}`;
  let taskDescription = missionContext?.description || mission.description || null;
  if (options?.stuckPlanningFeedback && taskDescription) {
    taskDescription = `> **System Feedback**: ${options.stuckPlanningFeedback}\n\n${taskDescription}`;
  }
  const taskContext: Record<string, unknown> = {
    ...(missionContext?.context || {}),
    ...(options?.manualRun ? { manualRun: true } : {}),
    ...(options?.stuckPlanningFeedback ? { stuckPlanningFeedback: options.stuckPlanningFeedback } : {}),
    cycleNumber: cycleCtx.cycleNumber,
    triggerChainId: cycleCtx.triggerChainId,
    triggerSource: cycleCtx.triggerSource,
    // The organizer's planning task must NOT be checked out on the integration
    // branch once that branch is real work.
    //
    // `headBranch` is used verbatim by the claim route, so the planning worker's
    // `workers.branch` becomes `mission/<slug>-<id8>` — and the runner then
    // creates a LOCAL branch of that name pointing at trunk. Harmless while the
    // column was inert bookkeeping; under Option A′ that remote ref holds every
    // merged task PR of the mission, so a plain push is a non-fast-forward
    // reject and a force-push would reset the integration branch to trunk and
    // destroy the mission's landed work. The organizer plans; it does not need
    // the mission's branch, so opted-in missions give it its own task branch.
    ...(workingBranch && !mission.integrationBranchEnabled
      ? { headBranch: workingBranch, baseBranch }
      : {}),
  };

  // Get template config for mode/priority from schedule if available
  const template = (mission.schedule as any)?.taskTemplate;
  const subjectObservation = await prepareSubject({
    workspaceId,
    workspaceRepo: workspace?.repo
      ?.replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, ''),
    gitConfig: workspace?.gitConfig,
    title: taskTitle,
    description: taskDescription ?? undefined,
    context: taskContext,
    systemContext: {
      origin: 'organizer',
      subjectMissionId: mission.id,
      branch: workingBranch ?? undefined,
    },
    origin: 'organizer',
  });

  // Derive heartbeat role from mission's dominant child task role
  // (first heartbeat with no tasks yet falls back to organizer)
  let roleSlug = template?.roleSlug || 'organizer';
  if (roleSlug === 'organizer') {
    const dominantRole = await db
      .select({ roleSlug: tasks.roleSlug, count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(
        eq(tasks.missionId, mission.id),
        not(eq(tasks.mode, 'planning')),
        isNotNull(tasks.roleSlug),
      ))
      .groupBy(tasks.roleSlug)
      .orderBy(sql`count(*) desc`)
      .limit(1);
    if (dominantRole[0]?.roleSlug) {
      roleSlug = dominantRole[0].roleSlug;
    }
  }

  // Create the planning task — atomic dedup via DB unique constraint.
  // The partial unique index (mode=planning, status IN active states) ensures only
  // one in-flight planning task exists per mission even if two callers race past
  // the soft dedup check above.
  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId,
      title: taskTitle,
      description: taskDescription,
      priority: template?.priority || mission.priority || 0,
      status: 'pending',
      mode: template?.mode || 'planning',
      taskClass: 'bookkeeping',
      roleSlug,
      runnerPreference: template?.runnerPreference || 'any',
      requiredCapabilities: template?.requiredCapabilities || [],
      context: taskContext,
      creationSource: 'orchestrator',
      missionId: mission.id,
      ...subjectObservation.taskValues,
      // Run the planning task on the mission's chosen backend so the whole
      // mission (including the organizer) stays on one agent backend.
      ...(mission.defaultBackend ? { backend: mission.defaultBackend } : {}),
    })
    .onConflictDoNothing()
    .returning();

  if (!task) {
    // Another caller won the race — fetch the task they inserted
    const inFlight = await db.query.tasks.findFirst({
      where: and(
        eq(tasks.missionId, missionId),
        eq(tasks.mode, 'planning'),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    if (inFlight) await recordOrganizerDuplicate(inFlight, mission.id, recordSubjectMatch);
    return { task: inFlight ?? null, deduped: true };
  }

  if (subjectObservation.anchor && subjectObservation.match) {
    await recordSubjectMatch({
      workspaceId,
      origin: 'organizer',
      reportingTaskId: task.id,
      anchor: subjectObservation.anchor,
      match: subjectObservation.match,
    });
  }

  if (workspace) {
    await dispatchNewTask(task, workspace);
  }

  // Announce the cycle on the mission channel. The cron path (mission-loop.ts)
  // already does this; the manual path used to be silent on the wire, so a
  // client that clicked "Plan now" had nothing to listen to and the orchestrator
  // worked invisibly for minutes.
  await Promise.resolve(
    triggerEvent(channels.mission(missionId), events.MISSION_CYCLE_STARTED, {
      missionId,
      cycleNumber: cycleCtx.cycleNumber,
      triggerChainId: cycleCtx.triggerChainId,
      triggerSource: cycleCtx.triggerSource,
      planningTaskId: task.id,
    }),
  ).catch((e) => console.error('[runMission] cycle_started emit failed:', e));

  return { task };
}
