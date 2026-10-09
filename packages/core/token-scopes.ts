import type { BuilddAction } from './mcp-tools';

/** Shared permission vocabulary for REST, MCP and the token editor. */
export const TOKEN_SCOPE_DEFINITIONS = [
  { scope: 'tasks:read', label: 'Read tasks', description: 'Read tasks, artifacts, schedules, skills and workspace knowledge.' },
  { scope: 'tasks:write', label: 'Manage tasks', description: 'Create, edit and cancel tasks; write artifacts and review pull requests.' },
  { scope: 'tasks:admin', label: 'Approve and correct tasks', description: 'Read and manage tasks, approve or reject plans and correct completed task results.' },
  { scope: 'workers:write', label: 'Run workers', description: 'Claim tasks, report progress, complete work and exchange worker messages.' },
  { scope: 'workers:admin', label: 'Steer agents', description: 'Run workers and send administrative instructions to running agents.' },
  { scope: 'missions:admin', label: 'Manage missions', description: 'Create and manage missions, initiatives and spec discrepancies.' },
  { scope: 'analytics:read', label: 'Read analytics', description: 'Read usage, budgets, runner health, failures and delivery analytics.' },
  { scope: 'releases', label: 'Manage releases', description: 'Read release status and trigger releases.' },
  { scope: 'secrets', label: 'Manage secrets', description: 'Read and manage encrypted credentials.' },
  { scope: 'skills:admin', label: 'Manage skills', description: 'Create, edit and delete skills and agent roles.' },
  { scope: 'workspaces:admin', label: 'Manage workspaces', description: 'Create and configure workspaces and watched projects.' },
  { scope: 'schedules:write', label: 'Manage schedules', description: 'Create, edit, pause and delete schedules.' },
  { scope: 'knowledge:write', label: 'Write knowledge', description: 'Create and update workspace memories and ingest knowledge.' },
  { scope: 'knowledge:admin', label: 'Maintain knowledge', description: 'Write and consolidate knowledge and permanently delete memories.' },
  { scope: 'admin', label: 'Full administration', description: 'All capabilities, including token, account and model administration.' },
] as const;
export type TokenScope = (typeof TOKEN_SCOPE_DEFINITIONS)[number]['scope'];
export const TOKEN_SCOPES: TokenScope[] = TOKEN_SCOPE_DEFINITIONS.map(d => d.scope);

export const TOKEN_PRESETS = {
  // Not a host-runner token: host runners also lease model credentials, which
  // needs a runner token from `buildd login`.
  runner: { label: 'Task agent', description: 'Claim tasks and report results over MCP or the API. For a host runner, use `buildd login` instead.', scopes: ['tasks:read', 'tasks:write', 'workers:write', 'analytics:read', 'knowledge:write'] as TokenScope[] },
  ci: { label: 'CI trigger', description: 'Create tasks and publish artifacts from CI.', scopes: ['tasks:read', 'tasks:write'] as TokenScope[] },
  analytics: { label: 'Analytics reader', description: 'Read operational analytics without changing anything.', scopes: ['analytics:read'] as TokenScope[] },
  admin: { label: 'Admin', description: 'Full administration within the selected workspaces.', scopes: ['admin'] as TokenScope[] },
} as const;
export type TokenPreset = keyof typeof TOKEN_PRESETS;

/** Presentation mapping only: legacy tokens retain their exact original level gates. */
export const LEGACY_LEVEL_PRESET = { worker: 'runner', trigger: 'ci', admin: 'admin' } as const satisfies Record<string, TokenPreset>;

/** Scopes only a team owner or admin may put on a token. Every other scope is member-grantable. */
export function requiresTeamAdminToGrant(scope: string): boolean {
  return scope.endsWith(':admin') || ['admin', 'secrets', 'releases', 'schedules:write'].includes(scope);
}

/** The stored level of a scoped token: admin only with the admin scope. */
export function scopedTokenLevel(scopes: readonly string[]): 'admin' | 'worker' {
  return scopes.includes('admin') ? 'admin' : 'worker';
}

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === 'string' && TOKEN_SCOPES.includes(value as TokenScope);
}

/** Missing scopes are legacy tokens: callers must retain their existing level gates. */
export function hasTokenScope(scopes: readonly string[] | null | undefined, required: TokenScope): boolean {
  if (!scopes) return false;
  if (scopes.includes('admin') || scopes.includes(required)) return true;
  if ((required === 'tasks:read' || required === 'tasks:write') && scopes.includes('tasks:admin')) return true;
  if (required === 'workers:write' && scopes.includes('workers:admin')) return true;
  if (required === 'knowledge:write' && scopes.includes('knowledge:admin')) return true;
  return false;
}

/** Restrictions apply independently of scopes, including the admin scope. */
export function tokenWorkspaceAllowed(workspaceIds: readonly string[] | null | undefined, workspaceId: string | null | undefined): boolean {
  return workspaceIds == null || (!!workspaceId && workspaceIds.includes(workspaceId));
}

/** Exhaustive action registry; adding an MCP action requires choosing its capability. */
export const ACTION_TOKEN_SCOPE: Record<BuilddAction, TokenScope> = {
  spec_compare: 'tasks:read', list_discrepancies: 'tasks:read', get_discrepancy: 'tasks:read',
  list_tasks: 'tasks:read', get_task: 'tasks:read', get_task_messages: 'tasks:read',
  create_task: 'tasks:write', update_task: 'tasks:write', correct_task_result: 'tasks:admin', approve_plan: 'tasks:admin', reject_plan: 'tasks:admin',
  claim_task: 'workers:write', update_progress: 'workers:write', receive_messages: 'workers:write', complete_task: 'workers:write', get_page_source: 'workers:write', deploy: 'workers:write',
  create_pr: 'tasks:write', record_pr_supersession: 'workers:write', send_agent_message: 'workers:admin',
  emit_event: 'tasks:write', query_events: 'tasks:read', post_note: 'tasks:write', suggest_schedule_update: 'workers:write',
  list_prs: 'tasks:read', get_pr: 'tasks:read', get_pr_review: 'tasks:read',
  merge_pr: 'tasks:write', close_pr: 'tasks:write', update_pr: 'tasks:write', request_pr_review: 'tasks:write',
  list_artifacts: 'tasks:read', get_artifact: 'tasks:read', list_artifact_templates: 'tasks:read',
  create_artifact: 'tasks:write', upload_artifact: 'tasks:write', update_artifact: 'tasks:write',
  list_schedules: 'tasks:read', trace_schedule: 'tasks:read', create_schedule: 'schedules:write', update_schedule: 'schedules:write', pause_schedules: 'schedules:write', delete_schedule: 'schedules:write',
  explain: 'analytics:read', get_error_traces: 'analytics:read', get_failure_analytics: 'analytics:read', dispatch_health: 'analytics:read', read_evidence: 'analytics:read',
  get_budget_forecast: 'analytics:read', get_usage_stats: 'analytics:read', get_manifest_coverage: 'analytics:read', get_path_claim_stats: 'analytics:read', get_decision_stats: 'analytics:read', list_runners: 'analytics:read', list_connectors: 'analytics:read',
  resolve_capability: 'analytics:read',
  request_capability: 'tasks:write',
  list_releases: 'releases', get_release: 'releases', release_status: 'releases', trigger_release: 'releases',
  manage_missions: 'missions:admin', manage_initiatives: 'missions:admin', link_tracker: 'missions:admin', get_visual_review: 'missions:admin', adjudicate_discrepancy: 'missions:admin', promote_discrepancy: 'missions:admin',
  list_skills: 'tasks:read', get_skill: 'tasks:read', register_skill: 'skills:admin', update_skill: 'skills:admin', delete_skill: 'skills:admin',
  manage_workspaces: 'workspaces:admin', manage_watched_projects: 'workspaces:admin',
  manage_secrets: 'secrets', manage_providers: 'secrets', manage_model_tiers: 'admin', manage_evidence_backends: 'admin', manage_experiments: 'admin',
  consolidate_knowledge: 'knowledge:admin', memory_delete: 'knowledge:admin',
};

export function requiredScopeForAction(action: string, params: Record<string, unknown> = {}): TokenScope | null {
  if (['manage_missions', 'manage_initiatives', 'manage_workspaces'].includes(action) && ['list', 'get', 'get_criteria_state'].includes(String(params.action))) return 'tasks:read';
  // Readiness is a read-only GET of /api/workspaces/[id]/readiness, which the route policy maps to tasks:read.
  if (action === 'manage_workspaces' && params.action === 'readiness') return 'tasks:read';
  if (action === 'manage_experiments' && ['list', 'get', 'readout'].includes(String(params.action))) return 'analytics:read';
  return Object.hasOwn(ACTION_TOKEN_SCOPE, action) ? ACTION_TOKEN_SCOPE[action as BuilddAction] : null;
}
