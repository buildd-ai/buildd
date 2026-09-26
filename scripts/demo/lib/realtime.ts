/**
 * Realtime payloads the demo replays, shaped like the real server's.
 */

export type Push = [channel: string, event: string, data: unknown];

type TaskLike = { id: string; title: string; workspaceId: string; mode?: string | null; priority?: number | null; missionId?: string | null };

/**
 * `task:created` as lib/task-dispatch.ts publishes it (buildTaskPayload). The
 * mission page only re-renders when `task.missionId` is its own — an id-only
 * payload made new tasks invisible until a reload.
 */
export function taskCreatedPush(workspaceChannel: string, task: TaskLike): Push {
  return [workspaceChannel, 'task:created', {
    task: {
      id: task.id, title: task.title, workspaceId: task.workspaceId, mode: task.mode ?? 'execution', priority: task.priority ?? 0,
      ...(task.missionId ? { missionId: task.missionId } : {}),
    },
  }];
}

/** `task:claimed` as the claim route publishes it. */
export function taskClaimedPush(workspaceChannel: string, task: TaskLike, worker: { id: string; name: string }): Push {
  return [workspaceChannel, 'task:claimed', {
    task: { id: task.id, title: task.title, status: 'assigned', workspaceId: task.workspaceId },
    worker: { id: worker.id, name: worker.name, status: 'idle' },
  }];
}

/**
 * What the GitHub webhook publishes when a PR's CI state changes or it merges:
 * `worker:progress` on the workspace channel carrying ONLY `{taskId}` (see
 * apps/web/src/app/api/github/webhook/route.ts). The missing workerId is what
 * tells the mission page "the row's PR state changed — re-render"; a payload
 * with a workerId and an unchanged status is treated as a heartbeat and only
 * patched, so the Board/Lanes never showed CI or merges live.
 */
export function webhookPrNudge(workspaceChannel: string, taskId: string): Push {
  return [workspaceChannel, 'worker:progress', { taskId }];
}
