/**
 * Notifications module: the subscriptions ledger and the team's push channel.
 *
 * Ledger (`recordEvent`, lib/subscriptions.ts): every core event that is also
 * a subscribable fact writes its ledger row here, so emitters never name the
 * ledger. Exactly-once per (subscription, event) is the ledger's own
 * invariant; two emitters of one fact build the same dedupe key. Prose is
 * omitted for sensitive workspaces.
 *
 * Team push (`notifyTeam`): a worker-reported outcome is pushed to the owning
 * team's channel. A merge-completed task is not; it never was.
 *
 * Every send is fire-and-forget, exactly as the inline calls were, so the
 * emitting request gains no latency.
 */
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { notifyTeam } from '@/lib/notify';
import { isCredentialExpiredError } from '@/lib/notify-rules';
import {
  recordEvent, taskCompletedEvent, taskFailedEvent, taskNeedsInputEvent, prMergedEvent, prCiFailedEvent,
} from '@/lib/subscriptions';

const taskUrl = (taskId: string) => `https://buildd.dev/app/tasks/${taskId}`;

export const notificationSubscribers: readonly AnySubscriber[] = [
  // ── Subscriptions ledger ───────────────────────────────────────────────────
  subscriber('notifications', 'task.completed', 'ledger-task-completed', async e => {
    if (e.via === 'merge') {
      // Same fact as the worker route's completion, same dedupe key: one row.
      await recordEvent(taskCompletedEvent({ taskId: e.taskId, workerId: e.workerId, workspaceId: e.workspaceId }));
      return;
    }
    void recordEvent(taskCompletedEvent({
      taskId: e.taskId, workerId: e.workerId, title: e.sensitive ? null : e.title, workspaceId: e.workspaceId,
    }));
  }),
  subscriber('notifications', 'task.failed', 'ledger-task-failed', e => {
    void recordEvent(taskFailedEvent({
      taskId: e.taskId, workerId: e.workerId, title: e.sensitive ? null : e.title, workspaceId: e.workspaceId,
    }));
  }),
  // "Tell me when this task needs input". Keyed per question, so a re-sent
  // waitingFor writes one row.
  subscriber('notifications', 'task.needs_input', 'ledger-task-needs-input', e => {
    void recordEvent(taskNeedsInputEvent({ taskId: e.taskId, workerId: e.workerId, prompt: e.prompt }));
  }),
  subscriber('notifications', 'pr.merged', 'ledger-pr-merged', async e => {
    await recordEvent(prMergedEvent({ repoFullName: e.repoFullName, prNumber: e.prNumber, url: e.url }));
  }),
  subscriber('notifications', 'pr.ci_failed', 'ledger-pr-ci-failed', async e => {
    await recordEvent(prCiFailedEvent({ repoFullName: e.repoFullName, prNumber: e.prNumber, headSha: e.headSha }));
  }),

  // ── Team push ──────────────────────────────────────────────────────────────
  // A retry is a (transient) failure, so it is gated on the taskFailed toggle.
  // Every push redacts the title (and workspace name) in a sensitive workspace.
  subscriber('notifications', 'task.retrying', 'push-task-retrying', e => {
    void notifyTeam(e.teamId, 'taskFailed', {
      title: 'Task retrying',
      message: e.sensitive ? 'Task auto-retrying (content redacted)' : `Auto-retrying: ${e.title}\n${e.workspaceName || 'unknown'}`,
      url: taskUrl(e.taskId),
      urlTitle: 'View task',
      priority: 0,
    });
  }),
  subscriber('notifications', 'task.completed', 'push-task-completed', e => {
    if (e.via !== 'worker') return;
    void notifyTeam(e.teamId, 'taskCompleted', {
      title: 'Task done',
      message: e.sensitive ? 'Task completed (content redacted)' : `${e.title}\n${e.workspaceName || 'unknown'}`,
      url: taskUrl(e.taskId),
      urlTitle: 'View task',
      priority: -1,
    });
  }),
  subscriber('notifications', 'task.failed', 'push-task-failed', e => {
    void notifyTeam(e.teamId, 'taskFailed', {
      title: 'Task failed',
      message: e.sensitive ? 'Task failed (content redacted)' : `${e.title}\n${e.workspaceName || 'unknown'}`,
      url: taskUrl(e.taskId),
      urlTitle: 'View task',
      priority: 0,
    });
    // A failure caused by an invalid/expired agent-backend credential gets its
    // own actionable alert, so the owner re-sets it before more tasks burn.
    if (isCredentialExpiredError(e.error)) {
      void notifyTeam(e.teamId, 'credentialExpired', {
        title: '🔑 Agent credential expired',
        message: 'Your Claude credential is expired or invalid — set it again under Settings, Runners.'
          + (e.sensitive ? '' : `\nTask: ${e.title}`),
        url: `https://buildd.dev/app/settings/runners`,
        urlTitle: 'Open settings',
        priority: 1,
      });
    }
  }),
];
