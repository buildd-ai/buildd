/**
 * Send a webhook callback when a task completes or fails.
 *
 * Looks for `task.context.callback.url` — if present, POSTs result data to that URL.
 * Non-fatal: errors are logged but never thrown.
 */
export async function sendTaskCallback(
  task: {
    id: string;
    context?: {
      callback?: {
        url?: string;
        token?: string;
      };
      [key: string]: unknown;
    } | null;
  },
  result: {
    status: string;
    summary?: string;
    prUrl?: string;
    structuredOutput?: unknown;
  },
  workerStats?: {
    turns?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: string | null;
    durationMs?: number | null;
    commitCount?: number | null;
    filesChanged?: number | null;
    linesAdded?: number | null;
    linesRemoved?: number | null;
  },
  budgetUsage?: {
    session: { percent: number; resets_at: string };
    weekly: { percent: number; resets_at: string };
  } | null
): Promise<void> {
  try {
    const callback = (task.context as any)?.callback;
    if (!callback?.url) return;

    const url: string = callback.url;
    // Only allow HTTPS URLs
    if (!url.startsWith('https://')) return;

    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(callback.token
          ? { Authorization: `Bearer ${callback.token}` }
          : {}),
      },
      body: JSON.stringify({
        taskId: task.id,
        status: result.status,
        summary: result.summary,
        prUrl: result.prUrl,
        structuredOutput: result.structuredOutput,
        dashboardUrl: `https://buildd.dev/app/tasks/${task.id}`,
        // Worker performance data
        ...(workerStats?.turns != null && { turns: workerStats.turns }),
        ...(workerStats?.inputTokens != null && { inputTokens: workerStats.inputTokens }),
        ...(workerStats?.outputTokens != null && { outputTokens: workerStats.outputTokens }),
        ...(workerStats?.costUsd != null && { costUsd: parseFloat(workerStats.costUsd) }),
        ...(workerStats?.durationMs != null && { durationMs: workerStats.durationMs }),
        ...(workerStats?.commitCount != null && { commitCount: workerStats.commitCount }),
        ...(workerStats?.filesChanged != null && { filesChanged: workerStats.filesChanged }),
        ...(workerStats?.linesAdded != null && { linesAdded: workerStats.linesAdded }),
        ...(workerStats?.linesRemoved != null && { linesRemoved: workerStats.linesRemoved }),
        ...(budgetUsage && { budgetUsage }),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error('Task callback failed:', error);
  }
}
