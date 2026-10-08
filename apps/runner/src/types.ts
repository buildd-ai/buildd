import type { RoleBundle, RoleConfig, RoleInstructions } from './roles.js';
import type { PromptCompositionEvent } from './memory-digest-policy.js';
import type { BashCommandCounts } from './bash-classify.js';
import type { DerivedFileRule, RunnerFleetIdentity, SkillBundle } from '@buildd/shared';

// Worker status
export type WorkerStatus = 'idle' | 'working' | 'done' | 'error' | 'stale' | 'waiting';

// Permission suggestion from SDK (PermissionUpdate subset relevant to UI display)
export interface PermissionSuggestion {
  type: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode' | 'addDirectories' | 'removeDirectories';
  label: string;  // Human-readable label for UI display
  raw: unknown;   // Original PermissionUpdate object to pass back to SDK
}

// Waiting for user input (question/permission)
export interface WaitingFor {
  type: 'question' | 'permission';
  prompt: string;
  options?: Array<{
    label: string;
    description?: string;
    /** Question brief: what choosing this leads to (from the option's description). */
    consequence?: string;
    recommended?: boolean;
  }>;
  /** Question brief (packages/core/question-brief.ts): the task and the exact decision. */
  context?: string;
  recommended?: { label: string; reason?: string };
  where?: { taskTitle?: string; branch?: string; file?: string };
  /** Set only to `'hold'` — Jev held this question rather than asking outright (question-gate.ts). */
  disposition?: 'hold';
  holdReason?: string;
  /** ISO timestamp; see question-gate.ts `HOLD_RESURFACE_MS`. */
  resurfaceAt?: string;
  toolUseId?: string;  // The SDK tool_use block id — needed for parent_tool_use_id in responses
  // Permission-specific fields (when type === 'permission')
  toolName?: string;           // The tool requesting permission
  toolInput?: unknown;         // The tool input that triggered the request
  permissionSuggestions?: PermissionSuggestion[];  // SDK-provided suggestions for auto-fill
}

// Meaningful checkpoint events that map to actual worker activity
export const CheckpointEvent = {
  SESSION_STARTED: 'session_started',
  FIRST_READ: 'first_read',
  FIRST_EDIT: 'first_edit',
  FIRST_COMMIT: 'first_commit',
  FIRST_PUSH: 'first_push',
  TASK_COMPLETED: 'task_completed',
  TASK_ERROR: 'task_error',
} as const;

export type CheckpointEventType = typeof CheckpointEvent[keyof typeof CheckpointEvent];

// Human-readable labels for checkpoint events
export const CHECKPOINT_LABELS: Record<CheckpointEventType, string> = {
  session_started: 'Session started',
  first_read: 'First file read',
  first_edit: 'First file edit',
  first_commit: 'First commit',
  first_push: 'First push',
  task_completed: 'Task completed',
  task_error: 'Task failed',
};

// Milestone for progress tracking (typed union — no legacy format)
export type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number }
  | { type: 'checkpoint'; event: CheckpointEventType; label: string; ts: number }
  | {
      type: 'action';
      label: string;
      ts: number;
      // Structured tool-call fields (see tool-milestones.ts). The web task page
      // reads these exact names for the tool tape and "Touched files" list.
      tool?: 'Edit' | 'Write' | 'MultiEdit' | 'Read' | 'Bash';
      /** File path from the tool input, relative to the session cwd when under it. */
      path?: string;
      /** Lines added (multiset line diff for Edit/MultiEdit; content lines for Write). */
      add?: number;
      /** Lines removed. */
      rem?: number;
      /** Bash only: command, truncated to ~80 chars and secret-redacted. */
      cmd?: string;
      /** Read only: consecutive same-path Reads folded into this milestone. */
      count?: number;
    };

// Tool call tracking
export interface ToolCall {
  name: string;
  timestamp: number;
  input?: any;
  /**
   * The originating tool_use block id (Claude SDK `block.id`, or the Codex
   * `item.id` surfaced by the codex-events adapter). Used to correlate a later
   * `tool_result`'s `tool_use_id` back to the source tool for error-trace
   * scanning (workers.ts handleMessage `user`/tool_result branch).
   */
  toolUseId?: string;
}

// File checkpoint (from SDK files_persisted events)
export interface Checkpoint {
  uuid: string;  // The message UUID — used for rewindFiles()
  timestamp: number;
  files: Array<{ filename: string; file_id: string }>;
}

// Chat message for unified timeline
export type ChatMessage =
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'tool_use'; name: string; input?: any; timestamp: number }
  | { type: 'user'; content: string; timestamp: number };

// Agent team member
export interface TeamMember {
  name: string;
  role?: string;
  status: 'active' | 'idle' | 'done';
  spawnedAt: number;
}

// Inter-agent message
export interface TeamMessage {
  from: string;
  to: string | 'broadcast';
  content: string;
  summary?: string;
  timestamp: number;
}

// Subagent task lifecycle tracking (from SDK task_started / task_notification messages)
export interface SubagentTask {
  taskId: string;
  toolUseId: string;
  description: string;
  taskType: string;
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
  completedAt?: number;
  message?: string;
  isBackground?: boolean;  // SDK v0.2.49+: true when agent definition has `background: true`
  // SDK v0.3.202+: agent identity for reconstructing depth-2+ agent trees.
  // `agentId` is this subagent's SDK id; `parentAgentId` is its spawning agent
  // (absent for direct children of the main worker). Read defensively — older
  // CLIs don't stamp these, in which case the tree renders as a flat list.
  agentId?: string;
  parentAgentId?: string;
  // SDK v0.2.51+: cumulative progress metrics for background subagents
  progress?: {
    toolCount: number;
    durationMs: number;
    agentName: string | null;
    cumulativeUsage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  };
}

// Team state for a worker
export interface TeamState {
  teamName: string;
  members: TeamMember[];
  messages: TeamMessage[];
  createdAt: number;
}

// Local worker state
export interface LocalWorker {
  id: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  /** The task's parentTaskId at claim — lets a later retry recognise this
   *  worker as part of its lineage (see classifyResumeBranchHolder). */
  parentTaskId?: string | null;
  taskMode?: string;  // 'execution' or 'planning'
  taskBackend?: 'claude' | 'codex';  // Which agent backend ran this task
  workspaceId: string;
  workspaceName: string;
  workspaceDataClass: 'standard' | 'sensitive';
  branch: string;
  status: WorkerStatus;
  hasNewActivity: boolean;  // Blue dot
  startedAt: number;  // When worker was created (for cycle time tracking)
  lastActivity: number;
  // True while a tool/subagent call is executing (set on PreToolUse, cleared on
  // PostToolUse / PostToolUseFailure). Long silent tools (e.g. a bash that waits
  // on CI) emit no SDK stream messages, so checkStale exempts in-flight tools
  // from the soft-probe/stale-abort path and relies on the 30-min hard timeout.
  toolInFlight?: boolean;
  // Transient (never persisted): set by loadAllWorkers when it rewrites a
  // 'working' worker to 'error' because SDK sessions cannot survive a runner
  // restart. restoreWorkersFromDisk reads it to notify the server, which would
  // otherwise leave the row 'running' until the reaper expires it. A marker,
  // rather than re-deriving intent from the error string, keeps the two sides
  // from silently drifting the way the status check did.
  killedByRestart?: boolean;
  completedAt?: number;  // When task completed/errored (for sorting)
  milestones: Milestone[];
  currentAction: string;
  commits: Array<{ sha: string; message: string }>;
  // Set true once a create_pr tool result confirms a real PR was opened (not
  // merely that the tool was called). Gates the pr_required output requirement.
  prCreated?: boolean;
  // PR URL captured from a successful create_pr result, when parseable.
  prUrl?: string;
  /**
   * How many end-of-session pushes (session-end-classification.ts) this
   * worker has received across any resumed turns. Capped at
   * SESSION_END_MAX_PUSHES; once reached the session is parked instead of
   * pushed or failed, with the reason recorded and visible — see
   * `sessionEndPushes` and `parkSessionEnd`. Replaces the old one-shot
   * `noDeliverableNudged` boolean with a counted bound.
   */
  sessionEndPushCount?: number;
  /** One entry per push given under `sessionEndPushCount`, for reconstructing the sequence afterward. */
  sessionEndPushes?: Array<{
    label: 'waiting_on_background_job' | 'asking_permission_it_has' | 'believes_done_no_deliverable' | 'genuinely_blocked';
    at: number;
    text: string;
  }>;
  /**
   * The most recent tool call the runner itself denied (a PreToolUse hook
   * deny), used by session-end-classification.ts to tell "the agent backed
   * off after a runner refusal it could route around" from a genuine stop.
   * Overwritten on every denial; only meaningful when it matches the LAST
   * recorded tool call (see `lastToolWasDeniedByRunner`).
   */
  lastToolDenial?: { toolUseId?: string; kind: string; runnerAttributed: boolean; ts: number };
  output: string[];  // Recent output lines
  toolCalls: ToolCall[];  // Track tool calls for post-execution summary
  messages: ChatMessage[];  // Unified chronological timeline
  sessionId?: string;
  // Codex thread id (Phase 1C / R5). Captured from the Codex `thread.started`
  // event (surfaced by the adapter as system:init.session_id) and persisted so a
  // follow-up resumes the prior thread via the backend's resumeThreadId. Kept
  // SEPARATE from sessionId so the Claude-vs-Codex resume branch stays explicit.
  codexThreadId?: string;
  error?: string;
  waitingFor?: WaitingFor;  // Set when agent asks a question
  teamState?: TeamState;  // Set when agent spawns a team
  subagentTasks: SubagentTask[];  // Subagent task lifecycle (task_started → task_notification)
  // Total number of task_started events observed — uncapped, unlike subagentTasks (capped at 100).
  // When subagentTasksObservedCount > subagentTasks.length, persisted span metrics are floors.
  subagentTasksObservedCount: number;
  worktreePath?: string;  // Git worktree path (isolated cwd for this worker)
  /** cwd of the current agent session (worktree or shared clone). Makes milestone paths repo-relative. */
  sessionCwd?: string;
  /**
   * The ref this worker's worktree was cut from, as resolved by setupWorktree —
   * `origin/<default>` on a trunk task, the mission integration branch on a
   * mission task that opted in. setupWorktree runs in startWorker and later
   * steps read the base in startSession, so the resolved answer travels on the
   * worker rather than being re-derived and risking disagreement.
   */
  worktreeBaseRef?: string;
  /**
   * The ref this task's PR is compared against (resolvePrBaseRef). Differs from
   * `worktreeBaseRef` on a resume, where the worktree is cut from the prior
   * attempt's branch. Checkpoint sweeps measure against this one; persisted so
   * a restored worker does not sweep with an empty committed half.
   */
  prBaseRef?: string;
  /**
   * What the runner's pre-agent base merge did on a conflict retry (merged, or
   * left in progress with the real conflicts). Appended to the system prompt.
   */
  derivedMergeNote?: string;
  /**
   * Set when the worker's environment was provisioned but degraded — today only
   * by a dependency install that failed for a non-structural reason (drift,
   * timeout, unknown) on an auto-detected repo, where failing closed on a guess
   * would be worse than proceeding.
   *
   * Exists because the failure used to be invisible: install returned `void`, so
   * a worker could report `done` with an empty node_modules and nothing
   * anywhere recorded it. A `done` carrying this is a *visible* degradation,
   * which a review or merge policy can act on.
   */
  envDegraded?: { phase: 'install'; failure: string; dir: string };
  checkpoints: Checkpoint[];  // File checkpoints for rollback support
  checkpointEvents: Set<CheckpointEventType>;  // Tracks which meaningful checkpoints have fired
  pendingMcpCalls?: Array<{ server: string; tool: string; ts: number; ok: boolean; durationMs?: number }>;  // Buffered MCP tool calls awaiting sync
  pendingErrorTraces?: Array<{ pattern: string; excerpt: string; source?: string }>;  // Buffered agent tool-output error matches awaiting sync
  pendingActionEvents?: Array<{ action: string; ts: number }>;  // Buffered buildd MCP action calls awaiting sync (see action-events.ts)
  // Buffered prompt-composition records awaiting sync — one per prompt build,
  // in both memory-digest arms (see memory-digest-policy.ts).
  pendingPromptCompositionEvents?: PromptCompositionEvent[];
  // Counts calls to buildPromptCompositionRecord for this worker. A worker can
  // build more than one prompt (e.g. the bwrap-retry restart in startSession
  // rebuilds from scratch), so this is the ordering key for those rows —
  // never reset mid-worker, or two builds would collide on buildIndex.
  promptBuildIndex?: number;
  // Paths written while path-claim endpoint was unreachable (timeout/error). Flushed
  // on the next successful claim call. Runner-local only: the working-set
  // tracker (below) is what tells the server about every edit, hook or not.
  pendingPaths?: string[];
  /**
   * Authoritative working set (working-set.ts): the task-owned file set from
   * git with its generation, what the server has acknowledged holding, and the
   * holders blocking the rest. Persisted so a restart replays from it.
   */
  workingSet?: import('./working-set').WorkingSetState;
  /**
   * Ship checkpoints whose coverage could not be proven, not yet reported to
   * the server (the server was unreachable at the time, by definition).
   * Drained by the next successful sync.
   */
  pendingShipReports?: import('@buildd/shared').ShipCheckpointReport[];
  /** Coverage-unknown milestones already posted, so a retried ship does not repeat them. Transient. */
  shipCoverageMilestones?: string[];
  /**
   * Workspace `gitConfig.pathClaimEnforcement`, resolved at session start.
   * Absent = advisory (the default). See path-claim-enforcement.ts.
   */
  pathClaimMode?: 'advisory' | 'enforce';
  /**
   * A confirmed checkpoint collision: a path this task already changed is held
   * by another live task. Once set (enforce mode) further edits, pushes and
   * completion are refused and the task is deferred. Persisted.
   */
  pathCollision?: import('./path-claim-enforcement').PathCollision;
  /** Set while the collision hand-off (checkpoint + deferral) is in flight, so it runs once. */
  pathCollisionDeferring?: boolean;
  /** Path-claim calls that hit the deadline or failed: enforcement was degraded for them. */
  pathClaimDegraded?: number;
  /** How many of `pathClaimDegraded` the server has been told about (the next sync sends the delta). */
  pathClaimDegradedReported?: number;
  /** `pathClaimDegraded` split by cause, so the server can tell a timeout from a network/5xx error. */
  pathClaimDegradedByCause?: { timeout: number; error: number };
  /** The `pathClaimDegradedByCause` totals the server has been told about. */
  pathClaimDegradedByCauseReported?: { timeout: number; error: number };
  /** Last time the sweep refreshed the base ref with a fetch (ms epoch). */
  pathSweepBaseFetchedAt?: number;
  lastAssistantMessage?: string;  // Final agent response text (from SDK Stop hook)
  /**
   * Running per-turn token tally, accumulated from backend turn_complete usage.
   * Last-resort token source for the worker report: assistant messages always
   * carry usage, whereas the SDK result's per-model map is empty on seat auth.
   */
  tokenTally?: { inputTokens: number; outputTokens: number };
  /** How this run's usage is charged (cost-basis.ts); set when the agent env is built. */
  costBasis?: 'real' | 'virtual' | 'unknown';
  // Set when sandbox_mount_gap abort fires; signals server to exempt from retry cap.
  // Currently never set — the abort was disabled after it fired on file content
  // (test titles, fixture strings) rather than real denials. Detection now only
  // annotates via addMilestone (see workers.ts). Left in place for the exitCause
  // taxonomy to re-enable once the tightened scanner has a production track record.
  sandboxMountGap?: boolean;
  bwrapRetryPending?: boolean;  // Set when bwrap namespace denial fires mid-run; startSession will restart without sandbox
  // Phase tracking (reasoning text → tool call grouping)
  phaseText: string | null;
  phaseStart: number | null;
  phaseToolCount: number;
  phaseTools: string[];  // Notable tool labels in current phase, cap 5
  /**
   * The model this session was started with — the per-task model the claim route
   * resolved (task.context.model) or the runner-global default. Reported back so
   * task_outcomes.actual_model reflects what really ran.
   */
  sessionModel?: string;
  /** Model id the SDK reported on the init message, when it provides one. */
  reportedModel?: string;
  // SDK result metadata (populated on completion)
  resultMeta?: ResultMeta | null;
  /**
   * The claim put this task in a running `question_gate` experiment: every
   * AskUserQuestion goes through POST /api/workers/[id]/question-check before
   * it is parked (apps/runner/src/question-gate.ts).
   */
  questionGate?: { maxPushbacks: number };
  /** Questions the gate sent back to the agent in this worker. */
  questionPushbacks?: number;
  /** Last file the agent edited or wrote, for the question brief's `where`. */
  lastEditedFile?: string;
  // Full tool-call histogram keyed by exact SDK tool name (see tool-metrics.ts).
  // Flushed into resultMeta.toolCounts at completion.
  toolCounts?: Record<string, number>;
  /**
   * Bash sub-classification (see bash-classify.ts). The histogram above can
   * only ever show a single bar for `Bash` — by far the most-called tool — so
   * every shell-run `grep` / `rg` / VCS content search was invisible to any
   * rollup, including to the Read/Grep/Glob counters above. Bucket counts plus
   * coarse search-pattern shapes only; no command or pattern text is retained.
   */
  bashCommandCounts?: BashCommandCounts;
  /** File tool calls per repo area (file-area.ts): tool -> area -> calls. Area only, never a path. */
  fileToolAreas?: Record<string, Record<string, number>>;
  // MCP credential secrets (label → value) delivered inline at claim time.
  // Injected as env vars into cleanEnv so ${VAR} refs in .mcp.json HTTP headers resolve.
  mcpSecrets?: Record<string, string>;
  // Server-managed API key (delivered inline during claim, injected into subprocess env)
  serverApiKey?: string;
  // Server-managed OAuth token (delivered inline during claim, injected as CLAUDE_CODE_OAUTH_TOKEN)
  serverOauthToken?: string;
  // The team's agent model endpoint (docs/design/agent-model-endpoint.md), when it
  // won the claim's ranking. The only model credential this worker's agent gets.
  modelEndpoint?: import('@buildd/shared').ClaimModelEndpoint;
  // The claim withheld a winning endpoint because this runner has a per-machine provider.
  modelEndpointIgnored?: boolean;
  // Cloud claim: the endpoint behind egress lacks ToolSearch pass-through (ENABLE_TOOL_SEARCH=false).
  toolSearchDisabled?: boolean;
  // Which GitHub credentials the agent gets (@buildd/core/agent-github-credentials).
  // 'scoped': only the task-scoped token (agent-github-credentials.ts). A mode, not a secret.
  githubCredentials?: { mode: 'scoped' | 'runner' };
  // Managed Claude access token (from claude_credential purpose). When set, the runner
  // creates a per-worker CLAUDE_CONFIG_DIR and writes credentials.json with ONLY this
  // access_token — no refresh_token — preventing in-session token rotation.
  claudeAccessToken?: string;
  claudeTokenExpiresAt?: Date | null;
  /** OAuth scopes recorded for the managed claude_credential; written into .credentials.json. */
  claudeTokenScopes?: string[];
  /** claude.ai artifact access resolved by the claim (absent = off). */
  claudeAiArtifacts?: import('@buildd/shared').ClaudeAiArtifactAccess;
  // secretId of the claude_credential managed by the broker for this worker.
  // Used by startSession to fetch a fresh token via the broker socket instead
  // of relying on the potentially-stale claudeAccessToken from the claim response.
  claudeCredentialId?: string;
  // Codex OAuth credential (delivered inline during claim, materialized as CODEX_HOME/auth.json)
  codexCredential?: {
    accessToken: string;
    refreshToken: string;
    accountId: string;
    expiresAt: Date | null;
  };
  // Role config from claim route (for role env resolution) — packaged roles only
  roleConfig?: RoleConfig;
  // The packaged role bundle (CLAUDE.md, skills, .mcp.json, env mapping),
  // fetched from roleConfig.configUrl at claim. Held in memory only: its files
  // are written per session and removed at session end (session-prompt-files.ts).
  roleBundle?: RoleBundle;
  // Role persona from claim route. Present whenever the task resolved a role
  // row, packaged or not; the only source of the agent's persona on both the
  // Claude (systemPrompt.append) and Codex (AGENTS.md) paths.
  roleInstructions?: RoleInstructions;
  // Role/workspace env secrets (ENV_NAME → value) resolved server-side against
  // the `secrets` table (purpose='role_env_secret') and delivered inline at
  // claim time. Merged into role env by resolveWorkerRoleEnv — independent of
  // roleConfig, so an MCP-registered role with no packaged R2 bundle still
  // gets its declared env vars.
  roleEnvSecrets?: Record<string, string>;
  // ENV_NAME keys the role/workspace mapping declared with no matching secrets
  // row — merged into resolveWorkerRoleEnv's `missing` so a declared-but-unmet
  // requirement still records the existing "Role env degraded" milestone.
  roleEnvMissing?: string[];
  // Skill bundles resolved by the claim route for task.context.skillSlugs.
  // Written by syncSkillToLocal into <session cwd>/.claude/skills for each
  // session so the SDK's native Skill tool can find them, and removed when the
  // session ends — without this, a task instructed to invoke a skill has the
  // instruction but not the skill.
  skillBundles?: SkillBundle[];
  // True once this process holds the task's role/skill payload (set at claim,
  // or by rehydratePromptBundles). Never persisted: a worker restored from disk
  // lacks it, which is how a resume knows to re-fetch (session-prompt-bundles.ts).
  promptBundlesLoaded?: boolean;
  // Degraded connectors (advisory mode) — connectors that are unavailable but
  // task was allowed to proceed. Injected into system prompt in startSession.
  degradedConnectors?: Array<{ id: string; name: string; failureMode: string }>;
  // Assertion connector metadata for mid-task re-auth (spec §F.2)
  assertionConnectors?: Array<{ name: string; mintApiUrl: string; tokenEndpoint: string }>;
  // Per-connector assertion access token cache (in-memory, per-session only)
  assertionTokenCache?: Map<string, { accessToken: string; expiresAt: number }>;
  // Connectors for which assertion re-exchange has failed (set by hook-factory §F.2).
  // When set, handleMessage treats a 401 tool_result as exhausted → fires circuit breaker.
  assertionReAuthFailed?: Set<string>;
  // Prompt suggestions for follow-up actions (populated on completion)
  promptSuggestions?: string[];
  // Last assistant message text (captured via Stop hook's last_assistant_message)
  lastAssistantMessage?: string;
  // Set after the first loop-guard nudge is injected so we don't double-send
  loopNudgeSent?: boolean;
  // Current prompt UUID (SDK v0.3.196 BaseHookInput.prompt_id) — correlates hook events
  // with SDK-emitted OTel spans at prompt grain (attribute: prompt.id).
  currentPromptId?: string;
  // Command lifecycle counts (SDK v0.3.206 command_lifecycle frames) — tracks the
  // terminal state of each queued message so cancelled/discarded steers surface.
  // Lazily initialized on the first frame; absent on CLIs that never emit it.
  commandLifecycle?: import('./command-lifecycle').CommandLifecycleTracker;
  // Model capabilities discovered via SDK v0.2.49+ supportedModels()
  modelCapabilities?: {
    model?: string;
    capabilities?: {
      supportsEffort: boolean;
      supportedEffortLevels: string[];
      supportsAdaptiveThinking: boolean;
    };
    warnings: string[];
  };
}

// Per-model token usage from SDK result
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

// SDK result metadata - captured from SDKResultSuccess/SDKResultError
export interface ResultMeta {
  stopReason: string | null;
  terminalReason?: string | null;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  modelUsage: Record<string, ModelUsage>;
  /**
   * Top-level usage totals from the SDK result. Populated even on seat-based
   * (OAuth) auth, where `modelUsage` stays empty — see usage-aggregate.ts.
   * `inputTokens` is the all-in input figure (fresh + cache read + cache write);
   * the optional cache fields carry the breakdown so the server can price a seat
   * session without treating every cached token as fresh input.
   */
  totalUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  } | null;
  /** SDK-reported session cost. Always 0 on seat/OAuth auth. */
  totalCostUsd?: number | null;
  /** The model the session actually ran on (see resolveActualModel). */
  actualModel?: string | null;
  permissionDenials?: Array<{ tool: string; reason: string }>;
  /**
   * Every tool_use in the session counted by exact tool name (`Bash`,
   * `mcp__buildd__buildd`, …). Absent on workers that predate the histogram or
   * that called no tools; consumers must treat absence as "unknown", not zero.
   */
  toolCounts?: Record<string, number>;
  /**
   * What the session's Bash calls were FOR: bucket counts plus coarse
   * search-pattern shapes (see bash-classify.ts). Absent when the worker made
   * no Bash call or predates the classifier — absence is "unknown", not zero.
   */
  bashCommandCounts?: BashCommandCounts;
  /** File tool calls per repo area (file-area.ts): tool -> area -> calls. Area only, never a path. */
  fileToolAreas?: Record<string, Record<string, number>>;
  /**
   * Outcome of the one-shot "closing turn" a session that ends without
   * calling complete_task gets before the runner falls back to
   * summarySource:'fallback' — see startSession's isClosingTurn handling.
   * 'authored' = the closing turn called complete_task itself. 'declined' =
   * it ran but still didn't; `declined:<reason>` = it ended on its own error
   * (`max_turns`, or `error` for any other error result / thrown error) and
   * the fallback ran instead. `skipped:<reason>` = none was attempted (not
   * resumable, or the original session ended by error/abort/rate-limit/
   * credential-failure/cancellation). Absent when the agent's own
   * complete_task call already won the race before the decision was made.
   * Mirrors packages/core/db/schema.ts's ResultMeta — kept in sync manually,
   * same as every other field in this local copy.
   */
  closingTurnOutcome?: 'authored' | 'declined' | `declined:${string}` | `skipped:${string}`;
  /**
   * Every end-of-session push this worker received (session-end-classification.ts)
   * before its eventual terminal outcome — label, when, and the exact text sent.
   * Lets "pushes per session and how often a push led to delivery" be queried
   * directly from already-recorded completions instead of new telemetry infra.
   * Mirrors packages/core/db/schema.ts's ResultMeta — kept in sync manually.
   */
  sessionEndPushes?: Array<{
    label: 'waiting_on_background_job' | 'asking_permission_it_has' | 'believes_done_no_deliverable' | 'genuinely_blocked';
    at: number;
    text: string;
  }>;
}

// Loop exit condition (spec §1)
export type LoopExitCondition =
  | { type: 'command'; command?: string }
  | { type: 'pr_checks_green' }
  | {
      type: 'structured_predicate';
      predicate?: {
        path: string;
        operator: 'eq' | 'neq' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte';
        value?: string | number | boolean | null;
      };
    };

export interface LoopConfig {
  exitCondition: LoopExitCondition;
  maxLoops?: number;
  backoffMinutes?: number;
}

// Task from buildd
export interface BuilddTask {
  id: string;
  /** Set on retry/attempt tasks (the task they retry). Full claim rows carry it. */
  parentTaskId?: string | null;
  title: string;
  description: string;
  workspaceId: string;
  workspace?: {
    name: string;
    repo?: string;
    gitConfig?: WorkspaceGitConfig;
    configStatus?: 'unconfigured' | 'admin_confirmed';
    teamId?: string;
    dataClass?: 'standard' | 'sensitive';
  };
  status: string;
  priority: number;
  mode?: string;
  dependsOn?: string[];
  /** The mission this task belongs to, when it has one. */
  missionId?: string | null;
  /**
   * Option A′ integration fields for this task's mission, sent by the claim
   * route. They exist so `resolveTaskPrBase` can answer "what base does this
   * task's PR take" on the runner with the SAME inputs the server uses — see
   * prompt-builder.ts's Git Workflow block.
   */
  mission?: {
    workingBranch?: string | null;
    integrationBranchEnabled?: boolean | null;
  } | null;
  // Role slug this task is routed to (e.g. "builder", "researcher") — drives
  // role-scoped runner behaviour such as pr-mutation-enforcement.ts.
  roleSlug?: string;
  context?: Record<string, unknown>;  // May contain attachments
  attachments?: Array<{ id: string; filename: string; url: string }>;
  // Task taxonomy
  kind?: 'coordination' | 'engineering' | 'research' | 'writing' | 'design' | 'analysis' | 'observation';
  /**
   * Files/globs the task declared it expects to touch (`tasks.path_manifest`).
   *
   * The claim response has always carried this — its task query has no column
   * projection and passes the row wholesale — it simply was not declared here,
   * so nothing on the runner could see it. It is the strongest key available
   * for task-scoped memory retrieval; see task-memory-retrieval.ts.
   *
   * May contain the repo-wide sentinel `'**'`, which means "no scope declared"
   * and must not be treated as a path.
   */
  pathManifest?: string[] | null;
  // Agent backend to use for execution
  backend?: 'claude' | 'codex';
  // Output requirement — what deliverables are enforced on completion
  outputRequirement?: 'pr_required' | 'artifact_required' | 'none' | 'auto';
  // JSON Schema for structured output — passed to SDK outputFormat
  outputSchema?: Record<string, unknown> | null;
  // Assignment tracking
  claimedBy?: string | null;
  claimedAt?: string | null;
  expiresAt?: string | null;
  // Loop-until-verified config (spec §1). null = no loop; runner skips all loop branches.
  loopConfig?: LoopConfig | null;
  // Current loop iteration index (0 before first run, incremented by server on each evaluation).
  loopIteration?: number;
  // Deliverable snapshot
  result?: {
    summary?: string;
    branch?: string;
    commits?: number;
    sha?: string;
    files?: number;
    added?: number;
    removed?: number;
    prUrl?: string;
    prNumber?: number;
  } | null;
}

// Git workflow configuration (matches server schema)
export interface WorkspaceGitConfig {
  /** Files regenerated instead of merged (packages/shared DerivedFileRule; see merge-drivers.ts). */
  derivedFiles?: DerivedFileRule[];
  /** Register mergiraf as a structural merge driver in this runner's clones. */
  mergiraf?: boolean;
  // Branching
  defaultBranch: string;
  branchingStrategy: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
  branchPrefix?: string;
  useBuildBranch?: boolean;

  // Commit conventions
  commitStyle: 'conventional' | 'freeform' | 'custom';
  commitPrefix?: string;

  // PR/Merge behavior
  requiresPR: boolean;
  targetBranch?: string;
  autoCreatePR: boolean;
  subjectPolicy?: {
    mode?: 'observe' | 'propose' | 'enforce';
    dedupe?: 'suggest' | 'attach-system' | 'attach-all';
    proposalGraceHours?: number;
    conflictDeadDays?: number;
    autoCloseBuilddSupersededPrs?: boolean;
    priorWorkInjection?: boolean;
  };

  // Agent instructions
  agentInstructions?: string;
  useClaudeMd: boolean;

  // Permission mode
  bypassPermissions?: boolean;

  // Claim-time memory as an index; see @buildd/core/memory-claim-index
  memoryIndexInjection?: boolean;
  memoryIndexTokenBudget?: number;

  // Maximum budget in USD per worker session
  maxBudgetUsd?: number;

  // Fallback model (SDK v0.2.45+)
  fallbackModel?: string;

  // SDK debug logging
  debug?: boolean;
  debugFile?: string;

  // Worktree isolation for subagents (SDK v0.2.49+)
  // When enabled, skill-as-subagent definitions include `isolation: 'worktree'`
  useWorktreeIsolation?: boolean;

  // Sandbox configuration for worker isolation (SDK v0.2.44+)
  sandbox?: {
    enabled?: boolean;
    autoAllowBashIfSandboxed?: boolean;
    network?: {
      allowedDomains?: string[];
      allowLocalBinding?: boolean;
    };
    excludedCommands?: string[];
    // Credential-read blocking for sandboxed commands (SDK v0.3.187)
    // Prevents sandboxed bash commands from reading sensitive credential files or env vars.
    credentials?: {
      files?: Array<{ path: string; mode: 'deny' }>;
      environment?: Array<{ name: string; mode: 'deny' | 'mask'; injectHosts?: string[] }>;
    };
  };

  // Auto-merge PRs via GitHub's auto-merge feature
  autoMergePR?: boolean;

  // Policy checks before push / create_pr (workflow-state-kernel.md §6.10, S31).
  // Only `commands` is the runner's; the server reads the rest.
  preflight?: { commands?: string[] } | null;
}

// SSE event types
export type SSEEvent =
  | { type: 'workers'; workers: LocalWorker[] }
  | { type: 'worker_update'; worker: LocalWorker }
  | { type: 'tasks'; tasks: BuilddTask[] }
  | { type: 'output'; workerId: string; line: string }
  | { type: 'milestone'; workerId: string; milestone: Milestone };

// Extended task result with execution context
export interface TaskResult {
  summary?: string;
  branch?: string;
  commits?: number;
  sha?: string;
  files?: number;
  added?: number;
  removed?: number;
  prUrl?: string;
  prNumber?: number;
  phases?: Array<{ label: string; toolCount: number }>;
  lastQuestion?: string;
}

// Command from server
export interface WorkerCommand {
  // deliver_pending: a message was queued for this worker; sync to collect it (no text).
  action: 'pause' | 'resume' | 'abort' | 'message' | 'deliver_pending' | 'rollback' | 'recover';
  text?: string;
  timestamp: number;
  // rollback fields
  checkpointUuid?: string;
  // recovery fields
  recoveryMode?: 'diagnose' | 'complete' | 'restart';
  // abort fields — cancel_queued (SDK 0.3.219+): clear the message queue so
  // queued messages do not execute after the interrupt. Default: false.
  cancelQueued?: boolean;
}

// Provider configuration for LLM routing
export type LLMProvider = 'anthropic' | 'openrouter';

export interface ProviderConfig {
  provider: LLMProvider;
  // For OpenRouter: the API key (sk-or-...)
  // For Anthropic: uses ANTHROPIC_API_KEY or Claude Code OAuth
  apiKey?: string;
  // Custom base URL (e.g., https://openrouter.ai/api)
  baseUrl?: string;
}

// Config
export interface LocalUIConfig {
  projectRoots: string[];  // All roots to search
  builddServer: string;
  apiKey: string;
  maxConcurrent: number;
  model: string;
  // LLM provider configuration (default: anthropic)
  llmProvider?: ProviderConfig;
  // Serverless mode (no server connection)
  serverless?: boolean;
  // Direct access URL for this runner instance
  localUiUrl?: string;
  // Pusher config (optional, for command relay)
  pusherKey?: string;
  pusherCluster?: string;
  // Channel prefix for environment isolation (e.g. "preview-")
  pusherChannelPrefix?: string;
  // Accept remote task assignments from dashboard (default: true)
  acceptRemoteTasks?: boolean;
  // Bypass permission prompts for bash commands (dangerous commands still blocked)
  bypassPermissions?: boolean;
  // Maximum budget in USD per worker session (local fallback; workspace gitConfig.maxBudgetUsd takes priority)
  maxBudgetUsd?: number;
  // Maximum turns per worker session (default: no limit)
  maxTurns?: number;
  // Controls AskUserQuestion behavior. Default (undefined/true): abort+retry —
  // the worker is marked failed with failReason 'needs_input' and the user
  // responds asynchronously via the dashboard, creating a follow-up task.
  // Set to false to preserve the legacy blocking waiting_input behavior.
  inputAsRetry?: boolean;
  // Tier 3 structural isolation root. When set, each workspace gets its own
  // git clone at <root>/<workspaceId>/ and credential dirs are scoped there
  // too — eliminating cross-workspace filesystem access.
  // Set via BUILDD_WORKSPACE_ISOLATION_ROOT env var.
  workspaceIsolationRoot?: string;
  // Single-task mode (`buildd --once`, see run-once.ts). The WorkerManager runs
  // only the task it is handed via claimAndStart: no claim polling, no
  // knowledge-ingest jobs, no restore of other workers from disk, no worktree
  // sweeps or server cleanup. Heartbeats, sync and Pusher commands still run.
  singleTask?: boolean;
  // What this runner is in the fleet, sent on every heartbeat as
  // environment.fleet. Set only by `--once` (run-once.ts buildOnceConfig):
  // ephemeral, one slot, executor and, in a cloud container, the group.
  fleetIdentity?: RunnerFleetIdentity;
}
