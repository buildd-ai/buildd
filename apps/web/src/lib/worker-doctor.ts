import { db } from '@buildd/core/db';
import { workers, tasks } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Recovery recommendation from the doctor agent.
 */
export interface RecoveryRecommendation {
  workerId: string;
  taskId: string | null;
  diagnosis: string;
  recommendedAction: 'diagnose' | 'complete' | 'restart' | 'none';
  confidence: 'high' | 'medium' | 'low';
  details: {
    workerStatus: string;
    staleDurationMs: number;
    hasProgress: boolean;
    hasPR: boolean;
    hasCommits: boolean;
    lastAction: string | null;
    error: string | null;
  };
}

/**
 * Analyze a worker and produce a recovery recommendation.
 *
 * The doctor examines:
 * - Worker status and duration since last update
 * - Whether the worker has made meaningful progress (commits, PR, milestones)
 * - The nature of any error (transient vs permanent)
 * - Whether the task can benefit from a restart
 */
export async function diagnoseWorker(workerId: string): Promise<RecoveryRecommendation> {
  const worker = await db.query.workers.findFirst({
    where: eq(workers.id, workerId),
    with: { task: true },
  });

  if (!worker) {
    throw new Error(`Worker ${workerId} not found`);
  }

  const staleDurationMs = Date.now() - (worker.updatedAt?.getTime() || 0);
  const milestones = (worker.milestones as any[]) || [];
  const hasPR = !!(worker.prUrl || worker.prNumber);
  const hasCommits = (worker.commitCount || 0) > 0;
  const hasProgress = milestones.length > 2 || hasCommits; // More than just initial milestones
  const lastAction = worker.currentAction;
  const error = worker.error;

  const details = {
    workerStatus: worker.status,
    staleDurationMs,
    hasProgress,
    hasPR,
    hasCommits,
    lastAction,
    error,
  };

  // Already completed successfully — no action needed
  if (worker.status === 'completed') {
    return {
      workerId,
      taskId: worker.taskId,
      diagnosis: 'Worker already completed successfully.',
      recommendedAction: 'none',
      confidence: 'high',
      details,
    };
  }

  // Worker failed with a PR already created — likely can be completed
  if ((worker.status === 'failed' || worker.status === 'error') && hasPR) {
    return {
      workerId,
      taskId: worker.taskId,
      diagnosis: 'Worker failed but has a PR. The work may be substantially complete.',
      recommendedAction: 'complete',
      confidence: 'high',
      details,
    };
  }

  // Worker failed with commits — work was done, may be completable
  if ((worker.status === 'failed' || worker.status === 'error') && hasCommits) {
    return {
      workerId,
      taskId: worker.taskId,
      diagnosis: 'Worker failed after making commits. Consider completing if work is sufficient, or restart to finish.',
      recommendedAction: 'restart',
      confidence: 'medium',
      details,
    };
  }

  // Worker failed with no progress — restart is the clear action
  if ((worker.status === 'failed' || worker.status === 'error') && !hasProgress) {
    const isTransientError = error && (
      error.includes('expired') ||
      error.includes('timed out') ||
      error.includes('went offline') ||
      error.includes('runner restarted') ||
      error.includes('rate limit') ||
      error.includes('Process restarted')
    );

    return {
      workerId,
      taskId: worker.taskId,
      diagnosis: isTransientError
        ? `Worker failed due to transient issue: ${error}. Restart should succeed.`
        : `Worker failed with no progress: ${error || 'unknown error'}. Restart to try again.`,
      recommendedAction: 'restart',
      confidence: isTransientError ? 'high' : 'medium',
      details,
    };
  }

  // Worker is still active but stale (5+ minutes since update)
  if (['running', 'starting'].includes(worker.status) && staleDurationMs > 5 * 60 * 1000) {
    // Very stale (>15 min) — likely stuck, restart
    if (staleDurationMs > 15 * 60 * 1000) {
      return {
        workerId,
        taskId: worker.taskId,
        diagnosis: `Worker has been unresponsive for ${Math.round(staleDurationMs / 60000)} minutes. Likely stuck.`,
        recommendedAction: hasCommits ? 'diagnose' : 'restart',
        confidence: 'high',
        details,
      };
    }

    // Moderately stale (5-15 min) — diagnose first
    return {
      workerId,
      taskId: worker.taskId,
      diagnosis: `Worker appears stale (${Math.round(staleDurationMs / 60000)} minutes since last update). Sending diagnosis.`,
      recommendedAction: 'diagnose',
      confidence: 'medium',
      details,
    };
  }

  // Worker is waiting for input — check how long
  if (worker.status === 'waiting_input') {
    const waitDurationMs = staleDurationMs;
    if (waitDurationMs > 60 * 60 * 1000) { // 1+ hour waiting
      return {
        workerId,
        taskId: worker.taskId,
        diagnosis: `Worker waiting for input for ${Math.round(waitDurationMs / 60000)} minutes. Consider restarting with autonomous mode.`,
        recommendedAction: 'restart',
        confidence: 'high',
        details,
      };
    }

    return {
      workerId,
      taskId: worker.taskId,
      diagnosis: 'Worker is waiting for user input. Provide input or restart with autonomous mode.',
      recommendedAction: 'none',
      confidence: 'low',
      details,
    };
  }

  // Default: active worker, no action needed
  return {
    workerId,
    taskId: worker.taskId,
    diagnosis: 'Worker appears to be running normally.',
    recommendedAction: 'none',
    confidence: 'low',
    details,
  };
}
