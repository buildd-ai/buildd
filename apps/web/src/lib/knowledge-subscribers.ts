/**
 * Knowledge module: evidence and memory labels from a finished task.
 *
 * - `task.terminal` → persist the task's evidence record (why it failed, or the
 *   caveat on a success). Awaited: a serverless function may freeze an
 *   un-awaited write. `persistTaskEvidence` is contained and never throws.
 * - `worker.finished` → label the memories this task was shown (did the
 *   summary act on them?). Scheduled with `after()`, so it adds no latency,
 *   and only on the transition into completed in a standard workspace.
 * - `spec.approved` → put the approved spec into recall and the graph
 *   (lib/specs/knowledge.ts). Contained: it never throws. The approval emits
 *   this after its response (lib/specs/approval.ts), so the index adds no
 *   latency to Approve.
 * - `workspace.created` → queue a full ingest of the linked repo, unless the
 *   workspace was created with knowledge ingest off (then the skip is
 *   logged). Not awaited, as when the create route did it inline: a failed
 *   enqueue is logged and never fails the create.
 */
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { persistTaskEvidence } from '@/lib/task-evidence-store';
import { scheduleMemoryUseLabels, shouldLabelMemoryUses } from '@/lib/memory-decisions';
import { indexApprovedSpec } from '@/lib/specs/knowledge';
import { enqueueFullIngestJob, logIngestSkip } from '@/lib/knowledge-ingest';
import { normalizeRepoFullName } from '@/lib/repo-scope';

export const knowledgeSubscribers: readonly AnySubscriber[] = [
  subscriber('knowledge', 'task.terminal', 'task-evidence', async e => {
    await persistTaskEvidence(e.taskId, e.workerId, { isSensitive: e.sensitive });
  }),
  subscriber('knowledge', 'worker.finished', 'memory-use-labels', e => {
    if (!shouldLabelMemoryUses({
      status: e.status,
      previousStatus: e.previousStatus,
      taskId: e.taskId,
      workspace: e.workspace,
      serverRefusal: e.serverRefusal,
    })) return;
    scheduleMemoryUseLabels({ taskId: e.taskId, accountId: e.accountId, summary: e.summary });
  }),
  subscriber('knowledge', 'spec.approved', 'living-spec-index', async e => {
    await indexApprovedSpec(e.specId);
  }),
  subscriber('knowledge', 'workspace.created', 'repo-link-ingest', e => {
    if (!e.repoUrl) return;
    if (!e.knowledgeIngest) {
      logIngestSkip('workspace_create', { workspaceId: e.workspaceId });
      return;
    }
    const repo = normalizeRepoFullName(e.repoUrl);
    if (!repo) return;
    enqueueFullIngestJob({ workspaceId: e.workspaceId, repo, trigger: 'repo_link' }).catch(err =>
      console.error(`[knowledge-ingest] repo-link enqueue failed for new workspace ${e.workspaceId}:`, err)
    );
  }),
];
