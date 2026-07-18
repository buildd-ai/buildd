/**
 * Shared MCP tool handlers for Buildd.
 *
 * Used by:
 * - packages/core/buildd-mcp-server.ts (in-process SDK server)
 * - apps/web/src/app/api/mcp/route.ts (HTTP server)
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

const PRIORITY_NAMES: Record<string, number> = {
  lowest: 1, low: 3, medium: 5, high: 7, highest: 9, critical: 10, urgent: 10,
};

/** Convert named priority levels (e.g. "medium") to integer 0-10. */
function normalizePriority(val: unknown, fallback = 5): number {
  if (val === undefined || val === null) return fallback;
  if (typeof val === 'number') return Math.max(0, Math.min(10, Math.round(val)));
  const s = String(val).toLowerCase().trim();
  const parsed = Number(s);
  if (!isNaN(parsed)) return Math.max(0, Math.min(10, Math.round(parsed)));
  return PRIORITY_NAMES[s] ?? fallback;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ApiFn = (endpoint: string, options?: RequestInit) => Promise<any>;

export interface ActionContext {
  workerId?: string;
  workspaceId?: string;
  // Team that owns this context. Memories are a team-level resource (the memory
  // service is team-scoped), so the `memory` corpus is namespaced by teamId —
  // every other corpus is workspace-scoped. See knowledgeNamespace().
  teamId?: string;
  // Discriminator for the multi-workspace guard: OAuth tokens can have access
  // to multiple workspaces; API keys are workspace-scoped at creation. Only
  // OAuth tokens need the "explicit workspaceId required" guard for ambiguous
  // mutating actions like create_task and claim_task.
  authType?: 'api' | 'oauth';
  getWorkspaceId: () => Promise<string | null>;
  getLevel: () => Promise<'trigger' | 'worker' | 'admin'>;
  appBaseUrl?: string;
  // Optional KnowledgeStore wiring for best-effort auto-indexing of agent work
  // product (completed tasks, PRs, artifacts, approved plans). Mirrored writes
  // never block or fail the underlying action.
  knowledgeStore?: KnowledgeStore;
  embedder?: Embedder | null;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ── Action Lists ─────────────────────────────────────────────────────────────

// Trigger level: can create tasks and artifacts, but cannot claim or execute.
// Read-only schedule discovery is allowed at this level so any caller can
// trace "what fired this notification?" without needing an admin token.
export const triggerActions = [
  'list_tasks', 'get_task', 'create_task', 'create_artifact',
  'list_artifacts', 'get_artifact', 'emit_event',
  'list_artifact_templates',
  'list_schedules', 'trace_schedule',
  'get_task', 'get_task_messages',
] as const;

export const workerActions = [
  'list_tasks', 'get_task', 'claim_task', 'update_progress', 'complete_task',
  'create_pr', 'update_task', 'create_task', 'create_artifact',
  'upload_artifact', 'list_artifacts', 'get_artifact', 'update_artifact',
  'emit_event', 'query_events', 'get_error_traces',
  'list_artifact_templates',
  'suggest_schedule_update',
  'post_note',
  'list_schedules', 'trace_schedule',
  'get_task', 'get_task_messages',
] as const;

// list_schedules and trace_schedule live in worker/trigger sets above;
// admins inherit them via allActions = [...workerActions, ...adminActions].
export const adminActions = [
  'create_schedule', 'update_schedule', 'delete_schedule',
  'pause_schedules',
  'register_skill', 'list_skills', 'get_skill', 'update_skill', 'delete_skill',
  'manage_secrets',
  'approve_plan', 'reject_plan',
  'manage_missions',
  'manage_workspaces',
  'manage_watched_projects',
  'trigger_release',
  'release_status',
  'send_agent_message',
  'spec_compare',
] as const;

export const allActions = [...workerActions, ...adminActions] as const;

export const memoryActions = ['context', 'search', 'save', 'get', 'update', 'delete', 'query_knowledge', 'consolidate_knowledge'] as const;

export type BuilddAction = (typeof allActions)[number];
export type MemoryAction = (typeof memoryActions)[number];

// ── Description Builders ─────────────────────────────────────────────────────

export function buildToolDescription(actions: readonly string[]): string {
  return `Task coordination tool. Available actions: ${actions.join(', ')}. Use action parameter to select operation, params for action-specific arguments.`;
}

export function buildParamsDescription(actions: readonly string[]): string {
  const descriptions: Record<string, string> = {
    list_tasks: '{ offset? }',
    get_task: '{ taskId (required), include? (array of "workers"|"artifacts", default both) } — read-only status check. Returns task fields plus the latest worker (id, status, branch, prUrl, prNumber, summary from task.result, error, completedAt) and artifact IDs + shareUrls. Use this to follow a task to completion after create_task.',
    claim_task: '{ maxTasks?, workspaceId? } — auto-assigns highest-priority pending task',
    update_progress: '{ workerId?, progress (required), message?, plan?, inputTokens?, outputTokens?, lastCommitSha?, commitCount?, filesChanged?, linesAdded?, linesRemoved? } — workerId auto-resolved from context if omitted',
    complete_task: '{ workerId?, summary?, error?, structuredOutput?, nextSuggestion?, entities? (EntityRef[]), relations? (RelationRef[]), supersedes? (string[]) } — if error present, marks task as failed. entities/relations are optional Layer 2 metadata for the knowledge graph; response includes entity binding counts. supersedes lists knowledge source_ids this outcome REPLACES — accepted forms: "task:<taskId>" (earlier task outcome), "pr:<number>", "plan:<taskId>", "artifact:<artifactId>"; matched chunks are marked superseded and drop out of default retrieval (response includes "Superseded: n"). workerId auto-resolved from context if omitted',
    create_pr: '{ workerId?, title (required), head (required), body?, base?, draft?, prUrl? } — workerId auto-resolved from context if omitted. Pass prUrl to register an externally-created PR (e.g. via gh CLI) when the workspace has no GitHub App installation.',
    update_task: '{ taskId (required), title?, description?, priority?, project?, status? (pending|completed|failed|cancelled — completed/failed require no active worker; cancelled can be set on any task including assigned ones, use it to kill duplicate or unwanted tasks) }',
    create_task: '{ title (required), description (required), workspaceId?, priority?, category? (bug|feature|refactor|chore|docs|test|infra|design — auto-detected if omitted), outputRequirement? (pr_required|artifact_required|none|auto — default auto), outputSchema?, project? (monorepo project name for scoping), missionId? (auto-inherited from caller), parentTaskId? (link retry to original task), dependsOn? (array of task IDs that must complete AND have their PRs merged before this task is claimable — REQUIRED for acceptance/gate/validation tasks; without it the task is claimed immediately even if upstream PRs are still open, causing repeated failures), pathManifest? (array of file paths/globs this task will create or modify — e.g. ["apps/web/src/lib/foo.ts","packages/core/db/schema.ts"]; the API auto-adds dependsOn edges when manifests of sibling tasks overlap, preventing two tasks from editing the same file in parallel), roleSlug? (route to specific role), baseBranch? (start worktree from this branch instead of default), verificationCommand? (command to run after completion), iteration? (retry attempt number), maxIterations? (max retry attempts), failureContext? (error output from previous attempt), skillSlugs?, model? (haiku|sonnet|opus or full ID), effort? (low|medium|high — reasoning effort), callbackUrl? (HTTPS URL to POST results on completion), callbackToken? (Bearer token for callback auth), release? ("true"|"false"|"inherit" — override workspace release default; "true" forces release on completion, "false" suppresses it, "inherit" uses workspace setting), backend? (claude|codex — which agent engine runs the task; omit to inherit the role default, then claude) }',
    create_artifact: '{ workerId?, missionId?, type (required: content|report|data|link|summary|email_draft|social_post|analysis|recommendation|alert|calendar_event|file), title (required), content?, url?, metadata?, key? } — workerId auto-resolved from context if omitted. Pass missionId instead to create a mission-level artifact without a worker context.',
    upload_artifact: '{ workerId?, filename (required), mimeType (required), sizeBytes (required), title?, type? (default: file), metadata? } — Returns presigned upload URL. After calling, upload file with: curl -X PUT -H "Content-Type: {mimeType}" --data-binary @{filePath} "{uploadUrl}". Also returns downloadUrl for embedding in markdown.',
    list_artifacts: '{ workspaceId?, missionId?, key?, type?, limit? }',
    get_artifact: '{ artifactId (required) } — fetch full artifact content by ID',
    update_artifact: '{ artifactId (required), title?, content?, metadata? }',
    create_schedule: '{ name (required), cronExpression (required), title (required), description?, timezone?, priority?, mode?, skillSlugs?, trigger?, workspaceId? } [admin]',
    update_schedule: '{ scheduleId (required), cronExpression?, timezone?, enabled?, name?, taskTemplate?, skillSlugs?, workspaceId? } [admin]',
    delete_schedule: '{ scheduleId (required), workspaceId? } — permanently remove a schedule [admin]',
    list_schedules: '{ workspaceId?, minutesAgo? (filter to schedules whose lastRunAt is within this window — use to identify "what just fired?"), nameContains? (case-insensitive substring filter on schedule name) } — read-only, available at all token levels. Output includes lastRunAt, lastError, and an output-channel hint (e.g. "sends pushover via dispatch") inferred from the task template.',
    trace_schedule: '{ taskId? OR minutesAgo? OR taskTitleContains?, workspaceId? } — reverse-lookup: given a stray task or a recent notification, find the schedule that spawned it. taskId is the strongest signal (uses the schedule_id FK); minutesAgo lists schedules that fired within the window; taskTitleContains matches on the task template title.',
    pause_schedules: '{ workspaceId?, scheduleIds? (string[]), namePattern? (case-insensitive substring), enabled? (default false — pass true to resume) } — bulk-flip the enabled flag on schedules. Provide scheduleIds for an exact list, namePattern to match by name, or omit both to apply to all schedules in the workspace. The 2am kill-switch when a schedule is misbehaving. [admin]',
    register_skill: '{ name (required), content (required), description?, source?, workspaceId?, slug?, model? (inherit|opus|sonnet|haiku|claude-sonnet-5|claude-fable-5 or full model ID), allowedTools? (string[]), canDelegateTo? (string[]), background? (boolean), maxTurns? (number), color? (hex string), mcpServers? (Record<string, McpServerConfig> or string[]), requiredEnvVars? (Record<string, string>), connectorRefs? (string[] of connector IDs this role mounts — role-level opt-in to team connectors), isRole? (boolean), defaultBackend? (claude|codex|null — default agent engine for tasks routed to this role; task.backend overrides) } — create/upsert skill by slug [admin]',
    list_skills: '{ workspaceId?, enabled? (boolean), isRole? (boolean) } — list skills/roles in workspace [admin]',
    get_skill: '{ slug (required), workspaceId? } — fetch full skill body and config by slug. Returns the same shape register_skill accepts, so the result can be edited and passed back to update_skill [admin]',
    update_skill: '{ slug (required), workspaceId?, name?, description?, content?, model?, allowedTools?, canDelegateTo?, background?, maxTurns?, color?, mcpServers? (Record<string, McpServerConfig>), requiredEnvVars? (Record<string, string>), connectorRefs? (string[] of connector IDs this role mounts), isRole?, repoUrl?, enabled?, defaultBackend? (claude|codex|null) } — update skill by slug [admin]',
    delete_skill: '{ slug (required), workspaceId? } — delete skill by slug [admin]',
    manage_secrets: '{ action: "list" | "set" | "delete", label? (required for set — env var name), value? (required for set — the secret value), purpose? (default: mcp_credential), secretId? (required for delete) } — manage encrypted MCP credential secrets [admin]',
    approve_plan: '{ taskId (required) } — approve planning task, create child execution tasks [admin]',
    reject_plan: '{ taskId (required), feedback (required) } — reject plan with feedback, create revised planning task [admin]',
    manage_missions: '{ action: "list" | "create" | "get" | "update" | "delete" | "link_task" | "unlink_task", missionId?, title?, description?, workspaceId?, cronExpression?, priority?, status?, taskId?, skillSlugs?, model?, isHeartbeat?: boolean (default true — heartbeat auto-enabled on create; set false to disable), heartbeatChecklist?: string, activeHoursStart?: number (0-23), activeHoursEnd?: number (0-23), activeHoursTimezone?: string, maxConcurrentTasks?: number (null = no cap, >= 1 = max active tasks from this mission), dependsOnMission?: string (mission ID — this mission is BLOCKED until the upstream mission satisfies gateCondition; set to null to remove), gateCondition?: "merged" | "completed" (default "merged" — "merged" requires upstream PRs actually merged to target branch via webhook; "completed" requires upstream.status==="completed"), orchestrationMode?: "auto" | "manual" (default "auto" — "manual" keeps heartbeat config but suppresses ALL orchestrator initiative: no heartbeat evaluation, no task spawning, no retrigger. Tasks already in the mission still execute. Use "auto" to arm, "manual" to disarm. One-shot "Run now" always works in either mode. Precedence: manual=disarmed entirely; auto+pre-filed tasks=coordinate-only (organizer detected pre-filed task chain and will coordinate rather than decompose); auto+no pre-filed tasks=full decomposition.) } — manage team missions [admin]',
    manage_workspaces: '{ action: "list" | "create" | "update" | "create_repo" | "init", workspaceId? (required for update/create_repo/init), name?, repoUrl?, defaultBranch?, accessMode?, org?, private? (default true), description?, autoMergePR? (boolean — enable auto-merge of worker PRs), autoMergeMaxLines? (number), autoMergeDenyPaths? (string[]), gitConfig? (object — partial gitConfig fields, shallow-merged server-side), releaseConfig?: { enabled: boolean, strategy?: "workflow_dispatch"|"branch_merge"|"script" (absent ⇒ branch_merge), workflowFile? (workflow_dispatch — e.g. "release.yml"), ref? (workflow_dispatch/script — e.g. "dev"), inputs? (workflow_dispatch — string-valued workflow inputs), prodBranch? (branch_merge — e.g. "main"), deployTarget?: { type: "vercel", projectId?: string, teamId?: string }, postDeployHooks?: Array<{ type: "http"|"buildd_mcp", description: string, url?: string, action?: string, params?: object, headers?: object }>, verificationUrl?: string, command? (script — e.g. "bun run release") } } — manage workspaces and bootstrap new projects. The releaseConfig.strategy decides how releases run: "workflow_dispatch" dispatches the repo\'s own release workflow (most general), "branch_merge" merges into prodBranch on task completion + verifies deploy, "script" runs a release command (not yet implemented). New project flow: 1) manage_workspaces action=create (name + optional repoUrl) to create workspace under your team, 2) Agent claims task in that workspace, 3) If no repo yet: manage_workspaces action=create_repo to create GitHub repo, or action=update to link existing repo, 4) Agent scaffolds project, commits, pushes, 5) Future tasks automatically resolve to the repo directory. [admin]',
    manage_watched_projects: '{ action: "list" | "create" | "update" | "delete" | "run", workspaceId? (required for list/create), projectId? (required for update/delete/run), repo?, enabled?, vercelProjectId?, inFlightWindowMin?, prodGraceMin?, roleSlug?, pushoverApp? ("tasks"|"alerts"), releasePrFilter? ({ base?, label?, titlePrefix? }), notes? } — manage project health watcher rows. The watcher fires a buildd task + Pushover alert when CI breaks on release PRs or Vercel prod is unhealthy. Vercel checks require vercelProjectId. "run" forces an immediate check on one row (handy for testing). [admin]',
    trigger_release: '{ workspaceId? OR repo? (owner/name — one is required), ref?, workflowFile?, inputs? (string-valued workflow inputs), force? (folded into inputs.force) } — trigger a release. The workspace\'s releaseConfig.strategy decides what happens; buildd no longer assumes dev→main. For "workflow_dispatch" workspaces this dispatches the repo\'s release workflow and READS THE RUN BACK (returns runId/runStatus/runUrl when resolvable, else runsUrl). NOTE: dispatching a workflow typically OPENS the release PR — it does not itself deploy; prod ships only when that PR passes CI and merges, and force bypasses the empty-commit check, NOT CI. "branch_merge" workspaces release automatically on task completion (not via this trigger). For an unconfigured workspace, pass workflowFile + ref explicitly. Call release_status first to fire informed. Uses the buildd GitHub App installation token. [admin]',
    release_status: '{ workspaceId? OR repo? (owner/name — one is required), ref?, prodBranch? } — read-only release preflight: what would ship (commits on ref ahead of prodBranch), whether the source ref\'s CI is passing/failing/pending, and whether a release PR is already open. Use before trigger_release to decide if releasing is safe right now. [admin]',
    emit_event: '{ workerId?, type (required), label (required), metadata? } — workerId auto-resolved from context if omitted',
    query_events: '{ workerId?, type? } — workerId auto-resolved from context if omitted',
    get_error_traces: '{ workerId?, taskId?, since? (ISO date), limit? (default 50, max 500) } — returns pattern-matched errors caught from agent tool output (cd: No such file, git fatal, OOM, etc.). Defaults to the caller worker\'s task. Use this when debugging why a task failed.',
    list_artifact_templates: '{ } — list available artifact templates with their JSON schemas for structured output',
    suggest_schedule_update: '{ scheduleId?, cronExpression?, enabled?, reason (required) } — propose a schedule change for human approval. scheduleId auto-resolved from task context if omitted. At least one of cronExpression or enabled required.',
    post_note: '{ type (required: decision|question|warning|suggestion|update), title (required), body?, defaultChoice? (for questions — what you chose while waiting for user reply), workerId?, missionId? } — post a lightweight note to the mission feed. Non-blocking — returns immediately. For questions, include defaultChoice so work continues without waiting for user reply. User replies are delivered on your next update_progress call. missionId auto-resolved from task context if omitted.',
    detect_projects: '{ rootDir? } — detect monorepo projects from package.json workspaces field',
    get_task_messages: '{ taskId (required) } — returns the instruction history (human→agent messages + agent responses) for the task\'s active or most recent worker. Available to trigger/worker/admin tokens.',
    send_agent_message: '{ taskId (required), message (required), priority? ("urgent" — deliver instantly via Pusher, otherwise queued for next check-in) } — deliver a mid-flight steering message to the running agent for the given task. Requires admin-level token. [admin]',
    spec_compare: '{ feature (required — feature/term to check, e.g. "objectives", "codex backend"), topK? (default 5, max 20) } — spec-drift tool. Retrieves CODE vs SPEC evidence from the unified workspace store ({workspaceId}:code and {workspaceId}:spec) for one feature and returns both sides for YOU to judge (implemented / documented-not-built / shipped-not-documented / contradicted). Scores surface candidates; they do not decide — read the snippets. No verdict is computed server-side. [admin]',
  };

  const lines = actions
    .filter(a => descriptions[a])
    .map(a => `- ${a}: ${descriptions[a]}`);
  return `Action-specific parameters. By action:\n${lines.join('\n')}\n\nNote: workspaceId accepts a UUID, a repo name (e.g. "buildd"), or "owner/repo" (e.g. "buildd-ai/buildd"). Usually the repo folder name is enough — the org prefix is optional.`;
}

export function buildMemoryDescription(actions: readonly string[]): string {
  const descriptions: Record<string, string> = {
    context: '{ project? } — get markdown-formatted memory context for agent injection',
    search: '{ query?, type?, files? (array), project?, limit?, offset? }',
    save: '{ type (required: gotcha|pattern|decision|discovery|architecture), title (required), content (required), files? (array), tags? (array), project?, source?, supersedes? (string[] of memory IDs this entry replaces — memory ids ARE the chunk source_ids in the team memory namespace; superseded entries drop out of default knowledge retrieval; response includes the superseded count) }',
    get: '{ id (required) }',
    update: '{ id (required), title?, content?, type?, files? (array), tags?, project?, supersedes? (string[] of memory IDs this updated entry replaces; superseded entries drop out of default knowledge retrieval) }',
    delete: '{ id (required) }',
    query_knowledge: '{ query (required), corpus? (memory|task|pr|plan|artifact|code|docs|spec, default memory), mode? (hybrid|vector|lexical, default hybrid), topK? (default 10) } — semantic+lexical hybrid search across the team\'s knowledge: prior memories, completed task outcomes, PRs, approved plans, and artifacts. Use corpus=memory BEFORE starting work to find prior lessons (gotchas, patterns, decisions) — builders should query for the task title and any error message before diagnosing. Use corpus=code to search this workspace\'s codebase (must be ingested first), corpus=spec to search spec/docs chunks. Also use corpus=memory BEFORE saving a new memory to detect near-duplicates (skip or update rather than adding another entry for the same gotcha). Returns ranked results with sourceUrl. NOTE: corpus=memory uses {teamId}:memory; all other corpora use {workspaceId}:{corpus}.',
    consolidate_knowledge: '{ op (required: find_duplicates|find_decayed|archive), corpora? (find ops — find_duplicates defaults to [memory,task], find_decayed to [task,artifact]), threshold? (find_duplicates cosine floor, default 0.92), limit?, halfLifeMultiple? (find_decayed age gate as multiple of corpus half-life, default 6), corpus? + sourceIds? (required for archive), reason? (archive audit marker) } — knowledge-consolidation support for the weekly consolidation task. find_duplicates surfaces near-duplicate chunk PAIRS (same namespace, embedding cosine > threshold) for YOU to judge; find_decayed surfaces old zero-hit task/artifact chunks; archive flips the listed chunks to is_current=false (audit-recoverable — nothing is deleted; superseded chunks stay queryable via history). Merge memory duplicates via save/update with supersedes (memory service is the source of truth); use archive for task-corpus losers and decayed noise.',
  };

  const lines = actions
    .filter(a => descriptions[a])
    .map(a => `- ${a}: ${descriptions[a]}`);
  return `Action-specific parameters:\n${lines.join('\n')}`;
}

// ── Buildd Action Handler ────────────────────────────────────────────────────

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });
const errorResult = (t: string): ToolResult => ({
  content: [{ type: 'text' as const, text: t }],
  isError: true,
});

/**
 * Heuristic hint for what a scheduled task actually *does* (where its output lands).
 * Surfaced in list_schedules + trace_schedule output so a caller can identify the
 * schedule behind a stray notification without reading the task template.
 *
 * Looks at task template skillSlugs and description/title for known notification
 * patterns. Returns null when nothing recognisable matches.
 */
function describeOutputChannel(taskTemplate: unknown): string | null {
  if (!taskTemplate || typeof taskTemplate !== 'object') return null;
  const tpl = taskTemplate as Record<string, unknown>;
  const ctx = (tpl.context as Record<string, unknown> | undefined) ?? {};
  const slugs = Array.isArray(ctx.skillSlugs) ? (ctx.skillSlugs as string[]) : [];
  const haystack = [
    String(tpl.title ?? ''),
    String(tpl.description ?? ''),
    ...slugs,
  ].join(' ').toLowerCase();

  const hints: string[] = [];
  if (/pushover|send_pushover|send_notification|mcp__dispatch|mcp__moa-ops|moa_ops__send_pushover/.test(haystack)) {
    hints.push('pushover');
  }
  if (/dispatch|cue\.buildd\.dev/.test(haystack)) hints.push('dispatch');
  if (/slack/.test(haystack)) hints.push('slack');
  if (/email|gmail|mailgun/.test(haystack)) hints.push('email');
  if (/digest|morning|daily summary|good morning/.test(haystack)) hints.push('daily digest');
  for (const slug of slugs) {
    if (/digest|notif|morning|finance/i.test(slug)) hints.push(`skill:${slug}`);
  }

  if (hints.length === 0) return null;
  // Dedupe while preserving order.
  return Array.from(new Set(hints)).join(', ');
}

// UUID pattern for workspace IDs
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve worker ID from params, falling back to context worker ID.
 * Throws if neither is available.
 */
function resolveWorkerId(param: unknown, ctx: ActionContext): string {
  const workerId = (param as string) || ctx.workerId;
  if (!workerId) throw new Error('workerId is required — pass it explicitly or ensure the MCP server has worker context');
  return workerId;
}

/**
 * Resolve a skill's UUID from its slug within a workspace.
 */
async function resolveSkillId(api: ApiFn, wsId: string, slug: string): Promise<string> {
  const data = await api(`/api/workspaces/${wsId}/skills`);
  const match = (data.skills || []).find((s: any) => s.slug === slug);
  if (!match) throw new Error(`Skill with slug "${slug}" not found in workspace`);
  return match.id;
}

/**
 * Build a skill update body from params, picking only defined fields.
 */
function buildSkillBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (params.name) body.name = params.name;
  if (params.description !== undefined) body.description = params.description;
  if (params.content) body.content = params.content;
  if (params.source) body.source = params.source;
  if (params.model) body.model = params.model;
  if (Array.isArray(params.allowedTools)) body.allowedTools = params.allowedTools;
  if (Array.isArray(params.canDelegateTo)) body.canDelegateTo = params.canDelegateTo;
  if (typeof params.background === 'boolean') body.background = params.background;
  if (typeof params.maxTurns === 'number') body.maxTurns = params.maxTurns;
  if (params.color) body.color = params.color;
  if (params.mcpServers && typeof params.mcpServers === 'object') body.mcpServers = params.mcpServers;
  if (params.requiredEnvVars && typeof params.requiredEnvVars === 'object') body.requiredEnvVars = params.requiredEnvVars;
  if (Array.isArray(params.connectorRefs)) body.connectorRefs = params.connectorRefs;
  if (typeof params.isRole === 'boolean') body.isRole = params.isRole;
  if (typeof params.enabled === 'boolean') body.enabled = params.enabled;
  if (params.repoUrl !== undefined) body.repoUrl = params.repoUrl;
  if (params.defaultBackend === 'claude' || params.defaultBackend === 'codex' || params.defaultBackend === null) {
    body.defaultBackend = params.defaultBackend;
  }
  return body;
}

/**
 * Actions that read/write workspace-scoped state and silently fail open when
 * the workspace is ambiguous — the high-blast-radius cases observed on
 * 2026-05-25 (claim_task picked the wrong workspace, agent flailed for 3hr).
 *
 * Guarded: claim_task (root cause), create_task (high blast radius), list_tasks
 * (silently aggregates across workspaces, makes "which task did I see?" lying).
 *
 * NOT guarded (yet): update_task/update_progress/complete_task/create_pr —
 * these take a taskId/workerId which fully determines the workspace.
 * Follow-up: resource-derived workspace + sub-action guarding for manage_*.
 */
const AMBIGUOUS_WORKSPACE_ACTIONS = new Set<string>([
  'list_tasks',
  'claim_task',
  'create_task',
]);

/**
 * For OAuth tokens with access to multiple workspaces, refuse ambiguous
 * mutating/aggregating actions unless workspaceId is explicit (either via
 * URL pin at OAuth time or via params). API-key tokens are workspace-scoped
 * at creation and skip this guard.
 */
async function requireExplicitWorkspace(
  api: ApiFn,
  action: string,
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ToolResult | null> {
  if (!AMBIGUOUS_WORKSPACE_ACTIONS.has(action)) return null;
  if (ctx.workspaceId) return null;          // URL-pinned at OAuth time
  if (params.workspaceId) return null;        // explicit per-call
  if (ctx.authType !== 'oauth') return null;  // API keys are workspace-scoped

  let workspaces: Array<{ id: string; name: string; repo?: string | null }> = [];
  try {
    const data = await api('/api/workspaces');
    workspaces = data.workspaces || [];
  } catch {
    // If we can't enumerate, fall through — downstream resolver still errors
    // cleanly on null wsId rather than misrouting.
    return null;
  }

  if (workspaces.length <= 1) return null;

  const choices = workspaces
    .map((ws) => `- "${ws.name}"${ws.repo ? ` (${ws.repo})` : ''} → ${ws.id}`)
    .join('\n');
  return {
    content: [{
      type: 'text' as const,
      text: `This OAuth token has access to ${workspaces.length} workspaces. Action "${action}" requires an explicit workspaceId to avoid misrouting (the 2026-05-25 incident). Pass workspaceId in params — workspace name is accepted:\n${choices}`,
    }],
    isError: true,
  };
}

/**
 * Resolve workspace ID from a UUID, repo name (e.g. "buildd-ai/buildd"), or workspace name.
 * Falls back to context workspace ID if no param given.
 */
async function resolveWorkspaceId(
  api: ApiFn,
  param: unknown,
  ctx: ActionContext,
): Promise<string | null> {
  const raw = (param as string) || ctx.workspaceId;
  if (raw && UUID_RE.test(raw)) return raw;

  // Try context fallback first
  if (!raw) return ctx.getWorkspaceId();

  // Not a UUID — resolve by repo name or workspace name
  // Try by-repo first (handles "owner/repo" format)
  if (raw.includes('/')) {
    const data = await api(`/api/workspaces/by-repo?repo=${encodeURIComponent(raw)}`);
    if (data.workspace?.id) return data.workspace.id;
  }

  // Fall back to name match across accessible workspaces
  const wsData = await api('/api/workspaces');
  const workspaces = wsData.workspaces || [];
  const match = workspaces.find((ws: any) =>
    ws.name.toLowerCase() === raw.toLowerCase() ||
    ws.repo?.toLowerCase() === raw.toLowerCase() ||
    ws.repo?.toLowerCase().endsWith('/' + raw.toLowerCase())
  );
  if (match) return match.id;

  return null;
}

/**
 * Resolve missionId from explicit param or by inheriting from the calling worker's task.
 */
async function resolveMissionId(
  api: ApiFn,
  param: unknown,
  ctx: ActionContext,
): Promise<string | null> {
  if (param && typeof param === 'string') return param;
  if (!ctx.workerId) return null;
  try {
    const workerData = await api(`/api/workers/${ctx.workerId}`);
    return workerData?.task?.missionId || workerData?.task?.context?.missionId || null;
  } catch {
    return null;
  }
}

// Actions that require at least worker level (trigger tokens cannot use these)
const workerOnlyActions = new Set(
  (workerActions as readonly string[]).filter(a => !(triggerActions as readonly string[]).includes(a))
);

async function requireWorkerLevel(ctx: ActionContext, action: string): Promise<ToolResult | null> {
  if (!workerOnlyActions.has(action)) return null;
  const level = await ctx.getLevel();
  if (level === 'trigger') {
    return errorResult(`Action '${action}' requires a worker or admin token. Trigger tokens can only use: ${triggerActions.join(', ')}`);
  }
  return null;
}

/**
 * Mutating actions that must be blocked when the calling worker's task has
 * been externally terminated (cancelled/failed by admin). This prevents a
 * long-running worker that missed the abort signal from spawning orphan tasks,
 * creating dangling PRs, or emitting stale side-effects.
 *
 * update_progress is intentionally excluded — the PATCH route already returns
 * a 409 (abort) for terminated workers, and allowing progress updates to flow
 * through (and surface the abort) is preferable to hard-blocking them here.
 */
const WRITE_FENCED_ACTIONS = new Set<string>([
  'create_task',
  'complete_task',
  'create_pr',
  'create_artifact',
  'emit_event',
]);

/**
 * Task statuses set by an external actor that indicate the worker should stop.
 * 'completed' is excluded: the worker may be retrying its own complete_task
 * in a race — the existing 409 path from the PATCH route handles that.
 */
const EXTERNALLY_TERMINAL_TASK_STATUSES = new Set<string>(['cancelled', 'failed']);

/**
 * Write fence: reject mutating actions when the calling worker's task has been
 * externally terminated. Preserves the complete-vs-abort race carve-out —
 * complete_task is allowed through if the worker is already completed or has
 * deliverables (PR/artifact created before the cancel arrived).
 *
 * Fails open on API errors so a transient lookup failure never permanently
 * blocks a live worker. The underlying API routes enforce their own state checks.
 */
async function checkWriteFence(
  api: ApiFn,
  action: string,
  ctx: ActionContext,
): Promise<ToolResult | null> {
  if (!ctx.workerId) return null;
  if (!WRITE_FENCED_ACTIONS.has(action)) return null;

  let workerData: any;
  try {
    workerData = await api(`/api/workers/${ctx.workerId}`);
  } catch {
    return null;
  }

  const taskStatus = (workerData?.task?.status as string | undefined) ?? null;
  if (!taskStatus || !EXTERNALLY_TERMINAL_TASK_STATUSES.has(taskStatus)) return null;

  // complete_task carve-out: if the worker itself is already completed or already
  // produced deliverables (a PR or artifact was attached before the cancel arrived),
  // let complete_task through — this mirrors the sync abort path that skips the
  // abort flag when actualStatus==='completed' || hasDeliverables.
  if (action === 'complete_task') {
    const workerStatus = workerData?.status as string | undefined;
    const hasDeliverables = !!(workerData?.prUrl || workerData?.prNumber);
    if (workerStatus === 'completed' || hasDeliverables) return null;
  }

  const taskId = (workerData?.task?.id || workerData?.taskId) as string | undefined;
  return errorResult(
    `**TASK ${taskStatus.toUpperCase()}: Action '${action}' blocked.** ` +
    `Your task${taskId ? ` (${taskId})` : ''} is in state '${taskStatus}' — it was terminated externally. ` +
    `Stop working on this task immediately. Do not create tasks, PRs, or artifacts. ` +
    `If you need to record that the worker stopped, call complete_task with an error param.`
  );
}

/**
 * Corpora eligible for entity-keyed supersession. Code/docs are deliberately
 * excluded: path-keyed supersession already covers them, and defines-sets from
 * regex extraction are too weak there to key replacement on.
 */
const ENTITY_SUPERSEDABLE_CORPORA: ReadonlySet<string> = new Set(['memory', 'task', 'plan', 'artifact']);

/**
 * Validate an agent-supplied `supersedes` param.
 * Returns `{}` when absent, `{ ids }` when valid, `{ error }` when malformed.
 */
function parseSupersedesParam(raw: unknown): { ids?: string[]; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) {
    return { error: 'supersedes must be an array of knowledge source_id strings (e.g. ["task:<taskId>"] or memory ids)' };
  }
  if (raw.length > 50) {
    return { error: 'supersedes accepts at most 50 source_ids per call' };
  }
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || v.trim() === '') {
      return { error: 'supersedes entries must be non-empty strings (chunk source_ids)' };
    }
    ids.push(v.trim());
  }
  return { ids };
}

/**
 * Best-effort entity binding after a chunk is indexed.
 *
 * Runs entity extraction on the chunk content, resolves agent-supplied entity
 * refs, and persists chunk_entities. Returns EntityBinding for caller feedback;
 * all errors are swallowed so entity failure never blocks the underlying action.
 *
 * When `store` is provided and the corpus is entity-supersedable, chunks whose
 * defines-set identically matches this chunk's bound defines entities are
 * marked superseded (best-effort, never fails the action).
 */
async function processEntityRefs(
  workspaceId: string,
  chunkSourceId: string,
  namespace: string,
  chunkContent: string,
  corpus: string,
  sourcePath: string | null | undefined,
  metadata: Record<string, unknown> | undefined,
  agentRefs: EntityRef[] | undefined,
  agentRelations: RelationRef[] | undefined,
  store?: KnowledgeStore,
  sourceTs?: Date | null,
): Promise<EntityBinding> {
  try {
    const { extractEntities } = await import('./knowledge-store/entity-extractor');
    const { resolveAndPersistEntities } = await import('./knowledge-store/entity-resolver');
    const { buildAgentRelationEdges } = await import('./knowledge-store/edge-builder');

    const extracted = extractEntities({
      content: chunkContent,
      sourcePath: sourcePath ?? undefined,
      metadata,
      corpus: corpus as Corpus,
      workspaceId,
    });

    const result = await resolveAndPersistEntities({
      workspaceId,
      chunkSourceId,
      namespace,
      extracted,
      agentRefs,
      source: 'mcp',
    });

    if (agentRelations && agentRelations.length > 0) {
      await buildAgentRelationEdges(workspaceId, agentRelations, chunkSourceId).catch(() => {});
    }

    // Wave-1 C1: entity-keyed supersession — when this chunk defines the same
    // entity set as an older chunk in a supersedable corpus, the old one yields.
    if (
      store?.markSupersededByEntities &&
      ENTITY_SUPERSEDABLE_CORPORA.has(corpus) &&
      result.definesEntityIds.length > 0
    ) {
      await store
        .markSupersededByEntities(namespace, chunkSourceId, result.definesEntityIds, {
          corpus: corpus as Corpus,
          sourceTs: sourceTs ?? null,
        })
        .catch(() => {});
    }

    return result.binding;
  } catch {
    return { bound: 0, ambiguous: [], unresolved: [] };
  }
}

/**
 * Best-effort mirror of an agent work-product "card" into the KnowledgeStore.
 *
 * Mirrors the memory-mirroring pattern from `handleMemoryAction`: resolve the
 * workspace, build the namespace, upsert one chunk — and swallow every error so
 * a failed index never breaks the underlying action. No-ops when the store or
 * workspace is unavailable.
 */
async function mirrorWorkProduct(
  ctx: ActionContext,
  corpus: Corpus,
  chunk: UpsertChunk,
): Promise<UpsertResult | null> {
  if (!ctx.knowledgeStore) return null;
  try {
    const wsId = ctx.workspaceId || (await ctx.getWorkspaceId());
    if (!wsId) return null;
    const ns = buildNamespace(wsId, corpus);
    const result = await ctx.knowledgeStore.upsert(ns, [chunk]);
    return result ?? null;
  } catch {
    // Best-effort — never fail the underlying action if indexing fails.
    return null;
  }
}

export async function handleBuilddAction(
  api: ApiFn,
  action: string,
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ToolResult> {
  // Check trigger-level restrictions before processing
  const levelErr = await requireWorkerLevel(ctx, action);
  if (levelErr) return levelErr;

  // Multi-workspace guard: OAuth tokens must pass workspaceId for ambiguous
  // actions when they can see >1 workspace.
  const wsErr = await requireExplicitWorkspace(api, action, params, ctx);
  if (wsErr) return wsErr;

  // Write fence: block mutating actions when the calling worker's task has been
  // externally cancelled or failed. Prevents orphan task creation from a worker
  // that finished a long evaluation without seeing the abort signal.
  const fenceErr = await checkWriteFence(api, action, ctx);
  if (fenceErr) return fenceErr;

  switch (action) {
    case 'list_tasks': {
      const data = await api('/api/tasks');
      const allTasks = data.tasks || [];
      const wsId = ctx.workspaceId || await ctx.getWorkspaceId();
      // Include pending + assigned + in_progress so planners see all ongoing work,
      // not just tasks waiting to be claimed. This prevents duplicate task creation
      // when a planner checks existing work before creating new tasks.
      let active = allTasks.filter((t: any) => ['pending', 'assigned', 'in_progress'].includes(t.status));
      if (wsId) {
        active = active.filter((t: any) => t.workspaceId === wsId);
      }
      // Pending tasks first (claimable), then assigned/in_progress (already running)
      active.sort((a: any, b: any) => {
        const statusOrder: Record<string, number> = { pending: 0, assigned: 1, in_progress: 2 };
        const statusDiff = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
        if (statusDiff !== 0) return statusDiff;
        return (b.priority || 0) - (a.priority || 0);
      });

      const limit = 5;
      const offset = Math.max((params.offset as number) || 0, 0);
      const paginated = active.slice(offset, offset + limit);
      const hasMore = offset + limit < active.length;

      if (paginated.length === 0) return text('No active tasks found.');

      const summary = paginated.map((t: any) => {
        const catPrefix = t.category ? `[${t.category}] ` : '';
        const statusSuffix = t.status !== 'pending' ? ` [${t.status}]` : '';
        return `- ${catPrefix}${t.title}${statusSuffix} (id: ${t.id})\n  ${t.description?.slice(0, 100) || 'No description'}...`;
      }).join('\n\n');

      const pendingCount = active.filter((t: any) => t.status === 'pending').length;
      const header = `${active.length} active task${active.length === 1 ? '' : 's'} (${pendingCount} pending, ${active.length - pendingCount} in progress):`;
      const moreHint = hasMore ? `\n\nCall with offset=${offset + limit} to see more.` : '';
      const claimHint = `\n\nTo claim a task, call action=claim_task (it auto-assigns the highest-priority pending task — you don't pick by ID).`;
      return text(`${header}\n\n${summary}${moreHint}${claimHint}`);
    }

    case 'get_task': {
      if (!params.taskId) throw new Error('taskId is required');

      const includeParam = params.include;
      const includes = Array.isArray(includeParam)
        ? (includeParam as string[])
        : ['workers', 'artifacts'];
      const qs = includes.length > 0 ? `?include=${encodeURIComponent(includes.join(','))}` : '';

      const task = await api(`/api/tasks/${encodeURIComponent(params.taskId as string)}${qs}`);

      const appBase = ctx.appBaseUrl || 'https://buildd.dev';
      const taskUrl = `${appBase}/app/tasks/${task.id}`;

      const lines: string[] = [];
      lines.push(`**Task:** ${task.title} (${task.id})`);
      lines.push(`**Status:** ${task.status}${task.category ? ` [${task.category}]` : ''} (priority ${task.priority ?? 0})`);
      lines.push(`**Task URL:** ${taskUrl}`);
      if (task.workspace?.name || task.workspace?.repo) {
        lines.push(`**Workspace:** ${task.workspace.name}${task.workspace.repo ? ` (${task.workspace.repo})` : ''}`);
      }
      if (task.mission) {
        lines.push(`**Mission:** ${task.mission.title} (${task.mission.id}) — ${task.mission.status}`);
      }
      if (task.description) {
        const desc = task.description.length > 400 ? task.description.slice(0, 400) + '…' : task.description;
        lines.push('', '## Description', desc);
      }

      const result = task.result;
      if (result && (result.summary || result.prUrl || result.prNumber || result.sha)) {
        lines.push('', '## Result');
        if (result.summary) lines.push(`**Summary:** ${result.summary}`);
        if (result.prUrl || result.prNumber) {
          lines.push(`**PR:** ${result.prUrl || `#${result.prNumber}`}`);
        }
        if (result.branch) lines.push(`**Branch:** ${result.branch}`);
        if (result.sha) {
          const shortSha = String(result.sha).slice(0, 7);
          const commitCount = result.commits ? ` (${result.commits} commit${result.commits === 1 ? '' : 's'})` : '';
          lines.push(`**Last commit:** ${shortSha}${commitCount}`);
        }
        if (typeof result.files === 'number' || typeof result.added === 'number' || typeof result.removed === 'number') {
          const stats: string[] = [];
          if (typeof result.files === 'number') stats.push(`${result.files} files`);
          if (typeof result.added === 'number') stats.push(`+${result.added}`);
          if (typeof result.removed === 'number') stats.push(`-${result.removed}`);
          if (stats.length > 0) lines.push(`**Diff:** ${stats.join(' / ')}`);
        }
      }

      const workers = Array.isArray(task.workers) ? task.workers : [];
      if (workers.length > 0) {
        lines.push('', `## Workers (${workers.length})`);
        for (const w of workers) {
          const wlines: string[] = [];
          wlines.push(`- **${w.id}** — ${w.status}${w.branch ? ` on \`${w.branch}\`` : ''}`);
          wlines.push(`  Worker URL: ${taskUrl}`);
          if (w.prUrl || w.prNumber) wlines.push(`  PR: ${w.prUrl || `#${w.prNumber}`}`);
          if (w.lastCommitSha) wlines.push(`  Last commit: ${String(w.lastCommitSha).slice(0, 7)}`);
          if (w.completedAt) wlines.push(`  Completed: ${w.completedAt}`);
          if (w.error) wlines.push(`  Error: ${w.error}`);
          if (w.waitingFor) {
            const actionUrl = `${taskUrl}/respond`;
            wlines.push(`  **Needs input:** ${w.waitingFor.prompt || 'Awaiting response'}`);
            wlines.push(`  Action URL: ${actionUrl}`);
          }
          lines.push(wlines.join('\n'));
        }
      }

      const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
      if (artifacts.length > 0) {
        lines.push('', `## Artifacts (${artifacts.length})`);
        for (const a of artifacts) {
          const meta = a.key ? `, key: ${a.key}` : '';
          const share = a.shareUrl ? `\n  Share: ${a.shareUrl}` : '';
          lines.push(`- **${a.title}** (${a.type}${meta})\n  ID: ${a.id}${share}`);
        }
      }

      return text(lines.join('\n'));
    }

    case 'claim_task': {
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      const data = await api('/api/workers/claim', {
        method: 'POST',
        body: JSON.stringify({ maxTasks: params.maxTasks || 1, workspaceId: wsId, runner: 'mcp' }),
      });

      const workers = data.workers || [];
      if (workers.length === 0) return text('No tasks available to claim. All tasks may be assigned or completed.');

      const claimed = workers.map((w: any) =>
        `**Worker ID:** ${w.id}\n**Task:** ${w.task.title}\n**Branch:** ${w.branch}\n**Description:** ${w.task.description || 'No description'}`
      ).join('\n\n---\n\n');

      // Proactively fetch relevant memory from memory service
      let memorySection = '';
      try {
        const { getMemoryClient } = await import('./memory-client');
        const memClient = getMemoryClient();
        if (memClient && workers[0]?.task?.title) {
          const searchData = await memClient.search({
            query: workers[0].task.title,
            limit: 5,
          });
          const results = searchData.results || [];
          if (results.length > 0) {
            const batchData = await memClient.batch(results.map(r => r.id));
            const memories = batchData.memories || [];
            if (memories.length > 0) {
              const memoryLines = memories.map((m: any) => {
                const truncContent = m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
                return `- **[${m.type}] ${m.title}**: ${truncContent}`;
              });
              memorySection = `\n\n## Relevant Memory\nREAD these memories before starting work:\n${memoryLines.join('\n')}\n\nUse \`buildd_memory\` action=search for more context.`;
            }
          }
        }
      } catch {
        // Memory fetch is non-fatal
      }

      // Open PRs section: inform agent about concurrent work
      let openPRsSection = '';
      const firstWorkerPRs = workers[0]?.openPRs;
      if (firstWorkerPRs && firstWorkerPRs.length > 0) {
        const prLines = firstWorkerPRs.map((pr: any) =>
          `- PR #${pr.prNumber} (branch: ${pr.branch}): "${pr.taskTitle || 'Unknown task'}" — ${pr.prUrl}`
        );
        openPRsSection = `\n\n## Open PRs in this workspace\nThese PRs are from other agents working in the same repo. Avoid modifying the same files if possible, or rebase on top of their branches.\n${prLines.join('\n')}`;
      }

      return text(`Claimed ${workers.length} task(s):\n\n${claimed}${openPRsSection}${memorySection}\n\nUse the worker ID to report progress and completion.`);
    }

    case 'update_progress': {
      const workerId = resolveWorkerId(params.workerId, ctx);

      // Plan submission
      if (params.plan) {
        await api(`/api/workers/${workerId}/plan`, {
          method: 'POST',
          body: JSON.stringify({ plan: params.plan }),
        });
        return text('Your plan has been submitted for review. Please wait for the task author to approve it before proceeding with implementation. Do not make any changes until you receive approval.');
      }

      let response;
      try {
        const statusMilestone = params.message ? {
          appendMilestones: [{
            type: 'status',
            label: params.message,
            progress: params.progress || 0,
            ts: Date.now(),
          }],
        } : {};

        const progressBody: Record<string, unknown> = {
          status: 'running',
          progress: params.progress || 0,
          ...statusMilestone,
        };
        if (params.message) progressBody.currentAction = params.message;
        if (typeof params.inputTokens === 'number') progressBody.inputTokens = params.inputTokens;
        if (typeof params.outputTokens === 'number') progressBody.outputTokens = params.outputTokens;
        if (params.lastCommitSha) progressBody.lastCommitSha = params.lastCommitSha;
        if (typeof params.commitCount === 'number') progressBody.commitCount = params.commitCount;
        if (typeof params.filesChanged === 'number') progressBody.filesChanged = params.filesChanged;
        if (typeof params.linesAdded === 'number') progressBody.linesAdded = params.linesAdded;
        if (typeof params.linesRemoved === 'number') progressBody.linesRemoved = params.linesRemoved;

        response = await api(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify(progressBody),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('409')) {
          return errorResult('**ABORT: Your worker has been terminated.** The task may have been reassigned by an admin. STOP working on this task immediately - do not push, commit, or create PRs. Use complete_task with error param or simply stop.');
        }
        throw err;
      }

      let resultText = `Progress updated: ${params.progress}%${params.message ? ` - ${params.message}` : ''}`;

      const instructions = response.instructions;
      if (instructions) {
        resultText += `\n\n**ADMIN INSTRUCTION:** ${instructions}`;
      }

      return text(resultText);
    }

    case 'complete_task': {
      const workerId = resolveWorkerId(params.workerId, ctx);

      // Validate supersedes BEFORE any state change so malformed input never
      // half-completes the task.
      const supersedesParse = parseSupersedesParam(params.supersedes);
      if (supersedesParse.error) return errorResult(supersedesParse.error);
      const supersedesIds = supersedesParse.ids;

      if (params.error) {
        await api(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'failed', error: params.error }),
        });
        return text(`Task marked as failed: ${params.error}`);
      }

      let result: any;
      let entityBinding: EntityBinding | null = null;
      let supersededCount = 0;
      try {
        result = await api(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'completed',
            ...(params.summary ? { summary: params.summary } : {}),
            ...(params.structuredOutput ? { structuredOutput: params.structuredOutput } : {}),
            ...(params.nextSuggestion ? { nextSuggestion: params.nextSuggestion } : {}),
          }),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('409')) {
          return errorResult('**WARNING: Worker was already terminated.** The task may have been reassigned. Your work may have been superseded by another worker.');
        }
        // Handle output requirement validation errors (400) — return hint so agent can fix
        if (errMsg.includes('400')) {
          try {
            const jsonMatch = errMsg.match(/\{.*\}/s);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.hint) {
                return errorResult(`**Cannot complete task:** ${parsed.error}\n\nPlease use \`${parsed.hint}\` before calling complete_task again.`);
              }
            }
          } catch { /* fall through to generic error */ }
          return errorResult(`**Cannot complete task:** ${errMsg}\n\nIf you created a PR using \`gh pr create\`, use \`create_pr\` instead so Buildd can track it.`);
        }
        throw err;
      }

      // Surface effort metrics from the completed worker
      const effortParts: string[] = [];
      if (result?.turns) effortParts.push(`${result.turns} turns`);
      const mcpCallCount = Array.isArray(result?.mcpCalls) ? result.mcpCalls.length : 0;
      if (mcpCallCount > 0) effortParts.push(`${mcpCallCount} tool calls`);
      const effortSuffix = effortParts.length > 0 ? ` (${effortParts.join(', ')})` : '';

      // Fetch release result + task details (set by workers route after release execution)
      let releaseLine = '';
      if (params.workerId || ctx.workerId) {
        try {
          const wid = params.workerId || ctx.workerId;
          const workerData = await api(`/api/workers/${wid}`);
          const taskId = workerData?.taskId;
          if (taskId) {
            const taskData = await api(`/api/tasks/${taskId}`);
            const releaseResult = taskData?.releaseResult;
            if (releaseResult?.message) {
              releaseLine = `\n\n${releaseResult.message}`;
            } else if (taskData?.result?.releaseSummary) {
              releaseLine = `\n\n${taskData.result.releaseSummary}`;
            }

            // Mirror the completed task into the KnowledgeStore (best-effort).
            const prUrl = taskData?.prUrl || taskData?.result?.prUrl || workerData?.prUrl || null;
            const taskChunk = buildTaskCard({
              taskId,
              title: taskData?.title ?? null,
              description: taskData?.description ?? null,
              summary: (params.summary as string) ?? taskData?.result?.summary ?? null,
              success: true,
              prUrl,
              missionId: taskData?.missionId ?? null,
            });
            // Stamp with completion time for recency decay scoring.
            const completedAtRaw = workerData?.completedAt ?? taskData?.completedAt;
            if (completedAtRaw) taskChunk.sourceTs = new Date(completedAtRaw);
            // Explicit supersession: agent-asserted source_ids this outcome replaces.
            if (supersedesIds && supersedesIds.length > 0) taskChunk.supersedes = supersedesIds;
            const mirrorResult = await mirrorWorkProduct(ctx, 'task', taskChunk);
            if (mirrorResult) supersededCount = mirrorResult.superseded;

            // Phase D1: also mirror a recency-weighted session card into the
            // `session` corpus (process narrative + loose threads, low authority
            // / 7-day half-life). Distinct from the durable task card above; it
            // powers "someone worked this area recently" at claim time. Fully
            // best-effort — never let it disturb completion.
            try {
              const sessionChunk = buildSessionCard({
                taskId,
                workerId: (params.workerId as string) || ctx.workerId || null,
                title: taskData?.title ?? null,
                summary: (params.summary as string) ?? taskData?.result?.summary ?? null,
                nextSuggestion: (params.nextSuggestion as string) ?? null,
                success: true,
                turns: typeof result?.turns === 'number' ? result.turns : null,
                missionId: taskData?.missionId ?? null,
              });
              if (completedAtRaw) sessionChunk.sourceTs = new Date(completedAtRaw);
              await mirrorWorkProduct(ctx, 'session', sessionChunk);
            } catch { /* non-fatal */ }

            // Layer 2: bind entity refs and build edges (best-effort)
            const wsId = ctx.workspaceId ?? await ctx.getWorkspaceId();
            if (wsId && ctx.knowledgeStore) {
              const ns = buildNamespace(wsId, 'task');
              entityBinding = await processEntityRefs(
                wsId, taskChunk.id, ns,
                taskChunk.content, 'task', null,
                { taskId, missionId: taskData?.missionId ?? null },
                params.entities as EntityRef[] | undefined,
                params.relations as RelationRef[] | undefined,
                ctx.knowledgeStore,
                taskChunk.sourceTs ?? null,
              );
              if (taskData?.missionId) {
                const { buildOutcomeOfEdge } = await import('./knowledge-store/edge-builder');
                await buildOutcomeOfEdge(wsId, taskId, taskData.missionId, taskChunk.id).catch(() => {});
              }
            }
          }
        } catch { /* non-fatal */ }
      }

      let entityBindingText = '';
      if (entityBinding && (entityBinding.bound > 0 || entityBinding.ambiguous.length > 0 || entityBinding.unresolved.length > 0)) {
        entityBindingText = `\n\nEntity binding: ${entityBinding.bound} bound`;
        if (entityBinding.ambiguous.length > 0) {
          entityBindingText += `, ${entityBinding.ambiguous.length} ambiguous (${entityBinding.ambiguous.map(a => a.ref).join(', ')})`;
        }
        if (entityBinding.unresolved.length > 0) {
          entityBindingText += `, ${entityBinding.unresolved.length} unresolved`;
        }
      }

      // Acknowledge explicit supersession whenever the param was supplied so
      // agents get truthful feedback (0 means no listed id matched a current chunk).
      const supersededText = supersedesIds !== undefined
        ? `\n\nSuperseded: ${supersededCount}`
        : '';

      return text(`Task completed successfully!${effortSuffix}${params.summary ? `\n\nSummary: ${params.summary}` : ''}${releaseLine}${entityBindingText}${supersededText}`);
    }

    case 'create_pr': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      if (!params.title || !params.head) {
        throw new Error('title and head branch are required');
      }

      const data = await api('/api/github/pr', {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          title: params.title,
          body: params.body,
          head: params.head,
          base: params.base,
          draft: params.draft,
          prUrl: params.prUrl,
        }),
      });

      // Mirror the PR into the KnowledgeStore (best-effort). Resolve task/mission
      // linkage from the worker without failing the action if it can't be found.
      try {
        let taskId: string | null = null;
        let missionId: string | null = null;
        try {
          const workerData = await api(`/api/workers/${workerId}`);
          taskId = workerData?.taskId ?? null;
          missionId = workerData?.task?.missionId ?? workerData?.missionId ?? null;
        } catch { /* linkage is optional */ }
        const prChunk = buildPrCard({
          prNumber: data.pr.number,
          title: data.pr.title ?? (params.title as string),
          body: (params.body as string) ?? null,
          url: data.pr.url ?? (params.prUrl as string) ?? null,
          taskId,
          missionId,
        });
        // Stamp with PR creation time for recency decay scoring.
        const prCreatedAt = data.pr.createdAt ?? data.pr.created_at;
        if (prCreatedAt) prChunk.sourceTs = new Date(prCreatedAt);
        await mirrorWorkProduct(ctx, 'pr', prChunk);
      } catch { /* non-fatal */ }

      return text(`Pull request created!\n\n**PR #${data.pr.number}:** ${data.pr.title}\n**URL:** ${data.pr.url}\n**State:** ${data.pr.state}`);
    }

    case 'update_task': {
      if (!params.taskId) throw new Error('taskId is required');

      const updateFields: Record<string, unknown> = {};
      if (params.title !== undefined) updateFields.title = params.title;
      if (params.description !== undefined) updateFields.description = params.description;
      if (params.priority !== undefined) updateFields.priority = normalizePriority(params.priority);
      if (params.project !== undefined) updateFields.project = params.project;
      if (params.status !== undefined) updateFields.status = params.status;

      if (Object.keys(updateFields).length === 0) {
        throw new Error('At least one field (title, description, priority, project, status) must be provided');
      }

      const updated = await api(`/api/tasks/${params.taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateFields),
      });

      return text(`Task updated: "${updated.title}" (ID: ${updated.id})\nStatus: ${updated.status}\nPriority: ${updated.priority}`);
    }

    case 'create_task': {
      if (!params.title || !params.description) throw new Error('title and description are required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const taskBody: Record<string, unknown> = {
        workspaceId: wsId,
        title: params.title,
        description: params.description,
        priority: normalizePriority(params.priority),
        creationSource: 'mcp',
      };
      if (ctx.workerId) taskBody.createdByWorkerId = ctx.workerId;
      if (params.parentTaskId && typeof params.parentTaskId === 'string') {
        taskBody.parentTaskId = params.parentTaskId;
      }
      if (Array.isArray(params.dependsOn) && params.dependsOn.length > 0) {
        taskBody.dependsOn = params.dependsOn;
      }
      if (Array.isArray(params.pathManifest) && params.pathManifest.length > 0) {
        taskBody.pathManifest = params.pathManifest;
      }
      if (params.category) taskBody.category = params.category;
      if (params.roleSlug && typeof params.roleSlug === 'string') taskBody.roleSlug = params.roleSlug;
      // Agent backend override. Omit to inherit the role's default (then 'claude').
      if (params.backend === 'claude' || params.backend === 'codex') taskBody.backend = params.backend;
      // outputRequirement inheritance from mission is handled by the API route;
      // only pass through if explicitly provided by the caller.
      if (params.outputRequirement) taskBody.outputRequirement = params.outputRequirement;
      if (params.outputSchema && typeof params.outputSchema === 'object') {
        taskBody.outputSchema = params.outputSchema;
      }
      if (params.project) taskBody.project = params.project;

      // Auto-link to mission: explicit param takes precedence, then inherit from caller's task
      if (params.missionId) {
        taskBody.missionId = params.missionId;
      } else if (ctx.workerId) {
        // Fetch caller worker's task to inherit missionId
        try {
          const workerData = await api(`/api/workers/${ctx.workerId}`);
          const callerMissionId = workerData?.task?.missionId || workerData?.task?.context?.missionId;
          if (callerMissionId) {
            taskBody.missionId = callerMissionId;
          }
        } catch {
          // Non-fatal — skip auto-linking if worker lookup fails
        }
      }

      // Pass through context fields for worker configuration
      const taskContext: Record<string, unknown> = (taskBody.context as Record<string, unknown>) || {};
      if (params.skillSlugs && Array.isArray(params.skillSlugs)) {
        taskContext.skillSlugs = params.skillSlugs;
      }
      if (params.model && typeof params.model === 'string') {
        taskContext.model = params.model;
      }
      if (params.effort && typeof params.effort === 'string') {
        taskContext.effort = params.effort;
      }
      // Ralph loop fields — branch continuity, verification, and retry metadata
      if (params.baseBranch && typeof params.baseBranch === 'string') {
        taskContext.baseBranch = params.baseBranch;
      }
      if (params.verificationCommand && typeof params.verificationCommand === 'string') {
        taskContext.verificationCommand = params.verificationCommand;
      }
      if (typeof params.iteration === 'number') {
        taskContext.iteration = params.iteration;
      }
      if (typeof params.maxIterations === 'number') {
        taskContext.maxIterations = params.maxIterations;
      }
      if (params.failureContext && typeof params.failureContext === 'string') {
        taskContext.failureContext = params.failureContext;
      }
      if (params.callbackUrl && typeof params.callbackUrl === 'string') {
        if (!params.callbackUrl.startsWith('https://')) {
          throw new Error('callbackUrl must use HTTPS');
        }
        taskContext.callback = {
          url: params.callbackUrl,
          ...(params.callbackToken && typeof params.callbackToken === 'string'
            ? { token: params.callbackToken }
            : {}),
        };
      }
      if (Object.keys(taskContext).length > 0) {
        taskBody.context = taskContext;
      }
      if (params.release && ['true', 'false', 'inherit'].includes(params.release as string)) {
        taskBody.release = params.release;
      }

      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(taskBody),
      });

      const createAppBase = ctx.appBaseUrl || 'https://buildd.dev';
      const createdTaskUrl = `${createAppBase}/app/tasks/${task.id}`;
      return text(`Task created: "${task.title}" (ID: ${task.id})\nStatus: Queued — no runner has claimed it yet. A runner will pick it up on its next poll; follow progress with get_task (taskId ${task.id}).\nPriority: ${task.priority}\nTask URL: ${createdTaskUrl}${taskBody.parentTaskId ? `\nParent: ${taskBody.parentTaskId}` : ''}${taskBody.missionId ? `\nLinked to mission: ${taskBody.missionId}` : ''}${ctx.workerId ? `\nCreated by worker: ${ctx.workerId}` : ''}`);
    }

    case 'create_schedule': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.name || !params.cronExpression || !params.title) {
        throw new Error('name, cronExpression, and title are required');
      }

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const taskTemplate: Record<string, unknown> = {
        title: params.title,
        description: params.description,
        priority: normalizePriority(params.priority),
        mode: params.mode || 'execution',
      };

      if (params.skillSlugs && Array.isArray(params.skillSlugs) && params.skillSlugs.length > 0) {
        taskTemplate.context = { skillSlugs: params.skillSlugs };
      }

      if (params.trigger && typeof params.trigger === 'object') {
        const trigger = params.trigger as Record<string, unknown>;
        if (!trigger.type || !trigger.url) throw new Error("trigger requires type ('rss' | 'http-json') and url");
        if (trigger.type !== 'rss' && trigger.type !== 'http-json') throw new Error("trigger.type must be 'rss' or 'http-json'");
        taskTemplate.trigger = {
          type: trigger.type,
          url: trigger.url,
          ...(trigger.path ? { path: trigger.path } : {}),
          ...(trigger.headers ? { headers: trigger.headers } : {}),
        };
      }

      const schedule = await api(`/api/workspaces/${wsId}/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          cronExpression: params.cronExpression,
          timezone: params.timezone || 'UTC',
          taskTemplate,
        }),
      });

      const sched = schedule.schedule;
      const triggerInfo = sched.taskTemplate?.trigger
        ? `\nTrigger: ${sched.taskTemplate.trigger.type} → ${sched.taskTemplate.trigger.url}`
        : '';
      return text(`Schedule created: "${sched.name}" (ID: ${sched.id})\nCron: ${sched.cronExpression} (${sched.timezone})\nNext run: ${sched.nextRunAt || 'not scheduled'}\nCreates task: "${sched.taskTemplate.title}"${triggerInfo}`);
    }

    case 'update_schedule': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.scheduleId) throw new Error('scheduleId is required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace.');

      const updateBody: Record<string, unknown> = {};
      if (params.cronExpression !== undefined) updateBody.cronExpression = params.cronExpression;
      if (params.timezone !== undefined) updateBody.timezone = params.timezone;
      if (params.enabled !== undefined) updateBody.enabled = params.enabled;
      if (params.name !== undefined) updateBody.name = params.name;
      if (params.taskTemplate !== undefined) updateBody.taskTemplate = params.taskTemplate;

      if (params.skillSlugs && Array.isArray(params.skillSlugs) && !params.taskTemplate) {
        const current = await api(`/api/workspaces/${wsId}/schedules/${params.scheduleId}`);
        const existingTemplate = current.schedule?.taskTemplate || {};
        updateBody.taskTemplate = {
          ...existingTemplate,
          context: {
            ...(existingTemplate.context || {}),
            skillSlugs: params.skillSlugs,
          },
        };
      }

      if (Object.keys(updateBody).length === 0) {
        throw new Error('At least one field (cronExpression, timezone, enabled, name, taskTemplate, skillSlugs, workspaceId) must be provided');
      }

      const updated = await api(`/api/workspaces/${wsId}/schedules/${params.scheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateBody),
      });

      const updSched = updated.schedule;
      return text(`Schedule updated: "${updSched.name}" (ID: ${updSched.id})\nCron: ${updSched.cronExpression} (${updSched.timezone})\nEnabled: ${updSched.enabled}\nNext run: ${updSched.nextRunAt || 'not scheduled'}`);
    }

    case 'delete_schedule': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.scheduleId) throw new Error('scheduleId is required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace.');

      const result = await api(`/api/workspaces/${wsId}/schedules/${params.scheduleId}`, {
        method: 'DELETE',
      });

      if (!result.success) throw new Error(result.error || 'Failed to delete schedule');
      return text(`Schedule ${params.scheduleId} deleted successfully.`);
    }

    case 'list_schedules': {
      // Read-only — any authenticated level (trigger/worker/admin) can list.

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      const minutesAgo = typeof params.minutesAgo === 'number' ? params.minutesAgo : null;
      const nameContains = typeof params.nameContains === 'string' ? params.nameContains.toLowerCase() : null;
      const filterCutoff = minutesAgo !== null ? Date.now() - minutesAgo * 60_000 : null;

      const matchesFilters = (s: any): boolean => {
        if (filterCutoff !== null) {
          const last = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
          if (!Number.isFinite(last) || last < filterCutoff) return false;
        }
        if (nameContains && !s.name.toLowerCase().includes(nameContains)) return false;
        return true;
      };

      const renderLine = (s: any, workspace?: string): string => {
        const wsTag = workspace ? ` [${workspace}]` : '';
        const status = s.enabled ? '' : ' (PAUSED)';
        const last = s.lastRunAt ? `Last: ${s.lastRunAt}` : 'Last: never';
        const failures = s.consecutiveFailures > 0 ? ` | Failures: ${s.consecutiveFailures}` : '';
        const err = s.lastError ? `\n  ⚠ Last error: ${String(s.lastError).slice(0, 200)}` : '';
        const channel = describeOutputChannel(s.taskTemplate);
        const channelLine = channel ? `\n  Sends: ${channel}` : '';
        return `- **${s.name}**${status}${wsTag}\n  Cron: ${s.cronExpression} (${s.timezone})\n  Next: ${s.nextRunAt || 'N/A'} | ${last} | Runs: ${s.totalRuns}${failures}\n  Task: ${s.taskTemplate.title}${channelLine}${err}\n  ID: ${s.id}`;
      };

      // If workspace specified, list its schedules; otherwise aggregate across all workspaces
      if (wsId) {
        const data = await api(`/api/workspaces/${wsId}/schedules`);
        const schedules = (data.schedules || []).filter(matchesFilters);

        if (schedules.length === 0) {
          if (minutesAgo !== null || nameContains) return text('No schedules matched the filter.');
          return text('No schedules configured for this workspace.');
        }

        const summary = schedules.map((s: any) => renderLine(s)).join('\n\n');
        return text(`${schedules.length} schedule(s):\n\n${summary}`);
      }

      // No workspace — list across all accessible workspaces
      const wsData = await api('/api/workspaces');
      const workspaces = wsData.workspaces || [];
      if (workspaces.length === 0) return text('No workspaces found.');

      const allSchedules: { workspace: string; schedule: any }[] = [];
      for (const ws of workspaces) {
        const data = await api(`/api/workspaces/${ws.id}/schedules`);
        for (const s of (data.schedules || [])) {
          if (matchesFilters(s)) allSchedules.push({ workspace: ws.name, schedule: s });
        }
      }

      if (allSchedules.length === 0) {
        if (minutesAgo !== null || nameContains) return text('No schedules matched the filter across any workspace.');
        return text('No schedules configured across any workspace.');
      }

      const summary = allSchedules.map(({ workspace, schedule: s }) => renderLine(s, workspace)).join('\n\n');
      return text(`${allSchedules.length} schedule(s) across ${workspaces.length} workspace(s):\n\n${summary}`);
    }

    case 'trace_schedule': {
      // Read-only — given a task or a recent-fire window, find the schedule(s) responsible.
      const taskId = typeof params.taskId === 'string' ? params.taskId : null;
      const taskTitleContains = typeof params.taskTitleContains === 'string' ? params.taskTitleContains.toLowerCase() : null;
      const minutesAgo = typeof params.minutesAgo === 'number' ? params.minutesAgo : null;

      if (!taskId && !taskTitleContains && minutesAgo === null) {
        return errorResult('Provide one of: taskId, taskTitleContains, or minutesAgo.');
      }

      // Path 1: task ID — direct FK lookup, highest confidence.
      if (taskId) {
        const task = await api(`/api/tasks/${taskId}`).catch(() => null);
        if (!task) return errorResult(`Task ${taskId} not found.`);

        const scheduleId = task.scheduleId || task.task?.scheduleId;
        const wsId = task.workspaceId || task.task?.workspaceId;

        if (!scheduleId) {
          return text(
            `Task ${taskId} has no scheduleId. creationSource=${task.creationSource ?? task.task?.creationSource ?? 'unknown'}.\n` +
              `It was not created by a schedule (or pre-dates the schedule_id column).`
          );
        }

        const sched = await api(`/api/workspaces/${wsId}/schedules/${scheduleId}`).catch(() => null);
        if (!sched?.schedule) {
          return text(`Task ${taskId} references schedule ${scheduleId}, but that schedule no longer exists.`);
        }
        const s = sched.schedule;
        const channel = describeOutputChannel(s.taskTemplate);
        return text(
          `Task ${taskId} was created by schedule:\n` +
            `- **${s.name}** ${s.enabled ? '' : '(PAUSED)'}\n` +
            `  Cron: ${s.cronExpression} (${s.timezone})\n` +
            `  Last run: ${s.lastRunAt || 'never'} | Total runs: ${s.totalRuns}\n` +
            (channel ? `  Sends: ${channel}\n` : '') +
            `  ID: ${s.id}\n\n` +
            `To pause: pause_schedules { scheduleIds: ["${s.id}"], workspaceId: "${wsId}" }`
        );
      }

      // Paths 2/3: search by recency + title across workspaces.
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      const workspaceList = wsId
        ? [{ id: wsId, name: '' }]
        : ((await api('/api/workspaces')).workspaces || []) as Array<{ id: string; name: string }>;

      const filterCutoff = minutesAgo !== null ? Date.now() - minutesAgo * 60_000 : null;
      const candidates: Array<{ workspace: string; schedule: any; reasons: string[] }> = [];

      for (const ws of workspaceList) {
        const data = await api(`/api/workspaces/${ws.id}/schedules`).catch(() => null);
        if (!data) continue;
        for (const s of (data.schedules || [])) {
          const reasons: string[] = [];
          if (filterCutoff !== null) {
            const last = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
            if (Number.isFinite(last) && last >= filterCutoff) {
              reasons.push(`fired ${Math.round((Date.now() - last) / 60_000)}m ago`);
            }
          }
          if (taskTitleContains) {
            const t = String(s.taskTemplate?.title || '').toLowerCase();
            if (t.includes(taskTitleContains)) reasons.push(`title matches "${taskTitleContains}"`);
          }
          if (reasons.length > 0) candidates.push({ workspace: ws.name, schedule: s, reasons });
        }
      }

      if (candidates.length === 0) {
        return text('No schedules matched. Widen the window with a larger minutesAgo, or check the task ID directly.');
      }

      // Rank: more reasons first, then most-recently fired.
      candidates.sort((a, b) => {
        if (a.reasons.length !== b.reasons.length) return b.reasons.length - a.reasons.length;
        const aLast = a.schedule.lastRunAt ? Date.parse(a.schedule.lastRunAt) : 0;
        const bLast = b.schedule.lastRunAt ? Date.parse(b.schedule.lastRunAt) : 0;
        return bLast - aLast;
      });

      const lines = candidates.map(({ workspace, schedule: s, reasons }) => {
        const channel = describeOutputChannel(s.taskTemplate);
        const wsTag = workspace ? ` [${workspace}]` : '';
        return (
          `- **${s.name}**${wsTag} — ${reasons.join(', ')}\n` +
          `  Cron: ${s.cronExpression} (${s.timezone}) | Last: ${s.lastRunAt || 'never'}\n` +
          (channel ? `  Sends: ${channel}\n` : '') +
          `  ID: ${s.id}`
        );
      });

      return text(`${candidates.length} candidate schedule(s), best match first:\n\n${lines.join('\n\n')}`);
    }

    case 'pause_schedules': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const desiredEnabled = params.enabled === true; // default false = pause
      const scheduleIds = Array.isArray(params.scheduleIds)
        ? (params.scheduleIds as string[])
        : null;
      const namePattern = typeof params.namePattern === 'string' ? params.namePattern.toLowerCase() : null;

      // Resolve target schedule IDs
      let targets: Array<{ id: string; name: string; enabled: boolean }> = [];
      if (scheduleIds) {
        // Caller gave exact IDs — fetch the workspace list once to get names for the summary
        const data = await api(`/api/workspaces/${wsId}/schedules`);
        const all = (data.schedules || []) as Array<{ id: string; name: string; enabled: boolean }>;
        const idSet = new Set(scheduleIds);
        targets = all.filter((s) => idSet.has(s.id));
        const missing = scheduleIds.filter((id) => !targets.some((t) => t.id === id));
        if (missing.length) {
          return errorResult(`Schedule(s) not found in this workspace: ${missing.join(', ')}`);
        }
      } else {
        const data = await api(`/api/workspaces/${wsId}/schedules`);
        const all = (data.schedules || []) as Array<{ id: string; name: string; enabled: boolean }>;
        targets = namePattern
          ? all.filter((s) => s.name.toLowerCase().includes(namePattern))
          : all;
      }

      if (targets.length === 0) {
        return text(
          namePattern
            ? `No schedules matching "${params.namePattern}" in this workspace.`
            : 'No schedules in this workspace.',
        );
      }

      // Skip schedules already in the desired state — avoid noise + needless writes
      const toFlip = targets.filter((s) => s.enabled !== desiredEnabled);
      const skipped = targets.length - toFlip.length;

      if (toFlip.length === 0) {
        return text(
          `All ${targets.length} matched schedule(s) already ${desiredEnabled ? 'enabled' : 'paused'}. No changes.`,
        );
      }

      const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
      for (const sched of toFlip) {
        try {
          await api(`/api/workspaces/${wsId}/schedules/${sched.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: desiredEnabled }),
          });
          results.push({ id: sched.id, name: sched.name, ok: true });
        } catch (err) {
          results.push({
            id: sched.id,
            name: sched.name,
            ok: false,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }

      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const lines = [
        `${desiredEnabled ? 'Resumed' : 'Paused'} ${succeeded.length}/${toFlip.length} schedule(s)${skipped ? ` (skipped ${skipped} already in target state)` : ''}.`,
        '',
        ...succeeded.map((r) => `  ✓ ${r.name} [${r.id}]`),
        ...failed.map((r) => `  ✗ ${r.name} [${r.id}] — ${r.error}`),
        failed.length ? '\nNote: in-flight tasks already claimed by workers continue running. Cancel them via update_task if needed.' : '',
      ].filter((l) => l !== '');

      return failed.length > 0 ? errorResult(lines.join('\n')) : text(lines.join('\n'));
    }

    case 'register_skill': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.name || !params.content) throw new Error('name and content are required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const skillBody: Record<string, unknown> = {
        name: params.name,
        content: params.content,
        description: params.description || undefined,
        source: params.source || 'mcp',
      };
      if (params.model) skillBody.model = params.model;
      if (Array.isArray(params.allowedTools)) skillBody.allowedTools = params.allowedTools;
      if (Array.isArray(params.canDelegateTo)) skillBody.canDelegateTo = params.canDelegateTo;
      if (typeof params.background === 'boolean') skillBody.background = params.background;
      if (typeof params.maxTurns === 'number') skillBody.maxTurns = params.maxTurns;
      if (params.color) skillBody.color = params.color;
      if (params.mcpServers && typeof params.mcpServers === 'object') skillBody.mcpServers = params.mcpServers;
      if (params.requiredEnvVars && typeof params.requiredEnvVars === 'object') skillBody.requiredEnvVars = params.requiredEnvVars;
      if (Array.isArray(params.connectorRefs)) skillBody.connectorRefs = params.connectorRefs;
      if (typeof params.isRole === 'boolean') skillBody.isRole = params.isRole;
      if (params.slug) skillBody.slug = params.slug;

      const data = await api(`/api/workspaces/${wsId}/skills`, {
        method: 'POST',
        body: JSON.stringify(skillBody),
      });

      const skill = data.skill;
      return text(`Skill registered: "${skill.name}" (slug: ${skill.slug})\nOrigin: ${skill.origin}\nEnabled: ${skill.enabled}`);
    }

    case 'list_skills': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      // If workspace specified, list its skills
      if (wsId) {
        const qp = new URLSearchParams();
        if (typeof params.enabled === 'boolean') qp.set('enabled', String(params.enabled));
        if (typeof params.isRole === 'boolean') qp.set('isRole', String(params.isRole));
        const qs = qp.toString() ? `?${qp.toString()}` : '';

        const data = await api(`/api/workspaces/${wsId}/skills${qs}`);
        const skills = data.skills || [];
        if (skills.length === 0) return text('No skills found.');

        const summary = skills.map((s: any) => {
          const mcpCount = s.mcpServers
            ? (Array.isArray(s.mcpServers) ? s.mcpServers.length : Object.keys(s.mcpServers).length)
            : 0;
          const tags = [
            s.isRole ? 'role' : 'skill',
            s.enabled ? '' : 'DISABLED',
            s.model !== 'inherit' ? s.model : '',
            mcpCount > 0 ? `${mcpCount} MCP(s)` : '',
          ].filter(Boolean).join(', ');
          return `- **${s.name}** (\`${s.slug}\`) [${tags}]${s.description ? `\n  ${s.description}` : ''}`;
        }).join('\n');

        return text(`${skills.length} skill(s):\n\n${summary}`);
      }

      // No workspace — list across all accessible workspaces
      const wsData = await api('/api/workspaces');
      const workspaces = wsData.workspaces || [];
      if (workspaces.length === 0) return text('No workspaces found.');

      const allSkills: { workspace: string; skill: any }[] = [];
      for (const ws of workspaces) {
        const qp = new URLSearchParams();
        if (typeof params.enabled === 'boolean') qp.set('enabled', String(params.enabled));
        if (typeof params.isRole === 'boolean') qp.set('isRole', String(params.isRole));
        const qs = qp.toString() ? `?${qp.toString()}` : '';
        const data = await api(`/api/workspaces/${ws.id}/skills${qs}`);
        for (const s of (data.skills || [])) {
          allSkills.push({ workspace: ws.name, skill: s });
        }
      }

      if (allSkills.length === 0) return text('No skills found across any workspace.');

      const summary = allSkills.map(({ workspace, skill: s }) => {
        const mcpCount = s.mcpServers
          ? (Array.isArray(s.mcpServers) ? s.mcpServers.length : Object.keys(s.mcpServers).length)
          : 0;
        const tags = [
          s.isRole ? 'role' : 'skill',
          s.enabled ? '' : 'DISABLED',
          s.model !== 'inherit' ? s.model : '',
          mcpCount > 0 ? `${mcpCount} MCP(s)` : '',
        ].filter(Boolean).join(', ');
        return `- **${s.name}** (\`${s.slug}\`) [${tags}] — ${workspace}${s.description ? `\n  ${s.description}` : ''}`;
      }).join('\n');

      return text(`${allSkills.length} skill(s) across ${workspaces.length} workspace(s):\n\n${summary}`);
    }

    case 'get_skill': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.slug) throw new Error('slug is required to identify the skill to fetch');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const skillId = await resolveSkillId(api, wsId, params.slug as string);
      const data = await api(`/api/workspaces/${wsId}/skills/${skillId}`);
      const s = data.skill;
      if (!s) throw new Error(`Skill with slug "${params.slug}" not found`);

      const payload = {
        slug: s.slug,
        name: s.name,
        description: s.description ?? null,
        content: s.content ?? '',
        model: s.model,
        allowedTools: s.allowedTools ?? [],
        canDelegateTo: s.canDelegateTo ?? [],
        background: s.background ?? false,
        maxTurns: s.maxTurns ?? null,
        color: s.color ?? null,
        mcpServers: s.mcpServers ?? {},
        requiredEnvVars: s.requiredEnvVars ?? {},
        connectorRefs: s.connectorRefs ?? [],
        isRole: s.isRole ?? false,
        enabled: s.enabled,
        repoUrl: s.repoUrl ?? null,
        source: s.source ?? null,
      };

      return text(JSON.stringify(payload, null, 2));
    }

    case 'update_skill': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.slug) throw new Error('slug is required to identify the skill to update');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const skillId = await resolveSkillId(api, wsId, params.slug as string);
      const body = buildSkillBody(params);

      if (Object.keys(body).length === 0) {
        throw new Error('No fields to update. Provide at least one field (name, content, mcpServers, etc.)');
      }

      const data = await api(`/api/workspaces/${wsId}/skills/${skillId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      const s = data.skill;
      const mcpCount = s.mcpServers
        ? (Array.isArray(s.mcpServers) ? s.mcpServers.length : Object.keys(s.mcpServers).length)
        : 0;
      return text(`Skill updated: "${s.name}" (slug: ${s.slug})\nModel: ${s.model} | Tools: ${(s.allowedTools || []).length || 'all'} | MCPs: ${mcpCount} | Delegates to: ${(s.canDelegateTo || []).join(', ') || 'none'}\nEnabled: ${s.enabled}`);
    }

    case 'delete_skill': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.slug) throw new Error('slug is required to identify the skill to delete');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      const skillId = await resolveSkillId(api, wsId, params.slug as string);

      await api(`/api/workspaces/${wsId}/skills/${skillId}`, {
        method: 'DELETE',
      });

      return text(`Skill "${params.slug}" deleted successfully.`);
    }

    case 'manage_secrets': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const subAction = params.action as string;
      if (!subAction || !['list', 'set', 'delete'].includes(subAction)) {
        throw new Error('action is required: "list", "set", or "delete"');
      }

      if (subAction === 'list') {
        const data = await api('/api/secrets');
        const secrets = data.secrets || [];
        if (secrets.length === 0) return text('No secrets found.');

        const summary = secrets.map((s: any) =>
          `- **${s.label || s.purpose}** (${s.purpose})\n  ID: ${s.id} | Created: ${s.createdAt}`
        ).join('\n');
        return text(`${secrets.length} secret(s):\n\n${summary}`);
      }

      if (subAction === 'set') {
        if (!params.label) throw new Error('label is required (env var name, e.g. "buildd-api-key")');
        if (!params.value) throw new Error('value is required (the secret value)');

        const data = await api('/api/secrets', {
          method: 'POST',
          body: JSON.stringify({
            value: params.value,
            purpose: params.purpose || 'mcp_credential',
            label: params.label,
          }),
        });

        return text(`Secret stored: label="${params.label}" | ID: ${data.id}`);
      }

      if (subAction === 'delete') {
        if (!params.secretId) throw new Error('secretId is required');

        await api(`/api/secrets?id=${params.secretId}`, {
          method: 'DELETE',
        });

        return text(`Secret ${params.secretId} deleted.`);
      }

      return text('Unknown action');
    }

    case 'post_note': {
      if (!params.type || !params.title) throw new Error('type and title are required');

      const validNoteTypes = ['decision', 'question', 'warning', 'suggestion', 'update'];
      if (!validNoteTypes.includes(params.type as string)) {
        throw new Error(`Invalid type. Must be one of: ${validNoteTypes.join(', ')}`);
      }

      // Resolve missionId from task context if not provided
      let missionId = params.missionId as string | undefined;
      if (!missionId) {
        // Get missionId from the current worker's task
        const workerId = resolveWorkerId(params.workerId, ctx);
        const workerData = await api(`/api/workers/${workerId}`);
        if (workerData.task?.missionId) {
          missionId = workerData.task.missionId;
        }
      }
      if (!missionId) throw new Error('Could not resolve missionId — pass it explicitly or ensure this task is linked to a mission');

      const workerId = ctx.workerId || (params.workerId as string) || undefined;

      const noteBody: Record<string, unknown> = {
        type: params.type,
        title: params.title,
        authorType: 'agent',
        taskId: undefined as string | undefined,
        workerId,
        status: params.type === 'question' ? 'open' : 'answered',
      };
      if (params.body) noteBody.bodyText = params.body;
      if (params.defaultChoice) noteBody.defaultChoice = params.defaultChoice;

      // Resolve taskId from worker context
      if (workerId) {
        try {
          const workerData = await api(`/api/workers/${workerId}`);
          if (workerData.taskId) noteBody.taskId = workerData.taskId;
        } catch { /* ignore — taskId is optional */ }
      }

      const note = await api(`/api/missions/${missionId}/notes`, {
        method: 'POST',
        body: JSON.stringify(noteBody),
      });

      return text(`Note posted: "${params.title}" (${params.type})${params.type === 'question' ? `\nDefault choice: ${params.defaultChoice || 'none'}\nUser reply will be delivered on your next update_progress call.` : ''}`);
    }

    case 'create_artifact': {
      if (!params.type || !params.title) throw new Error('type and title are required');

      const validArtifactTypes = ['content', 'report', 'data', 'link', 'summary', 'email_draft', 'social_post', 'analysis', 'recommendation', 'alert', 'calendar_event', 'file'];
      if (!validArtifactTypes.includes(params.type as string)) {
        throw new Error(`Invalid type. Must be one of: ${validArtifactTypes.join(', ')}`);
      }

      const artifactBody: Record<string, unknown> = {
        type: params.type,
        title: params.title,
      };
      if (params.content) artifactBody.content = params.content;
      if (params.url) artifactBody.url = params.url;
      if (params.metadata && typeof params.metadata === 'object') artifactBody.metadata = params.metadata;
      if (params.key) artifactBody.key = params.key;

      // Support mission-level artifacts (no worker required) or worker artifacts
      let artifactData;
      if (params.missionId) {
        artifactData = await api(`/api/missions/${params.missionId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify(artifactBody),
        });
      } else {
        const workerId = resolveWorkerId(params.workerId, ctx);
        artifactData = await api(`/api/workers/${workerId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify(artifactBody),
        });
      }

      const art = artifactData.artifact;
      const upserted = artifactData.upserted ? ' (updated existing)' : '';

      // Mirror the artifact into the KnowledgeStore (best-effort).
      await mirrorWorkProduct(ctx, 'artifact', buildArtifactCard({
        artifactId: art.id,
        title: art.title,
        artifactType: art.type ?? (params.type as string),
        content: (params.content as string) ?? art.content ?? null,
        url: (params.url as string) ?? art.url ?? null,
        shareUrl: art.shareUrl ?? null,
        taskId: art.taskId ?? null,
        missionId: (params.missionId as string) ?? art.missionId ?? null,
      }));

      return text(`Artifact created${upserted}: "${art.title}" (${art.type})\nID: ${art.id}\nShare URL: ${art.shareUrl}`);
    }

    case 'upload_artifact': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      if (!params.filename || !params.mimeType || !params.sizeBytes) {
        throw new Error('filename, mimeType, and sizeBytes are required');
      }

      const uploadBody: Record<string, unknown> = {
        workerId,
        filename: params.filename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
      };
      if (params.title) uploadBody.title = params.title;
      if (params.type) uploadBody.type = params.type;
      if (params.metadata && typeof params.metadata === 'object') uploadBody.metadata = params.metadata;

      const data = await api('/api/artifacts/upload-url', {
        method: 'POST',
        body: JSON.stringify(uploadBody),
      });

      const mimeStr = params.mimeType as string;
      const lines = [
        `Upload URL ready (expires in 10 minutes).`,
        ``,
        `Upload the file:`,
        `curl -X PUT -H "Content-Type: ${mimeStr}" --data-binary @./${params.filename} "${data.uploadUrl}"`,
        ``,
        `Download URL (permanent, for markdown embedding):`,
        data.downloadUrl,
        ``,
        `Share URL: ${data.shareUrl}`,
        `Artifact ID: ${data.artifactId}`,
      ];

      if (mimeStr.startsWith('image/')) {
        lines.push(``, `Markdown image: ![${params.title || params.filename}](${data.downloadUrl})`);
      }

      return text(lines.join('\n'));
    }

    case 'list_artifacts': {
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      const searchParams = new URLSearchParams();
      if (params.missionId) searchParams.set('missionId', params.missionId as string);
      if (params.key) searchParams.set('key', params.key as string);
      if (params.type) searchParams.set('type', params.type as string);
      if (params.limit) searchParams.set('limit', String(params.limit));

      const formatArtifact = (a: any, workspace?: string) => {
        const preview = a.content && a.content.length > 200 ? a.content.slice(0, 200) + '...' : a.content;
        return `- **${a.title}** (${a.type}${a.key ? `, key: ${a.key}` : ''})${workspace ? ` [${workspace}]` : ''}\n  ID: ${a.id}\n  Updated: ${a.updatedAt}\n  Share: ${a.shareUrl || 'N/A'}${preview ? `\n  Preview: ${preview}` : ''}`;
      };

      if (wsId) {
        const data = await api(`/api/workspaces/${wsId}/artifacts?${searchParams}`);
        const artifactsList = data.artifacts || [];

        if (artifactsList.length === 0) {
          return text(`No artifacts found${params.key ? ` with key "${params.key}"` : ''}.`);
        }

        const summary = artifactsList.map((a: any) => formatArtifact(a)).join('\n\n');
        return text(`${artifactsList.length} artifact(s):\n\n${summary}`);
      }

      // No workspace — aggregate across all
      const wsData = await api('/api/workspaces');
      const workspaces = wsData.workspaces || [];
      if (workspaces.length === 0) return text('No workspaces found.');

      const allArtifacts: { workspace: string; artifact: any }[] = [];
      for (const ws of workspaces) {
        const data = await api(`/api/workspaces/${ws.id}/artifacts?${searchParams}`);
        for (const a of (data.artifacts || [])) {
          allArtifacts.push({ workspace: ws.name, artifact: a });
        }
      }

      if (allArtifacts.length === 0) {
        return text(`No artifacts found${params.key ? ` with key "${params.key}"` : ''}.`);
      }

      const summary = allArtifacts.map(({ workspace, artifact: a }) => formatArtifact(a, workspace)).join('\n\n');
      return text(`${allArtifacts.length} artifact(s) across ${workspaces.length} workspace(s):\n\n${summary}`);
    }

    case 'get_artifact': {
      if (!params.artifactId) throw new Error('artifactId is required');

      const data = await api(`/api/artifacts/${params.artifactId}`);
      const art = data.artifact;

      const meta = [
        `**Title:** ${art.title || '(untitled)'}`,
        `**Type:** ${art.type}`,
        `**ID:** ${art.id}`,
        art.key && `**Key:** ${art.key}`,
        `**Created:** ${art.createdAt}`,
        `**Updated:** ${art.updatedAt}`,
        art.shareUrl && `**Share URL:** ${art.shareUrl}`,
        art.metadata && Object.keys(art.metadata).length > 0 && `**Metadata:** ${JSON.stringify(art.metadata)}`,
      ].filter(Boolean).join('\n');

      const content = art.content || '(no content)';

      return text(`${meta}\n\n## Content\n\n${content}`);
    }

    case 'update_artifact': {
      if (!params.artifactId) throw new Error('artifactId is required');

      const updateBody: Record<string, unknown> = {};
      if (params.title !== undefined) updateBody.title = params.title;
      if (params.content !== undefined) updateBody.content = params.content;
      if (params.metadata !== undefined) updateBody.metadata = params.metadata;

      if (Object.keys(updateBody).length === 0) {
        throw new Error('At least one field (title, content, metadata) must be provided');
      }

      const updated = await api(`/api/artifacts/${params.artifactId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateBody),
      });

      const updatedArt = updated.artifact;
      return text(`Artifact updated: "${updatedArt.title}" (${updatedArt.type})\nID: ${updatedArt.id}\nShare URL: ${updatedArt.shareUrl || 'N/A'}`);
    }

    case 'list_artifact_templates': {
      const { artifactTemplates } = await import('./artifact-templates');
      const templateList = Object.entries(artifactTemplates).map(([name, tmpl]) =>
        `## ${name}\n**Type:** ${tmpl.type}\n**Description:** ${tmpl.description}\n**Schema:**\n\`\`\`json\n${JSON.stringify(tmpl.schema, null, 2)}\n\`\`\``
      ).join('\n\n---\n\n');
      return text(`Available artifact templates:\n\n${templateList}\n\nUse create_artifact with matching type and structured content following the schema.`);
    }

    // ── Observability (Phase 5) ────────────────────────────────────────────

    case 'emit_event': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      if (!params.type) throw new Error('type is required');
      if (!params.label) throw new Error('label is required');

      await api(`/api/workers/${workerId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          appendMilestones: [{
            type: params.type,
            label: params.label,
            ts: Date.now(),
            ...(params.metadata && typeof params.metadata === 'object' ? { metadata: params.metadata } : {}),
          }],
        }),
      });

      return text(`Event emitted: [${params.type}] ${params.label}`);
    }

    case 'query_events': {
      const workerId = resolveWorkerId(params.workerId, ctx);

      const data = await api(`/api/workers/${workerId}`);
      const milestones = data.milestones || [];

      let filtered = milestones;
      if (params.type) {
        filtered = milestones.filter((m: any) => m.type === params.type);
      }

      if (filtered.length === 0) {
        return text(`No events found${params.type ? ` of type "${params.type}"` : ''}.`);
      }

      const summary = filtered.map((m: any) =>
        `- [${m.type}] ${m.label} (${new Date(m.ts).toISOString()})${m.metadata ? ` — ${JSON.stringify(m.metadata)}` : ''}`
      ).join('\n');

      return text(`${filtered.length} event(s):\n\n${summary}`);
    }

    case 'get_error_traces': {
      // Three resolution modes, in priority:
      //   1. explicit workerId in params
      //   2. explicit taskId in params (returns cumulative traces across all
      //      workers that ran on this task — useful when retrying)
      //   3. infer from ctx.workerId (default: this agent's session)
      const limitNum = typeof params.limit === 'number'
        ? Math.min(Math.max(params.limit, 1), 500)
        : 50;
      const limitQs = `limit=${limitNum}`;
      const sinceQs = params.since && typeof params.since === 'string'
        ? `&since=${encodeURIComponent(params.since)}`
        : '';

      let endpoint: string;
      let scope: string;
      if (params.workerId && typeof params.workerId === 'string') {
        endpoint = `/api/workers/${encodeURIComponent(params.workerId)}/error-traces?${limitQs}${sinceQs}`;
        scope = `worker ${params.workerId}`;
      } else if (params.taskId && typeof params.taskId === 'string') {
        endpoint = `/api/tasks/${encodeURIComponent(params.taskId)}/error-traces?${limitQs}${sinceQs}`;
        scope = `task ${params.taskId}`;
      } else if (ctx.workerId) {
        // Default: traces for this agent's task (cumulative across retries)
        const workerData = await api(`/api/workers/${ctx.workerId}`);
        const taskId = workerData?.taskId;
        if (!taskId) {
          return errorResult('Could not determine taskId from context. Pass workerId or taskId explicitly.');
        }
        endpoint = `/api/tasks/${encodeURIComponent(taskId)}/error-traces?${limitQs}${sinceQs}`;
        scope = `task ${taskId} (current)`;
      } else {
        return errorResult('No workerId, taskId, or worker context provided.');
      }

      const data = await api(endpoint);
      const traces = (data.traces || []) as Array<{ pattern: string; excerpt: string; source: string | null; ts: string }>;

      if (traces.length === 0) {
        return text(`No error traces for ${scope}.`);
      }

      const summary = traces.map((t) => {
        const src = t.source ? ` [${t.source}]` : '';
        return `- **${t.pattern}**${src} at ${t.ts}\n  ${t.excerpt}`;
      }).join('\n');

      return text(`${traces.length} error trace(s) for ${scope}:\n\n${summary}`);
    }

    case 'suggest_schedule_update': {
      if (!params.reason) throw new Error('reason is required');
      if (params.cronExpression === undefined && params.enabled === undefined) {
        throw new Error('At least one of cronExpression or enabled must be provided');
      }

      // Resolve scheduleId from params or from worker's task context
      let scheduleId = params.scheduleId as string | undefined;
      let wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      if (!scheduleId && ctx.workerId) {
        const workerData = await api(`/api/workers/${ctx.workerId}`);
        const taskContext = workerData?.task?.context || workerData?.context || {};
        scheduleId = taskContext.scheduleId;
        if (!wsId) wsId = workerData?.workspaceId || workerData?.task?.workspaceId;
      }

      if (!scheduleId) throw new Error('scheduleId is required — pass it explicitly or run from a scheduled task');
      if (!wsId) throw new Error('Could not determine workspace.');

      const suggestionBody: Record<string, unknown> = {
        reason: params.reason,
      };
      if (params.cronExpression !== undefined) suggestionBody.cronExpression = params.cronExpression;
      if (params.enabled !== undefined) suggestionBody.enabled = params.enabled;
      if (ctx.workerId) suggestionBody.workerId = ctx.workerId;

      // Get taskId from worker context
      if (ctx.workerId) {
        try {
          const workerData = await api(`/api/workers/${ctx.workerId}`);
          if (workerData?.taskId) suggestionBody.taskId = workerData.taskId;
        } catch {
          // non-critical
        }
      }

      const result = await api(`/api/workspaces/${wsId}/schedules/${scheduleId}/suggestion`, {
        method: 'POST',
        body: JSON.stringify(suggestionBody),
      });

      const changes: string[] = [];
      if (params.cronExpression) changes.push(`cron → "${params.cronExpression}"`);
      if (params.enabled !== undefined) changes.push(`enabled → ${params.enabled}`);

      return text(`Schedule suggestion created for schedule ${scheduleId}.\nProposed changes: ${changes.join(', ')}\nReason: ${params.reason}\n\nThe suggestion is now pending human approval in the dashboard.`);
    }

    case 'approve_plan': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.taskId) throw new Error('taskId is required');

      const data = await api(`/api/tasks/${params.taskId}/approve-plan`, {
        method: 'POST',
      });

      const taskIds = data.tasks || [];

      // Mirror the approved plan into the KnowledgeStore (best-effort).
      // Only fetch the plan detail when there's actually a store to index into.
      if (ctx.knowledgeStore) {
        try {
          const taskData = await api(`/api/tasks/${params.taskId}`);
          const planText = renderPlanText(taskData?.result?.structuredOutput?.plan);
          if (planText) {
            await mirrorWorkProduct(ctx, 'plan', buildPlanCard({
              taskId: params.taskId as string,
              title: taskData?.title ?? null,
              plan: planText,
              missionId: taskData?.missionId ?? null,
            }));
          }
        } catch { /* non-fatal */ }
      }

      return text(`Plan approved! Created ${taskIds.length} child task(s):\n${taskIds.map((id: string) => `- ${id}`).join('\n')}`);
    }

    case 'reject_plan': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.taskId) throw new Error('taskId is required');
      if (!params.feedback) throw new Error('feedback is required');

      const data = await api(`/api/tasks/${params.taskId}/reject-plan`, {
        method: 'POST',
        body: JSON.stringify({ feedback: params.feedback }),
      });

      return text(`Plan rejected. Revised planning task created: ${data.taskId}`);
    }

    case 'manage_missions': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const missionAction = params.action as string;
      if (!missionAction) throw new Error('action is required (list, create, get, update, delete, link_task, unlink_task)');

      switch (missionAction) {
        case 'list': {
          const qs = new URLSearchParams();
          if (params.workspaceId) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (wsId) qs.set('workspaceId', wsId);
          }
          if (params.status) qs.set('status', params.status as string);
          const data = await api(`/api/missions?${qs}`);
          const missions = data.missions || [];
          if (missions.length === 0) return text('No missions found.');
          const summary = missions.map((m: any) =>
            `- **${m.title}** [${m.status}] — ${m.progress}% (${m.completedTasks}/${m.totalTasks} tasks)\n  ID: ${m.id}${m.workspace ? `\n  Workspace: ${m.workspace.name}` : ''}`
          ).join('\n\n');
          return text(`${missions.length} mission(s):\n\n${summary}`);
        }
        case 'create': {
          if (!params.title) throw new Error('title is required');
          const body: Record<string, unknown> = { title: params.title };
          if (params.description) body.description = params.description;
          if (params.workspaceId) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (!wsId) throw new Error(`Workspace not found: ${params.workspaceId}`);
            body.workspaceId = wsId;
          }
          if (params.cronExpression) body.cronExpression = params.cronExpression;
          if (params.priority !== undefined) body.priority = normalizePriority(params.priority);
          if (params.skillSlugs) body.skillSlugs = params.skillSlugs;
          if (params.model) body.model = params.model;
          if (params.status !== undefined) body.status = params.status;
          if (params.isHeartbeat !== undefined) body.isHeartbeat = params.isHeartbeat;
          if (params.heartbeatChecklist) body.heartbeatChecklist = params.heartbeatChecklist;
          if (params.activeHoursStart !== undefined) body.activeHoursStart = params.activeHoursStart;
          if (params.activeHoursEnd !== undefined) body.activeHoursEnd = params.activeHoursEnd;
          if (params.activeHoursTimezone) body.activeHoursTimezone = params.activeHoursTimezone;
          if (params.maxConcurrentTasks !== undefined) body.maxConcurrentTasks = params.maxConcurrentTasks;
          if (params.dependsOnMission !== undefined) body.dependsOnMission = params.dependsOnMission;
          if (params.gateCondition !== undefined) body.gateCondition = params.gateCondition;
          if (params.orchestrationMode !== undefined) body.orchestrationMode = params.orchestrationMode;
          const data = await api('/api/missions', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          const modeInfo = data.orchestrationMode === 'manual'
            ? 'Orchestration: manual (orchestrator idle — use "Run now" or set orchestrationMode=auto to arm)'
            : data.heartbeatInfo
              ? `Orchestration: auto — ${data.heartbeatInfo}`
              : 'Orchestration: auto';
          return text(`Mission created: "${data.title}" (ID: ${data.id})\nStatus: ${data.status}\nPriority: ${data.priority}\n${modeInfo}${data.organizerTask ? `\nOrganizer task: ${data.organizerTask.id}` : ''}`);
        }
        case 'get': {
          if (!params.missionId) throw new Error('missionId is required');
          const data = await api(`/api/missions/${params.missionId}`);
          const taskList = (data.tasks || []).map((t: any) =>
            `  - [${t.status}] ${t.title} (${t.id})`
          ).join('\n');
          const schedCtx = data.schedule?.taskTemplate?.context;
          const heartbeatRunning = schedCtx?.heartbeat && data.schedule?.enabled !== false && data.status !== 'paused';
          const isManual = data.orchestrationMode === 'manual';
          const modeInfo = isManual
            ? '\nOrchestration: manual — orchestrator idle (use Run now or set orchestrationMode=auto to arm)'
            : schedCtx?.heartbeat
              ? `\nOrchestration: auto\nHeartbeat: ${heartbeatRunning ? 'enabled' : 'paused'}${schedCtx.activeHoursStart != null && schedCtx.activeHoursEnd != null ? ` (active ${schedCtx.activeHoursStart}:00-${schedCtx.activeHoursEnd}:00${schedCtx.activeHoursTimezone ? ` ${schedCtx.activeHoursTimezone}` : ''})` : ''}${schedCtx.heartbeatChecklist ? `\nChecklist: ${schedCtx.heartbeatChecklist}` : ''}`
              : '\nOrchestration: auto';
          const concurrentInfo = data.maxConcurrentTasks != null ? `\nMax concurrent tasks: ${data.maxConcurrentTasks}` : '';
          const depInfo = data.dependsOnMissionId ? `\nDependency: ${data.dependsOnMissionId} (gate: ${data.gateCondition})${data.blocked ? ` — BLOCKED: ${data.blockedReason}` : ' — unblocked'}` : '';
          return text(`**${data.title}** [${data.status}]${data.blocked ? ' [BLOCKED]' : ''}\nID: ${data.id}\nProgress: ${data.progress}% (${data.completedTasks}/${data.totalTasks})\n${data.description ? `Description: ${data.description}\n` : ''}${modeInfo}${concurrentInfo}${depInfo}${taskList ? `\nLinked tasks:\n${taskList}` : '\nNo linked tasks.'}`);
        }
        case 'update': {
          if (!params.missionId) throw new Error('missionId is required');
          const body: Record<string, unknown> = {};
          if (params.title !== undefined) body.title = params.title;
          if (params.description !== undefined) body.description = params.description;
          if (params.status !== undefined) body.status = params.status;
          if (params.cronExpression !== undefined) body.cronExpression = params.cronExpression;
          if (params.priority !== undefined) body.priority = normalizePriority(params.priority);
          if (params.workspaceId !== undefined) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (!wsId) throw new Error(`Workspace not found: ${params.workspaceId}`);
            body.workspaceId = wsId;
          }
          if (params.skillSlugs !== undefined) body.skillSlugs = params.skillSlugs;
          if (params.model !== undefined) body.model = params.model;
          if (params.isHeartbeat !== undefined) body.isHeartbeat = params.isHeartbeat;
          if (params.heartbeatChecklist !== undefined) body.heartbeatChecklist = params.heartbeatChecklist;
          if (params.activeHoursStart !== undefined) body.activeHoursStart = params.activeHoursStart;
          if (params.activeHoursEnd !== undefined) body.activeHoursEnd = params.activeHoursEnd;
          if (params.activeHoursTimezone !== undefined) body.activeHoursTimezone = params.activeHoursTimezone;
          if (params.maxConcurrentTasks !== undefined) body.maxConcurrentTasks = params.maxConcurrentTasks;
          if (params.dependsOnMission !== undefined) body.dependsOnMission = params.dependsOnMission;
          if (params.gateCondition !== undefined) body.gateCondition = params.gateCondition;
          if (params.orchestrationMode !== undefined) body.orchestrationMode = params.orchestrationMode;
          if (Object.keys(body).length === 0) throw new Error('At least one field to update is required');
          const data = await api(`/api/missions/${params.missionId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          return text(`Mission updated: "${data.title}" [${data.status}] (ID: ${data.id})`);
        }
        case 'delete': {
          if (!params.missionId) throw new Error('missionId is required');
          await api(`/api/missions/${params.missionId}`, { method: 'DELETE' });
          return text(`Mission deleted: ${params.missionId}`);
        }
        case 'link_task': {
          if (!params.missionId || !params.taskId) throw new Error('missionId and taskId are required');
          await api(`/api/tasks/${params.taskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ missionId: params.missionId }),
          });
          return text(`Task ${params.taskId} linked to mission ${params.missionId}`);
        }
        case 'unlink_task': {
          if (!params.taskId) throw new Error('taskId is required');
          await api(`/api/tasks/${params.taskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ missionId: null }),
          });
          return text(`Task ${params.taskId} unlinked from mission`);
        }
        default:
          throw new Error(`Unknown missions action: ${missionAction}. Use one of: list, create, get, update, delete, link_task, unlink_task`);
      }
    }

    // ── Workspaces ─────────────────────────────────────────────────────────

    case 'manage_workspaces': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const wsAction = params.action as string;
      if (!wsAction) throw new Error('action is required (list, create, update, create_repo, init)');

      switch (wsAction) {
        case 'create': {
          if (!params.name && !params.repoUrl) throw new Error('name or repoUrl is required');
          const body: Record<string, unknown> = {};
          if (params.name) body.name = params.name;
          if (params.repoUrl) body.repoUrl = params.repoUrl;
          if (params.defaultBranch) body.defaultBranch = params.defaultBranch;
          if (params.accessMode) body.accessMode = params.accessMode;
          const wsData = await api('/api/workspaces', {
            method: 'POST',
            body: JSON.stringify(body),
          });

          // Auto-migrate calling mission to the new workspace
          const createMissionId = await resolveMissionId(api, params.missionId, ctx);
          let migrated = false;
          if (createMissionId) {
            try {
              await api(`/api/missions/${createMissionId}`, {
                method: 'PATCH',
                body: JSON.stringify({ workspaceId: wsData.id }),
              });
              migrated = true;
            } catch { /* non-fatal */ }
          }
          return text(`Workspace created: "${wsData.name}" (ID: ${wsData.id})${wsData.repo ? `\nRepo: ${wsData.repo}` : ''}${migrated ? `\nMission ${createMissionId} migrated to this workspace.` : ''}`);
        }
        case 'list': {
          const data = await api('/api/workspaces');
          const wsList = data.workspaces || [];
          if (wsList.length === 0) return text('No workspaces found.');
          const summary = wsList.map((ws: any) =>
            `- **${ws.name}**${ws.repo ? ` (${ws.repo})` : ' (no repo)'}\n  ID: ${ws.id}${ws.accessMode ? ` | Access: ${ws.accessMode}` : ''}`
          ).join('\n\n');
          return text(`${wsList.length} workspace(s):\n\n${summary}`);
        }
        case 'update': {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for update');
          const body: Record<string, unknown> = {};
          if (params.name !== undefined) body.name = params.name;
          if (params.repoUrl !== undefined) body.repoUrl = params.repoUrl;
          if (params.defaultBranch !== undefined) body.defaultBranch = params.defaultBranch;
          if (params.accessMode !== undefined) body.accessMode = params.accessMode;
          if (params.releaseConfig !== undefined) body.releaseConfig = params.releaseConfig;

          // Partial gitConfig: accept a gitConfig object and/or the common
          // autoMergePR shortcut. Shallow-merged server-side (PATCH), so other
          // gitConfig fields are preserved.
          const gitConfig: Record<string, unknown> = {
            ...(params.gitConfig && typeof params.gitConfig === 'object' ? params.gitConfig as Record<string, unknown> : {}),
          };
          if (params.autoMergePR !== undefined) gitConfig.autoMergePR = params.autoMergePR;
          if (params.autoMergeMaxLines !== undefined) gitConfig.autoMergeMaxLines = params.autoMergeMaxLines;
          if (params.autoMergeDenyPaths !== undefined) gitConfig.autoMergeDenyPaths = params.autoMergeDenyPaths;
          if (Object.keys(gitConfig).length > 0) body.gitConfig = gitConfig;

          // releaseConfig goes to the config endpoint; everything else to the workspace endpoint
          if (body.releaseConfig !== undefined) {
            await api(`/api/workspaces/${wsId}/config`, {
              method: 'POST',
              body: JSON.stringify({ releaseConfig: body.releaseConfig }),
            });
            delete body.releaseConfig;
          }

          const wsFields = Object.keys(body).filter(k => k !== 'releaseConfig');
          if (wsFields.length > 0) {
            await api(`/api/workspaces/${wsId}`, {
              method: 'PATCH',
              body: JSON.stringify(body),
            });
          }
          return text(`Workspace ${wsId} updated.${body.repoUrl ? ` Repo set to: ${body.repoUrl}` : ''}${body.name ? ` Name set to: ${body.name}` : ''}${params.releaseConfig !== undefined ? ' Release config updated.' : ''}${body.gitConfig ? ` gitConfig merged: ${JSON.stringify(gitConfig)}.` : ''}`);
        }
        case 'create_repo': {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for create_repo');
          if (!params.name) throw new Error('name (repo name) is required for create_repo');
          const repoData = await api(`/api/workspaces/${wsId}/create-repo`, {
            method: 'POST',
            body: JSON.stringify({
              name: params.name,
              org: params.org || undefined,
              private: params.private !== false,
              description: params.description || undefined,
            }),
          });
          if (repoData.error) {
            return errorResult(`Failed to create repo: ${repoData.error}${repoData.hint ? `\nHint: ${repoData.hint}` : ''}`);
          }

          // Auto-migrate calling mission to this workspace
          const repoMissionId = await resolveMissionId(api, params.missionId, ctx);
          let repoMigrated = false;
          if (repoMissionId) {
            try {
              await api(`/api/missions/${repoMissionId}`, {
                method: 'PATCH',
                body: JSON.stringify({ workspaceId: wsId }),
              });
              repoMigrated = true;
            } catch { /* non-fatal */ }
          }
          return text(`Repository created: ${repoData.repoUrl}\nWorkspace updated with new repo URL.${repoMigrated ? `\nMission ${repoMissionId} migrated to this workspace.` : ''}`);
        }
        case 'init': {
          // init is a runner-side action — return instructions for the agent
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for init');
          return text(`Workspace ${wsId} directory will be auto-created by the runner when a task is claimed. No-repo workspaces are resolved to a persistent project directory on the runner (e.g. /home/coder/project/{workspace-name}/). To set up the project:\n1. The runner creates the directory automatically\n2. Run \`git init\` in the workspace directory\n3. Use manage_workspaces action=create_repo or action=update to link a remote repo`);
        }
        default:
          throw new Error(`Unknown workspaces action: ${wsAction}. Use one of: list, create, update, create_repo, init`);
      }
    }

    case 'manage_watched_projects': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');

      const wpAction = params.action as string;
      if (!wpAction) throw new Error('action is required (list, create, update, delete, run)');

      const fields = ['repo', 'enabled', 'vercelProjectId', 'inFlightWindowMin', 'prodGraceMin', 'roleSlug', 'pushoverApp', 'releasePrFilter', 'notes'] as const;
      const pickFields = (): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        for (const f of fields) if (params[f] !== undefined) out[f] = params[f];
        return out;
      };

      switch (wpAction) {
        case 'list': {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for list');
          const data = await api(`/api/workspaces/${wsId}/watched-projects`);
          const rows = data.watchedProjects || [];
          if (rows.length === 0) return text('No watched projects in this workspace.');
          const summary = rows.map((r: any) =>
            `- **${r.repo}** ${r.enabled ? '(enabled)' : '(disabled)'}\n  ID: ${r.id} | Vercel: ${r.vercelProjectId || '(none)'} | InFlightWindow: ${r.inFlightWindowMin}m | ProdGrace: ${r.prodGraceMin}m | Role: ${r.roleSlug}\n  Last checked: ${r.lastCheckedAt || 'never'}${r.lastError ? `\n  Last error: ${r.lastError}` : ''}`
          ).join('\n\n');
          return text(`${rows.length} watched project(s):\n\n${summary}`);
        }
        case 'create': {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for create');
          if (!params.repo) throw new Error('repo is required (owner/name)');
          const data = await api(`/api/workspaces/${wsId}/watched-projects`, {
            method: 'POST',
            body: JSON.stringify(pickFields()),
          });
          const row = data.watchedProject;
          return text(`Watched project created: ${row.repo} (ID: ${row.id})`);
        }
        case 'update': {
          if (!params.projectId) throw new Error('projectId is required for update');
          const patch = pickFields();
          if (Object.keys(patch).length === 0) throw new Error('At least one field to update is required');
          const data = await api(`/api/watched-projects/${params.projectId}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
          });
          return text(`Watched project ${params.projectId} updated.\nNow: enabled=${data.watchedProject.enabled} | InFlightWindow: ${data.watchedProject.inFlightWindowMin}m | ProdGrace: ${data.watchedProject.prodGraceMin}m`);
        }
        case 'delete': {
          if (!params.projectId) throw new Error('projectId is required for delete');
          await api(`/api/watched-projects/${params.projectId}`, { method: 'DELETE' });
          return text(`Watched project ${params.projectId} deleted.`);
        }
        case 'run': {
          if (!params.projectId) throw new Error('projectId is required for run');
          const data = await api(`/api/watched-projects/${params.projectId}/run`, { method: 'POST' });
          if (!data.ok) return errorResult(`Run failed: ${data.error}`);
          return text(`Watcher ran for ${params.projectId}. Fired ${data.fired} alert(s).`);
        }
        default:
          throw new Error(`Unknown watched_projects action: ${wpAction}. Use one of: list, create, update, delete, run`);
      }
    }

    case 'trigger_release': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.workspaceId && !params.repo) throw new Error('workspaceId or repo is required (owner/name)');

      const body: Record<string, unknown> = {};
      if (params.workspaceId !== undefined) body.workspaceId = params.workspaceId;
      if (params.repo !== undefined) body.repo = params.repo;
      if (params.ref !== undefined) body.ref = params.ref;
      if (params.workflowFile !== undefined) body.workflowFile = params.workflowFile;
      if (params.inputs !== undefined) body.inputs = params.inputs;
      if (params.force !== undefined) body.force = params.force;

      const data = await api('/api/releases/trigger', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!data.ok) {
        return errorResult(`Release trigger failed: ${data.error}`);
      }
      const runLine = data.runUrl
        ? `\nRun: ${data.runUrl} (status: ${data.runStatus ?? 'unknown'}${data.runConclusion ? `, ${data.runConclusion}` : ''})`
        : `\nFollow: ${data.runsUrl}`;
      return text(
        `Release dispatched on ${data.repo} (${data.workflowFile}, ref=${data.ref}).${runLine}\n` +
          `Note: this opens the release PR — it does not deploy. Prod ships when that PR passes CI and merges.`,
      );
    }

    case 'release_status': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('This operation requires an admin-level token');
      if (!params.workspaceId && !params.repo) throw new Error('workspaceId or repo is required (owner/name)');

      const qs = new URLSearchParams();
      if (params.workspaceId) qs.set('workspaceId', String(params.workspaceId));
      if (params.repo) qs.set('repo', String(params.repo));
      if (params.ref) qs.set('ref', String(params.ref));
      if (params.prodBranch) qs.set('prodBranch', String(params.prodBranch));

      const data = await api(`/api/releases/status?${qs.toString()}`);
      if (!data.ok) {
        return errorResult(`Release status failed: ${data.error}`);
      }
      const ci =
        data.ciState === 'failing'
          ? `failing (${(data.failingChecks ?? []).join(', ') || 'unknown checks'})`
          : data.ciState;
      const prLine = data.openReleasePr
        ? `\nOpen release PR: #${data.openReleasePr.number} — ${data.openReleasePr.url}`
        : '\nNo open release PR.';
      const commits = (data.shippableCommits ?? [])
        .slice(0, 15)
        .map((c: { sha: string; message: string }) => `  - ${c.sha} ${c.message}`)
        .join('\n');
      return text(
        `Release preflight for ${data.repo} (${data.ref} → ${data.prodBranch}):\n` +
          `Strategy: ${data.strategy ?? 'unconfigured'} | CI on ${data.ref}: ${ci} | ${data.aheadBy} commit(s) ahead${prLine}` +
          (commits ? `\nWould ship:\n${commits}` : '\nNothing to ship.'),
      );
    }

    // ── Agent-Facing Interactive Actions ─────────────────────────────────────

    case 'get_task': {
      if (!params.taskId) throw new Error('taskId is required');

      const task = await api(`/api/tasks/${params.taskId}`);

      const parts: string[] = [
        `**Task:** ${task.title}`,
        `**ID:** ${task.id}`,
        `**Status:** ${task.status}`,
      ];

      if (task.priority !== undefined) parts.push(`**Priority:** ${task.priority}`);
      if (task.category) parts.push(`**Category:** ${task.category}`);
      if (task.missionId) parts.push(`**Mission:** ${task.missionId}`);

      // Active worker info (populated by enhanced task GET endpoint)
      const worker = task.activeWorker;
      if (worker) {
        parts.push(`\n**Active Worker:** ${worker.id}`);
        parts.push(`**Worker Status:** ${worker.status}`);
        if (worker.currentAction) parts.push(`**Current Action:** ${worker.currentAction}`);
        if (worker.prUrl) parts.push(`**PR URL:** ${worker.prUrl}`);
        if (worker.prNumber) parts.push(`**PR #:** ${worker.prNumber}`);
        if (worker.branch) parts.push(`**Branch:** ${worker.branch}`);
      }

      // Completion result (set when worker completes)
      const result = task.result;
      if (result) {
        parts.push('');
        if (result.summary) parts.push(`**Summary:** ${result.summary}`);
        if (result.prUrl && !worker?.prUrl) parts.push(`**PR URL:** ${result.prUrl}`);
        if (result.prNumber && !worker?.prNumber) parts.push(`**PR #:** ${result.prNumber}`);
        if (result.branch && !worker?.branch) parts.push(`**Branch:** ${result.branch}`);
        if (result.commits) parts.push(`**Commits:** ${result.commits}`);
        if (result.nextSuggestion) parts.push(`**Next Suggestion:** ${result.nextSuggestion}`);
      }

      // Artifact IDs (populated by enhanced task GET endpoint)
      if (Array.isArray(task.artifactIds) && task.artifactIds.length > 0) {
        parts.push(`\n**Artifacts (${task.artifactIds.length}):** ${task.artifactIds.join(', ')}`);
        parts.push('Use get_artifact with any artifact ID to read its content.');
      }

      if (!worker && !result) {
        const hint = task.status === 'pending'
          ? '\nTask is pending — not yet claimed by a worker.'
          : task.status === 'completed'
          ? '\nTask completed but no result snapshot available.'
          : '';
        if (hint) parts.push(hint);
      }

      return text(parts.join('\n'));
    }

    case 'get_task_messages': {
      if (!params.taskId) throw new Error('taskId is required');

      const data = await api(`/api/tasks/${params.taskId}/messages`);
      const messages: Array<{ type: string; message: string; timestamp: number }> = data.messages || [];

      if (messages.length === 0) {
        return text(`No messages for task ${params.taskId}. Messages appear when instructions are sent to or responses received from the running agent.`);
      }

      const lines = messages.map((m) => {
        const when = new Date(m.timestamp).toISOString();
        const label = m.type === 'instruction' ? '→ [human→agent]' : '← [agent→human]';
        return `${when} ${label}\n  ${m.message}`;
      });

      return text(`${messages.length} message(s) for task ${params.taskId}:\n\n${lines.join('\n\n')}`);
    }

    case 'send_agent_message': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('send_agent_message requires an admin-level token');
      if (!params.taskId || !params.message) throw new Error('taskId and message are required');

      // Fetch task with workers so we can find the live worker by worker.status,
      // not task.status. task.status stays 'assigned' the entire time a worker is
      // running — it only transitions to 'completed'/'failed' on terminal status —
      // so checking task.status causes false-negatives for tasks that are actively
      // being worked on.
      const task = await api(`/api/tasks/${params.taskId}?include=workers`);
      const allWorkers: any[] = Array.isArray(task.workers) ? task.workers : [];
      const activeWorker = allWorkers.find(
        (w) => w.status !== 'completed' && w.status !== 'failed',
      );
      const workerId = activeWorker?.id;

      if (!workerId) {
        const hint = allWorkers.length === 0
          ? 'Task is still pending — not yet claimed by a worker.'
          : 'No active worker found for this task (all workers are in a terminal state).';
        throw new Error(`Cannot send message: ${hint} (task status: ${task.status})`);
      }

      const result = await api(`/api/workers/${workerId}/instruct`, {
        method: 'POST',
        body: JSON.stringify({
          message: params.message as string,
          ...(params.priority ? { priority: params.priority } : {}),
        }),
      });

      const deliveryNote = params.priority === 'urgent'
        ? 'Message delivered instantly via Pusher.'
        : 'Message queued for delivery on next worker check-in.';

      return text(`Message sent to worker ${workerId}.\n${deliveryNote}\n${result.message || ''}`);
    }

    // Spec-drift compare (admin/dev only). Retrieves evidence from the unified
    // workspace store ({workspaceId}:code + {workspaceId}:spec) for a feature/term,
    // and returns BOTH sides for the CALLER to judge. There is no LLM in core —
    // the judging (implemented / removed / contradicted) is done by the calling agent
    // or interactive session reading the snippets. Scores SURFACE candidates; they do
    // NOT decide drift (a reranker always returns a best match, so a removed feature
    // still scores moderately against its semantic neighbour).
    case 'spec_compare': {
      const level = await ctx.getLevel();
      if (level !== 'admin') throw new Error('spec_compare requires an admin-level token (dev tooling)');

      const feature = (params.feature || params.query) as string | undefined;
      if (!feature) throw new Error('feature (or query) is required');

      const wsId = await ctx.getWorkspaceId();
      if (!wsId) throw new Error('workspaceId is required for spec_compare — connect with ?workspace=<id>');

      const topK = Math.min((params.topK as number) || 5, 20);
      const ks = ctx.knowledgeStore ?? new PgVectorStore(ctx.embedder ?? null);
      const [codeHits, specHits] = await Promise.all([
        ks.query(buildNamespace(wsId, 'code'), { text: feature, mode: 'hybrid', topK }),
        ks.query(buildNamespace(wsId, 'spec'), { text: feature, mode: 'hybrid', topK }),
      ]);

      const fmt = (hits: typeof codeHits) => hits.length
        ? hits.map((r, i) => `${i + 1}. [${r.score.toFixed(3)}] ${r.sourcePath ?? r.sourceType}\n   ${r.content.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')
        : '   (no matches)';

      return text(
        `# spec_compare: "${feature}"\n\n` +
        `## CODE evidence (what is actually implemented)\n${fmt(codeHits)}\n\n` +
        `## SPEC evidence (what the spec/docs claim)\n${fmt(specHits)}\n\n` +
        `## How to judge\n` +
        `Scores SURFACE candidates; they do NOT decide. Read the CODE snippets: do they ` +
        `actually implement "${feature}" (a real table/route/impl), or are they only ` +
        `semantic neighbours? Rule one of: IMPLEMENTED · DOCUMENTED-NOT-BUILT · ` +
        `SHIPPED-NOT-DOCUMENTED · CONTRADICTED. The verdict is yours, not the scores'.`
      );
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ── Memory Action Handler ────────────────────────────────────────────────────

import { MemoryClient } from './memory-client';
import type { KnowledgeStore, Embedder, Corpus, UpsertChunk, UpsertResult, EntityRef, RelationRef, EntityBinding } from './knowledge-store/types';
import { PgVectorStore, buildNamespace } from './knowledge-store/pg-vector-store';
import { findNearDuplicates, findDecayedUnused, archiveChunks } from './knowledge-store/consolidation';
import {
  buildTaskCard,
  buildSessionCard,
  buildPrCard,
  buildArtifactCard,
  buildPlanCard,
  renderPlanText,
} from './knowledge-store/cards';

/**
 * Resolve the KnowledgeStore namespace for a corpus.
 *
 * Canonical namespace scheme:
 *
 *   corpus=memory   → {teamId}:memory
 *     Memory is a team-level resource (shared across all workspaces in a team).
 *     teamId and workspaceId are DIFFERENT UUIDs — this is by design. If you see
 *     `d2cb1c29:memory` for memory but `57ffc0e4:task` for tasks, that's correct:
 *     d2cb1c29 is the teamId; 57ffc0e4 is the workspaceId. Reads and writes both
 *     use teamId, so they are consistent.
 *
 *   corpus=code|docs → {workspaceId}:code|docs
 *     Indexed per-workspace by the ingestion pipeline (ingest-knowledge.ts).
 *     Run with WORKSPACE_ID=<id> to populate; empty until ingested.
 *
 *   corpus=task|artifact|pr|plan|session → {workspaceId}:{corpus}
 *     Work-product corpora are workspace-scoped (auto-indexed by mirrorWorkProduct).
 *
 * Returns null when the required id is missing.
 */
function knowledgeNamespace(ctx: { workspaceId?: string; teamId?: string }, corpus: Corpus): string | null {
  if (corpus === 'memory') return ctx.teamId ? buildNamespace(ctx.teamId, 'memory') : null;
  return ctx.workspaceId ? buildNamespace(ctx.workspaceId, corpus) : null;
}

export async function handleMemoryAction(
  memoryClient: MemoryClient,
  action: string,
  params: Record<string, unknown>,
  ctx: {
    project?: string;
    workerId?: string;
    workspaceId?: string;
    teamId?: string;
    knowledgeStore?: KnowledgeStore;
    embedder?: Embedder | null;
  },
): Promise<ToolResult> {
  switch (action) {
    case 'context': {
      const project = (params.project as string) || ctx.project;
      const data = await memoryClient.getContext(project);
      return text(data.markdown || '(No memories yet)');
    }

    case 'search': {
      const data = await memoryClient.search({
        query: params.query as string | undefined,
        type: params.type as string | undefined,
        project: (params.project as string) || ctx.project,
        files: params.files as string[] | undefined,
        limit: Math.min((params.limit as number) || 10, 50),
        offset: params.offset as number | undefined,
      });

      if (!data.results || data.results.length === 0) {
        return text(`No memories found${params.query ? ` matching "${params.query}"` : ''}. Use buildd_memory action=save to record memories.`);
      }

      // Fetch full content
      const ids = data.results.map(r => r.id);
      let fetched: any[] = [];
      try {
        const batchData = await memoryClient.batch(ids);
        fetched = batchData.memories || [];
      } catch {
        fetched = [];
      }

      if (fetched.length > 0) {
        const details = fetched.map((m: any) =>
          `## ${m.type}: ${m.title}\n**ID:** ${m.id}\n**Files:** ${m.files?.join(', ') || 'none'}\n**Tags:** ${m.tags?.join(', ') || 'none'}\n\n${m.content}`
        ).join('\n\n---\n\n');

        return text(`Found ${data.total} memory(s)${data.total > fetched.length ? ` (showing ${fetched.length})` : ''}:\n\n${details}`);
      }

      // Fallback: summary only
      const summary = data.results.map((m: any) =>
        `- **${m.type}**: ${m.title}\n  ID: ${m.id}\n  Files: ${m.files?.slice(0, 3).join(', ') || 'none'}`
      ).join('\n\n');

      return text(`Found ${data.total} memory(s)${data.total > data.results.length ? ` (showing ${data.results.length})` : ''}:\n\n${summary}`);
    }

    case 'save': {
      if (!params.type || !params.title || !params.content) throw new Error('type, title, and content are required');

      const validTypes = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'];
      if (!validTypes.includes(params.type as string)) {
        throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
      }

      const saveSupersedes = parseSupersedesParam(params.supersedes);
      if (saveSupersedes.error) throw new Error(saveSupersedes.error);

      const data = await memoryClient.save({
        type: params.type as string,
        title: params.title as string,
        content: params.content as string,
        project: (params.project as string) || ctx.project || undefined,
        tags: params.tags as string[] | undefined,
        files: params.files as string[] | undefined,
        source: (params.source as string) || (ctx.workerId ? `worker:${ctx.workerId}` : 'mcp-agent'),
      });

      // Mirror into KnowledgeStore for hybrid retrieval (team-scoped — memories
      // belong to a team, not a workspace).
      let memEntityBinding: EntityBinding | null = null;
      let memSuperseded = 0;
      if (ctx.teamId && ctx.knowledgeStore) {
        const ns = buildNamespace(ctx.teamId, 'memory');
        const m = data.memory;
        const lexicalText = `${m.title}\n\n${m.content}`;
        // Best-effort — don't fail the memory save if indexing fails
        const upsertRes = await ctx.knowledgeStore.upsert(ns, [{
          id: m.id,
          content: m.content,
          lexicalText,
          sourceType: 'memory',
          sourceUrl: `/app/memory/${m.id}`,
          metadata: { memoryId: m.id, type: m.type, tags: m.tags, files: m.files, project: m.project },
          // Explicit supersession: memory ids ARE the chunk source_ids in {teamId}:memory.
          ...(saveSupersedes.ids && saveSupersedes.ids.length > 0 ? { supersedes: saveSupersedes.ids } : {}),
        }]).catch(() => undefined);
        if (upsertRes) memSuperseded = upsertRes.superseded;

        // Layer 2: bind entity refs (team-scoped; workspace_id = teamId for memories)
        memEntityBinding = await processEntityRefs(
          ctx.teamId, m.id, ns,
          `${m.title}\n\n${m.content}`, 'memory', null,
          { memoryId: m.id, type: m.type, tags: m.tags, files: m.files },
          params.entities as EntityRef[] | undefined,
          params.relations as RelationRef[] | undefined,
          ctx.knowledgeStore,
          null,
        );
      }

      const bindingStr = memEntityBinding && memEntityBinding.bound > 0
        ? ` | ${memEntityBinding.bound} entities bound${memEntityBinding.ambiguous.length > 0 ? `, ${memEntityBinding.ambiguous.length} ambiguous` : ''}`
        : '';
      const saveSupersededStr = saveSupersedes.ids !== undefined ? ` | superseded: ${memSuperseded}` : '';
      return text(`Memory saved: "${data.memory.title}" (${data.memory.type})\nID: ${data.memory.id}${bindingStr}${saveSupersededStr}`);
    }

    case 'get': {
      if (!params.id) throw new Error('id is required');
      const data = await memoryClient.get(params.id as string);
      const m = data.memory;
      const meta = [
        `Type: ${m.type}`,
        m.project && `Project: ${m.project}`,
        m.tags?.length && `Tags: ${m.tags.join(', ')}`,
        m.files?.length && `Files: ${m.files.join(', ')}`,
        m.source && `Source: ${m.source}`,
      ].filter(Boolean).join('\n');
      return text(`# ${m.title}\n\n${meta}\n\n${m.content}`);
    }

    case 'update': {
      if (!params.id) throw new Error('id is required');

      const updateFields: Record<string, unknown> = {};
      if (params.title !== undefined) updateFields.title = params.title;
      if (params.content !== undefined) updateFields.content = params.content;
      if (params.type !== undefined) updateFields.type = params.type;
      if (params.files !== undefined) updateFields.files = params.files;
      if (params.tags !== undefined) updateFields.tags = params.tags;
      if (params.project !== undefined) updateFields.project = params.project;

      if (Object.keys(updateFields).length === 0) {
        throw new Error('At least one field (title, content, type, files, tags, project) must be provided');
      }

      const updateSupersedes = parseSupersedesParam(params.supersedes);
      if (updateSupersedes.error) throw new Error(updateSupersedes.error);

      const data = await memoryClient.update(params.id as string, updateFields);

      // Mirror update into KnowledgeStore (team-scoped)
      let updateEntityBinding: EntityBinding | null = null;
      let updateSuperseded = 0;
      if (ctx.teamId && ctx.knowledgeStore) {
        const ns = buildNamespace(ctx.teamId, 'memory');
        const m = data.memory;
        const lexicalText = `${m.title}\n\n${m.content}`;
        const upsertRes = await ctx.knowledgeStore.upsert(ns, [{
          id: m.id,
          content: m.content,
          lexicalText,
          sourceType: 'memory',
          sourceUrl: `/app/memory/${m.id}`,
          metadata: { memoryId: m.id, type: m.type, tags: m.tags, files: m.files, project: m.project },
          // Explicit supersession: memory ids ARE the chunk source_ids in {teamId}:memory.
          ...(updateSupersedes.ids && updateSupersedes.ids.length > 0 ? { supersedes: updateSupersedes.ids } : {}),
        }]).catch(() => undefined);
        if (upsertRes) updateSuperseded = upsertRes.superseded;

        // Layer 2: re-bind entity refs on update
        updateEntityBinding = await processEntityRefs(
          ctx.teamId, m.id, ns,
          `${m.title}\n\n${m.content}`, 'memory', null,
          { memoryId: m.id, type: m.type },
          params.entities as EntityRef[] | undefined,
          params.relations as RelationRef[] | undefined,
          ctx.knowledgeStore,
          null,
        );
      }

      const updateBindingStr = updateEntityBinding && updateEntityBinding.bound > 0
        ? ` | ${updateEntityBinding.bound} entities bound`
        : '';
      const updateSupersededStr = updateSupersedes.ids !== undefined ? ` | superseded: ${updateSuperseded}` : '';
      return text(`Memory updated: "${data.memory.title}" (${data.memory.type})\nID: ${data.memory.id}${updateBindingStr}${updateSupersededStr}`);
    }

    case 'delete': {
      if (!params.id) throw new Error('id is required');
      await memoryClient.delete(params.id as string);

      // Remove from KnowledgeStore (team-scoped)
      if (ctx.teamId && ctx.knowledgeStore) {
        const ns = buildNamespace(ctx.teamId, 'memory');
        await ctx.knowledgeStore.delete(ns, [params.id as string]).catch(() => {});
      }

      return text(`Memory deleted: ${params.id}`);
    }

    case 'query_knowledge': {
      if (!params.query) throw new Error('query is required');

      const corpus = ((params.corpus as string) || 'memory') as Corpus;
      const mode = (params.mode as 'hybrid' | 'vector' | 'lexical') || 'hybrid';
      const topK = Math.min((params.topK as number) || 10, 50);

      const ns = knowledgeNamespace(ctx, corpus);

      if (!ns) {
        throw new Error(corpus === 'memory'
          ? 'teamId required for memory query_knowledge'
          : 'workspaceId required for query_knowledge');
      }

      const ks = ctx.knowledgeStore ?? new PgVectorStore(ctx.embedder ?? null);
      const results = await ks.query(ns, {
        text: params.query as string,
        mode,
        topK,
      });

      if (results.length === 0) {
        if (corpus === 'code' || corpus === 'docs') {
          return text(`No ${corpus} index for this workspace (namespace: ${ns}) — run ingestion first: WORKSPACE_ID=${ctx.workspaceId} bun packages/core/scripts/ingest-knowledge.ts <repo-dir>`);
        }
        return text(`No knowledge chunks found for query: "${params.query}" (namespace: ${ns}, mode: ${mode})`);
      }

      const formatted = results.map((r, i) =>
        `### ${i + 1}. ${r.metadata.type ? `[${r.metadata.type}] ` : ''}${r.sourceUrl ? `[source](${r.sourceUrl})` : r.sourceType}\n**Score:** ${r.score.toFixed(4)}\n\n${r.content}`
      ).join('\n\n---\n\n');

      return text(`Found ${results.length} chunk(s) (mode: ${mode}, namespace: ${ns}):\n\n${formatted}`);
    }

    case 'consolidate_knowledge': {
      const validOps = ['find_duplicates', 'find_decayed', 'archive'] as const;
      const op = params.op as (typeof validOps)[number] | undefined;
      if (!op || !validOps.includes(op)) {
        throw new Error(`op is required and must be one of: ${validOps.join(', ')}`);
      }

      if (op === 'archive') {
        const corpus = params.corpus as Corpus | undefined;
        if (!corpus) throw new Error('corpus is required for op=archive');
        const sourceIds = params.sourceIds;
        if (!Array.isArray(sourceIds) || sourceIds.length === 0 || !sourceIds.every(s => typeof s === 'string')) {
          throw new Error('sourceIds (non-empty string[]) is required for op=archive');
        }
        const archiveNs = knowledgeNamespace(ctx, corpus);
        if (!archiveNs) {
          throw new Error(corpus === 'memory' ? 'teamId required to archive memory chunks' : 'workspaceId required to archive chunks');
        }
        const result = await archiveChunks(archiveNs, sourceIds as string[], {
          reason: params.reason as string | undefined,
        });
        const idLines = result.sourceIds.map(id => `- ${id}`).join('\n');
        return text(`Archived ${result.archived} of ${sourceIds.length} chunk(s) in ${archiveNs} (is_current=false — recoverable, nothing deleted).${idLines ? `\n${idLines}` : ''}`);
      }

      // find_duplicates / find_decayed: resolve corpora → namespaces
      // (memory is team-scoped; everything else workspace-scoped).
      const defaultCorpora: Corpus[] = op === 'find_duplicates' ? ['memory', 'task'] : ['task', 'artifact'];
      const corpora = (params.corpora as Corpus[] | undefined) ?? defaultCorpora;
      const namespaces = corpora
        .map(c => knowledgeNamespace(ctx, c))
        .filter((ns): ns is string => ns !== null);
      if (namespaces.length === 0) {
        throw new Error(`No namespace resolvable for corpora [${corpora.join(', ')}] — memory needs teamId, other corpora need workspaceId`);
      }

      if (op === 'find_duplicates') {
        const pairs = await findNearDuplicates(namespaces, {
          threshold: params.threshold as number | undefined,
          limit: params.limit as number | undefined,
        });
        if (pairs.length === 0) {
          return text(`No near-duplicate pairs found (namespaces: ${namespaces.join(', ')}).`);
        }
        const formatted = pairs.map((p, i) =>
          `### ${i + 1}. similarity ${p.similarity.toFixed(3)} (${p.namespace})\n` +
          `- A: ${p.sourceIdA} (hits: ${p.hitCountA}${p.sourceTsA ? `, ts: ${p.sourceTsA.toISOString()}` : ''})\n  > ${p.previewA}\n` +
          `- B: ${p.sourceIdB} (hits: ${p.hitCountB}${p.sourceTsB ? `, ts: ${p.sourceTsB.toISOString()}` : ''})\n  > ${p.previewB}`
        ).join('\n\n');
        return text(`Found ${pairs.length} near-duplicate pair(s). Judge each pair before merging — merge memory survivors via save/update with supersedes; archive task-corpus losers.\n\n${formatted}`);
      }

      // op === 'find_decayed'
      const decayed = await findDecayedUnused(namespaces, {
        halfLifeMultiple: params.halfLifeMultiple as number | undefined,
        limit: params.limit as number | undefined,
      });
      if (decayed.length === 0) {
        return text(`No decayed unused chunks found (namespaces: ${namespaces.join(', ')}).`);
      }
      const decayedLines = decayed.map(d =>
        `- ${d.sourceId} [${d.corpus}]${d.sourceTs ? ` ts: ${d.sourceTs.toISOString()}` : ''} hits: ${d.hitCount}\n  > ${d.preview}`
      ).join('\n');
      return text(`Found ${decayed.length} decayed zero-hit chunk(s). Sanity-check previews, then archive with op=archive (corpus + sourceIds):\n${decayedLines}`);
    }

    default:
      throw new Error(`Unknown memory action: ${action}. Use one of: ${memoryActions.join(', ')}`);
  }
}
