import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, Milestone, PermissionSuggestion } from './types';
import { isPathDeniedByReadJail, resolveToolPath } from './read-jail.js';
import { findWorktreeEscape, findWriteEscape } from './worktree-confinement.js';
import { DANGEROUS_PATTERNS, SENSITIVE_PATHS, SENSITIVE_READ_PATHS, DANGEROUS_CREDENTIAL_READ_PATTERNS, classifyArtifactToolCall, isClaudeAiArtifactTool, type ClaudeAiArtifactAccess } from '@buildd/shared';
import { readFileSync } from 'fs';
import { saveWorker as storeSaveWorker } from './worker-store';
import type { BuilddClient } from './buildd';
import { exchangeAssertionConnector, isAuthError } from './assertion-exchange.js';
import { BUILDD_MCP_TOOL_NAME } from './action-events';
import { asksAQuestion, EMPTY_QUESTION_DENY_REASON } from './ask-user-question.js';
import { runnerDenial } from './runner-denial.js';
import { questionFromToolInput, runQuestionGate } from './question-gate.js';
import type { QuestionGateReply } from '@buildd/core/question-gate';
import type { PathClaimResponse } from './buildd';
import {
  extractEditPaths,
  normalizeWorktreePath,
  isRuntimeExcluded,
  isShipCommand,
  describeHolder,
  MAX_PENDING_PATHS,
  PATH_CLAIM_HOOK_DEADLINE_MS,
  type PathCollision,
  type CollisionSource,
} from './path-claim-enforcement.js';

import type { ShipCheckpointResult } from './ship-checkpoint';

/** Re-exported: the hook's backstop deadline lives beside the request timeout it must exceed. */
export { PATH_CLAIM_HOOK_DEADLINE_MS };

/** One line on why a ship checkpoint could not prove coverage. */
function describeUnknown(r: Extract<ShipCheckpointResult, { kind: 'unknown' }>): string {
  const cause = r.cause === 'sweep_incomplete'
    ? 'the task-owned file set could not be computed from git'
    : r.cause === 'server_rejected'
      ? 'the coordinator did not acknowledge the file set'
      : `the coordinator was unreachable: ${r.cause}`;
  return `${cause}${r.attempts > 0 ? ` after ${r.attempts} attempt(s)` : ''}${r.detail ? `; ${r.detail}` : ''}`;
}

/**
 * Deny-reason parts once a checkpoint collision is recorded, spread into
 * runnerDenial(). The runner is already checkpointing and deferring the task,
 * so there is nothing for the agent to wait for.
 */
function collisionDenial(c: PathCollision, what: string): [string, string] {
  return [
    `${what} is refused: ${c.path}, which this task already changed, is held by ${describeHolder(c)}. The runner is saving a checkpoint of this worktree and deferring the task until that task releases it`,
    'do not retry this call or make further edits; a later attempt resumes from the checkpoint',
  ];
}

/**
 * The one shape of a PreToolUse denial. Every deny in this file goes through
 * here with a `runnerDenial(...)` reason: an empty or bare reason reaches the
 * agent as a refusal it attributes to the user, and it stops the task
 * (runner-denials.test.ts enforces both).
 */
export function denyPreToolUse(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Dependencies that the hook factory needs from WorkerManager.
 * Passed as a context object to avoid coupling to the full class.
 */
export interface HookFactoryContext {
  config: {
    inputAsRetry?: boolean;
  };
  buildd: BuilddClient;
  addMilestone: (worker: LocalWorker, milestone: Milestone) => void;
  emit: (event: any) => void;
  /**
   * A confirmed checkpoint collision in enforce mode. WorkerManager persists
   * it, checkpoints the worktree and defers the task. Optional so tests and
   * advisory callers need not supply it.
   */
  onPathCollision?: (worker: LocalWorker, collision: PathCollision) => void;
  /**
   * Park an AskUserQuestion (waiting_input, notify, abort under inputAsRetry).
   * Called from the PreToolUse hook only for a gated worker
   * (`worker.questionGate`), once the question gate let the question through;
   * otherwise handleMessage parks it as before.
   */
  parkQuestion?: (worker: LocalWorker, toolInput: Record<string, unknown>, toolUseId?: string, gateReply?: QuestionGateReply) => Promise<void>;
  pendingPermissionRequests: Map<string, {
    resolve: (result: any) => void;
    toolInput: Record<string, unknown>;
    suggestions: unknown[];
    resolvePayloadType?: 'hook' | 'canUseTool';
  }>;
}

/**
 * Factory that creates SDK hook callbacks for worker sessions.
 *
 * Extracted from WorkerManager to reduce file size and isolate hook logic.
 * Each method returns a HookCallback function that captures the worker
 * and context in its closure.
 */
export class HookFactory {
  constructor(private ctx: HookFactoryContext) {}

  /**
   * PreToolUse hook that acquires file paths at the moment of Edit/Write/MultiEdit
   * (path-claims.md §6c, conflict-aware-orchestration.md §2).
   *
   * Paths are made worktree-relative; an escape is never sent as a claim.
   *
   * ADVISORY (default): a 409 never blocks the edit.
   * ENFORCE (`gitConfig.pathClaimEnforcement: 'enforce'`): a confirmed live
   * holder denies the edit and names the blocking task and path. After a
   * recorded checkpoint collision every further edit is refused.
   *
   * FAIL-OPEN in both modes (non-negotiable): the request is bounded by
   * PATH_CLAIM_TIMEOUT_MS (backstopped by PATH_CLAIM_HOOK_DEADLINE_MS); a
   * timeout, network error or 5xx lets the edit proceed, queues the path in
   * worker.pendingPaths and records degraded enforcement. Queued paths flush in their OWN request alongside the edit's,
   * so a held queued path can never deny an unrelated free edit, and only the
   * paths the server actually answered for leave the queue. A queued path the
   * server now reports held was already written: in enforce mode that is a
   * collision, handed to `onPathCollision`.
   */
  createPathClaimHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};
      const toolName = (input as any).tool_name as string;
      const rawPaths = extractEditPaths(toolName, (input as any).tool_input as Record<string, unknown>);
      if (rawPaths.length === 0) return {};

      // A recorded collision refuses every further edit, without a network call.
      const outcome = worker.pathClaimMode === 'enforce' && worker.pathCollision
        ? null
        : await this.claimEditPaths(worker, rawPaths);
      if (worker.pathClaimMode === 'enforce' && worker.pathCollision) {
        return denyPreToolUse(runnerDenial(...collisionDenial(worker.pathCollision, 'this edit')));
      }
      return outcome ?? {};
    };
  }

  /**
   * The body of the path-claim hook: normalize, claim, rebuild the pending
   * queue. Returns a deny result for a confirmed holder (enforce) or null. A
   * collision is recorded on `worker.pathCollision`, not returned.
   */
  private async claimEditPaths(
    worker: LocalWorker,
    rawPaths: string[],
  ): Promise<ReturnType<typeof denyPreToolUse> | null> {
    {
      const enforce = worker.pathClaimMode === 'enforce';
      // Normalize to worktree-relative paths; collect escapes.
      const root = worker.worktreePath || worker.sessionCwd;
      const newPaths: string[] = [];
      const escapes: string[] = [];
      for (const raw of rawPaths) {
        if (!root) { newPaths.push(raw); continue; }
        const n = normalizeWorktreePath(raw, root);
        if (n.ok) {
          if (!isRuntimeExcluded(n.path) && !newPaths.includes(n.path)) newPaths.push(n.path);
        } else if (n.reason === 'escape') {
          escapes.push(raw);
        }
      }
      if (enforce && escapes.length > 0) {
        return denyPreToolUse(runnerDenial(
          `${escapes.join(', ')} is outside this task's worktree, so it cannot be claimed for this task`,
          root ? `edit the file under ${root}` : undefined,
        ));
      }
      if (newPaths.length === 0) return null;

      const pending = (worker.pendingPaths ?? []).filter(p => !newPaths.includes(p));
      const [editResult, pendingResult] = await Promise.all([
        this.claimWithinDeadline(worker.taskId, newPaths),
        pending.length > 0 ? this.claimWithinDeadline(worker.taskId, pending) : Promise.resolve(null),
      ]);

      // Rebuild the queue path by path: keep what was not answered for.
      let queue = [...(worker.pendingPaths ?? [])].filter(p => !newPaths.includes(p));
      let collision: PathCollision | null = null;
      if (pendingResult) {
        if (pendingResult.kind === 'claimed') {
          queue = queue.filter(p => !pending.includes(p));
        } else if (pendingResult.kind === 'conflict') {
          // All-or-nothing: nothing was granted. Held paths leave the queue
          // (they will never be granted while held); the free ones retry.
          const held = pendingResult.blocked ?? pending.map(path => ({
            path, blockingTaskId: pendingResult.blockingTaskId, blockingPath: pendingResult.blockingPath ?? null,
          }));
          const heldSet = new Set(held.map(h => h.path));
          queue = queue.filter(p => !heldSet.has(p));
          console.log(`[Worker ${worker.id}] Path-claim: queued path(s) ${[...heldSet].join(', ')} now held by ${pendingResult.blockingTaskId}`);
          if (enforce && held.length > 0) {
            collision = {
              path: held[0].path,
              blockingTaskId: held[0].blockingTaskId,
              blockingTaskTitle: pendingResult.blockingTaskTitle ?? null,
              blockingPath: held[0].blockingPath ?? null,
              source: 'hook_flush',
              detectedAt: Date.now(),
            };
          }
        }
      }

      let denial: ReturnType<typeof denyPreToolUse> | null = null;
      if (editResult.kind === 'unavailable') {
        queue.push(...newPaths);
        this.recordDegraded(worker, newPaths, editResult.reason);
      } else if (editResult.kind === 'conflict') {
        const blocked = editResult.blocked?.[0];
        const path = blocked?.path ?? newPaths[0];
        console.log(`[Worker ${worker.id}] Path-claim ${enforce ? 'DENY' : 'advisory'} 409: ${editResult.blockingTaskId} holds ${newPaths.join(', ')}`);
        if (enforce) {
          denial = denyPreToolUse(runnerDenial(
            `${path} is being edited by ${describeHolder({
              blockingTaskId: editResult.blockingTaskId,
              blockingTaskTitle: editResult.blockingTaskTitle,
              blockingPath: blocked?.blockingPath ?? editResult.blockingPath,
            })}, and this workspace enforces path claims`,
            'leave that file alone and work on the rest of the task. You are registered as a waiter; a path_released message arrives on a later update_progress check-in once it is free',
          ));
        }
      }

      if (queue.length > MAX_PENDING_PATHS) queue = queue.slice(queue.length - MAX_PENDING_PATHS);
      worker.pendingPaths = queue;

      if (collision) {
        worker.pathCollision = collision;
        this.ctx.onPathCollision?.(worker, collision);
      }
      return denial;
    }
  }

  /**
   * claimPaths, backstopped by the hook's deadline in case the client ignores
   * its abort signal. The backstop sits above the request timeout, so a slow
   * answer still inside PATH_CLAIM_TIMEOUT_MS is always consumed.
   */
  private async claimWithinDeadline(taskId: string, paths: string[]): Promise<PathClaimResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<PathClaimResponse>(resolve => {
      timer = setTimeout(() => resolve({ kind: 'unavailable', reason: 'timeout' }), PATH_CLAIM_HOOK_DEADLINE_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.ctx.buildd.claimPaths(taskId, paths)).catch((): PathClaimResponse => ({ kind: 'unavailable', reason: 'error' })),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private recordDegraded(worker: LocalWorker, paths: string[], reason: string) {
    const first = !worker.pathClaimDegraded;
    worker.pathClaimDegraded = (worker.pathClaimDegraded ?? 0) + 1;
    // Attributed by cause so the ledger can tell a timeout from a network/5xx
    // error (PR #3487's distinction) instead of one "unavailable" bucket.
    const byCause = worker.pathClaimDegradedByCause ?? { timeout: 0, error: 0 };
    byCause[reason === 'timeout' ? 'timeout' : 'error'] += 1;
    worker.pathClaimDegradedByCause = byCause;
    console.log(`[Worker ${worker.id}] Path-claim unavailable (${reason}) for ${paths.join(', ')} — queued; enforcement degraded`);
    if (first) {
      this.ctx.addMilestone(worker, {
        type: 'status',
        label: `Path-claim service unavailable (${reason}): edits proceed, claims queued — enforcement degraded`,
        ts: Date.now(),
      });
    }
  }

  /**
   * Ship checkpoint guard (Claude only, both modes): before a ship — `git
   * push`, `gh pr create`, buildd `create_pr` or a non-error `complete_task` —
   * recompute the task's whole owned file set and reconcile it with the server
   * (ship-checkpoint.ts). The ship goes ahead only on a server ACK proving
   * complete coverage.
   *
   * Enforce mode fails CLOSED: a blocked path refuses the ship and starts the
   * deferral; coverage the server could not confirm (timeout, network error,
   * an unresolvable base) refuses the ship too, with the cause, and the agent
   * retries once coordination is back. Nothing ships on unknown coverage.
   *
   * Advisory mode still reconciles — the leases it leaves behind are what
   * protect every sibling — but reports rather than refuses: a blocked path is
   * logged, unknown coverage is recorded as `coverage_unknown_at_ship` on the
   * ledger via the next sync.
   *
   * This is checkpoint enforcement, not a pre-edit guarantee: a Bash write is
   * found here after it happened.
   */
  createPathCheckpointGuardHook(
    worker: LocalWorker,
    checkpoint: (worker: LocalWorker, source: CollisionSource) => Promise<ShipCheckpointResult>,
  ): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};
      const toolName = (input as any).tool_name as string;
      const toolInput = ((input as any).tool_input ?? {}) as Record<string, any>;
      const enforce = worker.pathClaimMode === 'enforce';

      let source: CollisionSource | null = null;
      let what = '';
      if (toolName === 'Bash' && isShipCommand(toolInput.command)) {
        source = 'pre_push'; what = 'this push';
      } else if (toolName === BUILDD_MCP_TOOL_NAME) {
        if (toolInput.action === 'create_pr') { source = 'pre_push'; what = 'create_pr'; }
        else if (toolInput.action === 'complete_task' && !toolInput.params?.error) { source = 'completion'; what = 'complete_task'; }
      }
      if (!source) return {};

      if (enforce && worker.pathCollision) {
        return denyPreToolUse(runnerDenial(...collisionDenial(worker.pathCollision, what)));
      }

      let result: ShipCheckpointResult;
      try {
        result = await checkpoint(worker, source);
      } catch (err) {
        // A checkpoint that crashed proved nothing. Same as unreachable.
        result = { kind: 'unknown', cause: 'error', attempts: 1, detail: err instanceof Error ? err.message.split('\n')[0] : String(err) };
      }

      if (result.kind === 'complete') return {};

      if (result.kind === 'blocked') {
        if (!enforce) {
          console.log(`[Worker ${worker.id}] Ship checkpoint advisory (${source}): ${result.collision.path} is held by ${result.collision.blockingTaskId}`);
          return {};
        }
        worker.pathCollision = result.collision;
        this.ctx.onPathCollision?.(worker, result.collision);
        return denyPreToolUse(runnerDenial(...collisionDenial(worker.pathCollision, what)));
      }

      // Coverage unknown. Record it for the server (it was unreachable, so the
      // next sync that lands carries the report), milestone it once per cause,
      // and in enforce mode refuse the ship — fail closed.
      const checkpointSource = source === 'completion' ? 'completion' : 'pre_push';
      worker.pendingShipReports = [
        ...(worker.pendingShipReports ?? []).slice(-19),
        { source: checkpointSource, result: 'unknown', cause: result.cause, refused: enforce, attempts: result.attempts, at: Date.now() },
      ];
      const label = `Ship checkpoint: path coverage unknown (${result.cause}) — ${enforce ? 'ship refused until coordination answers' : 'allowed; advisory mode'}`;
      worker.shipCoverageMilestones ??= [];
      if (!worker.shipCoverageMilestones.includes(label)) {
        worker.shipCoverageMilestones.push(label);
        this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      }
      storeSaveWorker(worker);
      if (!enforce) {
        console.log(`[Worker ${worker.id}] ${label}`);
        return {};
      }
      return denyPreToolUse(runnerDenial(
        `${what} is refused: buildd could not confirm that every file this task changed is coordinated (${describeUnknown(result)}). Nothing ships on unknown coverage`,
        'wait a moment and retry the same call; the runner re-checks with the coordinator each time. Do not work around it with --no-verify or by skipping create_pr',
      ));
    };
  }

  /**
   * PreToolUse hook for command-loop tasks: runs the verification command
   * BEFORE the agent's own `complete_task` reaches the server, and records the
   * evidence on the worker row.
   *
   * Why before: complete_task goes agent → buildd MCP → server directly, and
   * the server makes the loop exit decision on that PATCH. The runner's own
   * post-session evidence arrives after the row is terminal, is refused with
   * the rest of the completion payload, and (by design — it is a state input,
   * not a measurement) is not re-sent as metrics. Without this hook every
   * agent-authored completion of a command loop was evaluated as "no
   * verification evidence" and requeued, whatever the command would have said.
   *
   * The evidence travels as a runner-authored PATCH, never as a complete_task
   * parameter: the agent must not be able to author its own pass.
   *
   * Fail-open: if recording fails the call proceeds, and the server behaves as
   * it did before this hook existed. A complete_task carrying `error` is a
   * failure report, not a completion to verify, so it is left alone.
   */
  createLoopVerificationHook(
    worker: LocalWorker,
    collect: () => Promise<Record<string, unknown> | undefined>,
  ): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};
      if ((input as any).tool_name !== BUILDD_MCP_TOOL_NAME) return {};
      const toolInput = ((input as any).tool_input ?? {}) as { action?: string; params?: Record<string, unknown> };
      if (toolInput.action !== 'complete_task') return {};
      if (toolInput.params?.error) return {};

      this.ctx.addMilestone(worker, { type: 'status', label: 'Running verification command before complete_task…', ts: Date.now() });
      const verificationEvidence = await collect();
      if (!verificationEvidence) return {};
      try {
        await this.ctx.buildd.updateWorker(worker.id, { verificationEvidence });
        this.ctx.addMilestone(worker, {
          type: 'status',
          label: `Verification ${verificationEvidence.outcome === 'ok' ? 'passed' : String(verificationEvidence.outcome)} (exit ${verificationEvidence.exitCode ?? '?'})`,
          ts: Date.now(),
        });
      } catch (err) {
        console.warn(`[Worker ${worker.id}] Could not record verification evidence before complete_task: ${err instanceof Error ? err.message : String(err)}`);
      }
      return {};
    };
  }

  createReadJailHook(
    worker: LocalWorker,
    worktreePath: string,
    deniedPrefixes: string[],
  ): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};
      const toolName = (input as any).tool_name as string;
      if (toolName !== 'Read' && toolName !== 'Glob' && toolName !== 'Grep') return {};
      const toolInput = (input as any).tool_input as Record<string, unknown>;
      // Read uses file_path; Glob/Grep use path as an optional base dir
      const rawPath = toolName === 'Read'
        ? (toolInput.file_path as string | undefined)
        : (toolInput.path as string | undefined);
      if (!rawPath) return {};
      const absPath = resolveToolPath(rawPath, worktreePath);
      if (isPathDeniedByReadJail(absPath, worktreePath, deniedPrefixes)) {
        console.log(`[Worker ${worker.id}] Read-jail: denied ${toolName} → ${absPath}`);
        return denyPreToolUse(runnerDenial(
          `reads are confined to this worker's own worktree, and ${absPath} is outside it`,
          `read the equivalent file under ${worktreePath}, or skip it if the task does not need it`,
        ));
      }
      return {};
    };
  }

  /**
   * PreToolUse gate for claude.ai artifact tools (Artifact, ArtifactData,
   * ArtifactComments, ArtifactCheck, DesignSync). They act in the seat owner's
   * claude.ai account, so: read/list/get when opted in, publish only for
   * producer roles, delete never. Registered for every Claude session, so a
   * tool that appears without the opt-in (e.g. a role env secret setting
   * CLAUDE_CODE_ARTIFACT) is still refused. Policy: @buildd/shared
   * claude-ai-artifacts.ts.
   */
  createClaudeAiArtifactHook(worker: LocalWorker, access: ClaudeAiArtifactAccess): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};
      const toolName = (input as any).tool_name as string;
      if (!isClaudeAiArtifactTool(toolName)) return {};
      const toolInput = ((input as any).tool_input ?? {}) as Record<string, unknown>;
      const decision = classifyArtifactToolCall(toolName, toolInput, access);
      const url = typeof toolInput.url === 'string' ? toolInput.url : '';
      if (decision.allowed) {
        console.log(`[Worker ${worker.id}] claude.ai artifact: ${toolName} ${String(toolInput.action ?? '')} ${url}`.trim());
        return {};
      }
      console.log(`[Worker ${worker.id}] claude.ai artifact: denied ${toolName} ${String(toolInput.action ?? '')} ${url}`.trim());
      return denyPreToolUse(runnerDenial(
        decision.reason,
        'read the design from the copy-in artifact keys in the task context (get_artifact / list_artifacts), or ask in the task if it needs a write',
      ));
    };
  }

  /**
   * PreToolUse guard that keeps the agent acting in its own worktree.
   *
   * Worktrees are nested inside the primary clone, and agents were running
   * `cd <primary> && …` — testing, stashing and committing in the checkout every
   * worker shares. Denies Bash that changes directory into (or runs in) the
   * primary clone or a sibling worktree, and Edit/Write/MultiEdit/NotebookEdit
   * there. The worker's own worktree — itself under the primary path — and all
   * reads stay allowed. Policy lives in worktree-confinement.ts.
   */
  createWorktreeConfinementHook(
    worker: LocalWorker,
    worktreePath: string,
    primaryPath: string,
  ): HookCallback {
    const scope = { worktreePath, primaryPath };
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};
      const toolName = (input as any).tool_name as string;
      const toolInput = ((input as any).tool_input ?? {}) as Record<string, unknown>;

      let reason: string | null = null;
      if (toolName === 'Bash') {
        const command = typeof toolInput.command === 'string' ? toolInput.command : '';
        const cwd = typeof (input as any).cwd === 'string' ? (input as any).cwd as string : undefined;
        reason = findWorktreeEscape(command, { ...scope, cwd });
      } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
        const raw = (toolName === 'NotebookEdit' ? toolInput.notebook_path : toolInput.file_path) as string | undefined;
        if (raw) reason = findWriteEscape(raw, scope);
      }
      if (!reason) return {};

      console.log(`[Worker ${worker.id}] Worktree confinement: denied ${toolName} outside own worktree`);
      return denyPreToolUse(runnerDenial(reason));
    };
  }

  createPermissionHook(worker: LocalWorker, opts?: { inputPolicy?: string }): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreToolUse') return {};

      // A tool call is starting. Mark it in-flight and count it as activity so a
      // legitimately long, silent tool (e.g. a bash waiting on CI) is not treated
      // as a stalled session by checkStale. Cleared on PostToolUse / failure.
      worker.lastActivity = Date.now();
      worker.toolInFlight = true;

      // Track prompt_id for OTEL trace correlation (SDK v0.3.196)
      const promptId = (input as any).prompt_id as string | undefined;
      if (promptId && promptId !== worker.currentPromptId) {
        worker.currentPromptId = promptId;
      }

      const toolName = (input as any).tool_name;
      const toolInput = (input as any).tool_input as Record<string, unknown>;

      // An AskUserQuestion that asks nothing is not a question — deny it under
      // every input policy (see ask-user-question.ts). handleMessage skips the
      // park/abort for the same input, so the denial is what the agent sees.
      if (toolName === 'AskUserQuestion' && !asksAQuestion(toolInput)) {
        console.log(`[Worker ${worker.id}] Denied AskUserQuestion with no question text`);
        return denyPreToolUse(runnerDenial(EMPTY_QUESTION_DENY_REASON));
      }

      // Block AskUserQuestion when inputPolicy is 'autonomous' (default).
      // Prompt-level instruction alone is unreliable — enforce at hook level.
      if (toolName === 'AskUserQuestion'
          && (opts?.inputPolicy || 'autonomous') === 'autonomous'
          && this.ctx.config.inputAsRetry === false) {
        console.log(`[Worker ${worker.id}] Blocked AskUserQuestion (inputPolicy=autonomous)`);
        return denyPreToolUse(runnerDenial(
          'AskUserQuestion is disabled for this autonomous task, so the question was not sent to anyone',
          'make a reasonable decision yourself and proceed; to put a choice on record without waiting, post a note (buildd action=post_note, type=question, with defaultChoice)',
        ));
      }

      // AskUserQuestion is the agent's direct channel to the user — the question
      // itself is surfaced to the worker UI by handleMessage (waitingFor.type =
      // 'question'). It must NEVER be gated behind a separate tool-permission
      // approval ("may I ask you a question? → yes → here's the question").
      // Explicitly allow it here so it can't fall through to the PermissionRequest
      // / canUseTool gates. (The autonomous hard-block is handled above.)
      if (toolName === 'AskUserQuestion') {
        // Question gate (question-gate.ts): only for a worker whose claim
        // enrolled it. A pushback becomes this call's result and the agent
        // asks again; anything else parks the question here, because
        // handleMessage leaves gated questions to this hook.
        if (worker.questionGate) {
          const toolUseId = typeof (input as any).tool_use_id === 'string' ? (input as any).tool_use_id as string : undefined;
          const gate = await runQuestionGate(worker, questionFromToolInput(worker, toolInput, toolUseId), this.ctx.buildd);
          if (gate.action === 'pushback') {
            this.ctx.addMilestone(worker, { type: 'status', label: 'Question sent back: needs context', ts: Date.now() });
            return denyPreToolUse(runnerDenial(
              `this AskUserQuestion was not shown to anyone. ${gate.reason}`,
              'rewrite the question as a self-contained decision brief (what is being decided in this task and why it matters, what each option leads to, your recommended default first marked "(Recommended)") and call AskUserQuestion again',
            ));
          }
          if (gate.action === 'answer') {
            // Jev decided: the answer stands in for a person's reply. Nobody
            // was asked and nothing was parked — denying the tool call with
            // the answer as the reason is how the agent gets it, exactly like
            // a pushback, just not a request to rewrite.
            this.ctx.addMilestone(worker, { type: 'status', label: 'Question decided automatically', ts: Date.now() });
            return denyPreToolUse(runnerDenial(gate.reason, 'continue with this answer'));
          }
          await this.ctx.parkQuestion?.(worker, toolInput, toolUseId, gate.reply ?? undefined);
        }
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            permissionDecisionReason: 'AskUserQuestion is presented directly to the user; no separate permission needed',
          },
        };
      }

      // Block dangerous bash commands (destructive ops + credential file reads)
      if (toolName === 'Bash') {
        const command = (toolInput.command as string) || '';
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(command)) {
            console.log(`[Worker ${worker.id}] Blocked dangerous command: ${command.slice(0, 80)}`);
            return denyPreToolUse(runnerDenial(
              `this Bash command matches the destructive-command rule ${pattern}`,
              'use a narrower command that does the same job (for example delete a specific path inside your worktree, or reset one file), or skip the step if the task does not need it',
            ));
          }
        }
        // Block bash reads of runner credential files (second layer after env scoping)
        for (const pattern of DANGEROUS_CREDENTIAL_READ_PATTERNS) {
          if (pattern.test(command)) {
            console.log(`[Worker ${worker.id}] Blocked credential read via bash: ${command.slice(0, 80)}`);
            return denyPreToolUse(runnerDenial(
              'reading the runner\'s own credential files is blocked',
              'use the credentials already provided to you through your environment and MCP tools',
            ));
          }
        }

        // Explicitly allow safe bash commands (prevents acceptEdits stall)
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            permissionDecisionReason: 'Allowed by buildd permission hook',
          },
        };
      }

      // Block reads of runner credential files (capability scoping — not a permission prompt)
      if (toolName === 'Read') {
        const filePath = (toolInput.file_path as string) || '';
        for (const pattern of SENSITIVE_READ_PATHS) {
          if (pattern.test(filePath)) {
            console.log(`[Worker ${worker.id}] Blocked read of runner credential file: ${filePath}`);
            return denyPreToolUse(runnerDenial(
              `reading the runner's own credential files is blocked (${filePath})`,
              'use the credentials already provided to you through your environment and MCP tools',
            ));
          }
        }
      }

      // Block writes to sensitive paths
      if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
        const filePath = (toolInput.file_path as string) || (toolInput.filePath as string) || '';
        for (const pattern of SENSITIVE_PATHS) {
          if (pattern.test(filePath)) {
            console.log(`[Worker ${worker.id}] Blocked sensitive path write: ${filePath}`);
            return denyPreToolUse(runnerDenial(
              `writes to ${filePath} are blocked because it is a sensitive path`,
              'leave that file unchanged; if the task genuinely needs it changed, say so in your complete_task summary',
            ));
          }
        }
      }

      // Allow all other tools by default (prevents acceptEdits stall —
      // no terminal exists for interactive approval)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          permissionDecisionReason: 'Allowed by buildd permission hook',
        },
      };
    };
  }

  // Create a PostToolUse hook that captures team events (TeamCreate, SendMessage, Task).
  // Purely observational — returns {} and never blocks or modifies tool execution.
  createTeamTrackingHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PostToolUse') return {};

      // Tool finished — clear the in-flight flag and record activity.
      worker.lastActivity = Date.now();
      worker.toolInFlight = false;

      const toolName = (input as any).tool_name;
      const toolInput = (input as any).tool_input as Record<string, unknown>;

      if (toolName === 'TeamCreate') {
        const teamName = (toolInput.team_name as string) || 'unnamed';
        worker.teamState = {
          teamName,
          members: [],
          messages: [],
          createdAt: Date.now(),
        };
        this.ctx.addMilestone(worker, { type: 'status', label: `Team created: ${teamName}`, ts: Date.now() });
        console.log(`[Worker ${worker.id}] Team created: ${teamName}`);
      }

      if (toolName === 'SendMessage' && worker.teamState) {
        const msg = {
          from: (toolInput.sender as string) || 'leader',
          to: (toolInput.recipient as string) || (toolInput.type === 'broadcast' ? 'broadcast' : 'unknown'),
          content: (toolInput.content as string) || '',
          summary: (toolInput.summary as string) || undefined,
          timestamp: Date.now(),
        };
        worker.teamState.messages.push(msg);
        // Cap at 200 messages
        if (worker.teamState.messages.length > 200) {
          worker.teamState.messages.shift();
        }
        // Only emit milestone for broadcasts (avoid noise from DMs)
        if (toolInput.type === 'broadcast') {
          this.ctx.addMilestone(worker, { type: 'status', label: `Broadcast: ${msg.summary || msg.content.slice(0, 40)}`, ts: Date.now() });
        }
      }

      if (toolName === 'Task' && worker.teamState) {
        const agentName = (toolInput.name as string) || (toolInput.description as string) || 'subagent';
        const agentType = (toolInput.subagent_type as string) || undefined;
        worker.teamState.members.push({
          name: agentName,
          role: agentType,
          status: 'active',
          spawnedAt: Date.now(),
        });
        this.ctx.addMilestone(worker, { type: 'status', label: `Subagent: ${agentName}`, ts: Date.now() });
        console.log(`[Worker ${worker.id}] Subagent spawned: ${agentName}`);
      }

      return {};
    };
  }

  // Create a PostToolUseFailure hook that marks MCP calls as failed.
  // For assertion-mode connectors, also performs silent re-mint + re-exchange on
  // 401 errors (spec §F.2) and updates the in-memory MCP server headers so the
  // agent's next tool call retries with a fresh access token.
  createMcpFailureHook(
    worker: LocalWorker,
    mcpServersRef?: Record<string, any>,
    apiKey?: string,
    exchanger: typeof exchangeAssertionConnector = exchangeAssertionConnector,
  ): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PostToolUseFailure') return {};

      // Tool failed — clear the in-flight flag (so it can't get stuck) and record activity.
      worker.lastActivity = Date.now();
      worker.toolInFlight = false;

      const toolName = (input as any).tool_name as string;
      const toolError = String((input as any).error ?? (input as any).tool_output ?? '');

      // Only care about MCP tool failures
      if (toolName?.startsWith('mcp__') && worker.pendingMcpCalls?.length) {
        // Find the last matching pending call and mark it as failed
        for (let i = worker.pendingMcpCalls.length - 1; i >= 0; i--) {
          const call = worker.pendingMcpCalls[i];
          const expectedPrefix = `mcp__${call.server}__`;
          if (toolName.startsWith(expectedPrefix) && call.ok) {
            call.ok = false;
            break;
          }
        }

        // §F.2: Silent re-auth for assertion-mode connectors on 401.
        // Only attempt if we have the necessary context and the error looks like a 401.
        if (
          mcpServersRef &&
          apiKey &&
          worker.assertionConnectors?.length &&
          isAuthError(toolError)
        ) {
          // Derive the MCP server name from the tool name (mcp__<name>__<tool>).
          const serverName = toolName.split('__')[1];
          const assertionConn = worker.assertionConnectors.find(a => a.name === serverName);

          if (assertionConn) {
            try {
              const { accessToken, expiresAt } = await exchanger(
                assertionConn,
                apiKey,
                worker.id,
                worker.taskId,
              );
              // Update the in-memory MCP server entry so the next tool call uses the new token.
              const entry = mcpServersRef[serverName];
              if (entry?.type === 'http') {
                entry.headers = { Authorization: `Bearer ${accessToken}` };
              }
              worker.assertionTokenCache ??= new Map();
              worker.assertionTokenCache.set(serverName, { accessToken, expiresAt });
              console.log(`[Worker ${worker.id}] Assertion re-auth succeeded for connector ${serverName}`);
            } catch (err) {
              // Re-exchange failed — mark so handleMessage can fire the circuit breaker
              // when it processes the tool_result (spec §F.2: exhausted → connector:auth_expired).
              worker.assertionReAuthFailed ??= new Set();
              worker.assertionReAuthFailed.add(serverName);
              console.error(`[Worker ${worker.id}] Assertion re-auth failed for connector ${serverName}:`, err);
            }
          }
        }
      }

      return {};
    };
  }

  // Create a TeammateIdle hook that updates team member status when a teammate goes idle.
  // Purely observational — emits events for dashboard/Pusher visibility.
  createTeammateIdleHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'TeammateIdle') return {};

      const teammateName = (input as any).teammate_name as string;
      const teamName = (input as any).team_name as string;

      // Update team member status if we're tracking team state
      if (worker.teamState) {
        const member = worker.teamState.members.find(m => m.name === teammateName);
        if (member) {
          member.status = 'idle';
        }
      }

      this.ctx.addMilestone(worker, { type: 'status', label: `Teammate idle: ${teammateName}`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Teammate idle: ${teammateName} (team: ${teamName})`);

      return { async: true };
    };
  }

  // Create a PermissionRequest hook that blocks until the user approves or denies.
  // Displays tool_name, tool_input, and permission_suggestions in the worker detail UI.
  // Returns a decision (allow/deny) based on user input via resolvePermission().
  createPermissionRequestHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PermissionRequest') return {};

      const toolName = (input as any).tool_name as string;
      const toolInput = (input as any).tool_input as Record<string, unknown>;
      const permissionSuggestions = (input as any).permission_suggestions as unknown[] | undefined;

      // AskUserQuestion is the agent's direct line to the user; the question
      // itself is surfaced to the worker UI by handleMessage. Never gate it
      // behind a redundant "grant permission to ask a question" approval —
      // allow it straight through so the user sees a single prompt (the question).
      if (toolName === 'AskUserQuestion') {
        console.log(`[Worker ${worker.id}] Auto-allowing AskUserQuestion (user-facing tool, no permission gate)`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest' as const,
            decision: { behavior: 'allow' as const, updatedInput: toolInput },
          },
        };
      }

      console.log(`[Worker ${worker.id}] Permission requested: ${toolName}, suggestions=${permissionSuggestions?.length || 0}`);

      // Build human-readable labels for each suggestion
      const suggestions: PermissionSuggestion[] = (permissionSuggestions || []).map((s: any) => {
        let label = '';
        if (s.type === 'addRules' || s.type === 'replaceRules') {
          const rules = (s.rules as Array<{ toolName: string; ruleContent?: string }>)?.map(
            r => r.ruleContent ? `${r.toolName}: ${r.ruleContent}` : r.toolName
          ) || [];
          label = `Allow ${rules.join(', ')}`;
        } else if (s.type === 'setMode') {
          label = `Switch to ${s.mode} mode`;
        } else if (s.type === 'addDirectories') {
          label = `Allow access to ${(s.directories as string[])?.join(', ') || 'directories'}`;
        } else {
          label = `${s.type}`;
        }
        return { type: s.type, label, raw: s };
      });

      // Build a descriptive prompt
      const cmdPreview = toolName === 'Bash'
        ? (toolInput.command as string)?.slice(0, 120) || ''
        : '';
      const prompt = cmdPreview
        ? `Permission required for ${toolName}: ${cmdPreview}`
        : `Permission required for ${toolName}`;

      // Set worker to waiting state
      worker.status = 'waiting';
      worker.waitingFor = {
        type: 'permission',
        prompt,
        toolName,
        toolInput,
        permissionSuggestions: suggestions,
        options: [
          { label: 'Allow once', description: 'Allow this single tool call' },
          ...(suggestions.length > 0 ? [{ label: 'Always allow', description: 'Apply suggested permission rules for the session' }] : []),
          { label: 'Deny', description: 'Block this tool call' },
        ],
      };
      worker.currentAction = `Permission: ${toolName}`;
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      this.ctx.addMilestone(worker, { type: 'status', label: `Permission: ${toolName}`, ts: Date.now() });

      // Sync to server and persist
      this.ctx.buildd.updateWorker(worker.id, {
        status: 'waiting_input',
        currentAction: worker.currentAction,
        waitingFor: {
          type: 'permission',
          prompt,
          options: worker.waitingFor.options?.map(o => typeof o === 'string' ? o : o.label),
        },
      }).catch(() => {});
      storeSaveWorker(worker);
      this.ctx.emit({ type: 'worker_update', worker });

      // Block the hook until the user resolves the permission decision
      return new Promise<any>((resolve) => {
        this.ctx.pendingPermissionRequests.set(worker.id, {
          resolve,
          toolInput,
          suggestions: permissionSuggestions || [],
          resolvePayloadType: 'hook',
        });
      });
    };
  }

  // Create a canUseTool callback for programmatic permission decisions (SDK v0.3.186+).
  // Background agents now forward permission prompts to canUseTool instead of auto-denying.
  // Main agent calls are allowed immediately (hooks handle the actual decisions).
  // Background subagent calls (agentID present) are routed to the user via waitingFor.
  // agentID and requestId (v0.3.199) uniquely identify the request for multi-agent routing.
  createCanUseToolCallback(worker: LocalWorker, bypassPermissions: boolean): (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: unknown[];
      agentID?: string;
      requestId: string;
      toolUseID: string;
      title?: string;
      description?: string;
      [key: string]: unknown;
    },
  ) => Promise<{ behavior: 'allow'; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string }> {
    return async (toolName, input, options) => {
      const { agentID, requestId, title, suggestions } = options;

      // AskUserQuestion is the user-interaction channel itself — never gate it
      // behind a tool-permission prompt (for the main agent or a subagent). The
      // question is surfaced to the worker UI directly; a "grant permission to
      // ask you a question" step would be a nonsensical double-prompt.
      if (toolName === 'AskUserQuestion') {
        return { behavior: 'allow' as const };
      }

      // Main agent path (no agentID): allow — hooks run next and make the real decision
      if (!agentID) {
        return { behavior: 'allow' as const };
      }

      // Background subagent path: route to user for approval
      // If another permission request is already pending, deny to avoid deadlock
      if (this.ctx.pendingPermissionRequests.has(worker.id)) {
        console.log(`[Worker ${worker.id}] canUseTool: denied ${toolName} from agent ${agentID} (request ${requestId}) — another request already pending`);
        return {
          behavior: 'deny' as const,
          message: runnerDenial(
            'a permission request from this session is already waiting on a person, and only one can wait at a time',
            'retry this call after that request is answered, or make it from the main agent',
          ),
        };
      }

      const prompt = title || `Permission required for ${toolName} (subagent: ${agentID})`;

      // Build human-readable labels for each suggestion (reuse PermissionRequest logic)
      const permissionSuggestions: import('./types').PermissionSuggestion[] = ((suggestions as any[]) || []).map((s: any) => {
        let label = '';
        if (s.type === 'addRules' || s.type === 'replaceRules') {
          const rules = (s.rules as Array<{ toolName: string; ruleContent?: string }>)?.map(
            r => r.ruleContent ? `${r.toolName}: ${r.ruleContent}` : r.toolName,
          ) || [];
          label = `Allow ${rules.join(', ')}`;
        } else if (s.type === 'setMode') {
          label = `Switch to ${s.mode} mode`;
        } else if (s.type === 'addDirectories') {
          label = `Allow access to ${(s.directories as string[])?.join(', ') || 'directories'}`;
        } else {
          label = `${s.type}`;
        }
        return { type: s.type, label, raw: s };
      });

      // Set worker to waiting state
      worker.status = 'waiting';
      worker.waitingFor = {
        type: 'permission',
        prompt,
        toolName,
        toolInput: input,
        permissionSuggestions,
        options: [
          { label: 'Allow once', description: 'Allow this tool call' },
          ...(permissionSuggestions.length > 0 ? [{ label: 'Always allow', description: 'Apply suggested permission rules for the session' }] : []),
          { label: 'Deny', description: 'Block this tool call' },
        ],
      };
      worker.currentAction = `Permission: ${toolName} (agent: ${agentID})`;
      worker.hasNewActivity = true;
      worker.lastActivity = Date.now();
      this.ctx.addMilestone(worker, { type: 'status', label: `canUseTool: ${toolName} (agent: ${agentID})`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] canUseTool: ${toolName} from agent ${agentID} (request ${requestId})`);

      // Sync to server and persist
      this.ctx.buildd.updateWorker(worker.id, {
        status: 'waiting_input',
        currentAction: worker.currentAction,
        waitingFor: {
          type: 'permission',
          prompt,
          options: worker.waitingFor.options?.map(o => typeof o === 'string' ? o : o.label),
        },
      }).catch(() => {});
      storeSaveWorker(worker);
      this.ctx.emit({ type: 'worker_update', worker });

      // Block until user resolves the permission decision
      return new Promise<{ behavior: 'allow'; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string }>((resolve) => {
        this.ctx.pendingPermissionRequests.set(worker.id, {
          resolve,
          toolInput: input,
          suggestions: suggestions || [],
          resolvePayloadType: 'canUseTool',
        });
      });
    };
  }

  // Create a TaskCompleted hook that logs task completions within agent teams.
  // Emits milestones and updates team state for dashboard visibility.
  createTaskCompletedHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'TaskCompleted') return {};

      const taskId = (input as any).task_id as string;
      const taskSubject = (input as any).task_subject as string;
      const teammateName = (input as any).teammate_name as string | undefined;
      const teamName = (input as any).team_name as string | undefined;

      // Update team member status if completed by a known teammate
      if (worker.teamState && teammateName) {
        const member = worker.teamState.members.find(m => m.name === teammateName);
        if (member) {
          member.status = 'done';
        }
      }

      const label = teammateName
        ? `Task done (${teammateName}): ${taskSubject.slice(0, 50)}`
        : `Task done: ${taskSubject.slice(0, 50)}`;
      this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Task completed: ${taskSubject} (teammate: ${teammateName || 'leader'}, team: ${teamName || 'none'})`);

      return { async: true };
    };
  }

  // Create a SubagentStart hook that tracks subagent spawning.
  // Updates team state and emits milestones for dashboard visibility.
  createSubagentStartHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'SubagentStart') return {};

      // A subagent spawn is activity — keep the parent alive across silent subagent runs.
      worker.lastActivity = Date.now();

      const agentId = (input as any).agent_id as string;
      const agentType = (input as any).agent_type as string;

      // Update team member status if we're tracking team state
      if (worker.teamState) {
        const member = worker.teamState.members.find(m => m.name === agentId);
        if (member) {
          member.status = 'active';
        }
      }

      this.ctx.addMilestone(worker, { type: 'status', label: `Subagent started: ${agentType}`, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent started: ${agentType} (id: ${agentId})`);

      return { async: true };
    };
  }

  // Create a SubagentStop hook that tracks subagent completion.
  // Updates team state and emits milestones for dashboard visibility.
  createSubagentStopHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'SubagentStop') return {};

      // A subagent completing is activity — keep the parent alive between stream messages.
      worker.lastActivity = Date.now();

      const stopHookActive = (input as any).stop_hook_active as boolean;
      const lastAssistantMessage = (input as any).last_assistant_message as string | undefined;

      const label = lastAssistantMessage
        ? `Subagent: ${lastAssistantMessage.slice(0, 80)}${lastAssistantMessage.length > 80 ? '...' : ''}`
        : 'Subagent stopped';
      this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Subagent stopped (stop_hook_active: ${stopHookActive}, has_message: ${!!lastAssistantMessage})`);

      return { async: true };
    };
  }

  // Create a Stop hook that captures the last assistant message (v0.2.47+).
  // Used to generate prompt suggestions for follow-up actions after task completion.
  createStopHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'Stop') return {};

      // Track prompt_id for OTEL trace correlation (SDK v0.3.196)
      const promptId = (input as any).prompt_id as string | undefined;
      if (promptId && promptId !== worker.currentPromptId) {
        worker.currentPromptId = promptId;
      }

      const lastMessage = (input as any).last_assistant_message as string | undefined;
      if (lastMessage) {
        worker.lastAssistantMessage = lastMessage;
        // Generate prompt suggestions from the last message and task context
        worker.promptSuggestions = extractPromptSuggestions(worker, lastMessage);
        if (worker.promptSuggestions.length > 0) {
          console.log(`[Worker ${worker.id}] Generated ${worker.promptSuggestions.length} prompt suggestion(s)`);
        }
      }

      return { async: true };
    };
  }

  // Create a ConfigChange hook that logs config file changes (SDK v0.2.49+).
  // Emits milestones for audit trail and optionally blocks changes per workspace config.
  createConfigChangeHook(worker: LocalWorker, blockChanges: boolean): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'ConfigChange') return {};

      const filePath = (input as any).file_path as string;
      const changeType = (input as any).change_type as string;

      const label = blockChanges
        ? `Config change blocked: ${filePath}`
        : `Config changed: ${filePath} (${changeType})`;
      this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] ConfigChange: ${filePath} (${changeType}, blocked=${blockChanges})`);

      if (blockChanges) {
        return { continue: false };
      }

      return { async: true };
    };
  }

  // Create a Notification hook that captures agent status messages.
  // Emits milestones for dashboard visibility and logs the notification.
  createNotificationHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'Notification') return {};

      // Track prompt_id for OTEL trace correlation (SDK v0.3.196)
      const promptId = (input as any).prompt_id as string | undefined;
      if (promptId && promptId !== worker.currentPromptId) {
        worker.currentPromptId = promptId;
      }

      const message = (input as any).message as string;
      const title = (input as any).title as string | undefined;

      const label = title
        ? `${title}: ${message.slice(0, 60)}`
        : message.slice(0, 80);
      this.ctx.addMilestone(worker, { type: 'status', label, ts: Date.now() });
      console.log(`[Worker ${worker.id}] Notification: ${title ? `[${title}] ` : ''}${message}`);

      return { async: true };
    };
  }

  // Create a PreCompact hook that archives the full transcript before context compaction.
  // This preserves worker reasoning history that would otherwise be lost during compaction.
  createPreCompactHook(worker: LocalWorker): HookCallback {
    return async (input) => {
      if ((input as any).hook_event_name !== 'PreCompact') return {};

      const transcriptPath = (input as any).transcript_path as string | undefined;
      const trigger = (input as any).trigger as 'manual' | 'auto' | undefined;

      if (!transcriptPath) return {};

      try {
        const transcript = readFileSync(transcriptPath, 'utf-8');
        this.ctx.addMilestone(worker, { type: 'status', label: `Transcript archived (${trigger || 'auto'} compaction)`, ts: Date.now() });
        this.ctx.emit({
          type: 'transcript_archived',
          worker,
          data: {
            trigger: trigger || 'auto',
            transcriptPath,
            transcript,
          },
        });
        console.log(`[Worker ${worker.id}] Transcript archived before ${trigger || 'auto'} compaction (${transcript.length} chars)`);
      } catch {
        // Transcript file may not exist or be unreadable — non-fatal
      }
      return {};
    };
  }
}

// Extract prompt suggestions from the last assistant message and task context.
// Heuristic: look for actionable follow-up patterns in the final message.
export function extractPromptSuggestions(worker: LocalWorker, lastMessage: string): string[] {
  const suggestions: string[] = [];

  // Check for common follow-up patterns in the last message
  const hasCommits = worker.commits.length > 0;
  const hasPR = lastMessage.toLowerCase().includes('pull request') || lastMessage.toLowerCase().includes('pr ');
  const hasTests = lastMessage.toLowerCase().includes('test');
  const hasBuild = lastMessage.toLowerCase().includes('build');

  // If there are commits but no PR mentioned, suggest creating one
  if (hasCommits && !hasPR) {
    suggestions.push('Create a pull request for these changes');
  }

  // If code was changed, suggest running tests
  if (hasCommits && !hasTests) {
    suggestions.push('Run the test suite to verify changes');
  }

  // If tests were mentioned but not build, suggest build verification
  if (hasTests && !hasBuild) {
    suggestions.push('Run the build to check for errors');
  }

  // Look for explicit "next steps" or "you might want to" patterns
  const nextStepPatterns = [
    /(?:next steps?|you (?:can|could|might|may|should) (?:also |want to )?|consider |try |to follow up)[:\-]?\s*(.{10,80})/gi,
    /(?:TODO|FIXME|NOTE)[:\s]+(.{10,80})/gi,
  ];

  for (const pattern of nextStepPatterns) {
    let match;
    while ((match = pattern.exec(lastMessage)) !== null) {
      const suggestion = match[1].trim().replace(/[.!,;]+$/, '');
      if (suggestion.length >= 10 && suggestion.length <= 80) {
        suggestions.push(suggestion);
      }
      if (suggestions.length >= 5) break;
    }
    if (suggestions.length >= 5) break;
  }

  // Deduplicate and limit to 5 suggestions
  return [...new Set(suggestions)].slice(0, 5);
}
