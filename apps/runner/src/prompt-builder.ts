import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, BuilddTask } from './types';
import { sessionLog } from './session-logger';
import { shouldDenyPrMutation } from './pr-mutation-enforcement.js';
import { resolveTaskPrBase } from '@buildd/core/mission-integration';
import { HEARTBEAT_PROTOCOL_BLOCK } from '@buildd/shared';
import {
  buildMemoryBlock,
  byteLength,
  type MemoryBlockResult,
  type PromptSectionRecord,
} from './memory-digest-policy';

// ── Config resolution ──────────────────────────────────────────────

type WorkspaceConfig = { gitConfig?: any; configStatus?: string };

/**
 * Resolve bypass-permissions setting.
 * Priority: workspace gitConfig (if admin_confirmed) > local config > false
 */
export function resolveBypassPermissions(
  workspaceConfig: WorkspaceConfig,
  localBypassPermissions?: boolean,
): boolean {
  const isAdminConfirmed = workspaceConfig.configStatus === 'admin_confirmed';
  const wsBypass = workspaceConfig.gitConfig?.bypassPermissions;

  // Workspace-level setting takes priority if admin confirmed
  if (isAdminConfirmed && typeof wsBypass === 'boolean') {
    return wsBypass;
  }

  // Fall back to runner config
  if (typeof localBypassPermissions === 'boolean') {
    return localBypassPermissions;
  }

  // Default: false
  return false;
}

/**
 * Resolve maxBudgetUsd for SDK cost control.
 * Priority: workspace gitConfig (if admin_confirmed) > local config > undefined (no limit)
 */
export function resolveMaxBudgetUsd(
  workspaceConfig: WorkspaceConfig,
  localMaxBudgetUsd?: number,
): number | undefined {
  const isAdminConfirmed = workspaceConfig.configStatus === 'admin_confirmed';
  const wsBudget = workspaceConfig.gitConfig?.maxBudgetUsd;

  // Workspace-level setting takes priority if admin confirmed
  if (isAdminConfirmed && typeof wsBudget === 'number' && wsBudget > 0) {
    return wsBudget;
  }

  // Fall back to runner config
  if (typeof localMaxBudgetUsd === 'number' && localMaxBudgetUsd > 0) {
    return localMaxBudgetUsd;
  }

  return undefined;
}

/**
 * Resolve maxTurns for SDK-level turn limiting.
 * Priority: workspace gitConfig (if admin_confirmed) > local config > undefined (no limit)
 */
export function resolveMaxTurns(
  workspaceConfig: WorkspaceConfig,
  localMaxTurns?: number,
): number | undefined {
  const isAdminConfirmed = workspaceConfig.configStatus === 'admin_confirmed';
  const wsTurns = workspaceConfig.gitConfig?.maxTurns;

  // Workspace-level setting takes priority if admin confirmed
  if (isAdminConfirmed && typeof wsTurns === 'number' && wsTurns > 0) {
    return wsTurns;
  }

  // Fall back to runner config
  if (typeof localMaxTurns === 'number' && localMaxTurns > 0) {
    return localMaxTurns;
  }

  return undefined;
}

// ── Model selection ────────────────────────────────────────────────

/**
 * Resolve which model this session runs on.
 *
 * Priority: the per-task model the claim route resolved (written to
 * `task.context.model` by the smart-routing decision, and also the landing spot
 * for an explicit per-task override) > the runner-global `config.model`.
 *
 * Before this existed the runner always ran `config.model`, so the router's
 * decision was computed, persisted, shipped to the runner and discarded.
 *
 * **On by default; `BUILDD_HONOR_TASK_MODEL=0` is the kill switch.** The claim
 * route writes `context.model` for EVERY claimed task, so this moves the fleet
 * onto the tier registry's models — tasks the router tiers to opus run on opus,
 * and ones it tiers to haiku run on haiku. That is the whole point of the tier
 * system, which until now computed a decision and threw it away.
 *
 * Set the env var to `0` on a runner to fall back to `config.model` without a
 * revert or a redeploy — a restart is enough. Use that if fleet spend moves in a
 * direction you did not expect.
 *
 * Note the corollary: a runner pinned to a model via `--model`/config no longer
 * overrides the server for claimed tasks. `config.model` remains the default for
 * non-claim paths and the local UI.
 */
export function honorTaskModelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BUILDD_HONOR_TASK_MODEL !== '0';
}

export function resolveSessionModel(
  taskContext: unknown,
  configModel: string,
  honorTaskModel: boolean = honorTaskModelEnabled(),
): string {
  if (!honorTaskModel) return configModel;
  const ctx = taskContext as { model?: unknown } | null | undefined;
  const taskModel = typeof ctx?.model === 'string' ? ctx.model.trim() : '';
  return taskModel || configModel;
}

/**
 * The model the session actually ran on, for `task_outcomes.actual_model`.
 *
 * Priority: the SDK's own per-model attribution (`usage.byModel`) > the model
 * reported on the init message > the model we asked for. On seat/OAuth auth
 * `byModel` is empty, which is why the later fallbacks matter.
 *
 * When several models appear (a mid-session fallback fired), the one that
 * produced the most output tokens is the representative model.
 */
export function resolveActualModel(input: {
  modelUsage?: Record<string, unknown> | null;
  reportedModel?: string | null;
  requestedModel?: string | null;
}): string | null {
  const entries = Object.entries(input.modelUsage ?? {});
  if (entries.length === 1) return entries[0][0];
  if (entries.length > 1) {
    let best = entries[0][0];
    let bestOut = -1;
    for (const [model, usage] of entries) {
      const out = (usage as { outputTokens?: unknown } | null)?.outputTokens;
      const n = typeof out === 'number' && Number.isFinite(out) ? out : 0;
      if (n > bestOut) { bestOut = n; best = model; }
    }
    return best;
  }
  const reported = typeof input.reportedModel === 'string' ? input.reportedModel.trim() : '';
  if (reported) return reported;
  const requested = typeof input.requestedModel === 'string' ? input.requestedModel.trim() : '';
  return requested || null;
}

// ── Model capabilities ─────────────────────────────────────────────

/**
 * Discover model capabilities via SDK v0.2.49+ supportedModels().
 * Validates configured effort/thinking against actual model support and
 * stores capability info on the worker for dashboard visibility.
 * Runs in background (fire-and-forget) to avoid blocking the message loop.
 */
export function discoverModelCapabilities(
  queryInstance: ReturnType<typeof query>,
  worker: LocalWorker,
  configured: {
    effort?: string;
    thinking?: { type: string; budgetTokens?: number };
    extendedContext?: boolean;
  },
  modelId: string,
  emit: (event: any) => void,
): void {
  // Fire-and-forget — capability discovery should not block the worker
  queryInstance.supportedModels().then((models: any[]) => {
    // `ModelInfo.value` is the model ALIAS (e.g. 'sonnet'); `resolvedModel` is
    // the canonical wire id it resolves to (e.g. 'claude-sonnet-5') — see the
    // SDK's own ModelInfo doc comment. Tasks are configured with exact wire
    // ids far more often than bare aliases, so matching on `value` alone
    // missed every lookup in the fleet: this comparison must accept a match
    // on either field.
    const currentModel = models.find((m: any) => m.value === modelId || m.resolvedModel === modelId);

    if (!currentModel) {
      const warning = `Model "${modelId}" not found in supported models list`;
      console.warn(`[Worker ${worker.id}] ${warning}`);
      // This branch used to be the only warning path in this function that
      // skipped sessionLog — console-only, so the one warning actually able
      // to fire left no durable record.
      sessionLog(worker.id, 'warn', 'model_capability', warning, worker.taskId);
      worker.modelCapabilities = { warnings: [warning] };
      emit('event');
      return;
    }

    // Extract capability fields added in SDK v0.2.49
    const supportsEffort = currentModel.supportsEffort ?? false;
    const supportedEffortLevels: string[] = currentModel.supportedEffortLevels ?? [];
    const supportsAdaptiveThinking = currentModel.supportsAdaptiveThinking ?? false;

    const warnings: string[] = [];

    // Validate effort configuration
    if (configured.effort && !supportsEffort) {
      warnings.push(`Effort "${configured.effort}" configured but model "${modelId}" does not support effort — option will be ignored by SDK`);
    } else if (configured.effort && supportsEffort && supportedEffortLevels.length > 0) {
      if (!supportedEffortLevels.includes(configured.effort)) {
        warnings.push(`Effort "${configured.effort}" not in supported levels [${supportedEffortLevels.join(', ')}] for model "${modelId}"`);
      }
    }

    // Validate thinking configuration
    if (configured.thinking) {
      if (configured.thinking.type === 'adaptive' && !supportsAdaptiveThinking) {
        warnings.push(`Adaptive thinking configured but model "${modelId}" does not support it — option will be ignored by SDK`);
      }
      if (configured.thinking.type === 'enabled' && !supportsAdaptiveThinking) {
        warnings.push(`Extended thinking configured but model "${modelId}" does not support thinking — option will be ignored by SDK`);
      }
    }

    // Log warnings
    for (const warning of warnings) {
      console.warn(`[Worker ${worker.id}] ${warning}`);
      sessionLog(worker.id, 'warn', 'model_capability', warning, worker.taskId);
    }

    // Store capabilities on worker for API/dashboard access
    worker.modelCapabilities = {
      model: modelId,
      capabilities: {
        supportsEffort,
        supportedEffortLevels,
        supportsAdaptiveThinking,
      },
      warnings,
    };

    emit('event');
  }).catch((err: Error) => {
    // Non-fatal — capability discovery failure should not block the worker
    console.warn(`[Worker ${worker.id}] Model capability discovery failed: ${err.message}`);
    worker.modelCapabilities = { warnings: [`Capability discovery failed: ${err.message}`] };
    emit('event');
  });
}

// ── Prompt assembly ────────────────────────────────────────────────

export interface PromptContext {
  task: BuilddTask;
  worker: LocalWorker;
  gitConfig?: any;
  isConfigured: boolean;
  compactResult: { count: number; markdown?: string };
  taskSearchResults: Array<{ id: string }>;
  fullObservations: Array<{ type: string; title: string; content: string }>;
  inputPolicy: string;
  hasApiKey: boolean;
  inputAsRetry?: boolean;
  resolvedContextProviders?: string[];
  feedbackMemories?: Array<{ id: string; title: string; content: string }>;
}

export interface PromptBuildResult {
  promptText: string;
  /** What the workspace-memory block cost. */
  memory: MemoryBlockResult;
  /** Byte accounting for every section this function considered emitting. */
  sections: PromptSectionRecord[];
}

/**
 * Build the full prompt text from workspace context, task description, memory,
 * and communication policy — plus the experiment arm and block sizes the caller
 * needs in order to log what it just built.
 *
 * There is deliberately no text-only wrapper. One existed briefly and had no
 * production caller: every call site that builds a prompt is also the site that
 * must record its composition, so handing back the text alone invites a caller
 * that silently drops the denominator.
 */
export function buildPromptWithComposition(ctx: PromptContext): PromptBuildResult {
  const { task, worker, gitConfig, isConfigured, compactResult, taskSearchResults, fullObservations, inputPolicy, hasApiKey, inputAsRetry } = ctx;
  const promptParts: string[] = [];
  const sections: PromptSectionRecord[] = [];

  // Records byte accounting for every section this function considers,
  // whether or not it actually renders — see PromptSectionRecord. A section
  // that is gated off reports rendered: false rather than leaving nothing to
  // look at, which is the whole fix for "12 of 13 sections are invisible".
  const addSection = (name: string, content: string | null | undefined, truncated = false) => {
    if (content) {
      promptParts.push(content);
      sections.push({ name, bytes: byteLength(content), rendered: true, truncated });
    } else {
      sections.push({ name, bytes: 0, rendered: false, truncated: false });
    }
  };

  // Add admin-defined agent instructions (if configured)
  addSection(
    'workspace-instructions',
    isConfigured && gitConfig?.agentInstructions
      ? `## Workspace Instructions\n${gitConfig.agentInstructions}`
      : null,
  );

  // Add git workflow context (if configured and not 'none' strategy)
  // 'none' strategy means defer entirely to CLAUDE.md / project conventions
  if (isConfigured && gitConfig && gitConfig.branchingStrategy !== 'none') {
    const gitContext: string[] = ['## Git Workflow'];
    gitContext.push(`- Default branch: ${gitConfig.defaultBranch}`);

    if (gitConfig.branchPrefix) {
      gitContext.push(`- Branch naming: ${gitConfig.branchPrefix}<task-name>`);
    } else if (gitConfig.useBuildBranch) {
      gitContext.push(`- Branch naming: buildd/<task-id>-<task-name>`);
    }

    // THE base this task's PR takes, from the same function `create_pr` derives
    // it with (@buildd/core/mission-integration). This block used to read
    // `gitConfig.targetBranch` directly — it never looked at the mission — so a
    // task on a mission using an integration branch was told "PR to <trunk>"
    // while the server refused trunk for exactly that task. The worker had no
    // way to tell which side was wrong, and the only escape was a human.
    const prBaseResolution = resolveTaskPrBase({
      mission: task.mission,
      task,
      head: worker.branch,
      fallbacks: [gitConfig.targetBranch, gitConfig.defaultBranch],
    });
    const prTarget = prBaseResolution.base || gitConfig.targetBranch || gitConfig.defaultBranch;

    // Tell the worker their branch is already set up (worktree mode). Named
    // after the SAME base `prBaseResolution` derived above — this used to
    // unconditionally claim `origin/<defaultBranch>`, which is wrong for a
    // mission-integration task: `worktree-utils.ts`'s `resolveWorktreeBase`
    // actually cuts the worktree from `context.baseBranch` (the integration
    // branch, or a stacked predecessor), not the default branch. Claiming
    // "latest" from a ref the worktree was never cut from cost a real
    // collision: an agent that believed it had dev's latest Drizzle migration
    // index skipped checking dev before generating one, and reused an index
    // dev had since occupied (task 3075cfe5).
    if (worker.worktreePath) {
      const checkedOutFrom = prBaseResolution.base || gitConfig.defaultBranch;
      gitContext.push(`- Your branch \`${worker.branch}\` is already checked out with latest code from \`origin/${checkedOutFrom}\``);
      gitContext.push(`- You are working in an isolated worktree — commit and push directly, do NOT switch branches`);
    }

    if (gitConfig.requiresPR) {
      gitContext.push(`- Changes require PR to \`${prTarget}\``);
      if (prBaseResolution.source === 'mission_integration') {
        gitContext.push(
          `- \`${prTarget}\` is this mission's integration branch, NOT trunk — the mission reaches `
          + `trunk through a single PR from that branch. Do not retarget your PR at trunk; `
          + `\`create_pr\` derives this base for you, so omit \`base\` entirely.`,
        );
        gitContext.push(
          `- This branch can lag \`origin/${gitConfig.defaultBranch}\` on files with sequential indices `
          + `(e.g. numbered migrations) — before adding one, compare your latest index against `
          + `\`origin/${gitConfig.defaultBranch}\`'s to avoid a collision.`,
        );
      }
      if (gitConfig.autoCreatePR) {
        gitContext.push(`- Create PR when done`);
      }
      // If buildd MCP is available, prefer create_pr action over gh pr create to avoid duplicates
      if (hasApiKey) {
        gitContext.push(`- Use \`buildd\` action=create_pr to create PRs (do NOT use \`gh pr create\` — create_pr handles dedup and targets \`${prTarget}\` automatically)`);
        // Meet the reason before the wall: for a role whose shell/connector PR-write
        // access is actually denied (pr-mutation-enforcement.ts), say so here rather
        // than let the agent discover it as an unexplained tool failure mid-task.
        if (shouldDenyPrMutation(task.roleSlug, hasApiKey)) {
          gitContext.push(`- \`gh pr create/edit/merge/close/reopen/ready/review\` are blocked for this role — use \`create_pr\`/\`merge_pr\`/\`close_pr\`/\`request_pr_review\` instead. Read-only \`gh pr view/list/checks\` and \`gh api <GET>\` still work.`);
        }
      } else {
        gitContext.push(`- IMPORTANT: Always use \`gh pr create --base ${prTarget}\` to ensure the PR targets the correct branch`);
      }
    } else {
      gitContext.push(`- If creating a PR, always use \`--base ${prTarget}\` to target the correct branch`);
    }

    if (gitConfig.commitStyle === 'conventional') {
      gitContext.push(`- Use conventional commits (feat:, fix:, chore:, etc.)`);
    }

    addSection('git-workflow', gitContext.join('\n'));
  } else {
    sections.push({ name: 'git-workflow', bytes: 0, rendered: false, truncated: false });
  }

  // Add rich workspace memory context. The workspace-wide digest (identical
  // for every task in the workspace) is no longer rendered — see
  // memory-digest-policy.ts.
  const memory = buildMemoryBlock({
    compactResult,
    taskSearchResults,
    fullObservations,
  });
  addSection('workspace-memory', memory.block, memory.digestTruncated);

  // Add user preferences derived from feedback signals
  let feedbackTruncated = false;
  if (ctx.feedbackMemories && ctx.feedbackMemories.length > 0) {
    const feedbackParts: string[] = ['## User Preferences (from feedback)'];
    for (const mem of ctx.feedbackMemories) {
      const clipped = mem.content.length > 300;
      if (clipped) feedbackTruncated = true;
      feedbackParts.push(`- **${mem.title}**: ${clipped ? mem.content.slice(0, 300) + '...' : mem.content}`);
    }
    addSection('user-preferences', feedbackParts.join('\n'), feedbackTruncated);
  } else {
    sections.push({ name: 'user-preferences', bytes: 0, rendered: false, truncated: false });
  }

  // Add resolved context from providers (fetched at claim time). Not one
  // section per provider — the set is dynamic and unnamed at this layer — so
  // this reports the combined bytes of whatever fired.
  if (ctx.resolvedContextProviders?.length) {
    for (const block of ctx.resolvedContextProviders) {
      promptParts.push(block);
    }
    addSection('resolved-context-providers', ctx.resolvedContextProviders.join('\n\n'));
  } else {
    sections.push({ name: 'resolved-context-providers', bytes: 0, rendered: false, truncated: false });
  }

  // Add task description.
  //
  // Contamination guard: a description can get polluted by an ECHOED prompt
  // footer — the exact `---\nTask ID: ...\nWorker ID: ...\nWorkspace: ...`
  // shape this same function appends at the very end (below). That happens,
  // for instance, when a retry or a copy-paste carries a prior transcript's
  // tail into the next task's description. Only THAT literal signature is a
  // terminator: a bare markdown thematic break (`\n---\n`) is ordinary prose
  // — humans and agents both write horizontal rules — and must survive
  // intact. The old check (`indexOf('\n---')`) could not tell the two apart
  // and silently guillotined a meaningful slice of tasks, losing real spec
  // content with nothing recording that it happened.
  const CONTAMINATION_SIGNATURE = /\n---\s*\nTask ID:\s/;
  let taskDescription = task.description || task.title;
  let descriptionTruncated = false;
  const contamMatch = CONTAMINATION_SIGNATURE.exec(taskDescription);
  if (contamMatch) {
    descriptionTruncated = true;
    taskDescription = taskDescription.slice(0, contamMatch.index).trim();
  }
  addSection('task-description', `## Task\n${taskDescription}`, descriptionTruncated);

  // Rule K2-17: asked ONLY when the task has no recorded kind. `task.kind` is
  // already on the BuilddTask the runner holds, so the condition costs no query,
  // and a task that was filed with a kind never sees this line at all.
  addSection(
    'work-kind',
    !task.kind
      ? '## Work Kind\n'
        + 'This task has no recorded work-kind. On your first `update_progress`, set `kind` to the shape of the '
        + 'work you are actually doing — one of coordination, engineering, research, writing, design, analysis, '
        + 'observation.'
      : null,
  );

  // Handoff requirement: check if downstream tasks depend on this one
  const taskContext = task.context as Record<string, unknown> | undefined;
  const hasDependents = ((taskContext?.dependentCount as number | undefined) ?? 0) > 0;

  addSection(
    'handoff-requirement',
    hasDependents
      ? '## Handoff Requirement\n' +
        `**${taskContext?.dependentCount as number} task(s) depend on this one.** Before completing, you must include a \`handoff\` object in your structured output with at minimum a \`delivered\` field (one-line summary of what you delivered). Example: \`{ handoff: { delivered: "Implemented X feature that Y tasks will use" } }\`\n` +
        'Your handoff fields: `delivered` (required), `interfaces` (function/type names), `decisions` (array of {decision, why}), `gotchas` (pitfalls for consumers), `leftUndone` (explicitly named incomplete work).'
      : null,
  );

  // Add output requirement context so agents know what deliverables are expected
  const outputReq = task.outputRequirement || 'auto';
  // A planning task whose plan is a PROPOSAL SLOT rather than its deliverable
  // (context.planOptional) — the doc-fix dispatch is the first of these. Its
  // real output is the docs-only PR named by outputRequirement, and returning
  // no plan at all is the expected outcome, so the standard planning block's
  // "an empty plan stalls the mission" rule would be exactly backwards here.
  const planIsOptional = (task.context as { planOptional?: boolean } | undefined)?.planOptional === true;
  let outputRequirementContent: string;
  if (task.mode === 'planning' && !planIsOptional) {
    outputRequirementContent =
      '## Output Requirement\n' +
      'This is a **planning task**. Your final output is validated against a fixed JSON schema and returned as structured output — the system creates tasks directly from your `plan` array. Free-form text or a fenced ```json block is NOT read; only the structured output is.\n' +
      'Each `plan` item needs: ref (unique ID like "step-1"), title, description.\n' +
      'Optional per item: dependsOn (array of refs for ordering), baseBranch (ref of predecessor task to chain branches from), roleSlug (e.g. "builder", "researcher"), priority (integer), kind, complexity.\n' +
      'Always set `summary`, and set `missionComplete: true` when the mission goal is fully achieved.\n' +
      'Every planning cycle must either return a non-empty `plan` OR set `missionComplete: true` (or triageOutcome: "conflict") — an empty plan that does neither stalls the mission.\n' +
      'Do NOT call create_task — the system creates tasks from your plan automatically.';
  } else if (outputReq === 'pr_required') {
    outputRequirementContent = '## Output Requirement\nThis task **requires a PR**. Make your changes, commit, push, and create a PR via `buildd` action: create_pr before completing.';
  } else if (outputReq === 'artifact_required') {
    outputRequirementContent = '## Output Requirement\nThis task **requires you to create an artifact** as a deliverable. Use `buildd` action: create_artifact before completing the task.';
  } else if (outputReq === 'none') {
    outputRequirementContent = '## Output Requirement\nThis task has **no output requirement**. Complete with a summary — no commits, PRs, or artifacts needed unless the work calls for it.';
  } else {
    // 'auto' (the default). Announce the obligation up front — this used to
    // surface only as a 400 on the final complete_task call, after the work
    // was already spent. The gate that enforces this (apps/web/src/app/api/
    // workers/[id]/route.ts, outputReq === 'auto') fires on a fallback
    // summary (the session ending without an agent-authored complete_task
    // call) independently of commit count — so the obligation below is
    // stated the same way, not conditioned on "if you finish with commits".
    outputRequirementContent =
      '## Output Requirement\n' +
      'This task has no fixed output requirement, but you must always call `complete_task` yourself before the session ends — a session that just stops, even with zero commits, is treated as an unconfirmed outcome, not a completion. ' +
      'If you finish with commits or uncommitted changes in the worktree, `complete_task` must additionally be paired with ONE of: an open PR (`create_pr`) for the branch; an artifact recording the deliverable; or `discardEdits` stating why those edits are intentionally being thrown away. ' +
      'A coordination task whose deliverable is action taken against OTHER PRs (merging one via `merge_pr`, or dispatching a release) satisfies this automatically — it does not need a PR of its own.';
  }
  addSection('output-requirement', outputRequirementContent);

  addSection(
    'optional-plan',
    planIsOptional
      ? '## Optional Plan\n' +
        'Your structured output may ALSO carry a `plan` array. It is optional here: the deliverable above is what this task is for, and returning no plan is a valid, expected outcome that creates no follow-up and no noise.\n' +
        'Use it only when the task description asks you to propose follow-up work. When you do, each `plan` item needs: ref (unique ID like "step-1"), title, description.\n' +
        'Nothing in the plan is dispatched automatically — a human approves or rejects it. Do NOT call create_task to file the work yourself.'
      : null,
  );

  // Heartbeat protocol — static text, unconditional on roleSlug (mission-run's
  // dominant-role derivation can swap a heartbeat task's role away from
  // 'organizer', and a workspace may run an overridden organizer role config
  // that never carries this text) so a heartbeat gets it regardless of which
  // role, if any, got attached at claim time. See heartbeat-protocol.ts for why
  // this is not rendered into task.description any more.
  const isHeartbeatTask = (task.context as { heartbeat?: boolean } | undefined)?.heartbeat === true;
  addSection('heartbeat-protocol', isHeartbeatTask ? HEARTBEAT_PROTOCOL_BLOCK : null);

  // Inject aggregation context: embed child task results directly so the agent
  // doesn't need to fetch them via MCP (aggregator tasks run in bare temp dirs)
  const taskCtx = task.context as { aggregation?: boolean; childTasks?: Array<{ title: string; status: string; taskId: string; result: any }> } | undefined;
  let aggregationContent: string | null = null;
  if (taskCtx?.aggregation && taskCtx.childTasks && taskCtx.childTasks.length > 0) {
    const aggParts: string[] = ['## Aggregation Context', 'The following sub-task results are available for synthesis:'];
    for (const child of taskCtx.childTasks) {
      aggParts.push(`### ${child.title} (status: ${child.status})`);
      if (child.result) {
        const resultStr = typeof child.result === 'string' ? child.result : JSON.stringify(child.result, null, 2);
        aggParts.push(resultStr);
      } else {
        aggParts.push('*(no result)*');
      }
    }
    aggregationContent = aggParts.join('\n');
  }
  addSection('aggregation-context', aggregationContent);

  // Render retry context so workers know they're continuing previous work
  const retryIteration = (taskCtx as any)?.iteration as number | undefined;
  // failureContext is written as the structured { summary, errorType?, commitSha? }
  // object by every canonical writer (ci-retry.ts, conflict-retry.ts,
  // loop-dispatcher.ts, the direct failure-capture path in
  // workers/[id]/route.ts) — a bare string only exists for backward compat
  // with tasks written before that shape landed. Interpolating the object
  // directly stringifies it to "[object Object]".
  const rawFailureCtx = (taskCtx as any)?.failureContext as unknown;
  const failureCtx: string | undefined =
    typeof rawFailureCtx === 'string'
      ? rawFailureCtx
      : (rawFailureCtx as { summary?: string } | undefined | null)?.summary;
  const retryBaseBranch = (taskCtx as any)?.baseBranch as string | undefined;
  const maxIter = (taskCtx as any)?.maxIterations as number | undefined;

  let retryContent: string | null = null;
  if (retryIteration || failureCtx) {
    const retryParts: string[] = ['## Retry Context'];
    if (retryIteration) {
      retryParts.push(`This is attempt ${retryIteration}${maxIter ? ` of ${maxIter}` : ''}.`);
    }
    if (retryBaseBranch) {
      retryParts.push(`Previous work is on branch \`${retryBaseBranch}\`. Your worktree is based on that branch — continue from existing work, do NOT start fresh.`);
    }
    if (failureCtx) {
      retryParts.push(`Previous failure: ${failureCtx}`);
    }
    retryParts.push('Review the existing work and continue from where the previous attempt left off. Do not redo completed work.');
    retryContent = retryParts.join('\n');
  }
  addSection('retry-context', retryContent);

  // Communication instruction: configurable input policy
  // inputPolicy: 'autonomous' (default, no questions), 'important-only', 'allow'
  let communicationContent: string;
  if (inputPolicy === 'allow') {
    communicationContent = `## Communication\nWhen presenting options, recommendations, or asking the user how to proceed, use the AskUserQuestion tool instead of ending with a text question. This keeps context alive for follow-up work.`;
  } else if (inputPolicy === 'important-only') {
    communicationContent = `## Communication\nOnly use the AskUserQuestion tool for critical decisions that could cause irreversible damage or significant cost (e.g., deleting production data, large purchases). For everything else, make reasonable decisions autonomously and document your reasoning. Do NOT ask clarifying questions — pick the most sensible default.`;
  } else if (inputAsRetry !== false) {
    // inputAsRetry (default): allow AskUserQuestion for genuine blockers — session aborts and user responds async
    communicationContent = `## Communication\nIf you hit a genuine blocker you cannot resolve autonomously — no correct path forward, not just a hard task — use AskUserQuestion. The session will end, the task is parked waiting for your answer (this is NOT recorded as a failure and is never auto-retried into the same dead end), the owner is notified, and answering resumes your work from where you left off.\nThis is not for uncertainty, permission-seeking, or a design choice you are capable of making — decide, do the work, and explain your reasoning instead. If you want to flag a choice for the record without waiting on it, use \`buildd\` action=post_note with type=question and defaultChoice set to what you chose; that is non-blocking and work continues immediately.`;
  } else {
    // inputAsRetry explicitly disabled — hard block
    communicationContent = `## Communication\nDo NOT use the AskUserQuestion tool. Do NOT ask the user questions or wait for input. Make reasonable decisions autonomously and proceed with the task. If you are unsure about something, pick the most sensible default and document your reasoning.`;
  }
  addSection('communication', communicationContent);

  // Add task metadata
  addSection('task-metadata', `---\nTask ID: ${task.id}\nWorker ID: ${worker.id}\nWorkspace: ${worker.workspaceName}`);

  return { promptText: promptParts.join('\n\n'), memory, sections };
}

// ── Post-session helpers ───────────────────────────────────────────

/**
 * Extract unique file paths from tool calls (Read, Edit, Write).
 */
export function extractFilesFromToolCalls(toolCalls: Array<{ name: string; input?: any }>): string[] {
  const files = new Set<string>();
  for (const tc of toolCalls) {
    if ((tc.name === 'Read' || tc.name === 'Edit' || tc.name === 'Write') && tc.input?.file_path) {
      files.add(tc.input.file_path);
    }
  }
  return Array.from(files).slice(0, 20);
}

/**
 * Build a summary string from worker state (commits, files, milestones).
 */
export function buildSessionSummary(worker: LocalWorker): string {
  const parts: string[] = [];

  // Prefer last_assistant_message from Stop hook (direct from SDK, no parsing)
  if (worker.lastAssistantMessage) {
    const msg = worker.lastAssistantMessage;
    parts.push(`Outcome: ${msg.length > 400 ? msg.slice(0, 400) + '...' : msg}`);
  }

  // Commits (most useful for future workers)
  if (worker.commits.length > 0) {
    const commitMsgs = worker.commits.map(c => c.message).slice(-5);
    parts.push(`Commits: ${commitMsgs.join('; ')}`);
  }

  // Files modified
  const files = extractFilesFromToolCalls(worker.toolCalls);
  if (files.length > 0) {
    parts.push(`Files modified: ${files.slice(0, 10).join(', ')}`);
  }

  // Fallback: outcome from last output (only if no last_assistant_message)
  if (!worker.lastAssistantMessage) {
    const lastOutput = worker.output.slice(-3).join(' ').trim();
    if (lastOutput) {
      const truncated = lastOutput.length > 300 ? lastOutput.slice(0, 300) + '...' : lastOutput;
      parts.push(`Outcome: ${truncated}`);
    }
  }

  // Milestones (filtered: skip noise like "Reading..." entries)
  const milestones = worker.milestones
    .filter(m => m.label !== 'Task completed')
    .map(m => m.type === 'phase' ? `${m.label} (${m.toolCount} tools)` : m.label);
  if (milestones.length > 0) {
    parts.push(`Milestones: ${milestones.slice(-10).join(', ')}`);
  }

  const summary = parts.join('\n');
  return summary.length > 600 ? summary.slice(0, 600) + '...' : summary;
}

/**
 * Generate follow-up prompt suggestions based on what the worker accomplished.
 * Uses heuristics from commits, tool calls, and task context — no extra LLM call needed.
 */
export function generatePromptSuggestions(worker: LocalWorker): string[] {
  const suggestions: string[] = [];

  // If there are commits, suggest reviewing changes and running tests
  if (worker.commits.length > 0) {
    suggestions.push('Run tests to verify the changes');

    // If commits mention a specific feature/fix, suggest a follow-up
    const lastCommit = worker.commits[worker.commits.length - 1];
    if (lastCommit) {
      const msg = lastCommit.message.toLowerCase();
      if (msg.includes('fix') || msg.includes('bug')) {
        suggestions.push('Add a regression test for the fix');
      } else if (msg.includes('feat') || msg.includes('add')) {
        suggestions.push('Add documentation for the new feature');
      } else if (msg.includes('refactor')) {
        suggestions.push('Review the refactored code for edge cases');
      }
    }
  }

  // If files were edited, suggest reviewing them
  const editedFiles = extractFilesFromToolCalls(worker.toolCalls)
    .filter((_, i) => i < 5);
  if (editedFiles.length > 0) {
    const hasTests = editedFiles.some(f => f.includes('test') || f.includes('spec'));
    if (!hasTests) {
      suggestions.push('Write tests for the modified files');
    }
  }

  // Always offer a create-PR suggestion if there were commits
  if (worker.commits.length > 0) {
    suggestions.push('Create a pull request for these changes');
  }

  // Deduplicate and limit to 3
  return [...new Set(suggestions)].slice(0, 3);
}
