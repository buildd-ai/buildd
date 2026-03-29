import { db } from '@buildd/core/db';
import { tasks, missions, taskRecipes, taskSchedules, workspaceSkills, workers, artifacts } from '@buildd/core/db/schema';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';

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

  return uniqueRoles.map(r => ({
    slug: r.slug,
    name: r.name,
    model: r.model,
    color: r.color,
    description: r.description,
    currentLoad: loadMap[r.slug] || 0,
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
      workspaceId: true,
      scheduleId: true,
      lastEvaluationTaskId: true,
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
    columns: { id: true, title: true, status: true },
  });

  // Recent failed tasks
  const failedTasks = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, missionId),
      eq(tasks.status, 'failed')
    ),
    orderBy: [desc(tasks.createdAt)],
    limit: 3,
    columns: { id: true, title: true, result: true },
  });

  // Prior artifacts linked to this mission
  const priorArtifacts = await db.query.artifacts.findMany({
    where: eq(artifacts.missionId, mission.id),
    orderBy: [desc(artifacts.updatedAt)],
    limit: 10,
    columns: { id: true, key: true, type: true, title: true, content: true, updatedAt: true },
  });

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
      descParts.push(`- [${t.title}] status: ${t.status}`);
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
      descParts.push(`- [${t.title}] error: ${errorSummary}`);
    }
  }

  if (recipeSteps) {
    descParts.push('\n## Playbook');
    for (const step of recipeSteps as Array<{ ref?: string; title?: string; description?: string }>) {
      descParts.push(`- [ ] ${step.title || step.ref}${step.description ? `: ${step.description}` : ''}`);
    }
  }

  if (priorArtifacts.length > 0) {
    descParts.push('\n## Prior Artifacts');
    for (const a of priorArtifacts) {
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

  // Fetch available roles for orchestrator context
  let roles: Awaited<ReturnType<typeof getWorkspaceRoles>> = [];
  if (mission.workspaceId) {
    roles = await getWorkspaceRoles(mission.workspaceId);
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
    for (const r of roles) {
      const load = r.currentLoad > 0 ? ` (${r.currentLoad} active)` : ' (idle)';
      descParts.push(`- **${r.name}** (\`${r.slug}\`) — ${r.model}${load}${r.description ? `: ${r.description}` : ''}`);
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
    priorArtifacts: priorArtifacts.map(a => ({
      artifactId: a.id, key: a.key, type: a.type, title: a.title, updatedAt: a.updatedAt,
    })),
  };

  return { description: descParts.join('\n'), context: contextData };
}

/**
 * Build context specifically for heartbeat missions.
 * Produces a checklist-focused description with compact prior results.
 */
async function buildHeartbeatContext(mission: {
  id: string;
  title: string;
  description: string | null;
  heartbeatChecklist: string | null;
  skillSlugs?: string[];
}) {
  // Last 3 completed heartbeat results (compact)
  const priorHeartbeats = await db.query.tasks.findMany({
    where: and(
      eq(tasks.missionId, mission.id),
      eq(tasks.status, 'completed')
    ),
    orderBy: [desc(tasks.createdAt)],
    limit: 3,
    columns: { result: true, createdAt: true },
  });

  const descParts: string[] = [];
  descParts.push(`## Heartbeat: ${mission.title}`);
  if (mission.description) descParts.push(mission.description);

  descParts.push('\n## Checklist');
  descParts.push(mission.heartbeatChecklist || '(no checklist configured)');

  descParts.push('\n## Protocol');
  descParts.push(`You are running a periodic heartbeat check. Follow the checklist above.
- Perform each check item and note the result.
- If ALL checks pass with no action needed, report status "ok" with a one-line summary.
- If you took action on any check, report status "action_taken" and describe what you did.
- Do NOT repeat the same analysis as prior runs unless something has changed.
- Batch all checks into a single pass. Only create sub-tasks if a check explicitly requires external work.`);

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

  // PR awareness for build missions
  const hasBuilder = mission.skillSlugs?.includes('builder');
  if (hasBuilder) {
    const tasksWithPRs = await db.query.tasks.findMany({
      where: and(
        eq(tasks.missionId, mission.id),
        eq(tasks.status, 'completed'),
        sql`${tasks.result}->>'prUrl' IS NOT NULL`
      ),
      limit: 20,
      columns: { title: true, result: true },
    });
    if (tasksWithPRs.length > 0) {
      descParts.push('\n## Open PRs');
      descParts.push('Tasks created these PRs (check if merged):');
      for (const t of tasksWithPRs) {
        const r = t.result as Record<string, unknown>;
        descParts.push(`- [${t.title}] PR #${r.prNumber}: ${r.prUrl}`);
      }
      descParts.push('If multiple unmerged PRs exist on the same repo, create an integration task to merge them, resolve conflicts, and verify the build.');
    }
  }

  const contextData: Record<string, unknown> = {
    missionId: mission.id,
    missionTitle: mission.title,
    heartbeat: true,
    heartbeatChecklist: mission.heartbeatChecklist,
    outputSchema: HEARTBEAT_OUTPUT_SCHEMA,
  };

  return { description: descParts.join('\n'), context: contextData };
}
