import { db } from '@buildd/core/db';
import { tasks, missions, taskRecipes, taskSchedules, workspaceSkills, workers, artifacts, workspaces } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { detectMissionPhase, type MissionPhaseData } from './heartbeat-helpers';

const HEARTBEAT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'action_taken', 'error'] },
    summary: { type: 'string' },
    checksPerformed: { type: 'array', items: { type: 'string' } },
    actionsPerformed: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

/** Detect if this mission involves code/build work based on skills and role patterns */
function isBuildMission(
  templateContext: Record<string, unknown> | undefined,
  completedTasks: Array<{ roleSlug?: string | null }>
): boolean {
  const skillSlugs = (templateContext?.skillSlugs as string[]) || [];
  if (skillSlugs.includes('builder')) return true;
  const builderCount = completedTasks.filter(t => (t as any).roleSlug === 'builder').length;
  return builderCount > 0 && builderCount >= completedTasks.length / 2;
}

function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Check if the current hour falls within an active hours window.
 * Handles both normal ranges (9-17) and overnight ranges (22-6).
 */
export function isWithinActiveHours(currentHour: number, start: number, end: number): boolean {
  if (start < end) {
    // Normal range: e.g., 9-17
    return currentHour >= start && currentHour < end;
  }
  if (start > end) {
    // Overnight range: e.g., 22-6
    return currentHour >= start || currentHour < end;
  }
  // start === end means all hours active
  return true;
}

/**
 * Fetch available roles for a workspace with current load.
 * Reusable by both the context builder and the /api/roles endpoint.
 */
export async function getWorkspaceRoles(workspaceId: string) {
  const allRoles = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.workspaceId, workspaceId),
      eq(workspaceSkills.isRole, true),
      eq(workspaceSkills.enabled, true),
    ),
    columns: {
      slug: true,
      name: true,
      model: true,
      color: true,
      description: true,
    },
  });

  // Deduplicate by slug
  const seenSlugs = new Set<string>();
  const uniqueRoles = allRoles.filter(r => {
    if (seenSlugs.has(r.slug)) return false;
    seenSlugs.add(r.slug);
    return true;
  });

  // Count active workers per role slug
  const activeWorkerCounts = await db
    .select({
      roleSlug: tasks.roleSlug,
      count: sql<number>`count(distinct ${workers.id})::int`,
    })
    .from(workers)
    .innerJoin(tasks, eq(workers.taskId, tasks.id))
    .where(
      and(
        eq(workers.workspaceId, workspaceId),
        inArray(workers.status, ['running', 'starting', 'waiting_input']),
      )
    )
    .groupBy(tasks.roleSlug);

  const loadMap: Record<string, number> = {};
  for (const row of activeWorkerCounts) {
    if (row.roleSlug) loadMap[row.roleSlug] = row.count;
  }

  // Count completed tasks per role (last 30 days) for usage signal
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const completedCounts = await db
    .select({
      roleSlug: tasks.roleSlug,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.status, 'completed'),
        sql`${tasks.roleSlug} IS NOT NULL`,
        sql`${tasks.createdAt} >= ${thirtyDaysAgo}`,
      )
    )
    .groupBy(tasks.roleSlug);

  const completedMap: Record<string, number> = {};
  for (const row of completedCounts) {
    if (row.roleSlug) completedMap[row.roleSlug] = row.count;
  }

  return uniqueRoles.map(r => ({
    slug: r.slug,
    name: r.name,
    model: r.model,
    color: r.color,
    description: r.description,
    currentLoad: loadMap[r.slug] || 0,
    completedTasks30d: completedMap[r.slug] || 0,
  }));
}

/**
 * Build rich context for a mission planning task.
 * Queries task history, active tasks, failures, available roles, and optional recipe playbook.
 * Detects heartbeat mode from the schedule's taskTemplate context and produces specialised instructions.
 */
export async function buildMissionContext(missionId: string, templateContext?: Record<string, unknown>) {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
    columns: {
      id: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      teamId: true,
      workspaceId: true,
      scheduleId: true,
      lastEvaluationTaskId: true,
      contextArtifactIds: true,
    },
  });
  if (!mission) return null;

  // Resolve heartbeat config from the schedule's taskTemplate.context
  let isHeartbeat = false;
  let heartbeatChecklist: string | null = null;
  let scheduleContext: Record<string, unknown> | undefined;
  if (mission.scheduleId) {
    const schedule = await db.query.taskSchedules.findFirst({
      where: eq(taskSchedules.id, mission.scheduleId),
      columns: { taskTemplate: true },
    });
    scheduleContext = schedule?.taskTemplate?.context as Record<string, unknown> | undefined;
    if (scheduleContext?.heartbeat === true) {
      isHeartbeat = true;
      heartbeatChecklist = (scheduleContext.heartbeatChecklist as string) || null;
    }
  }
  // Also check templateContext passed in (e.g. from cron handler)
  if (templateContext?.heartbeat === true) {
    isHeartbeat = true;
    if (templateContext.heartbeatChecklist) {
      heartbeatChecklist = templateContext.heartbeatChecklist as string;
    }
  }

  // ── Heartbeat mode ──
  // Only use heartbeat context for cron-triggered runs. Initial creation,
  // manual runs, and retriggers should use full planning mode so the
  // orchestrator actually creates execution subtasks instead of just reporting.
  const triggerSource = templateContext?.triggerSource as string | undefined;
  const useHeartbeatMode = isHeartbeat && triggerSource === 'cron';

  if (useHeartbeatMode) {
    // Resolve skillSlugs from templateContext or schedule for role-gated sections
    const skillSlugs = (templateContext?.skillSlugs as string[])
      || (Array.isArray(scheduleContext?.skillSlugs) ? scheduleContext!.skillSlugs as string[] : []);

    return buildHeartbeatContext({
      id: mission.id,
      title: mission.title,
      description: mission.description,
      heartbeatChecklist,
      skillSlugs,
      workspaceId: mission.workspaceId,
    });
  }

  // ── Workspace state for organizer context ──
  let workspaceState: {
    name: string;
    repo: string | null;
    isCoordination: boolean;
    hasGitHubApp: boolean;
  } | null = null;

  let teamWorkspacesList: Array<{ id: string; name: string; repo: string | null }> = [];

  if (mission.workspaceId) {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, mission.workspaceId),
      columns: { id: true, name: true, repo: true, githubInstallationId: true },
    });
    if (ws) {
      workspaceState = {
        name: ws.name,
        repo: ws.repo,
        isCoordination: ws.name === '__coordination',
        hasGitHubApp: !!ws.githubInstallationId,
      };
    }
  }

  if (mission.teamId) {
    teamWorkspacesList = await db.query.workspaces.findMany({
      where: eq(workspaces.teamId, mission.teamId),
      columns: { id: true, name: true, repo: true },
      limit: 20,
    });
  }

  // ── Standard mission context ──
  // Last 10 completed tasks
  const completedTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      eq(tasks.status, 'completed')
    ),
    orderBy: [desc(tasks.createdAt)],
    limit: 10,
    columns: { id: true, title: true, mode: true, result: true, createdAt: true, roleSlug: true },
  });

  // Detect build mission for conditional PR context
  const isBuild = isBuildMission(templateContext, completedTasks);

  // Query tasks that created PRs (build missions only)
  let taskPRs: Array<{ title: string; prUrl: string; prNumber: number }> = [];
  if (isBuild) {
    const tasksWithPRs = await db.query.tasks.findMany({
      where: and(
        eq(tasks.missionId, missionId),
        eq(tasks.status, 'completed'),
        sql`${tasks.result}->>'prUrl' IS NOT NULL`
      ),
      limit: 20,
      columns: { id: true, title: true, result: true },
    });
    taskPRs = tasksWithPRs.map(t => {
      const r = t.result as Record<string, unknown>;
      return { title: t.title, prUrl: r.prUrl as string, prNumber: r.prNumber as number };
    });
  }

  // Active tasks
  const activeTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      inArray(tasks.status, ['pending', 'assigned', 'in_progress'])
    ),
    limit: 5,
    columns: { id: true, title: true, status: true, description: true },
  });

  // Recent failed tasks
  const failedTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      eq(tasks.status, 'failed')
    ),
    orderBy: [desc(tasks.createdAt)],
    limit: 3,
    columns: { id: true, title: true, result: true, description: true },
  });

  // Prior artifacts linked to this mission
  const priorArtifacts = await db.query.artifacts.findMany({
    where: eq(artifacts.missionId, mission.id),
    orderBy: [desc(artifacts.updatedAt)],
    limit: 10,
    columns: { id: true, key: true, type: true, title: true, content: true, updatedAt: true },
  });

  // Referenced artifacts from contextArtifactIds (cross-mission context)
  let referencedArtifacts: typeof priorArtifacts = [];
  if (mission.contextArtifactIds?.length) {
    referencedArtifacts = await db.query.artifacts.findMany({
      where: inArray(artifacts.id, mission.contextArtifactIds),
      limit: 10,
      columns: { id: true, key: true, type: true, title: true, content: true, updatedAt: true },
    });
  }

  const allArtifacts = [...priorArtifacts];
  const seen = new Set(allArtifacts.map(a => a.id));
  for (const a of referencedArtifacts) {
    if (!seen.has(a.id)) allArtifacts.push(a);
  }

  // Recipe playbook (if configured)
  const recipeId = templateContext?.recipeId as string | undefined;
  let recipeSteps: unknown[] | null = null;
  if (recipeId) {
    const recipe = await db.query.taskRecipes.findFirst({
      where: eq(taskRecipes.id, recipeId),
      columns: { name: true, steps: true },
    });
    if (recipe) {
      recipeSteps = recipe.steps as unknown[];
    }
  }

  // Build rich description
  const descParts: string[] = [];
  descParts.push(`## Mission: ${mission.title}`);
  if (mission.description) descParts.push(mission.description);

  // Surface cycle info from closed-loop re-triggers
  const cycleNumber = templateContext?.cycleNumber as number | undefined;
  if (cycleNumber && cycleNumber > 1) {
    descParts.push(`\n**Planning cycle ${cycleNumber}** — Review what changed since the last cycle.`);
    if (cycleNumber >= 4) {
      descParts.push('This mission has been through many cycles. Strongly consider whether objectives are met and the mission can be marked complete.');
    }
  }

  // Surface stuck-planning feedback from retrigger loop
  const stuckFeedback = templateContext?.stuckPlanningFeedback as string | undefined;
  if (stuckFeedback) {
    descParts.push(`\n> **System Feedback**: ${stuckFeedback}`);
  }

  // Workspace state for organizer
  if (workspaceState) {
    descParts.push('\n## Workspace State');
    if (workspaceState.isCoordination) {
      descParts.push(
        '**Current workspace: `__coordination` (meta-workspace)**\n' +
        'This workspace has no repo and is NOT a project workspace.\n' +
        'For code missions (builder tasks), you MUST create a dedicated workspace with a repo before creating tasks.'
      );
    } else {
      descParts.push(`**Current workspace: "${workspaceState.name}"**`);
      if (workspaceState.repo) {
        descParts.push(`Repo: ${workspaceState.repo}`);
      } else {
        descParts.push('Repo: none — use `manage_workspaces action=create_repo` to create one, or `action=update repoUrl=<url>` to link an existing repo.');
      }
    }
    descParts.push(`GitHub App: ${workspaceState.hasGitHubApp ? 'configured (create_repo available)' : 'not configured (use gh CLI to create repos, then update workspace with repoUrl)'}`);
  }

  const projectWorkspaces = teamWorkspacesList.filter(tw => tw.name !== '__coordination');
  if (projectWorkspaces.length > 0) {
    descParts.push('\n## Team Workspaces');
    descParts.push('Existing workspaces (reuse if applicable instead of creating new):');
    for (const tw of projectWorkspaces) {
      descParts.push(`- **${tw.name}**${tw.repo ? ` (${tw.repo})` : ' (no repo)'} — ID: ${tw.id}`);
    }
  }

  if (completedTasks.length > 0) {
    descParts.push('\n## Prior Results (last 10)');
    for (const t of completedTasks) {
      const result = t.result as Record<string, unknown> | null;
      const summary = result?.summary as string || 'no summary';
      const structuredOutput = result?.structuredOutput;
      const nextSuggestion = result?.nextSuggestion as string | undefined;
      let line = `- [${t.title}] ${timeAgo(t.createdAt)}: ${summary}`;
      if (structuredOutput) {
        line += `\n  ${JSON.stringify(structuredOutput)}`;
      }
      if (nextSuggestion) {
        line += `\n  → Next: "${nextSuggestion}"`;
      }
      descParts.push(line);
    }
  }

  // PR awareness for build missions
  if (isBuild && taskPRs.length > 0) {
    descParts.push('\n## Open Pull Requests');
    descParts.push('Tasks created these PRs (may still be open):');
    for (const pr of taskPRs) {
      descParts.push(`- [${pr.title}] — PR #${pr.prNumber}: ${pr.prUrl}`);
    }
    descParts.push('Check PR status before creating new work on the same repo.');
  }

  // Tasks blocked on user input (worker in waiting_input state)
  const waitingTasks = await db.query.workers.findMany({
    where: and(
      eq(workers.status, 'waiting_input'),
    ),
    with: { task: { columns: { id: true, title: true, missionId: true } } },
    columns: { id: true, waitingFor: true },
    limit: 5,
  }).then(ws => ws.filter(w => (w.task as any)?.missionId === missionId));

  if (activeTasks.length > 0) {
    descParts.push('\n## Active Tasks');
    for (const t of activeTasks) {
      let line = `- [${t.title}] status: ${t.status}`;
      if (t.description) line += `\n  ${t.description.slice(0, 200)}`;
      descParts.push(line);
    }
  }

  if (waitingTasks.length > 0) {
    descParts.push('\n## Blocked Tasks (Waiting for User Input)');
    descParts.push('These tasks are paused — a human must respond before they can continue. Consider working around these dependencies or spawning independent tasks.');
    for (const w of waitingTasks) {
      const task = w.task as { title: string } | null;
      const wf = w.waitingFor as { prompt: string } | null;
      descParts.push(`- [${task?.title || 'Unknown'}] Question: "${wf?.prompt || 'unknown'}"`);
    }
  }

  if (failedTasks.length > 0) {
    descParts.push('\n## Failed Tasks (recent)');
    for (const t of failedTasks) {
      const result = t.result as Record<string, unknown> | null;
      const errorSummary = result?.summary as string || 'unknown error';
      let line = `- [${t.title}] error: ${errorSummary}`;
      if (t.description) line += `\n  ${t.description.slice(0, 200)}`;
      descParts.push(line);
    }
  }

  if (recipeSteps) {
    descParts.push('\n## Playbook');
    for (const step of recipeSteps as Array<{ ref?: string; title?: string; description?: string }>) {
      descParts.push(`- [ ] ${step.title || step.ref}${step.description ? `: ${step.description}` : ''}`);
    }
  }

  if (allArtifacts.length > 0) {
    descParts.push('\n## Prior Artifacts');
    for (const a of allArtifacts) {
      const preview = a.content?.slice(0, 150) || '';
      const keyLabel = a.key ? ` (key: ${a.key})` : '';
      descParts.push(`- **${a.title || 'Untitled'}** [${a.type}]${keyLabel}\n  Preview: ${preview}${preview.length >= 150 ? '...' : ''}\n  ID: ${a.id}`);
    }
    descParts.push('\nUse `buildd` action: get_artifact to fetch full content.');
  }

  // TODO: Memory bridge — inject relevant memories when memory-client module is available.
  // Non-fatal: memory service may be unavailable. Example:
  // try {
  //   const { getMemoryClient } = await import('./memory-client');
  //   const memClient = getMemoryClient();
  //   if (memClient && mission.title) {
  //     const results = await memClient.search({ query: mission.title, limit: 5 });
  //     if (results?.results?.length) {
  //       descParts.push('\n## Relevant Team Memory');
  //       for (const m of results.results.slice(0, 3)) {
  //         descParts.push(`- **[${m.type}] ${m.title}**: ${m.content?.split('\n')[0] || ''}`);
  //       }
  //     }
  //   }
  // } catch { /* non-fatal */ }

  // Fetch available roles for orchestrator context — query ALL team workspaces,
  // not just the mission's workspace. Missions often start in __coordination which
  // has no roles, so querying only that workspace would give the orchestrator an empty list.
  const roleWorkspaceIds = teamWorkspacesList.map(tw => tw.id);
  if (mission.workspaceId && !roleWorkspaceIds.includes(mission.workspaceId)) {
    roleWorkspaceIds.push(mission.workspaceId);
  }
  let roles: Awaited<ReturnType<typeof getWorkspaceRoles>> = [];
  if (roleWorkspaceIds.length > 0) {
    const allRoleLists = await Promise.all(roleWorkspaceIds.map(id => getWorkspaceRoles(id)));
    // Deduplicate by slug — same role may exist in multiple workspaces
    const seenSlugs = new Set<string>();
    for (const list of allRoleLists) {
      for (const r of list) {
        if (!seenSlugs.has(r.slug)) {
          seenSlugs.add(r.slug);
          roles.push(r);
        }
      }
    }
  }

  // Detect role patterns from completed tasks — if tasks consistently use the same role,
  // the orchestrator should reuse it without re-evaluating every time
  const completedRoleSlugs = completedTasks
    .map(t => (t as any).roleSlug as string | null)
    .filter(Boolean);
  const roleFrequency: Record<string, number> = {};
  for (const slug of completedRoleSlugs) {
    roleFrequency[slug!] = (roleFrequency[slug!] || 0) + 1;
  }
  const dominantRole = Object.entries(roleFrequency).sort((a, b) => b[1] - a[1])[0];
  const isRecurringPattern = dominantRole && dominantRole[1] >= 3;

  if (roles.length > 0) {
    descParts.push('\n## Available Roles');
    descParts.push('**Set `roleSlug` on every task you create.** This routes the task to the right agent with the right tools and model.');
    for (const r of roles) {
      const load = r.currentLoad > 0 ? ` (${r.currentLoad} active)` : ' (idle)';
      const usage = r.completedTasks30d > 0 ? ` | ${r.completedTasks30d} completed (30d)` : '';
      descParts.push(`- **${r.name}** (\`${r.slug}\`) — ${r.model}${load}${usage}${r.description ? `: ${r.description}` : ''}`);
    }

    if (isRecurringPattern) {
      descParts.push(`\n**Pattern detected**: The last ${dominantRole[1]} tasks used role \`${dominantRole[0]}\`. ` +
        `For recurring work of the same kind, reuse this role. Only pick a different role if the task requires different capabilities.`);
    }
  }

  // Inject evaluation feedback from the last incomplete evaluation
  if (mission.lastEvaluationTaskId) {
    const evalTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, mission.lastEvaluationTaskId),
      columns: { result: true, status: true },
    });
    if (evalTask?.status === 'completed') {
      const evalResult = evalTask.result as Record<string, unknown> | null;
      const evalOutput = evalResult?.structuredOutput as Record<string, unknown> | undefined;
      if (evalOutput?.verdict && evalOutput.verdict !== 'complete') {
        descParts.push('\n## Prior Evaluation Feedback');
        descParts.push(`A completion evaluation returned **${evalOutput.verdict}** (confidence: ${evalOutput.confidence}).`);
        if (evalOutput.rationale) descParts.push(`Reason: ${evalOutput.rationale}`);
        const missing = evalOutput.missingWork as string[] | undefined;
        if (missing?.length) {
          descParts.push('Missing work:');
          for (const item of missing) descParts.push(`- ${item}`);
        }
        descParts.push('**Address these gaps before signaling completion again.**');
      }
    }
  }

  // Dynamic orchestrator hints (static instructions are in the Organizer role content)
  descParts.push('\n## Situational Guidance');

  if (isRecurringPattern) {
    descParts.push(
      '**Efficiency mode**: This mission has an established pattern. Be fast:\n' +
      '- If the work is routine (same type as prior tasks), create the task with the proven role — don\'t over-analyze.\n' +
      '- Only do a full evaluation if something has changed (failures, new requirements, blocked work).\n' +
      '- For recurring monitoring/check-ins, keep the same structure unless results indicate a problem.'
    );
  }

  if (completedTasks.length >= 3) {
    const summaries = completedTasks
      .map(t => (t.result as Record<string, unknown> | null)?.summary as string || '')
      .filter(Boolean);
    const uniqueSummaries = new Set(summaries);
    if (uniqueSummaries.size <= 2) {
      descParts.push(
        '⚠️ Recent tasks produced nearly identical results. Focus on what has CHANGED since the last run. ' +
        'Do NOT repeat the same analysis — identify new developments, blockers removed, or status changes. ' +
        'If nothing meaningful has changed, create fewer or no sub-tasks.'
      );
    }
  }

  if (isBuild && taskPRs.length > 0) {
    descParts.push(
      '**Sequencing**: Multiple PRs exist on this mission. When creating new tasks on the same repo, ' +
      'chain them with `dependsOn` or create an integration task to avoid branch conflicts.'
    );
  }

  // Build context JSONB
  const contextData: Record<string, unknown> = {
    missionId: mission.id,
    missionTitle: mission.title,
    orchestrator: true,
    workspaceState: workspaceState || { name: '__coordination', repo: null, isCoordination: true, hasGitHubApp: false },
    teamWorkspaces: projectWorkspaces.map(tw => ({ id: tw.id, name: tw.name, repo: tw.repo })),
    availableRoles: roles,
    recentCompletions: completedTasks.map(t => {
      const result = t.result as Record<string, unknown> | null;
      return {
        taskId: t.id,
        title: t.title,
        mode: t.mode,
        summary: result?.summary || null,
        structuredOutput: result?.structuredOutput || null,
        nextSuggestion: result?.nextSuggestion || null,
        prUrl: result?.prUrl || null,
        prNumber: result?.prNumber || null,
        completedAt: t.createdAt,
      };
    }),
    activeTasks: activeTasks.map(t => ({
      taskId: t.id,
      title: t.title,
      status: t.status,
    })),
    ...(recipeSteps ? { recipeSteps } : {}),
    priorArtifacts: allArtifacts.map(a => ({
      artifactId: a.id, key: a.key, type: a.type, title: a.title, updatedAt: a.updatedAt,
    })),
  };

  return { description: descParts.join('\n'), context: contextData };
}

/**
 * Build context specifically for heartbeat missions.
 * Queries full mission state (tasks, artifacts, PRs) and uses phase detection
 * to generate actionable guidance instead of passive status reporting.
 */
async function buildHeartbeatContext(mission: {
  id: string;
  title: string;
  description: string | null;
  heartbeatChecklist: string | null;
  skillSlugs?: string[];
  workspaceId?: string | null;
}) {
  // Query mission state in parallel
  const [priorHeartbeats, completedTasks, activeTasks, failedTasks, missionArtifacts, tasksWithPRs] = await Promise.all([
    // Last 3 heartbeat results
    db.query.tasks.findMany({
      where: and(
        eq(tasks.missionId, mission.id),
        eq(tasks.status, 'completed')
      ),
      orderBy: [desc(tasks.createdAt)],
      limit: 3,
      columns: { result: true, createdAt: true },
    }),
    // All completed tasks (with role info)
    db.query.tasks.findMany({
      where: and(
        eq(tasks.missionId, mission.id),
        eq(tasks.status, 'completed')
      ),
      orderBy: [desc(tasks.createdAt)],
      limit: 20,
      columns: { id: true, title: true, roleSlug: true, result: true, createdAt: true },
    }),
    // Active/pending tasks
    db.query.tasks.findMany({
      where: and(
        eq(tasks.missionId, mission.id),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress'])
      ),
      limit: 10,
      columns: { id: true, title: true, status: true, roleSlug: true },
    }),
    // Failed tasks
    db.query.tasks.findMany({
      where: and(
        eq(tasks.missionId, mission.id),
        eq(tasks.status, 'failed')
      ),
      orderBy: [desc(tasks.createdAt)],
      limit: 5,
      columns: { id: true, title: true, result: true },
    }),
    // Mission artifacts (non-heartbeat)
    db.query.artifacts.findMany({
      where: eq(artifacts.missionId, mission.id),
      orderBy: [desc(artifacts.updatedAt)],
      limit: 10,
      columns: { id: true, key: true, type: true, title: true, content: true, updatedAt: true },
    }),
    // Tasks that created PRs
    db.query.tasks.findMany({
      where: and(
        eq(tasks.missionId, mission.id),
        eq(tasks.status, 'completed'),
        sql`${tasks.result}->>'prUrl' IS NOT NULL`
      ),
      limit: 20,
      columns: { title: true, result: true },
    }),
  ]);

  // Extract prior heartbeat statuses for stall detection
  const priorStatuses = priorHeartbeats.map(t => {
    const result = t.result as Record<string, unknown> | null;
    const so = result?.structuredOutput as Record<string, unknown> | undefined;
    return (so?.status as string) || 'unknown';
  });

  // Non-auto-generated artifacts (actual deliverables, not heartbeat/mission summaries)
  const deliverableArtifacts = missionArtifacts.filter(a =>
    !a.key?.startsWith('heartbeat-') && !a.key?.startsWith('mission-')
  );

  // Detect mission phase
  const phaseData: MissionPhaseData = {
    completedTasks: completedTasks.map(t => ({
      roleSlug: t.roleSlug,
      result: t.result as Record<string, unknown> | null,
    })),
    activeTasks: activeTasks.map(t => ({ status: t.status, roleSlug: t.roleSlug })),
    failedTasks: failedTasks.map(t => ({ title: t.title })),
    artifacts: deliverableArtifacts.map(a => ({ type: a.type, key: a.key })),
    hasWorkspace: !!mission.workspaceId,
    prCount: tasksWithPRs.length,
    priorHeartbeatStatuses: priorStatuses,
  };
  const phase = detectMissionPhase(phaseData);

  // Build description
  const descParts: string[] = [];
  descParts.push(`## Heartbeat: ${mission.title}`);
  if (mission.description) descParts.push(mission.description);

  // Phase assessment — the most important section
  descParts.push(`\n## Mission Phase: ${phase.phase.toUpperCase()}`);
  descParts.push(phase.reason);
  if (phase.actions.length > 0) {
    descParts.push('\n**Required actions:**');
    for (const action of phase.actions) {
      descParts.push(`- ${action}`);
    }
  }

  // Mission state summary
  const builderCount = completedTasks.filter(t => t.roleSlug === 'builder').length;
  const organizerCount = completedTasks.filter(t => t.roleSlug === 'organizer' || !t.roleSlug).length;
  descParts.push(`\n## Mission State`);
  descParts.push(`- Workspace: ${mission.workspaceId || '**NONE** (must create before coding tasks can run)'}`);
  descParts.push(`- Completed: ${completedTasks.length} task(s) (${builderCount} builder, ${organizerCount} organizer/other)`);
  descParts.push(`- Active: ${activeTasks.length} task(s)`);
  descParts.push(`- Failed: ${failedTasks.length} task(s)`);
  descParts.push(`- Artifacts: ${deliverableArtifacts.length} deliverable(s)`);
  descParts.push(`- PRs: ${tasksWithPRs.length}`);

  // Checklist (user-configured or default)
  descParts.push('\n## Checklist');
  descParts.push(mission.heartbeatChecklist || '(no checklist configured)');

  // Protocol — action-oriented, not passive
  descParts.push('\n## Protocol');
  descParts.push(`You are running a mission heartbeat. Your job is to **drive the mission forward**, not just report status.
- Assess the phase above and execute the required actions.
- If you created tasks, retried failures, or made changes, report status "action_taken" with what you did.
- Only report "ok" if the mission is actively progressing and no action is needed RIGHT NOW.
- If the mission is stalled (same state as prior heartbeats), you MUST take action or escalate — never report "ok" for a stalled mission.
- If you need a human decision (e.g., repo creation approval), create a task with a clear question or use waiting_input.`);

  // Prior heartbeats
  if (priorHeartbeats.length > 0) {
    descParts.push('\n## Prior Heartbeats');
    for (const t of priorHeartbeats) {
      const result = t.result as Record<string, unknown> | null;
      const so = result?.structuredOutput as Record<string, unknown> | undefined;
      const status = so?.status || 'unknown';
      const summary = so?.summary || result?.summary || 'no summary';
      descParts.push(`- ${timeAgo(t.createdAt)}: [${status}] ${summary}`);
    }
  }

  // Completed task results (compact)
  if (completedTasks.length > 0) {
    descParts.push('\n## Completed Tasks');
    for (const t of completedTasks) {
      const result = t.result as Record<string, unknown> | null;
      const summary = result?.summary as string || 'no summary';
      const role = t.roleSlug || 'none';
      descParts.push(`- [${role}] ${t.title}: ${summary.slice(0, 200)}`);
    }
  }

  // Active tasks
  if (activeTasks.length > 0) {
    descParts.push('\n## Active Tasks');
    for (const t of activeTasks) {
      descParts.push(`- [${t.roleSlug || 'none'}] ${t.title} — ${t.status}`);
    }
  }

  // Failed tasks
  if (failedTasks.length > 0) {
    descParts.push('\n## Failed Tasks');
    for (const t of failedTasks) {
      const result = t.result as Record<string, unknown> | null;
      const error = result?.summary as string || 'unknown error';
      descParts.push(`- ${t.title}: ${error.slice(0, 200)}`);
    }
  }

  // Deliverable artifacts
  if (deliverableArtifacts.length > 0) {
    descParts.push('\n## Artifacts');
    for (const a of deliverableArtifacts) {
      const preview = a.content?.slice(0, 120) || '';
      descParts.push(`- **${a.title || 'Untitled'}** [${a.type}] (ID: ${a.id})`);
      if (preview) descParts.push(`  ${preview}${preview.length >= 120 ? '...' : ''}`);
    }
    descParts.push('\nUse `buildd` action=get_artifact to read full content.');
  }

  // PRs
  if (tasksWithPRs.length > 0) {
    descParts.push('\n## Pull Requests');
    for (const t of tasksWithPRs) {
      const r = t.result as Record<string, unknown>;
      descParts.push(`- [${t.title}] PR #${r.prNumber}: ${r.prUrl}`);
    }
  }

  const contextData: Record<string, unknown> = {
    missionId: mission.id,
    missionTitle: mission.title,
    heartbeat: true,
    heartbeatChecklist: mission.heartbeatChecklist,
    outputSchema: HEARTBEAT_OUTPUT_SCHEMA,
    phase: phase.phase,
    phaseActions: phase.actions,
    hasWorkspace: !!mission.workspaceId,
    workspaceId: mission.workspaceId || null,
    completedTaskCount: completedTasks.length,
    activeTaskCount: activeTasks.length,
    failedTaskCount: failedTasks.length,
    artifactCount: deliverableArtifacts.length,
    prCount: tasksWithPRs.length,
    priorArtifacts: deliverableArtifacts.map(a => ({
      artifactId: a.id, key: a.key, type: a.type, title: a.title,
    })),
  };

  return { description: descParts.join('\n'), context: contextData };
}
