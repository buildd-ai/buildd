import { existsSync } from 'fs';
import type { LocalWorker, Milestone, BuilddTask, ChatMessage, Checkpoint } from './types';
import type { BuilddClient } from './buildd';
import type { WorkspaceResolver } from './workspace';
import { saveWorker as storeSaveWorker, loadWorker as storeLoadWorker } from './worker-store';
import { sessionLog } from './session-logger';

/**
 * Session state needed by recovery operations.
 * Matches the WorkerSession interface from workers.ts without importing it directly.
 */
interface RecoverySession {
  inputStream: { end(): void };
  abortController: AbortController;
  queryInstance?: { rewindFiles(uuid: string, opts: { dryRun: boolean }): Promise<any> };
}

/**
 * Dependencies injected from WorkerManager.
 * This avoids circular imports and keeps the recovery module decoupled.
 */
export interface RecoveryDeps {
  workers: Map<string, LocalWorker>;
  sessions: Map<string, RecoverySession>;
  buildd: BuilddClient;
  resolver: WorkspaceResolver;
  pendingPermissionRequests: Map<string, { resolve: (result: any) => void }>;
  emit: (event: any) => void;
  addMilestone: (worker: LocalWorker, milestone: Milestone) => void;
  unsubscribeFromWorker: (workerId: string) => void;
  startSession: (worker: LocalWorker, cwd: string, task: BuilddTask, resumeSessionId?: string) => Promise<void>;
}

/**
 * RecoveryManager handles abort, rollback, retry, recover, and session resume
 * operations extracted from WorkerManager.
 */
export class RecoveryManager {
  constructor(private deps: RecoveryDeps) {}

  async abort(workerId: string, reason?: string) {
    const session = this.deps.sessions.get(workerId);
    if (session) {
      // Abort the query and end the input stream
      session.abortController.abort();
      session.inputStream.end();
      this.deps.sessions.delete(workerId);
    }

    // Clear any pending permission request (unblocks the hook with deny)
    const pending = this.deps.pendingPermissionRequests.get(workerId);
    if (pending) {
      pending.resolve({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'Aborted by user' },
        },
      });
      this.deps.pendingPermissionRequests.delete(workerId);
    }

    // Unsubscribe from Pusher
    this.deps.unsubscribeFromWorker(workerId);

    const worker = this.deps.workers.get(workerId);
    if (worker) {
      worker.status = 'error';
      // Preserve existing error (e.g., from infinite loop detection) or use provided reason
      worker.error = worker.error || reason || 'Aborted by user';
      worker.currentAction = 'Aborted';
      // This may return 409 if already completed on server - that's ok
      try {
        await this.deps.buildd.updateWorker(workerId, { status: 'failed', error: worker.error });
      } catch {
        // Ignore - worker may already be done on server
      }
      this.deps.emit({ type: 'worker_update', worker });
    }
  }

  async rollback(workerId: string, checkpointUuid: string, dryRun = false): Promise<{ success: boolean; error?: string; filesChanged?: number; insertions?: number; deletions?: number }> {
    const worker = this.deps.workers.get(workerId);
    if (!worker) {
      return { success: false, error: 'Worker not found' };
    }

    const session = this.deps.sessions.get(workerId);
    if (!session?.queryInstance) {
      return { success: false, error: 'No active session — rollback requires a running or recently completed query' };
    }

    // Verify checkpoint exists
    const checkpoint = worker.checkpoints.find(cp => cp.uuid === checkpointUuid);
    if (!checkpoint) {
      return { success: false, error: 'Checkpoint not found' };
    }

    try {
      console.log(`[Worker ${workerId}] ${dryRun ? 'Dry-run' : 'Rolling back'} to checkpoint ${checkpointUuid.slice(0, 12)} (${checkpoint.files.length} files)`);
      const result = await session.queryInstance.rewindFiles(checkpointUuid, { dryRun });

      if (!result.canRewind) {
        return { success: false, error: result.error || 'Cannot rewind to this checkpoint' };
      }

      if (!dryRun) {
        this.deps.addMilestone(worker, {
          type: 'status',
          label: `Rollback: ${result.filesChanged || 0} files reverted`,
          ts: Date.now(),
        });
        // Remove checkpoints after the rolled-back one (they're now invalid)
        const cpIndex = worker.checkpoints.findIndex(cp => cp.uuid === checkpointUuid);
        if (cpIndex >= 0) {
          worker.checkpoints = worker.checkpoints.slice(0, cpIndex + 1);
        }
        worker.hasNewActivity = true;
        this.deps.emit({ type: 'worker_update', worker });
        storeSaveWorker(worker);
      }

      return {
        success: true,
        filesChanged: result.filesChanged,
        insertions: result.insertions,
        deletions: result.deletions,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Worker ${workerId}] Rollback failed:`, errMsg);
      return { success: false, error: errMsg };
    }
  }

  async retry(workerId: string) {
    const worker = this.deps.workers.get(workerId);
    if (!worker) return;

    // Abort current session if any
    const session = this.deps.sessions.get(workerId);
    if (session) {
      session.abortController.abort();
      session.inputStream.end();
      this.deps.sessions.delete(workerId);
    }

    // Reset worker state
    worker.status = 'working';
    worker.error = undefined;
    worker.currentAction = 'Retrying...';
    worker.hasNewActivity = true;
    worker.lastActivity = Date.now();
    worker.completedAt = undefined;
    worker.checkpoints = [];  // Clear checkpoints — new session generates fresh ones
    this.deps.addMilestone(worker, { type: 'status', label: 'Retry requested', ts: Date.now() });
    this.deps.emit({ type: 'worker_update', worker });
    storeSaveWorker(worker);

    await this.deps.buildd.updateWorker(worker.id, { status: 'running', currentAction: 'Retrying...' });

    // Resolve workspace
    const workspacePath = this.deps.resolver.resolve({
      id: worker.workspaceId,
      name: worker.workspaceName,
      repo: undefined,
    });

    if (!workspacePath) {
      worker.status = 'error';
      worker.error = 'Cannot resolve workspace path - check PROJECTS_ROOT or set a path override';
      worker.currentAction = 'Workspace not found';
      worker.hasNewActivity = true;
      worker.completedAt = Date.now();
      this.deps.emit({ type: 'worker_update', worker });
      await this.deps.buildd.updateWorker(worker.id, { status: 'failed', error: worker.error });
      return;
    }

    // Build context-preserving description (same as follow-up but with retry framing)
    const contextParts: string[] = [];
    if (worker.taskDescription) {
      contextParts.push(`## Original Task\n${worker.taskDescription}`);
    }

    // Include what was done so far
    if (worker.milestones.length > 0) {
      const milestoneLabels = worker.milestones
        .filter(m => !['Task completed', 'Retry requested'].includes(m.label))
        .map(m => m.type === 'phase' ? `- ${m.label} (${m.toolCount} tools)` : `- ${m.label}`);
      if (milestoneLabels.length > 0) {
        contextParts.push(`## Work Done Before Retry\n${milestoneLabels.join('\n')}`);
      }
    }

    contextParts.push('## Instructions\nThe previous session stalled. Please continue the task from where it left off.');

    const task = {
      id: worker.taskId,
      title: worker.taskTitle,
      description: contextParts.join('\n\n'),
      workspaceId: worker.workspaceId,
      workspace: { name: worker.workspaceName },
      status: 'assigned',
      priority: 1,
    };

    this.deps.startSession(worker, workspacePath, task as any).catch(err => {
      console.error(`[Worker ${worker.id}] Retry session error:`, err);
      if (worker.status === 'working') {
        worker.status = 'error';
        worker.error = err instanceof Error ? err.message : 'Retry session failed';
        worker.currentAction = 'Retry failed';
        worker.hasNewActivity = true;
        worker.completedAt = Date.now();
        this.deps.emit({ type: 'worker_update', worker });
      }
    });
  }

  async recover(workerId: string, mode: 'diagnose' | 'complete' | 'restart') {
    // Try loading from memory first, then disk
    let worker = this.deps.workers.get(workerId);
    if (!worker) {
      const diskWorker = storeLoadWorker(workerId);
      if (diskWorker) {
        this.deps.workers.set(workerId, diskWorker);
        worker = diskWorker;
        console.log(`[Worker ${workerId}] Restored from disk for recovery (status: ${diskWorker.status})`);
      }
    }

    if (!worker) {
      console.error(`[Worker ${workerId}] Cannot recover: worker not found in memory or on disk`);
      return;
    }

    console.log(`[Worker ${workerId}] Recovery initiated: mode=${mode}`);
    this.deps.addMilestone(worker, { type: 'status', label: `Recovery: ${mode}`, ts: Date.now() });

    switch (mode) {
      case 'restart':
        // Restart reuses the existing retry logic
        await this.retry(workerId);
        return;

      case 'diagnose':
      case 'complete':
        await this.runDoctorAgent(worker, mode);
        return;
    }
  }

  private async runDoctorAgent(worker: LocalWorker, goal: 'diagnose' | 'complete') {
    const workspacePath = this.deps.resolver.resolve({
      id: worker.workspaceId,
      name: worker.workspaceName,
      repo: undefined,
    });

    if (!workspacePath) {
      console.error(`[Worker ${worker.id}] Cannot run doctor: workspace not found`);
      await this.deps.buildd.updateWorker(worker.id, {
        status: 'failed',
        error: 'Recovery failed: workspace not found',
      });
      return;
    }

    // Use worktree if available, otherwise workspace root
    const cwd = worker.worktreePath && existsSync(worker.worktreePath)
      ? worker.worktreePath
      : workspacePath;

    // Build doctor prompt based on goal
    const contextParts: string[] = [];

    contextParts.push(`## Recovery Mode: ${goal}`);
    contextParts.push(`You are a recovery agent inspecting a worker that failed to complete properly.`);
    contextParts.push(`Worker ID: ${worker.id}`);
    contextParts.push(`Task: ${worker.taskTitle}`);
    if (worker.taskDescription) {
      contextParts.push(`Task Description: ${worker.taskDescription}`);
    }
    if (worker.branch) {
      contextParts.push(`Branch: ${worker.branch}`);
    }

    // Include what was done
    if (worker.milestones.length > 0) {
      const milestoneLabels = worker.milestones
        .filter(m => !['Recovery: diagnose', 'Recovery: complete'].includes(m.label))
        .map(m => `- ${m.label}`);
      if (milestoneLabels.length > 0) {
        contextParts.push(`## Previous Progress\n${milestoneLabels.join('\n')}`);
      }
    }

    // Last output from previous session
    if (worker.output && worker.output.length > 0) {
      const lastOutput = worker.output.slice(-3).join('\n');
      contextParts.push(`## Last Output\n${lastOutput}`);
    }

    if (goal === 'diagnose') {
      contextParts.push(`## Instructions
Inspect the current state and report findings. Do NOT continue the original task.

1. Run \`git status\` to check for uncommitted changes
2. Run \`git log --oneline -5\` to see recent commits
3. Check if the task work appears complete or partial
4. Report your findings as a structured summary

Your assessment should include:
- **status**: complete | partial | not_started | unknown
- **uncommitted_changes**: yes | no
- **unpushed_commits**: yes | no
- **recommendation**: complete | restart | fail
- **reason**: Brief explanation

Keep it brief. Budget: $0.50 max.`);
    } else {
      // 'complete' mode
      contextParts.push(`## Instructions
The previous agent completed the work but failed to report completion properly.
Your job is to close out this task — do NOT start new work.

1. Check \`git status\` — commit any uncommitted changes if they look intentional
2. Check \`git log origin/${worker.branch || 'main'}..HEAD\` — push unpushed commits if any
3. If a PR is needed and doesn't exist, create one using \`buildd\` action=create_pr
4. Call \`buildd\` action=complete_task with worker ID ${worker.id} and a summary of what was done
5. If the work is clearly incomplete or broken, call complete_task with an error instead

Budget: $1.00 max. Do NOT start new work or refactor anything.`);
    }

    const doctorPrompt = contextParts.join('\n\n');

    // Update worker status
    worker.status = 'working';
    worker.error = undefined;
    worker.currentAction = `Recovery: ${goal}...`;
    worker.hasNewActivity = true;
    worker.lastActivity = Date.now();
    this.deps.emit({ type: 'worker_update', worker });
    storeSaveWorker(worker);

    await this.deps.buildd.updateWorker(worker.id, {
      status: 'running',
      currentAction: `Recovery: ${goal}`,
    });

    // Build task-like object for startSession
    const task = {
      id: worker.taskId,
      title: `[Recovery] ${worker.taskTitle}`,
      description: doctorPrompt,
      workspaceId: worker.workspaceId,
      workspace: { name: worker.workspaceName },
      status: 'assigned',
      priority: 1,
    };

    // Start a new session with strict budget limits
    this.deps.startSession(worker, cwd, task as any).catch(err => {
      console.error(`[Worker ${worker.id}] Doctor agent failed:`, err);
      worker.status = 'error';
      worker.error = `Recovery ${goal} failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      worker.currentAction = 'Recovery failed';
      worker.hasNewActivity = true;
      worker.completedAt = Date.now();
      this.deps.emit({ type: 'worker_update', worker });
      this.deps.buildd.updateWorker(worker.id, { status: 'failed', error: worker.error }).catch(() => {});
    });
  }

  /**
   * Resume a completed worker session with automatic fallback.
   *
   * Layer 1: SDK resume via sessionId (full context preserved on disk)
   * Layer 2: Reconstructed context (text summary of previous session)
   *
   * Each layer is logged via sessionLog for production diagnostics.
   */
  async resumeSession(worker: LocalWorker, sessionCwd: string, message: string) {
    sessionLog(worker.id, 'info', 'resume_requested', `Follow-up on ${worker.status} worker`, worker.taskId);

    // Layer 1: Try SDK resume with sessionId (preserves full conversation history)
    if (worker.sessionId) {
      sessionLog(worker.id, 'info', 'resume_layer1_attempt', `SDK resume with sessionId ${worker.sessionId}`, worker.taskId);
      console.log(`[Worker ${worker.id}] Layer 1: Resuming session ${worker.sessionId} (cwd: ${sessionCwd})`);

      const task = {
        id: worker.taskId,
        title: worker.taskTitle,
        description: message,
        workspaceId: worker.workspaceId,
        workspace: { name: worker.workspaceName },
        status: 'assigned',
        priority: 1,
      };

      try {
        await this.deps.startSession(worker, sessionCwd, task as any, worker.sessionId);
        return; // Layer 1 succeeded
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sessionLog(worker.id, 'warn', 'resume_layer1_failed', errMsg, worker.taskId);
        console.error(`[Worker ${worker.id}] Layer 1 failed, falling back to reconstruction:`, err);
        // Reset worker state so Layer 2 can attempt a fresh session
        // (startSession's catch block sets status='error' before re-throwing)
        worker.status = 'working';
        worker.error = undefined;
        worker.completedAt = undefined;
        // Fall through to Layer 2
      }
    } else {
      sessionLog(worker.id, 'info', 'resume_layer1_skipped', 'No sessionId available', worker.taskId);
      console.log(`[Worker ${worker.id}] No sessionId — skipping Layer 1`);
    }

    // Layer 2: Reconstructed context (text summary of previous session)
    sessionLog(worker.id, 'info', 'resume_layer2_attempt', 'Reconstructed context fallback', worker.taskId);
    console.log(`[Worker ${worker.id}] Layer 2: Reconstructed context`);

    try {
      await this.restartWithReconstructedContext(worker, sessionCwd, message);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      sessionLog(worker.id, 'error', 'resume_layer2_failed', errMsg, worker.taskId);
      throw err; // Let the caller handle the final error
    }
  }

  // Restart session with text-reconstructed context
  // Used when SDK resume fails (corrupted session, disk cleanup) or no sessionId available
  private async restartWithReconstructedContext(worker: LocalWorker, workspacePath: string, message: string) {
    const contextParts: string[] = [];

    // Preamble: instruct agent not to re-explore
    contextParts.push(`## IMPORTANT: Continuing a previous conversation\nYou already analyzed this codebase in a previous session. Do NOT re-read files or re-explore the codebase unless the user asks about something new. Act directly on your previous analysis summarized below.`);

    // Add original task description
    if (worker.taskDescription) {
      contextParts.push(`## Original Task\n${worker.taskDescription}`);
    }

    // Extract files explored/modified from tool calls
    const filesExplored = new Set<string>();
    const filesModified = new Set<string>();
    for (const tc of worker.toolCalls) {
      const filePath = tc.input?.file_path as string;
      if (tc.name === 'Read' && filePath) {
        filesExplored.add(filePath);
      } else if ((tc.name === 'Edit' || tc.name === 'Write') && filePath) {
        filesModified.add(filePath);
      }
    }

    // Collapsed files context (grouped, not one-per-line)
    if (filesExplored.size > 0 || filesModified.size > 0) {
      const filesContext: string[] = ['## Files Context'];
      if (filesExplored.size > 0) {
        filesContext.push(`Files explored: ${Array.from(filesExplored).slice(-20).join(', ')}`);
      }
      if (filesModified.size > 0) {
        filesContext.push(`Files modified: ${Array.from(filesModified).join(', ')}`);
      }
      contextParts.push(filesContext.join('\n'));
    }

    // Build conversation history with collapsed tool calls
    const recentMessages = worker.messages.slice(-30);
    if (recentMessages.length > 0) {
      const historyLines: string[] = ['## Previous Conversation'];

      // Extract the last agent text response separately
      let lastAgentResponse: string | null = null;
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        if (recentMessages[i].type === 'text') {
          lastAgentResponse = recentMessages[i].content!;
          break;
        }
      }

      for (const msg of recentMessages) {
        if (msg.type === 'text') {
          // Skip the last response here — we add it separately below
          if (msg.content === lastAgentResponse) continue;
          historyLines.push(`**Agent:** ${msg.content}`);
        } else if (msg.type === 'user') {
          historyLines.push(`**User:** ${msg.content}`);
        }
        // Tool calls are omitted — file context above covers them
      }
      contextParts.push(historyLines.join('\n'));

      // Add the last agent response as a distinct section (this is what the user is replying to)
      if (lastAgentResponse) {
        contextParts.push(`## Your Last Response\n${lastAgentResponse}`);
      }
    }

    // Add milestones as work summary
    if (worker.milestones.length > 0) {
      const milestoneLabels = worker.milestones
        .filter(m => m.label !== 'Task completed')
        .map(m => m.type === 'phase' ? `- ${m.label} (${m.toolCount} tools)` : `- ${m.label}`);
      if (milestoneLabels.length > 0) {
        contextParts.push(`## Work Completed\n${milestoneLabels.join('\n')}`);
      }
    }

    // Add follow-up message
    contextParts.push(`## Follow-up Request\n${message}`);

    const contextDescription = contextParts.join('\n\n');

    const task = {
      id: worker.taskId,
      title: worker.taskTitle,
      description: contextDescription,
      workspaceId: worker.workspaceId,
      workspace: { name: worker.workspaceName },
      status: 'assigned',
      priority: 1,
    };

    await this.deps.startSession(worker, workspacePath, task as any);
  }
}
