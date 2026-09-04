/**
 * Prompt-context injection — everything that rides the
 * `resolvedContextProviders` rail into the agent's prompt at claim time.
 *
 * ORDER MATTERS. The three attach functions append to the same array and the
 * runner concatenates it in order, so the call sequence in route.ts is the
 * contract: external providers, then retrieved knowledge, then subject-anchor
 * prior work. Every one is best-effort — a failure attaches nothing and the
 * claim still succeeds.
 */
import type { ClaimTasksResponse } from '@buildd/shared';
import { buildEntityCatalogContext, buildKnowledgeContext } from '@/lib/knowledge-context';
import { resolveSubjectPolicy } from '@buildd/core/subject-anchor-observe';
import { buildSubjectPriorWork } from './subject-prior-work';

/** The claim-candidate rows these blocks look tasks up in. */
type ClaimedTask = { id: string; title: string; workspaceId: string };

/**
 * Append one context block to both rails the runner reads: the response field
 * and the task context it is mirrored into.
 *
 * Shared by the knowledge and subject-prior-work blocks, which carried
 * identical copies. The external-provider block below deliberately does NOT
 * use this — it runs first and assigns, and it only mirrors into an existing
 * task context rather than creating one.
 */
function appendContextBlock(cw: ClaimTasksResponse['workers'][number], block: string): void {
  (cw as any).resolvedContextProviders = [...((cw as any).resolvedContextProviders ?? []), block];
  const taskObj = cw.task as any;
  if (taskObj) {
    taskObj.context = taskObj.context ?? {};
    taskObj.context.resolvedContextProviders = [...(taskObj.context.resolvedContextProviders ?? []), block];
  }
}

/**
 * Fetch the task's declared external context providers (5s timeout each) and
 * attach the ones that answered. Failures are logged, never fatal.
 */
export async function attachExternalContextProviders(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    const ctx = (task as any)?.context as { contextProviders?: Array<{ url: string; headers?: Record<string, string>; label?: string }> } | undefined;
    if (!ctx?.contextProviders?.length) continue;

    const results = await Promise.allSettled(
      ctx.contextProviders.map(async (provider) => {
        const res = await fetch(provider.url, {
          headers: { ...provider.headers, "Accept": "text/markdown, text/plain" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Context provider ${provider.url} returned ${res.status}`);
        const body = await res.text();
        return provider.label ? `## ${provider.label}\n\n${body}` : body;
      }),
    );
    const resolved = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map(r => r.value);

    if (resolved.length > 0) {
      (cw as any).resolvedContextProviders = resolved;
      // Also merge into task context so runner can read it from task.context
      const taskObj = cw.task as any;
      if (taskObj?.context) {
        taskObj.context.resolvedContextProviders = resolved;
      }
    }

    // Log failures for debugging
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[claim] context provider failed:", r.reason?.message || r.reason);
      }
    }
  }
}

/**
 * Inject related prior work into the agent's prompt — the worker analog of the
 * orchestrator's plan-time injection.
 *
 * Best-effort: buildKnowledgeContext returns [] on any failure.
 */
export async function attachKnowledgeContext(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if (!task) continue;
    const goal = [task.title, (task as any).description].filter(Boolean).join('\n');
    const teamId = (task as any).workspace?.teamId;
    const sensitive = (task as any).workspace?.dataClass === 'sensitive';
    const parts = await buildKnowledgeContext(goal, task.workspaceId, teamId, undefined, { sensitive });
    // Known-entities catalog (§8.4): canonical entity names for the task's
    // likely files so agents don't invent loose refs. Best-effort — returns ''
    // on any failure; the extra .catch is belt-and-braces (claim must not 500).
    const entityCatalog = await buildEntityCatalogContext(goal, task.workspaceId).catch(() => '');
    if (entityCatalog) parts.push(entityCatalog);
    if (parts.length === 0) continue;

    appendContextBlock(cw, parts.join('\n'));
  }
}

/**
 * Subject-anchor prior work injection (§7 of docs/design/task-subject-anchors.md).
 *
 * For tasks anchored to a subject PR, error, or mission, surface existing
 * sibling tasks so the agent doesn't re-discover or re-implement work already
 * in flight. Gated by priorWorkInjection in the workspace subjectPolicy
 * (default: true). Best-effort: failures are logged and the claim still succeeds.
 */
export async function attachSubjectPriorWork(
  claimedWorkers: ClaimTasksResponse['workers'],
  claimedTasks: readonly ClaimedTask[],
): Promise<void> {
  for (const cw of claimedWorkers) {
    const task = claimedTasks.find(t => t.id === cw.taskId);
    if (!task || !(task as any).subjectKind) continue;

    const wsGitConfig = (task as any).workspace?.gitConfig;
    const subjectPolicy = resolveSubjectPolicy(wsGitConfig?.subjectPolicy);

    const priorWork = await buildSubjectPriorWork(task as any, subjectPolicy).catch(err => {
      console.warn('[claim] subject-prior-work injection failed:', err);
      return null;
    });
    if (!priorWork) continue;

    appendContextBlock(cw, priorWork);
  }
}
