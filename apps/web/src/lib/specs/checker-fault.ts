/**
 * A mission's criterion check run that proved nothing: every criterion came
 * back inconclusive (no command could run at the head, every one timed out,
 * no test file found), or the run ended without reporting at all. That is the
 * checker failing, not the mission's work, so it is reported as friction with
 * a stable signature (`criterion-checker:<kind>`, the `namespace:stem` shape
 * get_failure_analytics hands out) instead of leaving the mission reading
 * "verifying" with nobody told.
 *
 * One open `[friction]` task per (workspace, signature): a repeat appends a
 * line to it. The line names the run and the mission only; no task content.
 */
export type CheckerFaultKind = 'all_inconclusive' | 'no_report';

export interface CheckerFault {
  kind: CheckerFaultKind;
  workspaceId: string;
  missionId: string;
  runTaskId: string;
  headSha: string;
  /** One short line: counts and outcome kinds only. */
  detail: string;
}

export const CHECKER_FAULT_NAMESPACE = 'criterion-checker';

export function checkerFaultSignature(kind: CheckerFaultKind): string {
  return `${CHECKER_FAULT_NAMESPACE}:${kind === 'all_inconclusive' ? 'every_criterion_inconclusive' : 'run_ended_without_a_report'}`;
}

export interface CheckerFaultDeps {
  findOpenBug(workspaceId: string, signature: string): Promise<{ id: string } | null>;
  appendToBug(taskId: string, text: string): Promise<void>;
  fileBug(row: { workspaceId: string; missionId: string; title: string; description: string; signature: string; excerpt: string }): Promise<{ id: string } | null>;
}

const TITLES: Record<CheckerFaultKind, string> = {
  all_inconclusive: '[friction] Criterion checks proved nothing: every criterion inconclusive',
  no_report: '[friction] Criterion check run ended without a report',
};

export async function reportCheckerFault(fault: CheckerFault, deps?: CheckerFaultDeps): Promise<{ signature: string; taskId: string | null; appended: boolean }> {
  const d = deps ?? await defaultDeps();
  const signature = checkerFaultSignature(fault.kind);
  const line = `run ${fault.runTaskId.slice(0, 8)} for mission ${fault.missionId.slice(0, 8)} at ${fault.headSha.slice(0, 7)}: ${fault.detail}`;
  const open = await d.findOpenBug(fault.workspaceId, signature);
  if (open) {
    await d.appendToBug(open.id, `\n- ${new Date().toISOString()}: ${line}`);
    return { signature, taskId: open.id, appended: true };
  }
  const description = [
    'A mission\'s criterion check run recorded no pass or fail for any criterion, so the mission\'s spec reads unverified for a reason that is not its code.',
    '',
    fault.kind === 'all_inconclusive'
      ? 'Every criterion of the run came back inconclusive: the head could not be checked out, every command timed out or could not start, or no test file the spec names was found.'
      : 'The run ended without the runner reporting any result: it failed to start, or its worker ended first.',
    '',
    'Where to look: the run task\'s milestones and worker error, apps/web/src/lib/specs/criterion-checks.ts, apps/runner/src/criterion-batch.ts.',
    '',
    'Occurrences:',
    `- ${new Date().toISOString()}: ${line}`,
  ].join('\n');
  const filed = await d.fileBug({ workspaceId: fault.workspaceId, missionId: fault.missionId, title: TITLES[fault.kind], description, signature, excerpt: fault.detail.slice(0, 200) });
  return { signature, taskId: filed?.id ?? null, appended: false };
}

async function defaultDeps(): Promise<CheckerFaultDeps> {
  const [{ db }, { tasks }, { and, eq, like, notInArray, sql }, { sqlWhere }, { TERMINAL_TASK_STATUSES }] = await Promise.all([
    import('@buildd/core/db'),
    import('@buildd/core/db/schema'),
    import('drizzle-orm'),
    import('@buildd/core/db/relational-sql'),
    import('@buildd/shared'),
  ]);
  return {
    findOpenBug: async (workspaceId, signature) => (await db.query.tasks.findFirst({
      where: sqlWhere(and(
        eq(tasks.workspaceId, workspaceId),
        like(tasks.title, '[friction] %'),
        sql`${tasks.context}->>'frictionSignature' = ${signature}`,
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
      )),
      columns: { id: true },
    })) ?? null,
    appendToBug: async (taskId, text) => {
      await db.update(tasks).set({ description: sql`coalesce(${tasks.description}, '') || ${text}`, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    },
    fileBug: async (row) => {
      // Not filed into the mission: the fault is the checker's, not the mission's work.
      const [inserted] = await db.insert(tasks).values({
        workspaceId: row.workspaceId,
        title: row.title,
        description: row.description,
        priority: 3,
        status: 'pending',
        mode: 'execution',
        taskClass: 'work',
        kind: 'engineering',
        creationSource: 'webhook',
        category: 'bug',
        context: { frictionSignature: row.signature, frictionExcerpt: row.excerpt, relatedMissionId: row.missionId },
      }).returning({ id: tasks.id });
      if (inserted?.id) {
        const { wakeTask } = await import('@/lib/dispatch-authority');
        await wakeTask(inserted.id, 'task.created');
      }
      return inserted ?? null;
    },
  };
}
