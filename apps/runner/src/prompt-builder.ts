import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { LocalWorker, BuilddTask } from './types';
import { sessionLog } from './session-logger';

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
    const currentModel = models.find((m: any) => m.value === modelId);

    if (!currentModel) {
      console.warn(`[Worker ${worker.id}] Model "${modelId}" not found in supportedModels() — capability validation skipped`);
      worker.modelCapabilities = { warnings: [`Model "${modelId}" not found in supported models list`] };
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
}

/**
 * Build the full prompt text from workspace context, task description,
 * memory, and communication policy.
 */
export function buildPrompt(ctx: PromptContext): string {
  const { task, worker, gitConfig, isConfigured, compactResult, taskSearchResults, fullObservations, inputPolicy, hasApiKey, inputAsRetry } = ctx;
  const promptParts: string[] = [];

  // Add admin-defined agent instructions (if configured)
  if (isConfigured && gitConfig?.agentInstructions) {
    promptParts.push(`## Workspace Instructions\n${gitConfig.agentInstructions}`);
  }

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

    // Tell the worker their branch is already set up (worktree mode)
    if (worker.worktreePath) {
      gitContext.push(`- Your branch \`${worker.branch}\` is already checked out with latest code from \`origin/${gitConfig.defaultBranch}\``);
      gitContext.push(`- You are working in an isolated worktree — commit and push directly, do NOT switch branches`);
    }

    const prTarget = gitConfig.targetBranch || gitConfig.defaultBranch;
    if (gitConfig.requiresPR) {
      gitContext.push(`- Changes require PR to \`${prTarget}\``);
      if (gitConfig.autoCreatePR) {
        gitContext.push(`- Create PR when done`);
      }
      // If buildd MCP is available, prefer create_pr action over gh pr create to avoid duplicates
      if (hasApiKey) {
        gitContext.push(`- Use \`buildd\` action=create_pr to create PRs (do NOT use \`gh pr create\` — create_pr handles dedup and targets \`${prTarget}\` automatically)`);
      } else {
        gitContext.push(`- IMPORTANT: Always use \`gh pr create --base ${prTarget}\` to ensure the PR targets the correct branch`);
      }
    } else {
      gitContext.push(`- If creating a PR, always use \`--base ${prTarget}\` to target the correct branch`);
    }

    if (gitConfig.commitStyle === 'conventional') {
      gitContext.push(`- Use conventional commits (feat:, fix:, chore:, etc.)`);
    }

    promptParts.push(gitContext.join('\n'));
  }

  // Add rich workspace memory context
  const MAX_MEMORY_BYTES = 4096;
  if (compactResult.count > 0 || taskSearchResults.length > 0) {
    const memoryContext: string[] = ['## Workspace Memory'];

    // Inject compact workspace digest (capped to prevent prompt bloat)
    if (compactResult.markdown) {
      let digest = compactResult.markdown;
      if (digest.length > MAX_MEMORY_BYTES) {
        digest = digest.slice(0, MAX_MEMORY_BYTES) + '\n\n*(truncated — use `buildd_search_memory` for more)*';
      }
      memoryContext.push(digest);
    }

    // Add task-specific matches as subsection
    if (fullObservations.length > 0) {
      memoryContext.push('### Relevant to This Task');
      for (const obs of fullObservations) {
        const truncContent = obs.content.length > 300
          ? obs.content.slice(0, 300) + '...'
          : obs.content;
        memoryContext.push(`- **[${obs.type}] ${obs.title}**: ${truncContent}`);
      }
    }

    memoryContext.push('\nUse `buildd_search_memory` for more context and `buildd_save_memory` to record learnings.');
    promptParts.push(memoryContext.join('\n'));
  }

  // Add task description
  // Clean up description: strip anything after "---" separator which might be polluted context from previous runs
  let taskDescription = task.description || task.title;
  const separatorIndex = taskDescription.indexOf('\n---');
  if (separatorIndex > 0) {
    taskDescription = taskDescription.substring(0, separatorIndex).trim();
  }
  promptParts.push(`## Task\n${taskDescription}`);

  // Add output requirement context so agents know what deliverables are expected
  const outputReq = task.outputRequirement || 'auto';
  if (task.mode === 'planning') {
    promptParts.push(
      '## Output Requirement\n' +
      'This is a **planning task**. Output a structured JSON plan.\n' +
      'Each item needs: ref (unique ID like "step-1"), title, description.\n' +
      'Optional: dependsOn (array of refs for ordering), baseBranch (ref of predecessor task to chain branches from), roleSlug (e.g. "builder", "researcher"), priority (integer).\n' +
      'Set missionComplete: true when the mission goal is fully achieved.\n' +
      'Do NOT call create_task — the system creates tasks from your plan automatically.'
    );
  } else if (outputReq === 'pr_required') {
    promptParts.push('## Output Requirement\nThis task **requires a PR**. Make your changes, commit, push, and create a PR via `buildd` action: create_pr before completing.');
  } else if (outputReq === 'artifact_required') {
    promptParts.push('## Output Requirement\nThis task **requires you to create an artifact** as a deliverable. Use `buildd` action: create_artifact before completing the task.');
  } else if (outputReq === 'none') {
    promptParts.push('## Output Requirement\nThis task has **no output requirement**. Complete with a summary — no commits, PRs, or artifacts needed unless the work calls for it.');
  }
  // 'auto' — no explicit section needed, default behavior is fine

  // Inject aggregation context: embed child task results directly so the agent
  // doesn't need to fetch them via MCP (aggregator tasks run in bare temp dirs)
  const taskCtx = task.context as { aggregation?: boolean; childTasks?: Array<{ title: string; status: string; taskId: string; result: any }> } | undefined;
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
    promptParts.push(aggParts.join('\n'));
  }

  // Render retry context so workers know they're continuing previous work
  const retryIteration = (taskCtx as any)?.iteration as number | undefined;
  const failureCtx = (taskCtx as any)?.failureContext as string | undefined;
  const retryBaseBranch = (taskCtx as any)?.baseBranch as string | undefined;
  const maxIter = (taskCtx as any)?.maxIterations as number | undefined;

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
    promptParts.push(retryParts.join('\n'));
  }

  // Communication instruction: configurable input policy
  // inputPolicy: 'autonomous' (default, no questions), 'important-only', 'allow'
  if (inputPolicy === 'allow') {
    promptParts.push(`## Communication\nWhen presenting options, recommendations, or asking the user how to proceed, use the AskUserQuestion tool instead of ending with a text question. This keeps context alive for follow-up work.`);
  } else if (inputPolicy === 'important-only') {
    promptParts.push(`## Communication\nOnly use the AskUserQuestion tool for critical decisions that could cause irreversible damage or significant cost (e.g., deleting production data, large purchases). For everything else, make reasonable decisions autonomously and document your reasoning. Do NOT ask clarifying questions — pick the most sensible default.`);
  } else {
    if (inputAsRetry !== false) {
      // inputAsRetry (default): allow AskUserQuestion for genuine blockers — session aborts and user responds async
      promptParts.push(`## Communication\nIf you hit a genuine blocker you cannot resolve autonomously, use AskUserQuestion. The session will end and the user will respond asynchronously. For everything else, make reasonable decisions autonomously and proceed.`);
    } else {
      // inputAsRetry explicitly disabled — hard block
      promptParts.push(`## Communication\nDo NOT use the AskUserQuestion tool. Do NOT ask the user questions or wait for input. Make reasonable decisions autonomously and proceed with the task. If you are unsure about something, pick the most sensible default and document your reasoning.`);
    }
  }

  // Add task metadata
  promptParts.push(`---\nTask ID: ${task.id}\nWorker ID: ${worker.id}\nWorkspace: ${worker.workspaceName}`);

  return promptParts.join('\n\n');
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
