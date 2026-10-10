import { hasTokenScope, requiredScopeForAction } from './token-scopes';
/**
 * Shared MCP tool handlers for Buildd.
 *
 * Used by:
 * - apps/web/src/app/api/mcp/route.ts (HTTP server)
 */

import { LOOP_MAX_LOOPS_MAX, LOOP_MAX_LOOPS_MIN, parseLoopConfig } from './loop-config';
import { hasConcretePathManifest, pathsOverlap } from './path-overlap';
import { DISPATCHABLE_BACKENDS, backendLabel, describeBackendRouting, isBackendPinned } from './backend-policy';
import { TIERS, isTierSurface, type Tier, type TierSurface } from './model-tier-defaults';
import { isTaskTier, isAcceptableModelPin } from './model-pin';
import type { MissionControlCapability } from './mission-control-capabilities';
import { ARTIFACT_TYPES, isArtifactType, isTerminalWorkerStatus, isTerminalTaskStatus, isWorkspaceExecutor, parseMergePolicy, findRemovedPathFieldInGitConfig, removedPolicyPathFieldError } from '@buildd/shared';
import { formatWorkerMessages, type WorkerMessage } from './worker-message-format';
import { formatDispatchHealth, type DispatchHealthReport } from './dispatch-health-report';
import type { DispatchHistoryEntry } from './dispatch-outbox';
import { formatEvidenceObjects, formatTaskEvidence, formatTaskMismatch } from './task-evidence-format';
import { runGetVisualReview, runListRunners } from './mcp-visual-review';
import { handleModelUpgradeAction } from './mcp-model-upgrades';
import { defaultProvidersScope, handleProvidersAction, providersNeedsAdmin, type ProvidersOp } from './mcp-providers';
import { modelCredentialPurposes } from './providers/manage';
import { normalizeProject, workspaceProjectKey } from './project-scope';
import { formatAnalyticsReadFailure, readScheduleDelegation } from './token-delegation';
import { saveMemory, updateMemory } from './memory-write';
import {
  LEDE_FIELD_SPEC,
  LEDE_REQUIRED_ERROR,
  composeBodyWithLede,
  deriveLedeFromTitle,
  normalizeLede,
} from './pr-lede';
import type { Direction } from './spec-discrepancy-ledger';
import type {
  FailureAnalytics,
  FailureSignatureFamily,
  GateAnalytics,
  GateReasonFamily,
  LandingMetrics,
  StalledIngestReport,
  GateRow,
  GateWindow,
  FailureSignatureLookup,
  FailureSignatureRow,
  FailureWindow,
  FailureIncident,
  FailureIncidentSeverity,
} from '@buildd/shared';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Default preview cap for `get_pr`'s PR-body section — deliberately smaller
 * than the knowledge-store's `CARD_CONTENT_CAP` (8000): that cap sizes a
 * write into a corpus read once at query time, this one sizes a response
 * returned on every `get_pr` call inside an agent loop. A short "Problem +
 * Changes" summary with Testing/Acceptance-criteria sections trimmed away
 * (the common shape of this repo's own PR bodies) fits comfortably under
 * 2000 chars; a body that runs long is exactly the case `fullBody: true`
 * exists for, and the truncation marker always reports how much was cut.
 */
const GET_PR_BODY_PREVIEW_CHARS = 2000;
const GET_TASK_DESCRIPTION_PREVIEW_CHARS = 400;

// ── Default response caps ────────────────────────────────────────────────────
// The most-called actions send these much by default; every cut says how much
// it cut and names the param (or action) that returns the rest. Sizes are held
// by packages/core/__tests__/mcp-response-budgets.test.ts.

/** claim_task: open PRs listed when the task declares no paths to match them against. */
export const CLAIM_OPEN_PRS_UNSCOPED = 3;
/** claim_task: a memory's content preview (non-index mode). */
const CLAIM_MEMORY_PREVIEW_CHARS = 120;
/** get_task: newest workers, artifacts and loop iterations shown without all:true. */
export const GET_TASK_WORKERS_SHOWN = 3;
export const GET_TASK_ARTIFACTS_SHOWN = 10;
export const GET_TASK_LOOP_ITERATIONS_SHOWN = 5;
/** get_pr: failing checks and fix attempts shown without all:true. */
export const GET_PR_FAILING_SHOWN = 5;
export const GET_PR_ATTEMPTS_SHOWN = 5;
/** explain on a workspace: ranked subjects per page (default / max). */
export const EXPLAIN_WORKSPACE_LIMIT_DEFAULT = 5;
export const EXPLAIN_WORKSPACE_LIMIT_MAX = 25;
/** explain on a workspace: causal links kept per subject summary. */
const EXPLAIN_WORKSPACE_BECAUSE_SHOWN = 2;
/** manage_missions get: description preview, criterion evidence, linked tasks. */
const MISSION_DESCRIPTION_PREVIEW_CHARS = 600;
const MISSION_CRITERION_EVIDENCE_CHARS = 300;
export const MISSION_TASKS_SHOWN = 15;

/**
 * explain on a workspace: one page of the ranked subjects, each as a summary
 * (what it is, its state, what it waits on, the one-line situation, the next
 * action and the first causal links). The full answer for one subject is
 * explain on that subject; the next page is offset. Ranking is the route's.
 */
export function pageWorkspaceExplain(data: { subjects?: any[]; considered?: number; quiet?: number }, params: Record<string, unknown>) {
  const subjects = Array.isArray(data.subjects) ? data.subjects : [];
  const rawLimit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.trunc(params.limit) : EXPLAIN_WORKSPACE_LIMIT_DEFAULT;
  const limit = Math.min(Math.max(rawLimit, 1), EXPLAIN_WORKSPACE_LIMIT_MAX);
  const offset = typeof params.offset === 'number' && Number.isFinite(params.offset) ? Math.max(Math.trunc(params.offset), 0) : 0;
  const page = subjects.slice(offset, offset + limit);
  const after = Math.max(subjects.length - offset - page.length, 0);
  const summary = (a: any) => {
    const because = Array.isArray(a.because) ? a.because : [];
    const s = a.subject ?? {};
    const one = s.taskId ? `taskId: "${s.taskId}"` : s.prNumber != null ? `prNumber: ${s.prNumber}` : s.missionId ? `missionId: "${s.missionId}"` : null;
    return {
      subject: s,
      state: a.state,
      waitingOn: a.waitingOn,
      situation: a.situation,
      nextAction: a.nextAction ?? null,
      because: because.slice(0, EXPLAIN_WORKSPACE_BECAUSE_SHOWN),
      ...(because.length > EXPLAIN_WORKSPACE_BECAUSE_SHOWN ? { becauseOmitted: because.length - EXPLAIN_WORKSPACE_BECAUSE_SHOWN } : {}),
      ...(one ? { full: `explain {${one}}` } : {}),
    };
  };
  return {
    scope: 'workspace',
    ...(data.considered != null ? { considered: data.considered } : {}),
    ...(data.quiet != null ? { quiet: data.quiet } : {}),
    waiting: subjects.length,
    offset,
    shown: page.length,
    omitted: subjects.length - page.length,
    ...(after > 0 || offset > 0
      ? { more: `${after > 0 ? `offset: ${offset + page.length} for the next ${Math.min(after, limit)}` : 'last page'}; limit up to ${EXPLAIN_WORKSPACE_LIMIT_MAX}. Each subject's full evidence (history, gates, provenance): its \`full\` call.` }
      : { more: "Each subject's full evidence (history, gates, provenance): its `full` call." }),
    subjects: page.map(summary),
  };
}

/** `items` cut to `max`, with the count of what was left out. */
function capList<T>(items: readonly T[], max: number, all: boolean): { shown: T[]; omitted: number } {
  if (all || items.length <= max) return { shown: [...items], omitted: 0 };
  return { shown: items.slice(0, max), omitted: items.length - max };
}

/**
 * claim_task's open-PR section: one line per PR (a PR adopted by a review
 * task appears twice in the claim payload, once per task title), narrowed to
 * the PRs whose task paths overlap this task's manifest when it declares
 * concrete paths, otherwise the newest few. Always says how many it left out.
 */
export function formatClaimOpenPRs(
  openPRs: Array<{ prNumber?: number | null; prUrl?: string | null; branch?: string | null; taskTitle?: string | null; pathManifest?: string[] | null }>,
  taskManifest: string[] | null | undefined,
): string {
  const seen = new Set<string>();
  const unique = openPRs.filter(pr => {
    const key = pr.prNumber != null ? `#${pr.prNumber}` : String(pr.prUrl ?? pr.branch ?? '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return '';
  const line = (pr: (typeof unique)[number]) =>
    `- PR #${pr.prNumber ?? '?'} (${pr.branch ?? 'no branch'}): "${pr.taskTitle || 'Unknown task'}"`;
  const scoped = hasConcretePathManifest(taskManifest ?? null);
  const shown = scoped
    ? unique.filter(pr => Array.isArray(pr.pathManifest) && pr.pathManifest.length > 0 && pathsOverlap(pr.pathManifest, taskManifest!))
    : unique.slice(0, CLAIM_OPEN_PRS_UNSCOPED);
  const omitted = unique.length - shown.length;
  const rest = omitted > 0 ? `\n(${omitted} other open PR${omitted === 1 ? '' : 's'} in this workspace${scoped ? ' touch none of your paths' : ''} — list_prs lists them all.)` : '';
  if (shown.length === 0) {
    return `\n\n## Open PRs\nNone of the ${unique.length} open PR${unique.length === 1 ? '' : 's'} in this workspace touch your declared paths — list_prs lists them.`;
  }
  const lead = scoped
    ? 'Open PRs touching your declared paths. Read one (get_pr) before editing the same files, or rebase on its branch:'
    : 'Open PRs from other agents in this repo. Avoid the same files, or rebase on their branches:';
  return `\n\n## Open PRs\n${lead}\n${shown.map(line).join('\n')}${rest}`;
}

/** The claimed task as claim_task shows it: ids, branch and a description preview. */
function formatClaimedAssignment(w: { id: string; branch?: string | null; taskId?: string | null; task: { id?: string; title: string; description?: string | null } }, branchNote: string): string {
  const taskId = w.task.id ?? w.taskId ?? null;
  const desc = w.task.description || 'No description';
  const long = desc.length > GET_TASK_DESCRIPTION_PREVIEW_CHARS;
  return [
    `**Worker ID:** ${w.id}`,
    `**Task:** ${w.task.title}${taskId ? ` (${taskId})` : ''}`,
    `**Branch:** ${w.branch || 'Not set'}${branchNote}`,
    `**Description:** ${long ? truncate(desc, GET_TASK_DESCRIPTION_PREVIEW_CHARS) : desc}`,
    ...(long ? [`Read the full instructions before starting: get_task {taskId${taskId ? `: "${taskId}"` : ''}, fullDescription: true}.`] : []),
  ].join('\n');
}

/**
 * `hint` values from the worker completion route (apps/web/src/app/api/workers/[id]/route.ts)
 * that name a real MCP action to call next, as opposed to a gate-identifying
 * slug like `handoff_required` or `organizer_did_not_report` that has no
 * corresponding tool. Only these get the "Please use `<hint>`" retry
 * instruction in complete_task's 400 handling below.
 */
const RETRY_HINT_ACTIONS = new Set(['create_pr', 'create_artifact']);

const PRIORITY_NAMES: Record<string, number> = {
  lowest: 1, low: 3, medium: 5, high: 7, highest: 9, critical: 10, urgent: 10,
};

const NOTE_TYPES = ['decision', 'question', 'warning', 'suggestion', 'update'] as const;

/**
 * Routing vocabulary for tasks.kind / tasks.complexity — the two inputs the
 * claim-time router's kind×complexity matrix reads. Same vocabulary the
 * schedules path writes via classifyScheduleCadence and the same union the
 * `tasks` table declares; POST /api/tasks validates against the identical lists.
 */
const TASK_KINDS = [
  'coordination', 'engineering', 'research', 'writing', 'design', 'analysis', 'observation',
] as const;
const TASK_COMPLEXITIES = ['simple', 'normal', 'complex'] as const;

/** Convert named priority levels (e.g. "medium") to integer 0-10. */
/** manage_model_tiers `surface`: absent means the row that serves both surfaces. */
function parseTierSurfaceParam(val: unknown): TierSurface | null {
  if (val == null || val === '') return null;
  if (isTierSurface(val)) return val;
  throw new Error('surface must be "agent" or "chat" (omit it for the row that serves both)');
}

function normalizePriority(val: unknown, fallback = 5): number {
  if (val === undefined || val === null) return fallback;
  if (typeof val === 'number') return Math.max(0, Math.min(10, Math.round(val)));
  const s = String(val).toLowerCase().trim();
  const parsed = Number(s);
  if (!isNaN(parsed)) return Math.max(0, Math.min(10, Math.round(parsed)));
  return PRIORITY_NAMES[s] ?? fallback;
}

async function assertMissionControlCapabilities(
  api: ApiFn,
  required: MissionControlCapability[],
): Promise<void> {
  if (required.length === 0) return;

  let data: { capabilities?: unknown };
  try {
    data = await api('/api/missions/capabilities');
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `Mission control capability check failed; refusing to apply ${required.join(', ')}${detail}`,
    );
  }

  const advertised = Array.isArray(data.capabilities)
    ? new Set(data.capabilities.filter((value): value is string => typeof value === 'string'))
    : new Set<string>();
  const unsupported = required.filter((capability) => !advertised.has(capability));
  if (unsupported.length > 0) {
    throw new Error(
      `Target API does not support required mission controls: ${unsupported.join(', ')}. `
      + 'No mission changes were made.',
    );
  }
}

/** One line an agent reads for a mission whose executor is 'local'. */
const LOCAL_EXECUTOR = 'local — runs in a local session; runners never auto-claim its tasks. Claim each with claim_task {taskId} and finish with complete_task.';

function requestedMissionControlCapabilities(
  params: Record<string, unknown>,
): MissionControlCapability[] {
  const required: MissionControlCapability[] = [];
  if (params.startMode !== undefined) required.push('startMode');
  if (params.executor !== undefined) required.push('executor');
  if (params.pacingMode !== undefined || params.pacingMaxPerHour !== undefined) {
    required.push('pacing');
  }
  return required;
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
  // 'chat': a person in agent chat, not a worker. Worker-directed hints
  // ("call claim_task") are left out: chat cannot claim.
  surface?: 'chat';
  // Who is behind the call: a signed-in person (an OAuth MCP session, or
  // chat), an account key, or a per-task token. Personal roles belong to a
  // person, so register_skill/update_skill/delete_skill { personal: true }
  // refuse 'key' and 'task_token' with a reason. Undefined (the in-process
  // runner server) leaves the decision to the REST route, which refuses a
  // caller with no person the same way.
  principal?: 'person' | 'key' | 'task_token';
  getWorkspaceId: () => Promise<string | null>;
  getLevel: () => Promise<'trigger' | 'worker' | 'admin'>;
  /** null/undefined retains legacy level permissions; [] grants no capabilities. */
  getScopes?: () => Promise<readonly string[] | null | undefined>;
  appBaseUrl?: string;
  // Optional KnowledgeStore wiring for best-effort auto-indexing of agent work
  // product (completed tasks, PRs, artifacts, approved plans). Mirrored writes
  // never block or fail the underlying action.
  knowledgeStore?: KnowledgeStore;
  embedder?: Embedder | null;
  // Resolve a MemoryStore for this context (team-keyed, in-process).
  // Injected by the MCP route so the callback type stays decoupled from the route layer.
  // `workspaceId`, when given, names the workspace the memory is for (e.g. the
  // task claim_task just claimed): the store is that workspace's team's, and
  // null when it is sensitive or cannot be resolved.
  getMemoryClient?: (workspaceId?: string) => Promise<MemoryStore | null>;
  // Where memory reads record their use (memory_uses). The web routes pass an
  // after()-backed writer so the write outlives the response; omitted, reads
  // fire and forget.
  memoryLedger?: MemoryLedgerWriter;
  // Jev decisions on memory writes (packages/core/memory-decisions.ts). The
  // web routes inject one; omitted (the runner), learn keeps today's rules.
  memoryDecider?: MemoryDecider;
  // The workspaces this connection may act in, when the transport knows them
  // better than the workspace listing route (an account-level OAuth grant:
  // its granted workspaces ∩ current membership, across teams). Omitted, the
  // action lists what GET /api/workspaces returns for the caller.
  listWorkspaces?: () => Promise<WorkspaceListing[]>;
}

/** One row of list_workspaces. */
export interface WorkspaceListing {
  workspaceId: string;
  name: string;
  repo?: string | null;
  teamId?: string | null;
  teamName?: string | null;
  /** The level the connection acts at there. */
  level?: 'trigger' | 'worker' | 'admin';
  /** What this connection may do there. */
  access?: 'read' | 'read-write';
}

export const LIST_WORKSPACES_LIMIT_DEFAULT = 20;
export const LIST_WORKSPACES_LIMIT_MAX = 50;

/**
 * list_workspaces output: one page, grouped by team, with the total and the
 * next offset so a caller can page without guessing.
 */
export function renderWorkspaceListing(rows: WorkspaceListing[], params: Record<string, unknown>): string {
  const rawLimit = Number(params.limit ?? LIST_WORKSPACES_LIMIT_DEFAULT);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), LIST_WORKSPACES_LIMIT_MAX) : LIST_WORKSPACES_LIMIT_DEFAULT;
  const rawOffset = Number(params.offset ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
  const page = rows.slice(offset, offset + limit);
  const teams: Array<{ teamId: string | null; teamName: string | null; workspaces: unknown[] }> = [];
  for (const r of page) {
    const key = r.teamId ?? null;
    let t = teams.find((x) => x.teamId === key);
    if (!t) { t = { teamId: key, teamName: r.teamName ?? null, workspaces: [] }; teams.push(t); }
    t.workspaces.push({
      id: r.workspaceId,
      name: r.name,
      ...(r.repo ? { repo: r.repo } : {}),
      ...(r.level ? { level: r.level } : {}),
      ...(r.access ? { access: r.access } : {}),
    });
  }
  const next = offset + page.length < rows.length ? offset + page.length : null;
  return JSON.stringify({ total: rows.length, offset, limit, nextOffset: next, teams }, null, 2);
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ── UUID Validation ───────────────────────────────────────────────────────────

const FULL_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates that `id` is a full UUID and returns it. Throws with an actionable
 * message if missing or malformed — specifically calling out 8-character UI
 * prefixes, which are the most common mistake.
 */
const GET_TASK_INCLUDES: readonly string[] = ['workers', 'artifacts', 'scheduling', 'dispatch'];

/** get_task include:["dispatch"]: one line per outbox intent, oldest first. */
export function formatDispatchTrail(trail: unknown): string[] {
  const rows = Array.isArray(trail) ? trail as DispatchHistoryEntry[] : [];
  const lines = [`## Dispatch (${rows.length})`];
  if (rows.length === 0) return [...lines, 'No dispatch intents recorded.'];
  for (const r of rows) {
    const status = r.status === 'delivered' && r.deliveredVia ? `delivered via ${r.deliveredVia}` : r.status;
    const parts = [`- ${r.id} ${r.cause}: ${status}`, r.transport];
    if (r.handedOffAt) parts.push(`handed off ${r.handedOffAt}`);
    else if (r.status === 'pending' && r.notBefore) parts.push(`due ${r.notBefore}`);
    parts.push(`${r.attemptCount} ${r.attemptCount === 1 ? 'attempt' : 'attempts'}`);
    if (r.lastError) parts.push(`last error: ${String(r.lastError).slice(0, 200)}`);
    lines.push(parts.join(' · '));
  }
  return lines;
}

/**
 * The stored facts that decide when, where and how a task runs. Rendered on
 * request so a filer can confirm what create_task persisted — dependency edges,
 * the effective path scope, tier and verification — without a raw REST read.
 */
function formatTaskScheduling(task: any): string[] {
  const ctx = task.context && typeof task.context === 'object' ? task.context as Record<string, unknown> : {};
  const out: string[] = ['', '## Scheduling'];
  const deps: string[] = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  out.push(deps.length > 0 ? `**Depends on (${deps.length}):** ${deps.join(', ')}` : '**Depends on:** none');
  const manifest: string[] | null = Array.isArray(task.pathManifest) ? task.pathManifest : null;
  out.push(manifest === null
    ? '**Path manifest:** none declared'
    : `**Path manifest (${manifest.length}):** ${manifest.length > 0 ? manifest.join(', ') : 'empty'}`);
  const decl = task.pathDeclaration;
  if (decl && typeof decl === 'object') {
    const declared = Array.isArray(decl.declared) ? decl.declared : null;
    if (declared) out.push(`**Declared manifest (${decl.source ?? 'unknown'}):** ${declared.join(', ') || 'empty'}`);
    if (Array.isArray(decl.inferredDependsOn) && decl.inferredDependsOn.length > 0) {
      out.push(`**Inferred dependsOn:** ${decl.inferredDependsOn.join(', ')}`);
    }
    if (Array.isArray(decl.narrowings) && decl.narrowings.length > 0) {
      out.push(`**Narrowings:** ${decl.narrowings.length}`);
    }
  }
  if (typeof task.pathClaimRevision === 'number') out.push(`**Path claim revision:** ${task.pathClaimRevision}`);
  out.push(`**Tier:** ${task.tier ?? 'unset (resolved from role/kind at claim)'}`);
  if (task.complexity) out.push(`**Complexity:** ${task.complexity}`);
  if (task.classifiedBy) out.push(`**Classified by:** ${task.classifiedBy}`);
  if (task.taskClass) out.push(`**Task class:** ${task.taskClass}`);
  if (task.parentTaskId) out.push(`**Parent task:** ${task.parentTaskId}`);
  if (task.outputRequirement) out.push(`**Output requirement:** ${task.outputRequirement}`);
  if (typeof ctx.verificationCommand === 'string' && ctx.verificationCommand) {
    out.push(`**Verification command:** \`${truncate(ctx.verificationCommand, 400)}\``);
  }
  const specSource = ctx.specSource;
  if (specSource && typeof specSource === 'object') {
    const src = specSource as Record<string, unknown>;
    const planning = typeof src.planningTaskId === 'string' ? ` (planning task ${src.planningTaskId})` : '';
    out.push(`**Spec source:** ${typeof src.specPath === 'string' ? src.specPath : JSON.stringify(src)}${planning}`);
  }
  return out;
}

function requireFullUuid(id: unknown, paramName: string): string {
  if (!id || typeof id !== 'string') throw new Error(`${paramName} is required`);
  if (!FULL_UUID_REGEX.test(id)) {
    const isPrefix = /^[0-9a-f]{1,35}$/i.test(id);
    const hint = isPrefix
      ? ` "${id}" looks like an ID prefix — the web UI shows 8-character prefixes; use the full UUID from the task URL or API response.`
      : ` Received: "${id}".`;
    throw new Error(`${paramName} must be a full UUID (e.g. b833be4b-1234-5678-abcd-ef0123456789).${hint}`);
  }
  return id;
}

/**
 * An account-level claim refusal (HTTP 429 from the claim route: worker slots,
 * daily cost, concurrent sessions) as one line, or null for any other error.
 * The route's body carries `code` and a `detail` sentence (task e7e8740a);
 * without this the caller saw a raw "API error: 429 - {...}".
 */
export function describeAccountLimitError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : '';
  const m = /^API error: 429 - ([\s\S]*)$/.exec(msg);
  if (!m) return null;
  try {
    const body = JSON.parse(m[1]);
    if (typeof body?.code === 'string' && typeof body?.detail === 'string') {
      return `Nothing claimed: ${body.code}. ${body.detail}`;
    }
  } catch {
    // Not JSON: fall through to the caller's own error handling.
  }
  return null;
}

/**
 * Human-readable reply for a claim that returned no workers. The claim route
 * always computes `diagnostics.reason` (and, for an explicit taskId, the gate
 * that excluded it as `diagnostics.taskExclusion`); the old reply discarded it
 * and said "All tasks may be assigned or completed" even with tasks pending.
 */
export function describeEmptyClaim(data: any, taskId?: string): string {
  const d = data?.diagnostics;
  if (!d?.reason) {
    return 'Nothing claimed: the server returned no workers and gave no reason.';
  }
  const detail: string[] = [];
  if (d.reason === 'no_slots' && typeof d.activeWorkers === 'number') {
    detail.push(`${d.activeWorkers}/${d.maxConcurrent ?? '?'} concurrent workers already active for this account`);
  }
  if (typeof d.pendingTasks === 'number') detail.push(`${d.pendingTasks} candidate(s)`);
  if (d.deferrals && Object.keys(d.deferrals).length > 0) {
    detail.push(`deferred by ${Object.entries(d.deferrals).map(([k, n]) => `${k}=${n}`).join(', ')}`);
  }
  if (d.blockedByPr?.prNumber) detail.push(`path overlap with open PR #${d.blockedByPr.prNumber}`);
  if (data.budgetResetsAt) detail.push(`budget resets at ${data.budgetResetsAt}`);

  const lines = [`Nothing claimed: ${d.reason}${detail.length ? ` (${detail.join('; ')})` : ''}.`];
  // Which budget or rate-limit wall held the claim, and when it lifts.
  if (typeof d.budgetBlock?.summary === 'string' && d.budgetBlock.summary) lines.push(d.budgetBlock.summary);
  if (taskId) {
    if (d.taskExclusion) {
      lines.push(`Task ${taskId} was excluded: ${d.taskExclusion.code}. ${d.taskExclusion.detail}`);
    } else if (d.reason === 'all_candidates_deferred' || d.reason === 'race_lost') {
      lines.push(`Task ${taskId} is claimable but was held back this poll (see the reason above); try again shortly.`);
    }
  }
  return lines.join('\n');
}

// ── Action Lists ─────────────────────────────────────────────────────────────

// Trigger level: can create tasks and artifacts, but cannot claim or execute.
// Read-only schedule discovery is allowed at this level so any caller can
// trace "what fired this notification?" without needing an admin token.
export const triggerActions = [
  // Discovery: which workspaces this connection can act in.
  'list_workspaces',
  'list_tasks', 'get_task', 'create_task', 'create_artifact',
  'list_artifacts', 'get_artifact', 'emit_event',
  'list_artifact_templates',
  'list_schedules', 'trace_schedule',
  'get_task_messages',
] as const;

export const workerActions = [
  // spec_compare is read-only retrieval over {ws}:docs and {ws}:code. It grants no
  // data access a worker lacks — query_knowledge/recall already reach both corpora —
  // so gating it to admin only meant the spec-validator role could never run its own
  // documented workflow (default-roles.ts instructs it to call spec_compare).
  'spec_compare',
  // Discrepancy ledger reads (§13) — same reasoning as spec_compare above:
  // read-only over rows the caller's workspace access already covers.
  'list_discrepancies', 'get_discrepancy',
  // Which workspaces (and teams) this connection can act in, with the level
  // and access in each: the one discovery call a multi-workspace connection
  // needs before naming a workspaceId. Read-only.
  'list_workspaces',
  'list_tasks', 'get_task', 'claim_task', 'update_progress', 'complete_task',
  // The agent's own read of messages sent to it (interactive / local-plugin
  // sessions; a runner-managed worker gets them from its runner instead).
  'receive_messages',
  'create_pr', 'close_pr', 'update_pr', 'merge_pr', 'get_pr', 'list_prs', 'request_pr_review', 'get_pr_review',
  'record_pr_supersession',
  'update_task', 'create_task', 'create_artifact',
  'upload_artifact', 'list_artifacts', 'get_artifact', 'update_artifact',
  // The visual auditor's own read: where its pages come from (sandbox or a
  // Vercel preview), resolved server-side with the workspace's GitHub App.
  'get_page_source',
  // Worker level, not admin: authority is the TASK's role grant in its
  // workspace (Platform Operator), checked server-side per capability and
  // target. The caller never receives the credential; a task under any
  // other role is refused whatever its key level.
  'deploy',
  'emit_event', 'query_events', 'get_error_traces',
  // Deterministic read over rows the caller can already see. Worker level, not
  // admin: the agent that needs "why is this stuck?" is the one standing in it.
  'explain',
  'list_artifact_templates',
  'suggest_schedule_update',
  'post_note',
  'list_schedules', 'trace_schedule',
  'get_task_messages',
  'get_budget_forecast',
  'get_usage_stats',
  'list_connectors',
  // Read-only semantic discovery over the same connector rows plus role
  // opt-in, catalog policy and Operator grant. Worker level: the organizer
  // choosing a role and the agent missing a tool are the ones asking.
  'resolve_capability',
  'list_releases',
  'get_release',
  // Read-only and team-scoped. Worker level, not trigger: the caller who needs
  // to know "is my failure already known?" is the one that just failed.
  'get_failure_analytics',
  // Read-only over the Failure Pattern Sentinel's own ledger (GET
  // /api/health/incidents) — same reasoning as get_failure_analytics above:
  // the agent chasing "is this already a known incident?" needs this without
  // a dashboard session.
  'list_incidents',
  // Read-only, team-scoped Dispatch transport health (Postgres counts plus one
  // Worker /health probe). Worker level for the same reason: the agent asking
  // "did my wake get delivered?" is the one waiting on it.
  'dispatch_health',
  'get_manifest_coverage',
  'get_path_claim_stats',
  'get_decision_stats',
  // Read-only heartbeat snapshot for the caller's runners — the same data
  // GET /api/workers/active serves, exposed as an MCP action so a task doing
  // update/version recon doesn't need SSH or a dashboard session to see it.
  // Worker level, not admin: any worker's own recon needs this, same
  // reasoning as get_failure_analytics above.
  'list_runners',
  // Read-only over run evidence (logs, test reports) of tasks the caller can
  // already see; the routes check reach and lineage and audit every read.
  'read_evidence',
  // Split by sub-action: list/get/readout are worker level (and only return
  // visibility='team' experiments below admin — the API 404s the rest); every
  // write sub-action (EXPERIMENT_WRITE_OPS) is admin level, checked in the
  // handler with the same structured forbidden result requireAdminLevel gives.
  'manage_experiments',
  // Model providers and credentials (/api/providers). Worker level, split by
  // sub-action: list/explain read; set/delete `mine` are a signed-in person's
  // own key; team/workspace set/delete and set_policy need admin, checked in
  // the handler (the route checks the permission again).
  'manage_providers',
] as const;

export const PROVIDER_OPS = ['list', 'set', 'delete', 'explain', 'set_policy'] as const;
export const PROVIDER_MINE_TASK_TOKEN_REFUSAL =
  'A per-task token has no person behind it, so it cannot set or remove a personal credential for anyone. Use team or workspace scope with an admin token, or ask the person to do it from their own session.';
export const PROVIDER_TASK_TOKEN_READ_ONLY =
  'A per-task token can list providers and explain what would run in its own workspace; it cannot change a credential or the credential policy, at any level.';
export const PROVIDER_MINE_KEY_REFUSAL =
  'An API key has no person behind it, so it cannot hold a personal credential. Use an MCP session signed in as yourself (OAuth), or scope team/workspace.';
/** manage_secrets set refuses these: model credentials have one write path. */
export const MODEL_PURPOSE_REFUSAL = (purpose: string) =>
  `purpose ${purpose} is a model credential; use manage_providers { action: "set", provider, scope, value } so it is stored where every surface reads it.`;

/** manage_experiments sub-actions that write, and so require an admin token. */
export const EXPERIMENT_WRITE_OPS = ['create', 'update', 'start', 'pause', 'conclude'] as const;
export const EXPERIMENT_READ_OPS = ['list', 'get', 'readout'] as const;

// list_schedules and trace_schedule live in worker/trigger sets above;
// admins inherit them via allActions = [...workerActions, ...adminActions].
export const adminActions = [
  'create_schedule', 'update_schedule', 'delete_schedule',
  'pause_schedules',
  'register_skill', 'list_skills', 'get_skill', 'update_skill', 'delete_skill',
  'manage_secrets',
  'approve_plan', 'reject_plan',
  // Discrepancy ledger mutations (§13): adjudicate records an owner decision,
  // promote mints a mission — same trust tier as approve_plan/manage_missions.
  'adjudicate_discrepancy', 'promote_discrepancy',
  'manage_missions',
  // Read-only, but GET /api/missions/[id]/visual-review takes admin keys only.
  'get_visual_review',
  'manage_initiatives',
  'link_tracker',
  'manage_workspaces',
  'manage_watched_projects',
  'manage_model_tiers',
  'manage_evidence_backends',
  'trigger_release',
  'release_status',
  'send_agent_message',
  'correct_task_result',
  'consolidate_knowledge',
  'memory_delete',
] as const;

/**
 * The admin actions an orchestration task's admin-level per-task token
 * (organizer, planning, heartbeat; apps/web/src/lib/task-token.ts) may call,
 * with the sub-actions it may use (null: every sub-action). Each is confined
 * by its REST route to the token's own task's mission in its own workspace.
 * Every other admin action is team-wide (other missions, workspaces, secrets,
 * schedules, skills, releases, knowledge maintenance) and is refused to a
 * task token before it reaches a route. Pinned, with the reason for each
 * refusal, by apps/web/src/lib/task-token-mcp-coverage.test.ts.
 */
export const ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS: Readonly<Record<string, readonly string[] | null>> = {
  // Its own mission only: read it, edit its descriptive fields, arm it, and
  // run or read its criteria. Never list, create or delete missions, or move
  // tasks between them.
  manage_missions: ['get', 'update', 'arm', 'evaluate', 'get_criteria_state'],
  // Plans of planning tasks on its own mission.
  approve_plan: null,
  reject_plan: null,
  // Workers of tasks on its own mission.
  send_agent_message: null,
};

/**
 * Why an orchestration task token may not call `action`, or null when it may
 * (any non-admin action, and the allowed admin actions above).
 */
export function orchestrationTaskTokenRefusal(action: string, params: Record<string, unknown> = {}): string | null {
  if (!(adminActions as readonly string[]).includes(action)) return null;
  if (isPersonalRoleCall(action, params)) return PERSONAL_ROLE_TASK_TOKEN_REFUSAL;
  if (!Object.hasOwn(ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS, action)) {
    return `action '${action}' is team-wide; a per-task token cannot use it, even at admin level`;
  }
  const subs = ORCHESTRATION_TASK_TOKEN_ADMIN_ACTIONS[action];
  if (subs && !subs.includes(String(params.action))) {
    return `${action} action '${String(params.action)}' is not available to a per-task token; it may use ${subs.join(', ')} on its own mission`;
  }
  return null;
}

export const allActions = [...workerActions, ...adminActions] as const;

/**
 * Admin actions with a personal-role path: `{ personal: true }` reads or
 * writes roles owned by a person through /api/roles (writes: permission
 * create_personal_roles, members by default), never a workspace or team
 * skill. list_skills / get_skill on that path see the caller's own personal
 * roles and the ones shared with the team, never another member's private
 * one (GET /api/roles decides). That path is open at worker level, so an
 * OAuth member session (worker level) can use it; the team-role path stays
 * admin. The route decides who may edit which personal role (owner, or a
 * team admin once shared); MCP does not pre-refuse.
 */
export const PERSONAL_ROLE_ACTIONS = ['register_skill', 'update_skill', 'delete_skill', 'list_skills', 'get_skill'] as const;

/** A skill action call on the caller's personal-role path. */
export function isPersonalRoleCall(action: string, params: Record<string, unknown> | undefined): boolean {
  return (PERSONAL_ROLE_ACTIONS as readonly string[]).includes(action)
    && (params?.personal === true || params?.personal === 'true');
}

export const PERSONAL_ROLE_TASK_TOKEN_REFUSAL =
  'A per-task token has no person behind it, so it cannot create or edit a personal role for anyone, its requester included. Ask the person to create it from the dashboard, buildd chat, or their own MCP session.';
export const PERSONAL_ROLE_KEY_REFUSAL =
  'An API key has no person behind it, so it cannot create or edit a personal role. Use the dashboard, buildd chat, or an MCP session signed in as yourself (OAuth).';

// delete and consolidate_knowledge moved to adminActions / buildd tool (compliance + single-consumer ops)
export const memoryActions = ['context', 'search', 'save', 'get', 'update', 'query_knowledge'] as const;

/** Valid `learn` types — also the vocabulary `recall`'s `type` filter is checked against. */
export const MEMORY_TYPES = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'] as const;

/**
 * Corpora reachable through `recall` / `query_knowledge`. `session` is a real
 * Corpus value (knowledge-store/types.ts) but write-only/internal — never
 * advertised to callers here.
 */
export const CORPORA = ['memory', 'task', 'pr', 'plan', 'artifact', 'code', 'docs', 'spec', 'initiative', 'evidence'] as const;

/**
 * Corpora a sensitive workspace never reads. memory/initiative are team-wide
 * namespaces a sensitive context must not see; evidence is never indexed for a
 * sensitive workspace (docs/specs/byo-evidence-storage.md, "Private and
 * sensitive rules"), and MUST return nothing for one even if a chunk exists.
 */
const SENSITIVE_WITHHELD_CORPORA: ReadonlySet<string> = new Set(['memory', 'initiative', 'evidence']);

/**
 * Validate a `recall`/`query_knowledge` scope-or-corpus param (string or
 * string[]) against CORPORA. Returns an error message listing valid values on
 * any unknown entry (a typo like 'tasks' otherwise fans out to an empty,
 * silently-wrong namespace instead of failing loudly); null when input is
 * absent or every entry is valid.
 */
export function parseCorpora(input: unknown): { error: string } | null {
  if (input === undefined || input === null) return null;
  const values = Array.isArray(input) ? input : [input];
  const invalid = values.filter(v => typeof v !== 'string' || !(CORPORA as readonly string[]).includes(v));
  if (invalid.length > 0) {
    return { error: `Unknown scope(s): ${invalid.join(', ')}. Valid values: ${CORPORA.join(', ')}` };
  }
  return null;
}

/**
 * JSON-Schema tool definitions for the `recall` / `learn` knowledge tools.
 *
 * Shared by both Streamable-HTTP MCP routes -- /api/mcp and the
 * workspace-pinned /api/mcp-oauth/[workspace] -- so the advertised tool set
 * cannot drift between them. It had drifted: the OAuth route's server
 * instructions named both tools while its ListTools handler registered
 * neither, so a client that believed the instructions got
 * `Unknown tool: recall`.
 *
 * Every call site must keep these behind the same `dataClass !== 'sensitive'`
 * gate the deprecated buildd_memory tool uses; handleRecallAction /
 * handleLearnAction re-check `ctx.isSensitive` as defense in depth.
 */
export const recallToolDefinition = {
  name: "recall",
  description: "Team knowledge base. Query this BEFORE starting work or diagnosing a failure — it holds prior gotchas, architecture decisions, and outcomes of past tasks. Pass the task title and any error message. Use scope=[\"memory\",\"task\"] to cover prior lessons AND recent outcomes in one call.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string" as const,
        description: "Natural language query — the task title, error text, or concept to look up. Required unless id is provided.",
      },
      scope: {
        // The enum below lists the corpora; repeating them here only cost tokens.
        description: 'Corpus to search — single string or array for multi-corpus fused results. Default: memory.',
        oneOf: [
          {
            type: "string" as const,
            enum: [...CORPORA],
          },
          {
            type: "array" as const,
            items: {
              type: "string" as const,
              enum: [...CORPORA],
            },
          },
        ],
      },
      type: {
        type: "string" as const,
        description: `Filter results to entries whose memory type matches. One of: ${MEMORY_TYPES.join(' | ')}. Only affects the memory corpus — other corpora have no type field.`,
      },
      files: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Narrow results to entries touching these file paths.",
      },
      limit: {
        type: "number" as const,
        description: "Max results to return. Default: 10.",
      },
      id: {
        type: "string" as const,
        description: "Direct fetch by memory ID — bypasses ranking; all other params ignored. Accepts the full ID or the 8-char short ID a memory index line shows (m:1a2b3c4d).",
      },
      includeCandidates: {
        type: "boolean" as const,
        description: "Also return unverified candidate memories (not yet promoted). Default false.",
      },
    },
  },
};

export const learnToolDefinition = {
  name: "learn",
  description: "Record a durable lesson for the team — a gotcha, pattern, decision, discovery, or architecture fact. Write what the next agent would have wanted to know. Near-duplicates are merged automatically.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string" as const,
        description: `Memory type. One of: ${MEMORY_TYPES.join(' | ')}`,
        enum: [...MEMORY_TYPES],
      },
      title: {
        type: "string" as const,
        description: "Short title for this lesson.",
      },
      content: {
        type: "string" as const,
        description: "The lesson content — what the next agent should know.",
      },
      files: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "File paths this lesson relates to.",
      },
      tags: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Tags for categorisation.",
      },
      scope: {
        type: "string" as const,
        description: "Omit. Memories are always filed under the calling workspace's project; naming any other project is refused.",
      },
      supersedes: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Memory IDs this entry replaces. Superseded entries drop out of default retrieval.",
      },
    },
    required: ["type", "title", "content"],
  },
};

export type BuilddAction = (typeof allActions)[number];
export type MemoryAction = (typeof memoryActions)[number];

// ── Description Builders ─────────────────────────────────────────────────────

export function buildToolDescription(actions: readonly string[]): string {
  return `Task coordination tool. Available actions: ${actions.join(', ')}. Use action parameter to select operation, params for action-specific arguments.\n\nA call above your token level returns {"error":"forbidden",...}; a 401 means auth expired/invalid.`;
}

export function buildParamsDescription(actions: readonly string[]): string {
  const descriptions: Record<string, string> = {
    list_workspaces: '{ offset?, limit? (default 20, max 50) } — the workspaces this connection can act in, grouped by team: id, name, repo, the level you act at there and your access (read or read-write). On an account-level connection it lists exactly the workspaces you granted it that you are still a member of, nothing else. Name one of them (id, owner/repo or name) on any other action. Read-only; nextOffset pages.',
    list_tasks: '{ offset?, limit? (default 5, clamped 1-50), status? ("active"|"completed"|"failed"|"cancelled", default "active"), missionId? (full UUID) } — unknown params and bad values are rejected, never ignored. "active" lists claimable/in-progress work. A terminal status switches to audit mode: ALL matching tasks in the workspace, fully paginated (no 24h window), each row tagged with summarySource (agent vs fallback) and PR/artifact attribution so a fallback summary with nothing shipped doesn\'t read as a real completion.',
    get_task: '{ taskId (required), include? (array of "workers"|"artifacts"|"scheduling"|"dispatch", default workers+artifacts; "scheduling" adds dependsOn, pathManifest/declaration, tier, verificationCommand, specSource; "dispatch" adds the task\'s dispatch outbox trail, one line per wake: cause, status, transport, handed-off time, delivered via, attempts, last error), fullDescription?, all? } — read-only status check. Descriptions default to a 400-character preview with an explicit omitted-character count; pass fullDescription:true to read all instructions and policy sections. Returns task fields, loop configuration/state/history, latest workers, and artifacts: by default the newest 3 workers, 10 artifacts and 5 loop iterations, each cut saying how many it left out; all:true returns every one (and full worker errors). Use this to follow a task to completion after create_task.',
    claim_task: '{ maxTasks?, workspaceId?, taskId? (full UUID), force? (admin, with taskId) }: returns the current assignment when worker context is present; otherwise auto-assigns the highest-priority pending task. Pass taskId to pick up one specific pending task (e.g. from list_tasks): it is treated like the dashboard Start button without override. A task in a mission with executor="local" is claimable ONLY this way, from your interactive session (never auto-assigned). OAuth budget pacing is skipped. From your own Claude Code session the claim runs on your seat, so the account\'s Claude session wall and the team\'s recorded provider rate-limit walls are skipped too; a runner that names a task is still held by them, and tenant work is still held by its tenant budget. A held mission or held task, unmet dependencies (including edges added automatically at creation for overlapping pathManifests), a future startAt, path overlap, mission pacing/concurrency and the workspace cap still apply. force: true (admin token, with taskId, task in your own team) claims that task past all of those except a hold on the task itself, like Start with override on the dashboard; it never bypasses a live worker, the mission budget, scope-undeclared serialization, provider walls or account limits, and it is recorded. When nothing is claimed the reply starts "Nothing claimed:" and names the server\'s reason (a budget_exhausted refusal names the wall that held it and when it lifts), plus the specific gate that excluded taskId when one was given.',
    receive_messages: '{ workerId? } — collect the messages sent to you: human steering (send_agent_message / the task page), replies to your post_note questions, mission guidance and worker→worker messages. Each is returned once and acknowledged as read. On a runner-managed worker the runner already delivers these into your session at the next turn boundary, so this returns nothing there; in an interactive or local-plugin session call it when a hook says messages are waiting. workerId auto-resolved from context if omitted.',
    update_progress: '{ workerId?, progress? (legacy self-report; never displayed), message?, plan?, kind? (coordination|engineering|research|writing|design|analysis|observation — the shape of the work you are actually doing; recorded only if the task has no kind yet, so reporting one for an already-classified task is a harmless no-op), inputTokens?, outputTokens?, costUsd?, costBasis? ("real"|"virtual"|"unknown"), lastCommitSha?, commitCount?, filesChanged?, linesAdded?, linesRemoved? } — workerId auto-resolved from context if omitted. inputTokens/outputTokens/costUsd are self-reported usage, written as a plain overwrite (a later, smaller report replaces rather than merges with the prior value) — the only way an interactive MCP session, with no runner watching the process, gets counted in get_usage_stats. costBasis says how that usage was charged: "real" (per token, e.g. an API key) or "virtual" (a subscription plan, valued at list price); omit it when you do not know and it records as unknown.',
    complete_task: '{ workerId?, summary?, error?, structuredOutput?, nextSuggestion?, discardEdits? (string), alreadyShippedIn? (PR number), entities? (EntityRef[]), relations? (RelationRef[]), supersedes? (string[]), inputTokens?, outputTokens?, costUsd?, costBasis? ("real"|"virtual"|"unknown") } — if error present, marks task as failed. discardEdits is for a task ending with commits or uncommitted worktree changes that are intentionally scratch and not meant to ship: state why (e.g. "conflict resolution attempts, no longer needed") and completion succeeds normally instead of being refused by the output-requirement gate — the reason is recorded on the task result for audit. Do not use it to paper over unfinished real work. alreadyShippedIn is for a pr_required task whose work already landed in a merged PR it does not own (another task shipped it first): pass that PR number and completion succeeds without a PR of its own once GitHub confirms it is merged in the workspace repo; any commits or edits of this worker\'s own also need discardEdits. entities/relations are optional Layer 2 metadata for the knowledge graph; response includes entity binding counts. supersedes lists knowledge source_ids this outcome REPLACES — accepted forms: "task:<taskId>" (earlier task outcome), "pr:<number>", "plan:<taskId>", "artifact:<artifactId>"; matched chunks are marked superseded and drop out of default retrieval (response includes "Superseded: n"). inputTokens/outputTokens/costUsd are self-reported usage — same plain overwrite as update_progress (a later, smaller report replaces rather than merges with the prior value), the only way an interactive MCP session\'s cost gets counted in get_usage_stats; costBasis as in update_progress. workerId auto-resolved from context if omitted',
    create_pr: '{ workerId?, title (required), head (required), lede (required — see below), body?, base?, draft?, prUrl?, requestReview? (boolean — hand the PR straight to a reviewer agent, same as calling request_pr_review afterwards), reviewerRole?, callbackUrl?, callbackOn? } — workerId auto-resolved from context if omitted. Pass prUrl to register an externally-created PR (e.g. via gh CLI) when the workspace has no GitHub App installation; on that path a missing lede is derived from the title instead of refused, because the PR already exists.\n\n'
      + 'head must be the branch claim_task assigned this worker — a mismatch is refused as head_not_owned. The one exception: a worker claimed from your own interactive session (claim_task called from this session, not a background runner) may instead use any other branch it actually pushed to, as long as no other worker already holds that exact name (refused as head_claimed, naming the other task, when one does).\n\n'
      + `lede (required) — ${LEDE_FIELD_SPEC}\n\n`
      + 'The lede leads the PR body; `body` follows it, unchanged and uncapped, under its own headings. Nothing inspects or grades what you write — the only way `lede` can fail is by being absent, and then no PR is created and you simply call again.',
    close_pr: '{ workerId?, prNumber (required), workspaceId? (disambiguate when prNumber exists in multiple repos) } — workerId is resolved from prNumber when absent, same as merge_pr. Close a pull request via the workspace\'s GitHub App installation. Use this instead of the GitHub connector\'s update_pull_request to avoid 403 permission gaps — the buildd App token already holds pull_requests: write.',
    update_pr: '{ workerId?, prNumber (required), body? , draft? (false — marks a draft PR ready for review instead of editing the body; one of body/draft is required) } — Replace a pull request\'s body, or mark it ready for review with draft:false (gh pr ready is blocked for builders) via the workspace\'s GitHub App installation, same as close_pr but rewriting content instead of state. Use this instead of the GitHub connector\'s update_pull_request (returns 403 Resource not accessible by integration on most installations) and instead of create_pr\'s dedup-adoption path for a PR create_pr did not open or was not asked to refresh — e.g. correcting a PR body after the fact (removing a disclosed URL, fixing a no-prod-data gate trip). Only an agent run or team member that owns the PR (its own worker\'s, or one its task\'s records link: a retry\'s PR, or a PR linked when the task was filed) may call this; a task token is confined to its own task\'s PR the same way close_pr is.',
    merge_pr: '{ workerId?, prNumber (required), mergeMethod? (merge|squash|rebase — default squash), workspaceId?, overrides? ({ freshness?: true, size?: true }), reason? (required with overrides) } — Merge a PR via the workspace\'s GitHub App installation token (pull_requests:write + contents:write). workerId is optional — the route resolves the worker from prNumber across the account\'s accessible workspaces. Pass workspaceId to disambiguate when the same prNumber appears in multiple repos. Updates worker mergedAt on success. Returns { ok, merged, message }. **Subject to the workspace merge policy:** under tier `agent-review` a self-merge is refused — the reviewer decides, so use request_pr_review and let an approve merge it; under `human` it is refused outright; under `auto-threshold` it merges only if the same safety check auto-merge uses passes (CI green, no deny paths, size cap, migration inspector). A 403 carries the reason and the tier — read it rather than retrying. If the App lacks contents:write, returns 403 with a hint to update permissions at github.com/settings/apps. **overrides** is the escape hatch for a PR whose landing escalated because the base kept moving (or the size cap): it merges past base freshness / the size cap, never the review verdict, red CI or a deny path, and is recorded with the reason. A person\'s own session (OAuth MCP, chat) may use it; an agent run is refused unless a person granted it on the run\'s task at creation (create_task context.landingOverride: { prNumbers, overrides: ["freshness"|"size"] }).',
    get_pr: '{ workerId?, prNumber?, workspaceId?, fullBody?, includeComments?, includeCiFailures?, all? } — Read PR details in a single call: mergeable state, CI check summary, review approvals, diff stats, and PR body (which contains the agent\'s work summary). workerId is optional — pass prNumber to resolve the worker from the account\'s workspaces; pass workspaceId to disambiguate. Either workerId or prNumber is required. By default the body is cut to ~2000 chars with a `…[truncated N chars]` marker (the exact count elided, never silently dropped) — pass fullBody:true for the complete text. When the PR has fix attempts (after CI #N / after review #N, including one that opened a PR of its own after a failed resume) they are listed with each attempt\'s errorClass, first key line and any mismatch flag (the latest 5, and the first 5 failing checks, unless all:true; each cut says how many it left out). Stored run-evidence objects (kind, size, id) are listed when the task has any; read one with read_evidence. Comments are omitted by default; pass includeComments:true to read buildd\'s own decision trail (activity log, review requests, human overrides — bounded to 10, ranked above bot/CI noise, with an omitted count). That trail is prose, not the verdict itself — use get_pr_review for the structured verdict/confidence/state. When CI is red and you need to know why, pass includeCiFailures:true: for each failing check it returns the job, the failing step and the last ~150 log lines (timestamps and escape codes stripped, secrets and production figures redacted, size-capped); a job whose log is unavailable comes back as its name and URL only.',
    list_prs: '{ state? ("open" default | "attention" = conflicts and red CI | "conflict" | "ci_failed" | "merged"), workspaceId? (omit: every workspace you reach), sinceDays? (merged: default 7, max 90), limit? (default 20, max 50) } — PRs buildd opened or adopted, one line each: number, state, task title, workspace, mission, task id, url, plus when it matters: NEEDS YOU (why), CI fix attempts so far, an agent already fixing or reviewing it, a mission-branch base, a stale state. Order: waiting on you, red nobody is fixing, red being fixed, the rest. attention lists only conflicts, red CI and PRs waiting on you. Closed PRs are never listed; read one with get_pr.',
    request_pr_review: '{ prNumber (required), workspaceId?, reviewerRole? (role slug — defaults to the workspace merge policy\'s reviewer role), callbackUrl? (https only — POSTed once with the review status), callbackOn? ("verdict" | "merge", default "verdict"), force? (re-review a PR whose review already finished; a second review of the head it already judged is a person\'s call, so only an OAuth session may force that, and an API key or task token gets a 409 force_requires_human) } — hand a PR to a reviewer agent on demand, including a PR buildd did not open (it is adopted as a task + worker mapped to the PR first, so the verdict, the PR activity comment and the workspace merge policy all apply exactly as they do for a worker PR). One reviewer per PR at a time: an in-flight review is returned as-is and force will NOT stack a second agent on it. On approval buildd merges only if the effective merge policy says so (autoMergeExpected in the response tells you). Wait for the outcome with get_pr_review, or supply callbackUrl.',
    get_pr_review: '{ prNumber (required), workspaceId?, waitFor? ("verdict" | "merge", default "verdict"), waitSeconds? (0-45, default 0) } — read where a PR review stands: state (not_requested | queued | reviewing | approved | changes_requested | escalated | review_failed), terminal, verdict, confidence, summary/feedback, and the PR\'s own merge state. A `review_failed` state carries `failureReason` — the reviewer worker\'s own crash/exit reason (e.g. budget exhausted, never started), when one was recorded — so a dropped verdict is explained rather than bare. waitSeconds > 0 long-polls server-side until the state is terminal for your waitFor, then returns; a longer wait is clamped to 45s (the serverless limit) and comes back with timedOut so you simply call again. waitFor "merge" keeps waiting through a request-changes retry loop but stops when nothing can land any more (escalated, failed, or an approval the policy leaves to a human).',
    record_pr_supersession: '{ workerId?, prNumber? (the CLOSED, unmerged PR that never landed — one of workerId/prNumber is required, same resolution as get_pr), workspaceId? (disambiguate when prNumber exists in multiple repos), supersedingPrNumber (required — the PR that carries this work now), supersedingRepo? (owner/name), reason (required — never a silent assertion) } — narrows `close_pr`/`merge_pr`\'s gap: a PR that closed without merging normally means the deliverable never shipped, and `canCompleteMission` blocks mission completion on exactly that. Use this when the diff actually landed anyway under a DIFFERENT PR (e.g. a mission integration branch was deleted out from under an open PR and the work was re-opened fresh) — it records a durable, auditable edge on the worker row, not a status you assert. REJECTED AT WRITE TIME, not discovered later: the target PR must exist (same repo, or supersedingRepo: another repo of this workspace or mission) and already be MERGED, and must differ from the PR being superseded; a 403/404/409 names which check failed. buildd auto-records this when a closed PR\'s content verifies in a merged PR; an unverified candidate is a mission-card suggestion. Once recorded, canCompleteMission, get_pr, get_task and explain all treat the superseded PR as shipped and name the PR it landed under.',
    update_task: '{ taskId (required), title?, description?, priority?, project?, status? (pending|completed|failed|cancelled), backend? (claude|codex, or null to fall back to the mission/role/workspace default), tier? (premium-plus|premium|standard|budget, or null to clear — pins the tier; setting a tier without model also drops an existing model pin), model? (Anthropic model id such as claude-…, or null to clear — pins an exact model and outranks tier), maxLoops? (1-50; only for an existing looped task), startAt? (ISO 8601 in the future, or null = start as soon as possible), startIn? (45m|3h|2d), abort? (true: with status cancelled, stop a live agent), pause? (true, on its own: pause the running agent instead of stopping it) } — updates task metadata. pause: true stops the agent at its next safe point and keeps its worktree and session; the task then waits like a question, and answering it (Resume on the task page) continues the same session. Refused for a task with no running agent or a local session. startAt/startIn reschedule a task that is still waiting (pending, unclaimed) instead of cancelling it; a claimed or running task is refused. pathManifest is NOT updatable here (rejected): it is set at create_task and grows only via check_path_claim. tier/model take effect on the next claim or retry; they do not change a running session. backend switches the agent provider; on a task paused by a provider budget/rate-limit it also lifts that provider\'s retry floor so the task is claimable immediately. status: cancelled on a task an agent is working on is refused (code live_worker) unless you also pass abort: true, because it stops that agent mid-run and loses anything it has not pushed; with abort: true it terminates the worker and releases its seat. To hold work that has not started, move its startAt instead of cancelling. maxLoops affects later loop dispatches but never changes an in-flight worker prompt; use send_agent_message to steer active work.',
    create_task: '{ title (required), description (required), label? (2–4 word noun-phrase shown as the task\'s chip next to its conventional-commit scope, max 48 chars — e.g. title "feat(fx): rates service with a 15-minute cache" → label "rates service"; no type prefix or filler words; derived from the title if omitted), workspaceId?, priority?, category? (bug|feature|refactor|chore|docs|test|infra|design|research — auto-detected if omitted), subjectAnchor?, fileAnywayReason? (nonblank explicit dedupe escape hatch), context? (legacy structured identity such as prNumber/headSha/frictionSignature; a PR the filing names, as #N in the title/description or context.prNumber/prNumbers, is linked to the new task so its run may close, update, merge or request review of it, but only a PR you may already act on yourself, or any named PR when a person files it), startAt? (future ISO 8601), startIn? (45m|3h|2d), startAfter? ("budget_reset"; mutually exclusive with startAt/startIn), outputRequirement? (pr_required|artifact_required|none|auto — default auto), outputSchema?, project? (monorepo project name for scoping), missionId? (auto-inherited from caller, except for [friction] tasks, which stay on trunk and only record context.relatedMissionId), parentTaskId?, dependsOn?, pathManifest?, roleSlug?, baseBranch?, headBranch? (pins the exact git branch claim_task assigns this task\'s worker, replacing the generated buildd/<id8>-<slug> name — the same mechanism a mission\'s shared integration branch uses internally, exposed here for a one-off task whose work must land on an existing or shared branch outside mission machinery. create_pr\'s ownership check also treats a PR headed at this branch as the task\'s own. Say it here, not in the title or description: free-text branch instructions are invisible to both claim_task and create_pr, so a task that merely describes the branch in prose gets a fresh generated one anyway and then has its PR refused as head_not_owned when it tries to use the described branch instead), verificationCommand? (command to run after completion), loopConfig? ({ exitCondition, maxLoops?, backoffMinutes?, waitExpiryMinutes? }; strict nested validation), loopUntilVerified? (true requires verificationCommand and expands to a command loop), loopUntilMerged? (true expands to loopConfig: { exitCondition: { type: "pr_merged" }, maxLoops: 6, waitExpiryMinutes: 240 } — task waits for PR merge via webhook, reaper-exempt until expiry), iteration?, maxIterations?, failureContext?, skillSlugs?, kind (state it on every task — coordination|engineering|research|writing|design|analysis|observation): the SHAPE of the work, not its subject. engineering changes code or config; research reads and reports without changing anything; writing produces prose or docs; design produces a visual or interaction artifact; analysis derives a judgment from data; observation watches something and records what it saw; coordination plans, routes or reconciles other tasks. It picks the model tier at claim time AND it is the only thing any surface draws this task\'s glyph from — a task filed without it is unlabelled on every screen for the rest of its life, and nothing infers it later from the title. complexity? (simple|normal|complex), tier? (premium-plus|premium|standard|budget — hard override that skips the kind×complexity matrix; premium-plus is Fable-class and ~2x premium per token, opt-in only), model?, effort? (low|medium|high), callbackUrl?, callbackToken?, release? ("true"|"false"|"inherit"), backend? (claude|codex), emitsPlan? (boolean, default false — spec-to-build opt-in: forces mode: "planning" and context.requiresPlanApproval: true, both non-overridable by the caller, and requires a non-empty pathManifest naming the spec document this task authors (400 otherwise). Use only when the task\'s entire deliverable is a breakdown that should become an approved, traceable plan — never inferred, always explicit) } — deferred tasks are not claimable before resolved startAt; unknown parameters are rejected, as are out-of-vocabulary kind/complexity values (they are never silently dropped)',
    manage_experiments: '{ action (required): "list" | "get" | "readout" | "create" | "update" | "start" | "pause" | "conclude", experimentId? (required except list/create), key?, title?, kind? ("model_routing" default), hypothesis?, treatmentFraction? (0-1 exclusive, share of ELIGIBLE tasks sent to the treatment arm; default 0.5), config? (model_routing: { arms: { treatment: { tier } }, eligibility: { maxBudgetPressure }, minSamplePerArm }), visibility? ("admins" default | "team"), decision? (required for conclude), policyVersion? (readout of an earlier version), workspaceId? } — team experiments. model_routing compares model tiers. heartbeat_triage and question_gate are retired kinds: existing rows stay listable/readable, but create and start are refused. create makes a draft; nothing enrolls until start. start (model_routing): from the next claim, eligible tasks (plain standard-tier routing, no pinned model, low budget pressure; the mission is the unit when there is one) are randomly split between the tier the router chose and the treatment tier, and every assignment is recorded. Only one experiment of each kind can run per team. pause stops new enrolment within a minute; conclude is final and records the decision. Changing treatmentFraction or config after the first start bumps policyVersion, and readout reports one version at a time. readout gives per-arm n, clean-completion rate with a 95% interval, the difference, and a verdict (insufficient_n until both arms reach minSamplePerArm). Every kind config also takes an optional duration cap, maxDurationDays and/or endsAt (ISO date); editing only the cap never bumps policyVersion, and a daily check pauses a running experiment once it is past its cap. list and readout also report enrolment health for running experiments: nothing enrolled for days, an arm never drawn, a split far off treatmentFraction, one unit (mission) holding most of an arm, past its cap. list/get/readout at worker level see only visibility="team" experiments; create/update/start/pause/conclude [admin]',
    manage_model_tiers: '{ action: "list" | "set" | "delete" | "policy" | "set_policy" | "adopt" | "model", workspaceId? (required for list; scopes set/delete to workspace override — omit for team-wide default; policy/set_policy/adopt: only an explicit workspaceId scopes to the workspace, omit for the team), tier? (required for set/delete: "premium-plus"|"premium"|"standard"|"budget"), provider? (required for set: "anthropic"|"openai"|"openai-codex"|"openrouter" — "openai" is the API-key provider for server-side calls such as chat; runners cannot use it), model? (required for set and model: full model ID, e.g. "claude-fable-5"), surface? (set/delete: "agent"|"chat" — scopes the row to agent runs or to chat and inference calls; omit for the row that serves both), defaultEffort? (set: "low"|"medium"|"high"|"xhigh"|"max"), defaultMaxTurns? (set: integer), mode? (set_policy: "latest-compatible"|"soak"|"manual"|"inherit"), soakHours? (set_policy with soak: default 72) } — manage team model tier registry and model upgrades. list returns the effective map (workspace+surface → workspace → team+surface → team → catalog → code fallback) with source annotation, one line per surface when a tier is split. set upserts a registry row (a pin: the tier stays on that model whatever the upgrade policy) — takes effect on next claim within 60s cache TTL. delete removes an override row, falling back to next level. Changing a tier row affects already-queued tasks; no deploy needed. policy reads the upgrade policy in effect and where it comes from (workspace/team/default), and per tier: the model, why it was chosen, any newer centrally certified model and why it is withheld (pinned/manual/soak), and deprecation. set_policy sets how catalog-resolved tiers move to newly certified models: latest-compatible adopts on certification, soak after soakHours with no compatibility incident, manual never on its own (adopt moves it); mode "inherit" clears the level. adopt (manual policy) takes every model certified so far. model shows one model\'s central certification: state, CLI floor, release/certification time, deprecation. [admin]',
    create_artifact: '{ workerId?, missionId?, initiativeId?, type (required: content|report|data|link|summary|email_draft|social_post|analysis|recommendation|alert|calendar_event|file|impl_plan|screenshot|recording|diff|walkthrough), title (required), content?, url?, metadata?, key?, taskId? } — workerId auto-resolved from context if omitted; for worker artifacts, taskId is auto-resolved from worker data if not provided. Pass missionId to create a mission-level artifact, or initiativeId to create an initiative-level artifact (roadmap/spec), without a worker context. taskId enables artifact notifications when the artifact is meant for review.',
    upload_artifact: '{ workerId?, filename (required), mimeType (required), sizeBytes (required — the exact byte size; the upload URL is signed for that size and a body of any other length is rejected), title?, type? (default: file), metadata?, missionId? (defaults to the task mission) } — Returns presigned upload URL. After calling, upload file with: curl -X PUT -H "Content-Type: {mimeType}" --data-binary @{filePath} "{uploadUrl}". Also returns downloadUrl for embedding in markdown.',
    list_artifacts: '{ workspaceId?, missionId?, initiativeId?, key?, type?, review?, limit? } — initiativeId returns initiative-level artifacts PLUS rolled-up artifacts from every child mission in one call. review: true narrows to artifacts deliberately produced for a human to read (reports, analyses, recommendations, anything named with a key or filed against a mission/initiative, anything shared publicly) and drops the captures — screenshots, diffs, uploaded files, machine markers. Same rule as the dashboard\'s "For review" view. Ignored when initiativeId is set.',
    get_artifact: '{ artifactId (required), revision? (read that immutable revision instead of the current body), view? ("outline"|"section"|"range"|"grep"|"meta"; default: the whole body when it is short, its outline when long), section? (id from the outline, with view section), offset? + length? (view range), grep? (literal text, with view grep), full? (true: the whole body however long) } — fetch an artifact by ID with its current revision and sha256. A long body comes back as an outline you read part by part, so a large reference never floods your context; what you read is recorded. File artifacts include a short-lived presigned download URL',
    update_artifact: '{ artifactId (required), title?, content?, metadata?, expectedRevision? (with content: write only if the body is still at that revision, else refused with the current one — pass the currentRevision get_artifact showed) } — every content change is kept as a new immutable revision',
    create_schedule: '{ name (required), cronExpression (required), title (required), description?, timezone?, priority?, mode?, skillSlugs?, roleSlug? (role every spawned task runs as; applied only while that role exists in the workspace, else the task files role-less), trigger?, workspaceId? } [admin]',
    update_schedule: '{ scheduleId (required), cronExpression?, timezone?, enabled?, name?, taskTemplate?, skillSlugs?, workspaceId?, delegation? ({ grants: [{ workspaceId (UUID), capabilities: (\"analytics:read\" | \"tasks:create\")[] }] } or null to clear) } [admin] — delegation lets the tasks this schedule spawns read the named workspaces\' analytics (decision ledger, decision/coordination stats, gate ledger) and/or file tasks there, and nothing else. Same team only; team admin or owner only; recorded with who granted it and when.',
    delete_schedule: '{ scheduleId (required), workspaceId? } — remove a schedule permanently; prefer pause_schedules if you might need to re-enable it. [admin]',
    list_schedules: '{ workspaceId?, minutesAgo? (filter to schedules whose lastRunAt is within this window — use to identify "what just fired?"), nameContains? (case-insensitive substring filter on schedule name), type? ("heartbeat" | "workspace" | "all", default "all" — heartbeat schedules are mission-owned and not independently pausable/editable; pass "workspace" for the schedules you can actually act on) } — read-only, available at all token levels. Output includes lastRunAt, lastError, and an output-channel hint (e.g. "sends pushover via dispatch") inferred from the task template.',
    trace_schedule: '{ taskId? OR minutesAgo? OR taskTitleContains?, workspaceId? } — reverse-lookup: given a stray task or a recent notification, find the schedule that spawned it. taskId is the strongest signal (uses the schedule_id FK); minutesAgo lists schedules that fired within the window; taskTitleContains matches on the task template title.',
    pause_schedules: '{ workspaceId?, scheduleIds? (string[]), namePattern? (case-insensitive substring), enabled? (default false — pass true to resume) } — bulk-flip the enabled flag on schedules. Provide scheduleIds for an exact list, namePattern to match by name, or omit both to apply to all schedules in the workspace. The 2am kill-switch when a schedule is misbehaving. [admin]',
    register_skill: '{ name (required), content (required), description?, source?, workspaceId?, slug?, model? (recommended: "premium-plus"|"premium"|"standard"|"budget" for tier-driven dispatch — tier-first is the preferred path; "inherit" to follow team default; exact model IDs like "claude-sonnet-5"|"claude-fable-5" are valid for pinning; legacy shorthands "opus"|"sonnet"|"haiku" still accepted), allowedTools? (string[]), canDelegateTo? (string[]), background? (boolean), maxTurns? (number), color? (hex string), mcpServers? (Record<string, McpServerConfig> or string[]), requiredEnvVars? (Record<string, string>), connectorRefs? (string[] of connector IDs this role mounts — role-level opt-in to team connectors), isRole? (boolean), defaultBackend? (claude|codex|null — default agent engine for tasks routed to this role; task.backend overrides), whenToUse? (20–300 chars: the work this role should pick up; a role without it is never inferred for a role-less task), notFor? (≤200 chars: nearby work that belongs to another role, named), claudeAiArtifacts? ("off"|"read"|"publish" — lets this role\'s sessions use Claude Code\'s claude.ai Artifact tool on the team seat: read/list only, or also publish for artifact producers; delete is always refused; a task overrides with context.claudeAiArtifacts), personal? (true: a role owned by YOU instead of a team skill — any member, worker level; starts private, only you can use it; goes to /api/roles, ignores workspaceId; no mcpServers or operator grant, requiredEnvVars only map your own secrets), visibility? (with personal: "team" shares it on create), teamId? (with personal: defaults to the session team) } — create/upsert skill by slug [admin; personal: true at worker level]. A per-task token or API key cannot create a personal role (no person behind it).',
    list_skills: '{ workspaceId?, enabled? (boolean), isRole? (boolean), personal? (true: personal roles instead, yours and ones shared with the team, never another member\'s private one; worker level) } — list skills/roles in workspace [admin; personal: true at worker level]',
    get_skill: '{ slug (required), workspaceId?, personal? (true: read a personal role by slug, your own first, else a shared one; worker level) } — fetch full skill body and config by slug. Returns the same shape register_skill accepts, so the result can be edited and passed back to update_skill [admin; personal: true at worker level]',
    update_skill: '{ slug (required), workspaceId?, name?, description?, content?, model? (recommended: "premium-plus"|"premium"|"standard"|"budget" for tier-driven dispatch — tier-first is the preferred path; "inherit" to follow team default; exact model IDs like "claude-sonnet-5"|"claude-fable-5" are valid for pinning; legacy shorthands "opus"|"sonnet"|"haiku" still accepted), allowedTools?, canDelegateTo?, background?, maxTurns?, color?, mcpServers? (Record<string, McpServerConfig>), requiredEnvVars? (Record<string, string>), connectorRefs? (string[] of connector IDs this role mounts), isRole?, repoUrl?, enabled?, defaultBackend? (claude|codex|null), whenToUse? (20–300 chars, null clears), notFor? (≤200 chars, null clears), claudeAiArtifacts? ("off"|"read"|"publish", null clears), personal? (true: edit a personal role by slug — your own first, else a shared one; worker level, the owner or a team admin once shared may edit), visibility? (with personal: "team" shares it with the team, "private" takes it back) } — update skill by slug [admin; personal: true at worker level]',
    delete_skill: '{ slug (required), workspaceId?, personal? (true: delete your own personal role, or a shared one as a team admin; worker level) } — delete skill by slug [admin; personal: true at worker level]',
    manage_evidence_backends: '{ action: "list" | "get" | "create" | "update" | "delete" | "verify", backendId? (required except list/create), workspaceId? (create: scope the backend to one workspace; omit for the team default), provider? (create: "s3" | "r2" | "s3_compatible" | "buildd_default"), endpoint? (https URL; required for r2 and s3_compatible; must resolve to a public address), region?, bucket? (required except buildd_default), prefix? (one path segment, default "evidence"), forcePathStyle?: boolean, sse? ("none" | "AES256" | "aws:kms"), kmsKeyId? (only with aws:kms), retentionDays? (1-3650, default 30), maxBytesPerTask? (bytes, default 8 MiB), credentials? ({ accessKeyId, secretAccessKey, sessionToken? }; required for create, replaces the stored credential on update; never returned) } — where a team\'s run evidence is written: a workspace backend beats the team backend, which beats the buildd-managed bucket. create and update verify the bucket on save (PUT, GET, DELETE of one probe object under {prefix}/.buildd-probe/, never a list) and report it; a failing probe does not reject the save or affect any task. verify re-runs the probe and warns when the probe object is readable without credentials. provider and workspaceId cannot change after create. [admin]',
    manage_providers: '{ action: "list" | "set" | "delete" | "explain" | "set_policy", provider? (required for set/delete: anthropic | claude-subscription | openai | codex-subscription | openrouter | litellm | custom-endpoint), scope? ("team" | "workspace" | "mine"; set/delete default: mine for a signed-in person, else team), workspaceId? (required with scope workspace), shape? (api_key | setup_token | gateway | endpoint; default the provider\'s pasteable one), value? (set: the key or token; never echoed back), config? (set: gateway { baseUrl }; endpoint { baseUrl, authHeader?, models?, appliesTo?, capabilities? }), surface? (explain, required: chat | agent-claude | agent-codex | cloud-egress; set: refuse unless the provider serves it), as? (explain: "self" your own work, default for a person | "team" team work), policy? (set_policy: team | personal_first | personal_only) } — model providers and their credentials, one write path for every surface. list: each provider, what it serves and why not (registry reasons), per scope the rows set (last four, health, legacy storage, what reads them today), and the credential policy. set validates and verifies before storing; a subscription login (oauth) is refused with a link to finish in the browser. explain: what the resolver would pick for a surface and why, never a value. Impossible provider×surface or scope pairs are refused with the registry reason. list/explain: worker level (a task token: its own workspace). set/delete scope mine: a signed-in person (OAuth session), never a task token or API key. set/delete scope team|workspace and set_policy [admin]',
    manage_secrets: '{ action: "list" | "set" | "delete", label? (required for set — env var name), value? (required for set — the secret value), purpose? (default: mcp_credential), secretId? (required for delete) } — manage encrypted MCP credential secrets [admin]',
    list_discrepancies: '{ workspaceId?, direction? ("spec_ahead"|"code_ahead"|"contradicted"), status? ("open"|"accepted"|"resolved") } — spec_discrepancies ledger rows (docs/design/spec-conformance.md §7/§13), oldest first. workspaceId resolves the same way as other workspace-scoped actions (UUID, repo name, or falls back to context).',
    get_discrepancy: '{ discrepancyId (required) } — one ledger row, including `evidence`: the exact file/symbol/route/migration the checker read and what it found. Never a similarity score — spec_compare already covers "how related is this text."',
    adjudicate_discrepancy: '{ discrepancyId (required), action: "accept" | "flip_direction", reason (required, non-blank), newDirection? ("spec_ahead"|"code_ahead" — required when action="flip_direction") } — accept parks the row (status=accepted) with `reason` recorded; flip_direction is the only path off a `contradicted` row and requires newDirection. [admin]',
    promote_discrepancy: '{ discrepancyId (required), title?, description? } — mints a mission via the same POST /api/missions primitive manage_missions action=create uses, then links it back onto the row. Only `spec_ahead` rows (confirmed by the Tier-3 cron, not a bare CI `contradicted`) may be promoted — a `code_ahead` or `contradicted` row is rejected per docs/design/spec-conformance.md §8\'s promotion table. Calling this on an already-promoted row returns the existing mission instead of minting a second one. [admin]',
    approve_plan: '{ taskId (required) } — approve planning task, create child execution tasks [admin]',
    reject_plan: '{ taskId (required), feedback (required) } — reject plan with feedback, create revised planning task [admin]',
    manage_missions: '{ action: "list" | "create" | "get" | "update" | "arm" | "delete" | "link_task" | "unlink_task" | "evaluate" | "get_criteria_state", missionId? (UUID, or a title to find), title? (get/update without missionId: finds by title, no rename), query? (list/get: title substring), description?, workspaceId? (title lookup: scope; update by UUID: move), initiativeId? (parent initiative; null unlinks), cronExpression?, priority?, status? (list: default "open" = not completed/archived, or all when query given; "all" for history), limit? (list: default 20, newest activity first), all? (get: every linked task, the full description and full criterion evidence; default is 15 tasks with unfinished ones first, a 600-char description and 300-char evidence, each cut saying how much it left out), fullDescription? (get: the full description only), taskId?, startAt? (future ISO 8601), startIn? (45m|3h|2d), startAfter? ("budget_reset"), skillSlugs?, model?, isHeartbeat?: boolean (check-ins, default true for a new auto mission: an hourly stuck check that starts the organizer only when the mission is stuck; the next step is planned when work finishes either way. false opts out), heartbeatChecklist?: string (the organizer checklist), activeHoursStart?: number, activeHoursEnd?: number, activeHoursTimezone?: string, maxConcurrentTasks?: number (mission parallel cap, integer 1–20; overrides the workspace cap up or down for its tasks), dependsOnMission?: string, gateCondition?: "merged" | "completed", orchestrationMode?: "auto" | "manual", decomposition?: "auto" | "none" (create only, default "auto" — filing the task chain yourself right after create? pass decomposition:"none" so the organizer\'s first planning pass is born coordinate-only instead of racing your own create_task calls with its own decomposition; "auto" lets the organizer decompose from the mission description as today. Equivalent to orchestrationMode:"auto" PLUS decompositionSkipped set before the organizer\'s planning task exists — the reactive pre-filed-task detection in runMission() only runs ONCE, at that same creation request, so it is always too early to see tasks you file afterward), costBudgetUsd?: number (pause and notify when cumulative worker spend reaches this threshold), pacingMode?: "eager" | "paced" (default "eager" — "paced" enforces a minimum interval between task starts), pacingMaxPerHour?: number (tasks per hour when pacingMode="paced"; default 1), startMode?: "armed" | "held" (default "armed" — held missions block all task claims until armed; arm action or startMode=armed releases them; force-starting a single task bypasses the gate), executor?: "runner" | "local" (default "runner" — who runs its tasks. "local": a person runs them from their own interactive session (Claude Code + local subagents); background runners never auto-claim them, the session claims each one with claim_task {taskId} and gets a normal tracked worker (PR link, cost), then finishes it with complete_task. Use this — not startMode=held — for work you run locally: held is a pure pause, blocks interactive claims too, and wins over executor), goalCriteria?: GoalCriterion[] (outcome-oriented completion gates that BLOCK mission completion until they pass; null clears; each criterion MUST have type (required) — one of: "command" | "all_prs_merged" | "no_open_tasks" | "artifact_exists" | "metric" | "description"; all types accept optional label:string. PREFER A MECHANICAL FORM: "command" runs a real command in the mission workspace (buildd dispatches a verification task and the exit code IS the verdict), and all_prs_merged / no_open_tasks / artifact_exists are read from DB state. "description" is prose, graded by one of two graders set by optional grader:"auto"|"api"|"runner" on the criterion (else the workspace gitConfig.criteriaGrader, else "auto"): "api" makes one inference call on the team\'s API key (per-token; with no key the criterion reads NOT_EVALUATED saying so, it never switches grader), "runner" dispatches a read-only verification task per criterion that a runner agent grades asynchronously on the team\'s own seat (OAuth included; the criterion reads PENDING "verifying on runner…" meanwhile, and says "waiting for a runner" if nothing claims it), "auto" uses api when a key resolves and runner otherwise. A prose verdict can still come back NOT_EVALUATED (unsure, failed run) which never counts as a pass, so "description" REQUIRES notMechanizableReason:string (10+ chars) saying why no mechanical form fits; writes without it are rejected 400. "metric" has no evaluator yet, so it stays UNVERIFIED and blocks completion — do not use it as a gate. Type-specific required fields: command→command:string, description→description:string+notMechanizableReason:string+grader?:"auto"|"api"|"runner", metric→query:string+operator:"gt"|"gte"|"lt"|"lte"|"eq"|"neq"+threshold:number+unit?:string, artifact_exists→key?:string+artifactType?:string. Example: [{type:"command",command:"bun run scripts/run-unit-tests.ts packages/core/__tests__/foo.test.ts",label:"no double-fire"},{type:"all_prs_merged"}]), autoVerify?: boolean (default true — when false, organizer never auto-evaluates criteria; on-demand still works; evaluation also fires automatically on mission completion when all tasks are done), autoSurfaceAudit?: boolean (default true — when a builder task under this mission declares a pathManifest touching apps/web/src/app/** or apps/web/src/components/**, a `[surface audit]` task is auto-appended, gated on every builder task in the mission; idempotent, re-runs extend its dependsOn instead of duplicating it. Set false to opt a non-UI or intentionally-unaudited mission out. Independently, a mission whose merged PRs changed UI files cannot complete without a passed audit; the refusal says so), surfaceAuditWaiver?: string (update only, a person\'s call: the reason (10+ chars) a mission that changed UI ships without a visual audit. Recorded on the mission and lets completion through; an in-task agent is refused), branchStrategy?: "mission-branch" | "direct" (create: omitted defaults to the workspace configured default; update: omitted means no change. "mission-branch" gives the mission one shared integration branch — every task PR bases on it instead of trunk, and the merge-policy tier applies once, to the single mission-to-trunk PR, when the mission work is done; the integration branch is created on the remote automatically, in the same call that sets this. "direct" is the current per-task behaviour — each task PR bases on and targets trunk directly, so the merge-policy tier applies once per task PR. Invalid values are rejected, not coerced). action=evaluate triggers on-demand criteria evaluation (rate-limited 6/hour) and returns GoalCriteriaState. action=get_criteria_state returns last GoalCriteriaState without re-evaluating. } — deferred missions are active but inert until resolved startAt; held missions have tasks that are not claimable; local-executor missions have tasks only an interactive session claims [admin]',
    manage_initiatives: '{ action: "list" | "create" | "get" | "update" | "delete" | "link_mission" | "unlink_mission", initiativeId?, missionId? (for link/unlink), title?, description?, workspaceId?, status?: "planned" | "active" | "paused" | "completed" | "archived" (set by a person; nothing derives or auto-advances it), priority?: number, ownerUserId?: string (a member of the initiative\'s team; null falls back to the creator; create defaults to the caller), targetDate?: "YYYY-MM-DD" | null (optional calendar target). Initiatives carry no KPIs: put checkable outcomes in mission goalCriteria. } — an initiative is an execution-free container above missions (initiative → mission → task), like a Linear initiative. Progress is missions done over missions. "get" returns a KB-optimized brief: rolled-up progress + child missions + initiative-level artifacts. Create/update auto-index the initiative into the team knowledge base (recall/query_knowledge corpus=initiative). [admin]',
    link_tracker: '{ entityType: "mission", entityId (required), url (required — a Linear project/issue URL) } — link a buildd entity to an external work tracker so task completions post back automatically. Phase 1 supports entityType="mission" (mission ↔ Linear project); the workspace must have a Linear connector configured. The external id is parsed deterministically from the URL, so re-linking the same URL is idempotent. [admin]',
    manage_workspaces: '{ action: "list" | "get" | "create" | "update" | "create_repo" | "init" | "readiness" | "scaffold" | "author_spec", workspaceId? (required for get/update/create_repo/init/readiness/scaffold/author_spec), name?, repoUrl?, defaultBranch?, accessMode?, org?, private? (default true), description?, maxConcurrentTasks? (number — update action only: workspace-level parallel worker cap; default 3; this is the floor — missions may raise the effective cap above it; action=get returns maxConcurrentTasks and maxConcurrentTasksSource ("default"|"explicit") so you can distinguish 3-by-default from 3-set-deliberately without a write), gitConfig? (object — partial gitConfig fields, shallow-merged server-side; gitConfig.criteriaGrader: "auto"|"api"|"runner" sets the workspace default grader for prose goal criteria; gitConfig.executor: "cloud"|"host"|"any"|null sets where its tasks run (cloud: host runners never claim them; host: cloud claims never do; null derives cloud from a cloud dispatch webhook, else any); who merges PRs is gitConfig.mergePolicy ({ tier: "auto-threshold" (merge on green CI) | "agent-review" | "human" }), not the legacy autoMergePR / autoMergeOnGreenCI flags, which nothing reads; to apply a detected policyConfig from action=init, use gitConfig.policyConfig; merge-policy paths are detected by action=init, never typed), releaseConfig?: { enabled: boolean, strategy?: "workflow_dispatch"|"branch_merge"|"script" (absent ⇒ branch_merge), workflowFile? (workflow_dispatch — e.g. "release.yml"), ref? (workflow_dispatch/script — e.g. "dev"), inputs? (workflow_dispatch — string-valued workflow inputs), prodBranch? (branch_merge — e.g. "main"), releaseBranch? (branch_merge — e.g. "dev"; when set, releases promote an open releaseBranch→prodBranch PR instead of merging the completing task\'s own branch directly; distinct from prodBranch, and NOT the same field as ref, which only applies to workflow_dispatch/script), deployTarget?: { type: "vercel", projectId?: string, teamId?: string }, postDeployHooks?: Array<{ type: "http"|"buildd_mcp", description: string, url?: string, action?: string, params?: object, headers?: object }>, verificationUrl?: string, command? (script — e.g. "bun run release") }, preset? ("cautious"|"balanced"|"autonomous" — only for action=init; default "balanced"), reviewerRole? (skill slug — only for action=init; which reviewer agent to use for agent-review escalations) } — manage workspaces and bootstrap new projects. Use get to retrieve the current gitConfig, configStatus, releaseConfig, and maxConcurrentTasks before making temporary changes. The releaseConfig.strategy decides how releases run: "workflow_dispatch" dispatches the repo\'s own release workflow (most general), "branch_merge" merges into prodBranch on task completion + verifies deploy (or, when releaseBranch is set, promotes releaseBranch to prodBranch via an open release PR instead), "script" runs a release command (not yet implemented). New project flow: 1) manage_workspaces action=create (name + optional repoUrl) to create workspace under your team, 2) Agent claims task in that workspace, 3) If no repo yet: manage_workspaces action=create_repo to create GitHub repo, or action=update to link existing repo, 4) Agent scaffolds project, commits, pushes, 5) Future tasks automatically resolve to the repo directory. action=init scans the repo and proposes a semantic risk-class policy (policyConfig) — paths are auto-detected from the repo structure, never hand-typed. Returns the proposed config for confirmation; apply with action=update gitConfig.policyConfig=<proposed>. action=readiness: read-only repo checklist + nextStep; load skill workspace-onboarding. action=scaffold: itemIds? (none = no-op), dryRun? (default true, creates nothing), confirm? (true = one PR task; human merges). action=author_spec: answers (the shared interview Q1-Q8 object: title, description, capabilities[{name,invariants,accepted,rejected,codePaths?}], outOfScope?, verification?, protectedAreas?), owner?, dryRun? (default true, returns the draft spec markdown only), confirm? (true = one PR task adding that one file). [admin]',
    manage_watched_projects: '{ action: "list" | "create" | "update" | "delete" | "run", workspaceId? (required for list/create), projectId? (required for update/delete/run), repo?, enabled?, vercelProjectId?, inFlightWindowMin?, prodGraceMin?, roleSlug?, pushoverApp? ("tasks"|"alerts"), releasePrFilter? ({ base?, label?, titlePrefix? }), notes? } — manage project health watcher rows. The watcher fires a buildd task + Pushover alert when CI breaks on release PRs or Vercel prod is unhealthy. Vercel checks require vercelProjectId. "run" forces an immediate check on one row (handy for testing). [admin]',
    trigger_release: '{ workspaceId? OR repo? (owner/name — one is required), ref?, workflowFile?, inputs? (string-valued workflow inputs), force? (folded into inputs.force) } — trigger a release. The workspace\'s releaseConfig.strategy decides what happens; buildd no longer assumes dev→main. For "workflow_dispatch" workspaces this dispatches the repo\'s release workflow and READS THE RUN BACK (returns runId/runStatus/runUrl when resolvable, else runsUrl). NOTE: dispatching a workflow typically OPENS the release PR — it does not itself deploy; prod ships only when that PR passes CI and merges, and force bypasses BOTH the empty-commit check in the workflow itself AND buildd\'s own in-flight dedup guard for this headSha (without force, a repeat call for a commit already dispatched returns the existing release without re-dispatching — reported as "not dispatched", not as success). "branch_merge" workspaces release automatically on task completion (not via this trigger). For an unconfigured workspace, pass workflowFile + ref explicitly. Call release_status first to fire informed. Uses the buildd GitHub App installation token. [admin]',
    release_status: '{ workspaceId? OR repo? (owner/name — one is required), ref?, prodBranch? } — read-only release preflight: what would ship (commits on ref ahead of prodBranch), whether the source ref\'s CI is passing/failing/pending, and whether a release PR is already open. Use before trigger_release to decide if releasing is safe right now. [admin]',
    emit_event: '{ workerId?, type (required), label (required), metadata? } — workerId auto-resolved from context if omitted',
    query_events: '{ workerId?, type? } — workerId auto-resolved from context if omitted',
    explain: '{ taskId? | missionId? | workspaceId? | prNumber? (exactly ONE subject; workspaceId may also accompany prNumber to disambiguate a number that exists in several repos), limit?, offset? (workspace scope: page size, default 5, max 25) } — deterministic read: what state a subject is in, what it is waiting on, and the evidence. Returns `state` + `waitingOn` from the one shared mission-state accessor, an ORDERED `because[]` causal chain whose elements carry hard refs (taskId, prNumber, commit SHA, criterion label, error signature, conflicting file paths), `history[]` with retries/review passes collapsed under their parent task, `nextAction` (or explicit null), and `derivedFrom` naming which row or derivation produced each field; a task or PR subject also carries `evidenceObjects[]` (id, kind, bytes, state; read with read_evidence). Workspace scope returns only the subjects that are waiting on something, ranked — not a dump: one page of summaries (state, waitingOn, situation, nextAction, the first causal links) with the omitted count, each naming the explain call that returns its full evidence. A pending task whose latest dispatch wake is undelivered past due, handed off to Dispatch with no receipt, or failed carries that as a because[] link with refs.outboxId. A conflicted PR reports the merges into its base since it opened, the files they touched, and which of those this branch touches too. No model is called and no merge is attempted: read the evidence and narrate it yourself.',
    get_error_traces: '{ workerId?, taskId? (full UUID or 8+ char prefix), workspaceId?, since? (ISO date; workspace default 7d), limit? (traces: default 50, max 500; workspace patterns: default 20, max 100) } — returns errors caught from agent tool output: every non-zero Bash exit (redacted command, exit code, output tail) plus known patterns (cd: No such file, git fatal, OOM, etc.). taskId also returns the evidence record written when the task ended (error class, key lines, last failing command, CI checks) and any mismatch flags — the answer to "why did it fail". workerId/taskId list individual traces; workspaceId returns a per-pattern rollup (count, tasks hit, first/last seen, latest excerpt, example taskIds) to tell a new failure from a recurring one. Defaults to the caller worker\'s task, or to the session workspace rollup when there is no worker context.',
    get_budget_forecast: '{ workspaceId? } — returns the current budget forecast for the caller\'s team: Claude learned floor pressure (forecast, not provider usage; source, observation age, sample basis) and Codex exhaustion, monthly dollar budget (spent/cap, burn rate, depletion estimate), and top mission budgets by % spent. Use before dispatching heavy task chains — learned pressure is advisory and must not be treated as a hard budget wall; use provider exhaustion or monthly depletion for startAfter: "budget_reset".',
    get_manifest_coverage: '{ workspaceId?, missionId?, window? (24h|7d|30d, default 7d) } — aggregate share of tasks created in the window with concrete, wildcard-only, or missing path manifests. Includes workspace, mission and kind breakdowns; concreteShare is a fraction in [0,1], null for no tasks.',
    get_path_claim_stats: '{ workspaceId?, missionId?, window? (24h|7d|30d, default 7d) } — check_path_claim call counts and claimed, blocked, deadlock and rejected outcomes from the decision ledger, with transport breakdown and explicit instrumentation coverage. Historical unrecorded successful calls cannot be reconstructed.',
    get_decision_stats: '{ workspaceId?, missionId?, window? (24h|7d|30d, default 7d), capability?, since?, until?, limit?, overriddenOnly?, disagreementOnly? } — with capability (e.g. \"question_gate\", or an orchestration_* one such as orchestration_claim, read from orchestration_decisions with the applied START/HOLD in byAppliedAnswer): the decision ledger for that capability in one workspace — every decision with verdict (for the question gate its decide / hold / ask disposition), confidence, reason, the answer in effect, any later human override and outcome labels, plus a summary; since/until (ISO, at most 31 days) pin a stable window, limit (max 500) bounds the page and truncated + nextUntil continue it. Every answer starts with status: OK or NO_DATA reached the data; FORBIDDEN, UNAUTHORIZED or TOOL_UNAVAILABLE did not, and is never evidence of zero decisions. A scheduled task reads another workspace only when its schedule delegates analytics:read on it. Without capability: orchestration decision-shadow ledger counts (orchestration_decisions, orchestration_manifest_predictions): totals, applied/suggested/fallback, labelled vs unlabelled, by decision group (capability, decisionId, fingerprint, policy, arm), by UTC day and by fallback reason, plus each workspace\'s opt-in state so zero rows can be told apart from a disabled capability. The DB-free substitute for querying the ledger directly.',
    get_usage_stats: '{ workspaceId?, window? ("24h"|"7d"|"30d", default 7d), groupBy? ("role"|"workspace"|"executor"|"creationSource"|"none", default role) } — read-only consumption stats for the caller\'s team: tokens/cost/turns/tool-calls per task (median and p90, not just mean — token spend is heavily skewed), the tool histogram (which tools agents actually reach for, and which MCP servers), per-model token split, and per-group success rate and completed-task count. groupBy "executor" splits work claimed from an interactive MCP session (claim_task, workers.runner = "mcp") from work a background runner claimed, with placeholder workers no runner executed (system, external, openclaw) under "other". Use it to answer "what does a task from this role cost" or "which tool is eating the context window" before optimizing a prompt or role. groupBy="role" reports a routed role (one the decision model filled in) as its own "<Role> · inferred" group beside the stated one, and every role group carries median/p90 time-to-claim. groupBy="creationSource" splits by where a task was filed from (dashboard, api, mcp, github, local_ui, schedule, webhook, orchestrator, conflict) — use it to size the "(unassigned)" role bucket by origin instead of reporting it qualitatively; note a chat-filed task is stamped creationSource "dashboard", so this split alone still can\'t separate chat from dashboard quick-adds. Tool numbers carry a coverage line: exact histograms exist only for workers that ran after the histogram shipped; older tasks are reconstructed from a capped MCP call log and are a floor. Also returns every tool, Bash intent buckets and code-search shapes (exact-histogram tasks only) and per-action buildd calls (recorded since capture began), each with its own coverage line.',
    read_evidence: '{ taskId? | prNumber? | evidenceId? (one is required; taskId: full UUID or 8+ char prefix), workspaceId? (with prNumber or evidenceId; defaults to the session workspace), kind? ("command_output"|"test_report"|"ci_job_log"|"transcript"|"pr_diff"), tail? (last N lines, max 10000), grep? (case-insensitive regex, max 200 chars, at most one * or +), cursor? (from a previous truncated read) } — read the stored run evidence behind a task or PR: full failing command output, test reports, CI job logs. evidenceId also reads a runner-hosted Quality Scout run command log (cited in a probe result as evidence:<id>). With no tail/grep (and no evidenceId) it lists the objects; with tail or grep it reads the newest matching object. Text is redacted and capped at 64 KB; a truncated read says so and returns a cursor. Never returns a download URL.',
    dispatch_health: '{ workspaceId? } — read-only Dispatch transport health for the caller\'s team (or one of its workspaces). Leads with a one-line verdict (healthy, or what is wrong), then the outbox counts (pending, due, overdue, delivering, stuck, handed off, unacked, unacked past the in-app fallback, orphaned, failed in 24h), deliveries in 24h by route (delivered_via), delivery latency p50/p95 (delivered_at minus not_before), whether the Dispatch Worker answers /health, the last hourly floor run\'s reconcile counts (platform-wide; any repair there is a bug signal), and workspaces not on the dispatch transport (the kill switch). Counts come from Postgres, which receipts keep in step with the Worker; the only Worker call is the /health probe. For one task\'s wakes use get_task include:["dispatch"]; for why a pending task has not started use explain.',
    get_failure_analytics: '{ workspaceId?, window? (24h|7d|30d — default 7d), error? (raw error text; switches to signature-lookup mode), errorPrefix? (literal prefix, e.g. "needs_input:"; switches to signature-family rollup mode), family? ("gate" — switches to the GATE LEDGER), limit? (top signatures, default 5, max 15) } — read-only worker-failure aggregation for the caller\'s team. Without error/errorPrefix: totals, failure rate, died-early count, top exit causes and top error signatures. With error: normalizes your error the same way the aggregation does and answers whether it is an already-known pattern, with count and first/last seen, plus a frictionSignature you pass as create_task context.frictionSignature so your friction report appends to the existing one instead of filing a duplicate. With errorPrefix: same frictionSignature handoff, but aggregated across every normalized signature sharing that literal prefix — use this for a failure family whose free-text tail (e.g. the embedded question in `needs_input: <question>`) makes each occurrence its own singleton signature invisible to both the overview and an exact error= lookup. With family="gate": the GATE LEDGER instead — every server-side refusal, deferral, advisory warning and explicit BYPASS, ranked by gate with a bypass rate each. A creation-time 400 never becomes a failed worker, so none of this is visible in any other mode; bypass rate over a lint IS its false-positive rate. The overview also reports PR landing: p50/p90 time from approved-and-green to merged, and how many PRs are stuck past the 30-minute target, plus full knowledge-ingest jobs no runner has taken. Combine family="gate" with errorPrefix to roll up gate reasons sharing a literal prefix. Call this before filing friction — it is the difference between "new bug" and "the 30th occurrence this week".',
    list_incidents: '{ workspaceId?, status? (CSV open|acknowledged|resolved, or "all"; default open,acknowledged), severity? (CSV low|medium|high|critical), rule? (CSV of rule names), signature? (exact), limit? (default 50, max 200) } — read-only: the Failure Pattern Sentinel\'s incident ledger. Each incident has severity, rule, first/last seen, counts, alert state and any linked fix task. Check it before filing a `[friction]` task: a systemic pattern may already be tracked. counts.total ignores limit.',
    get_page_source: '{ workerId?, sha? (commit to audit; default the head of captureRef.ref), prNumber? (use this PR\'s head commit instead, e.g. when that branch deploys to Production), waitSeconds? (0-45 long-poll on a preview still building) } — where the visual auditor\'s pages come from, per gitConfig.visualQa.pageSource (sandbox | vercel-preview | auto), and which branch to capture: captureRef { ref, source, integrationBase } is the mission\'s integration branch on a mission-branch mission, else trunk — dispatch the sandbox capture with --ref captureRef.ref and record it on every shot as qa.ref / qa.refSource. Reads the commit\'s GitHub deployment statuses (no Vercel credential) and returns the source, the preview URL when one is READY, or why not: "pending" (call again), "preview_unavailable" (loud: ask the owner, never pass). Also names the env vars capture reads for the two auth walls and whether each is mapped. Returns no secret.',
    deploy: '{ workerId?, provider (required: cloudflare), project (required), environment (required), credentialRef (required — the stored credential\'s reference: its label, or the provider name when unlabelled), operation (required: status|put_secret|upload_worker|ensure_bucket), params? } — Platform Operator deployment, run server-side with a stored credential you never see. Allowed only when this task\'s role is the Platform Operator AND this workspace\'s Operator grant covers the operation\'s capabilities (deployments:read or deployments:write, plus deployment_secrets:use) for exactly this provider, project, environment and credential ref; anything else is refused with a reason (not_enabled, capability_not_granted, project_not_allowed, ...). The Cloudflare Worker is the project in production and <project>-<environment> elsewhere. params by operation — status: none (latest deployment id/versions, secret NAMES, workers.dev URL); put_secret: { name, value } (value is sent to the Worker and never echoed); upload_worker: { modules: [{ name, content }], mainModule?, compatibilityDate (YYYY-MM-DD), compatibilityFlags?, vars? } (a built module bundle, e.g. `wrangler deploy --dry-run --outdir dist`, which needs no credential; existing secrets are kept; 3 MB cap); ensure_bucket: { bucket? (default <script>-snapshots; must start with <script>-), lifecycle?: [{ id, prefix, expireDays }] }. Every call, allowed or refused, is written to the deployment audit trail with the credential reference only. Returns { auditId, target, operation, result } and never a credential.',
    list_runners: '{ workspaceId? } — runners the caller can see: per runner "a busy of b slots", browser (yes = online now), branch, runner build and update state (currentCommit, diskCommit, commitDrift, updating, updateAvailable[Since], upToDateWithDeployed on main), workspaces, last heartbeat. Cloud runs (one container per task) are one elastic group per dispatcher, "N running", with each run nested. With workspaceId: only its runners, led by "Browser-capable runner online for <ws>: yes/no".',
    get_visual_review: '{ missionTitle? | missionId?, workspaceId?, awaitingOnly? } — a mission\'s visual QA: phase; each audit task (status, times, why); per route+viewport: round, agent verdict, finding, human decision, fix task, shot links; manual shots and reports; what needs you. missionTitle is team-wide unless workspaceId. No mission: missions waiting on you. [admin]',
    resolve_capability: '{ capability?, roleSlug?, workspaceId? } — what could satisfy a semantic need in this workspace, before choosing a role. capability is domain:verb, domain one of observability|deployment|database|analytics|work_tracking|docs|source_control, verb read|query|write (e.g. "observability:query", "deployment:read"); omit it to list every need something here serves, with what is available now. Returns ranked candidates: provider (catalog slug), installed connector or null, match exact|partial|category, access permitted|auto_grant (route to a role in roles.withAccess)|ask_admin|forbidden (team blocked it)|reconnect|unhealthy, availableNow, health, workspace enablement, compatibility (unknown_until_tested = the provider may refuse a Buildd-run client), risk (writeToolsExposed: mounting exposes every native tool, so read does not mean read-only), runtimeNeeds, nextSteps. Plus operator (Operator deploy grant, deployment needs only) and unclassifiedConnectors. roleSlug defaults to your own task\'s role under a per-task token. Read-only: installing, enabling or granting stays a team admin act. Native tool names and schemas are untouched.',
    list_connectors: '{ workspaceId? } — list connectors visible to the caller\'s workspace with live health status. Returns connectors owned by the team or shared to it that have been explicitly mounted for this workspace (connectorWorkspaces row present). Never-mounted connectors are excluded. Status: ok (mounted + healthy), auth_expired (credential missing or token expired), unreachable (credential revoked/degraded), disabled (connectorWorkspaces.enabled=false). Use this to diagnose why a task is degraded — if a required MCP tool is unavailable, check whether its connector shows auth_expired or disabled.',
    list_releases: '{ workspaceId?, missionId?, state?, limit? (default 10), sinceDays? } — list releases for a workspace or mission, newest first: version, state, deploy time, head SHA, id, and the tasks/PRs each shipped. "What shipped this week" = sinceDays: 7. get_release has the full record.',
    get_release: '{ releaseId (required) } — fetch a single release with attributed task edges. Returns all releases fields plus workspaceName, commitRangeUrl, degradationTaskId, attributedTasks (task title, status, prNumber, missionId), and attributedMissions.',
    list_artifact_templates: '{ } — list available artifact templates with their JSON schemas for structured output',
    suggest_schedule_update: '{ scheduleId?, cronExpression?, enabled?, reason (required) } — propose a schedule change for human approval. scheduleId auto-resolved from task context if omitted. At least one of cronExpression or enabled required.',
    post_note: `{ type (required: ${NOTE_TYPES.join('|')}), title (required), body?, defaultChoice? (for questions — what you chose while waiting for user reply), workerId?, missionId? } — post a lightweight note to the current task or mission feed. Non-blocking — returns immediately. For questions, include defaultChoice so work continues without waiting for user reply, and write it as a self-contained decision brief: the reader has not seen the task or the code, so the body says which task this is and what is being decided (one or two sentences), then one line per option of the form "<option>: what it leads to", and why you chose the default. User replies are delivered at your next turn boundary (or call receive_messages). missionId auto-resolved from task context if omitted; tasks without a mission receive a task-scoped note.`,
    get_task_messages: '{ taskId (required) } — returns the instruction history (human→agent messages + agent responses) for the task\'s active or most recent worker. Available to trigger/worker/admin tokens.',
    send_agent_message: '{ taskId (required), message (required), priority? ("urgent" — also pushed over Pusher for immediate delivery, otherwise queued for the next check-in) } — deliver a mid-flight steering message to the running agent. Delivery is confirmed by the agent, not by this call: get_task_messages marks anything unconfirmed as UNDELIVERED. Use this (not update_task) to redirect work in progress; update_task changes do not reach an active worker. [admin]',
    spec_compare: '{ feature (required — feature/term to check, e.g. "objectives", "codex backend"), topK? (default 5, max 20) } — spec-drift tool. Retrieves CODE vs DOC evidence from the unified workspace store ({workspaceId}:code and {workspaceId}:docs) for one feature and returns both sides for YOU to judge (implemented / documented-not-built / shipped-not-documented / contradicted). Scores surface candidates; they do not decide — read the snippets. No verdict is computed server-side.',
    correct_task_result: '{ taskId (required), summary?, prUrl?, prNumber? (at least one of summary / prUrl / prNumber) } — amend a completed or failed task\'s stored result after the fact. summary: replace result.summary (e.g. a stray assistant aside got captured, or a bug garbled it); the prior summary is preserved as result.previousSummary and the correction is stamped with result.summaryCorrectedAt so the durable record shows it was amended, not silently rewritten. prUrl/prNumber: attach the PR that delivered a task closed without a worker (e.g. by update_task status=completed) — the PR is verified in the workspace\'s GitHub repo via the GitHub App, mapped to the task with an external placeholder worker (as request_pr_review adoption does) and written to result.prUrl/prNumber, so the mission page lists it and mission completion sees it. Refused if another task owns the PR, unless that owner is an auto-adopted placeholder (a webhook-created bookkeeping task that only noticed the PR first, never did the work) — then the mapping moves onto this task instead of refusing. Also refused if the task already records a different PR; re-attaching the same PR is a no-op. Commit stats are never touched. Fails on a task that has not yet completed or failed — there is nothing to correct yet. [admin]',
    consolidate_knowledge: '{ op (required: find_duplicates|find_decayed|archive), corpora? (find ops — find_duplicates defaults to [memory,task], find_decayed to [task,artifact]), threshold? (cosine floor, default 0.92), limit?, halfLifeMultiple? (find_decayed age gate as multiple of corpus half-life, default 6), corpus? + sourceIds? (required for archive), reason? (audit marker) } — knowledge consolidation: surface near-duplicate chunk pairs for human review, find decayed unused chunks (memory: no recorded pull or use in the memory use ledger, with recent retrieval hits still counting while the ledger is young; every other corpus: zero retrieval hits), or archive a batch (is_current=false — audit-recoverable). Merge memory duplicates by calling learn with a supersedes param (preferred over archive for soft-deletion). [admin]',
    memory_delete: '{ id (required) } — permanently remove a memory entry and drop it from the knowledge store vector index. Compliance operation — prefer supersedes on save/update for soft-deletion instead. [admin]',
  };

  const lines = actions
    .filter(a => descriptions[a])
    .map(a => `- ${a}: ${descriptions[a]}`);
  return `Action-specific parameters. By action:\n${lines.join('\n')}\n\nNote: workspaceId accepts a UUID, a repo name (e.g. "buildd"), or "owner/repo" (e.g. "buildd-ai/buildd"). Usually the repo folder name is enough — the org prefix is optional.`;
}

export function buildMemoryDescription(actions: readonly string[]): string {
  const descriptions: Record<string, string> = {
    context: '{ project? } — get markdown-formatted memory context for agent injection. Memory is scoped to the calling workspace; naming another project is refused.',
    search: '{ query?, type?, files? (array), project? (must be the calling workspace\'s own), limit?, offset? }',
    save: '{ type (required: gotcha|pattern|decision|discovery|architecture), title (required), content (required), files? (array), tags? (array), project?, source?, supersedes? (string[] of memory IDs this entry replaces — memory ids ARE the chunk source_ids in the team memory namespace; superseded entries drop out of default knowledge retrieval; response includes the superseded count) }',
    get: '{ id (required) }',
    update: '{ id (required), title?, content?, type?, files? (array), tags?, project?, supersedes? (string[] of memory IDs this updated entry replaces; superseded entries drop out of default knowledge retrieval) }',
    query_knowledge: '{ query (required), corpus? (string or string[] — memory|task|pr|plan|artifact|code|docs|spec|initiative|evidence, default memory), mode? (hybrid|vector|lexical, default hybrid), topK? (default 10) } — semantic+lexical hybrid search across the team\'s knowledge: prior memories, completed task outcomes, PRs, approved plans, artifacts, and initiatives. Pass corpus as an array to query multiple corpora in one call and get a single rank-fused result set — e.g. corpus=["memory","task"] covers prior lessons AND recent outcomes without two round trips. Use corpus=evidence to search the error-bearing lines of stored run evidence (failing tests, error blocks, CI failure digests; read the full object with read_evidence). Use corpus=code to search this workspace\'s codebase (must be ingested first), corpus=spec to search spec/docs chunks. Also use corpus=memory BEFORE saving a new memory to detect near-duplicates (skip or update rather than adding another entry for the same gotcha). Returns ranked results with sourceUrl. NOTE: corpus=memory and corpus=initiative are team-scoped ({teamId}:{corpus}); all other corpora use {workspaceId}:{corpus}.',
  };

  const lines = actions
    .filter(a => descriptions[a])
    .map(a => `- ${a}: ${descriptions[a]}`);
  return `Action-specific parameters:\n${lines.join('\n')}`;
}

// ── Buildd Action Handler ────────────────────────────────────────────────────

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });

function timeUntilFromIso(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / (60 * 60 * 1000));
  if (h < 1) return `${Math.ceil(ms / 60000)}m`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Compact token counts — usage numbers run to millions and raw digits are unreadable. */
function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

const PR_RESOLVING_LABEL: Record<string, string> = {
  conflict: 'agent resolving the conflict', ci: 'agent fixing CI', review: 'agent reviewing',
};

const PR_STATE_LABEL: Record<string, string> = {
  conflict: 'CONFLICT', ci_failed: 'CI FAILED', ci_running: 'CI running', ci_green: 'CI green', pr_open: 'open', merged: 'merged',
};

/** list_prs output: a header, then one line per PR. An empty list is one "No …" line. */
export function renderPrList(data: { state?: string; sinceDays?: number; workspaceCount?: number; prs?: any[] }): string {
  const state = data.state ?? 'open';
  const prs = data.prs ?? [];
  const noun = (n: number) => `${n} PR${n === 1 ? '' : 's'}`;
  const days = data.sinceDays ?? 7;
  const window = days === 1 ? 'in the last day' : `in the last ${days} days`;
  // Saying the scope is what stops a model re-asking workspace by workspace.
  const n = data.workspaceCount;
  const scope = n === undefined ? '' : n === 1 ? ' in this workspace' : ` across your ${n} workspaces`;
  if (prs.length === 0) {
    return state === 'merged' ? `No PRs merged ${window}${scope}.`
      : state === 'attention' ? `No open PRs with conflicts or failing CI${scope}.`
      : state === 'open' ? `No open PRs${scope}.`
      : `No open PRs in state ${state}${scope}.`;
  }
  const needsYou = prs.filter(p => p.waitingOnYou).length;
  const conflicts = prs.filter(p => p.status === 'conflict').length;
  const red = prs.filter(p => p.status === 'ci_failed').length;
  const flags = [needsYou ? `${needsYou} needs you` : '', conflicts ? `${conflicts} conflicting` : '', red ? `${red} with failing CI` : ''].filter(Boolean).join(', ');
  const header = state === 'merged' ? `${noun(prs.length)} merged ${window}${scope}:`
    : state === 'open' ? `${prs.length} open PR${prs.length === 1 ? '' : 's'}${scope}${flags ? ` (${flags})` : ''}:`
    : `${noun(prs.length)} ${state === 'attention' ? 'needing attention' : `in state ${state}`}${scope}${flags ? ` (${flags})` : ''}:`;
  const day = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const lines = prs.map(p => {
    const when = state === 'merged' ? `merged ${day(p.mergedAt)}`
      : p.status === 'conflict' && p.conflictDetectedAt ? `conflicting since ${day(p.conflictDetectedAt)}`
      : p.startedAt ? `opened ${day(p.startedAt)}` : null;
    // Signals only appear when they matter; a quiet PR's line is unchanged.
    const lead = p.waitingOnYou ? `NEEDS YOU (${p.waitingOnYou}) · ` : '';
    const attempts = p.ciFixAttempts ? ` (${p.ciFixAttempts} fix attempt${p.ciFixAttempts === 1 ? '' : 's'})` : '';
    const label = `${PR_STATE_LABEL[p.status] ?? p.status ?? 'open'}${attempts}`;
    return `- #${p.prNumber ?? '?'} ${lead}${label} · ${[
      p.resolving ? PR_RESOLVING_LABEL[p.resolving] : null,
      p.builddOwns ? `not paged: ${p.builddOwns}` : null,
      p.taskTitle ?? '(no task)',
      p.workspaceName,
      p.missionTitle ? `mission "${p.missionTitle}"` : null,
      p.taskId ? `task ${String(p.taskId).slice(0, 8)}` : null,
      p.intoMissionBranch ? `→ ${p.intoMissionBranch}` : null,
      when,
      p.checkedHoursAgo ? `state checked ${p.checkedHoursAgo}h ago` : null,
    ].filter(Boolean).join(' · ')}\n  ${p.prUrl}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

const errorResult = (t: string): ToolResult => ({
  content: [{ type: 'text' as const, text: t }],
  isError: true,
});

// ── Failure analytics formatting ─────────────────────────────────────────────

/**
 * `satisfies Record<FailureWindow, 1>` makes this exhaustive at compile time —
 * adding a window to the shared union without adding it here fails tsc.
 */
const FAILURE_WINDOW_VALUES = Object.keys(
  { '24h': 1, '7d': 1, '30d': 1 } satisfies Record<FailureWindow, 1>,
) as FailureWindow[];

/** Mirrors `USAGE_WINDOWS` in apps/web/src/lib/usage-stats.ts — kept local since that module lives in a different package. */
const USAGE_WINDOW_VALUES = ['24h', '7d', '30d'] as const;

const pctOf = (share: number) => (share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);

/**
 * get_usage_stats: the four fine-grained breakdowns, each followed by its own
 * coverage line because none of them shares a population with another (or
 * with the task-keyed totals above them). A block whose data is absent says
 * why in one line rather than disappearing — "not recorded" must not read as
 * "zero".
 */
export function renderUsageBreakdowns(data: any): string[] {
  const lines: string[] = [];

  const bb = data?.bashBuckets;
  if (bb) {
    if (bb.classifiedCalls > 0) {
      const rows = (bb.buckets ?? []).map((b: any) => `  ${b.key}: ${b.calls} (${pctOf(b.share)})`);
      lines.push(`Bash buckets (share of classified Bash):\n${rows.join('\n')}`);
      lines.push(
        `  coverage: ${bb.classifiedCalls}/${bb.bashCalls} Bash calls classified, over ${bb.histogramTasks} task(s) with an exact histogram only; no cross-window delta`,
      );
    } else {
      lines.push(`Bash buckets: none classified (${bb.bashCalls} Bash call(s) over ${bb.histogramTasks} exact-histogram task(s), all from workers older than the classifier)`);
    }
  }

  const ss = data?.searchShapes;
  if (ss && ss.codeSearchCalls > 0) {
    const rows = (ss.shapes ?? []).map((s: any) => `  ${s.key}: ${s.calls} (${pctOf(s.share)})`);
    lines.push(`Search shapes (of ${ss.codeSearchCalls} code_search call(s); identifier = a bare symbol name):\n${rows.join('\n')}`);
  }

  const ba = data?.buildActions;
  if (ba) {
    const rows = (ba.actions ?? []).map((a: any) => `  ${a.action}: ${a.calls} (${pctOf(a.share / 100)})`);
    lines.push(rows.length > 0 ? `buildd actions (${ba.totalCalls} call(s)):\n${rows.join('\n')}` : 'buildd actions: none recorded in this window');
    lines.push(
      `  coverage: ${ba.workersWithEvents}/${ba.workers} worker(s) recorded; actions recorded since ${ba.capturedSince}, no backfill` +
      `${ba.windowPredatesCapture ? ' (this window opens earlier, so a low count may mean not yet recorded)' : ''}` +
      `${ba.truncated ? '; row cap hit, counts are floors' : ''}`,
    );
  } else {
    lines.push('buildd actions: unavailable (the action event stream could not be read)');
  }

  return lines;
}

// Agent context is finite. A small default, a hard ceiling, short lines.
const FAILURE_SIGNATURES_DEFAULT = 5;
const FAILURE_SIGNATURES_MAX = 15;
const FAILURE_SIGNATURE_LINE_MAX = 120;
/** Only the first line of an error is ever normalized, so this is generous. */
const FAILURE_LOOKUP_INPUT_MAX = 1000;
/** A prefix longer than the max normalized signature (200 chars) can never match anything. */
const FAILURE_PREFIX_INPUT_MAX = 200;

function truncateTo(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * "Is this error known?" in six lines or fewer.
 *
 * The frictionSignature is the payload that matters: handing it back turns a
 * duplicate friction task into an append onto the existing report.
 */
function formatFailureLookup(lookup: FailureSignatureLookup, window: FailureWindow, failedInWindow: number): string {
  const lines: string[] = [];
  const nextCall = `context: { frictionSignature: "${lookup.frictionSignature}", frictionExcerpt: "<first line of your error>" }`;

  if (lookup.known && lookup.supersededOnly) {
    lines.push(`Known, but only on worker(s) already \`superseded\` when the error landed — ${lookup.count} occurrence(s) in the last ${window}.`);
    lines.push(`signature: ${truncateTo(lookup.signature, 200)}`);
    lines.push(`first seen ${lookup.firstSeen} · last seen ${lookup.lastSeen}`);
    if (lookup.exampleTaskId) lines.push(`example task: ${lookup.exampleTaskId}`);
    lines.push('Not counted against the failure rate — the worker(s) had already been answered/replaced when this landed. See the worker row for details.');
    lines.push(`Next: file your friction report with ${nextCall} — it appends to the existing report instead of filing a duplicate.`);
    return lines.join('\n');
  }

  if (lookup.known) {
    lines.push(`Known failure pattern — ${lookup.count} occurrence(s) in the last ${window}.`);
    lines.push(`signature: ${truncateTo(lookup.signature, 200)}`);
    const detail = [
      `first seen ${lookup.firstSeen}`,
      `last seen ${lookup.lastSeen}`,
      `died early ${lookup.diedEarlyCount}/${lookup.count}`,
    ];
    if (lookup.exitCauses.length > 0) detail.push(`exit causes: ${lookup.exitCauses.join(', ')}`);
    lines.push(detail.join(' · '));
    if (lookup.exampleTaskId) lines.push(`example task: ${lookup.exampleTaskId}`);
    lines.push(`Next: file your friction report with ${nextCall} — it appends to the existing report instead of filing a duplicate.`);
    return lines.join('\n');
  }

  const caveat = lookup.exhaustive
    ? ''
    : ' The signature ranking was capped for this window, so a rare match may have been missed.';
  lines.push(`New failure — no match for this signature in the last ${window} (${failedInWindow} failure(s) in the window).${caveat}`);
  lines.push(`signature: ${truncateTo(lookup.signature, 200)}`);
  lines.push(`Next: file a friction report with ${nextCall} so later occurrences dedupe onto it.`);
  return lines.join('\n');
}

/**
 * Rollup for a family of failures sharing a literal signature prefix.
 *
 * For an error family whose free-text tail makes each occurrence its own
 * singleton signature (e.g. `needs_input: <question>`), this is the only way
 * to see the family's true size — no single occurrence ranks into the top-N
 * signature list on its own, so `formatFailureOverview` would never show it.
 */
function formatFailureFamily(family: FailureSignatureFamily, window: FailureWindow): string {
  const lines: string[] = [];
  const nextCall = `context: { frictionSignature: "${family.frictionSignature}", frictionExcerpt: "<first line of your error>" }`;

  if (!family.known) {
    lines.push(`No failure signature starts with "${truncateTo(family.prefix, 200)}" in the last ${window}.`);
    lines.push(`Next: file a friction report with ${nextCall} so later occurrences dedupe onto it.`);
    return lines.join('\n');
  }

  lines.push(`Signature family "${truncateTo(family.prefix, 200)}" — ${family.count} occurrence(s) across ${family.distinctSignatures} distinct signature(s) in the last ${window}.`);
  const detail = [
    `first seen ${family.firstSeen}`,
    `last seen ${family.lastSeen}`,
    `died early ${family.diedEarlyCount}/${family.count}`,
  ];
  if (family.exitCauses.length > 0) detail.push(`exit causes: ${family.exitCauses.join(', ')}`);
  lines.push(detail.join(' · '));
  if (family.exampleTaskId) lines.push(`example task: ${family.exampleTaskId}`);
  if (family.topSignatures.length > 0) {
    lines.push('Top variants:');
    family.topSignatures.forEach(s => {
      lines.push(`  ${s.count}× ${truncateTo(s.signature, FAILURE_SIGNATURE_LINE_MAX)}`);
    });
  }
  lines.push(`Next: file your friction report with ${nextCall} — it appends to the existing report instead of filing a duplicate.`);
  return lines.join('\n');
}

/**
 * Overview: totals, exit causes, and the top-N signature ranking.
 *
 * Deliberately omits byRole / byWorkspace / repeatFailureTasks / example worker
 * IDs — the dashboard renders those, an agent triaging one failure does not
 * need them, and every omitted table is context an agent gets to keep.
 */
function formatFailureOverview(analytics: FailureAnalytics, limit: number): string {
  const { totals, signatures, window } = analytics;

  if (totals.failed === 0) {
    return `No worker failures in the last ${window} (${totals.started} worker(s) started).`;
  }

  const lines: string[] = [
    `Worker failures — last ${window} (since ${analytics.windowStart})`,
    // Denominator is TERMINAL workers, not everything started — in-flight
    // workers have not had the chance to fail yet.
    `${totals.failed} of ${totals.terminal} terminal workers failed (${totals.failureRatePct}%)`
      + `${totals.stillRunning > 0 ? ` · ${totals.stillRunning} still running` : ''}`
      + ` · died early: ${totals.diedEarly} (${totals.diedEarlySharePct}% of failures)`,
  ];

  if (analytics.byExitCause.length > 0) {
    const causes = analytics.byExitCause
      .slice(0, 4)
      .map(c => `${c.exitCause} ${c.count} (${c.sharePct}%)`)
      .join(', ');
    lines.push(`Exit causes: ${causes}`);
  }

  const shown = signatures.slice(0, limit);
  if (shown.length > 0) {
    lines.push(`Top ${shown.length} of ${signatures.length} signatures:`);
    shown.forEach((s: FailureSignatureRow, i: number) => {
      const tail = [`last seen ${s.lastSeen}`, `died early ${s.diedEarlyCount}`];
      if (s.exitCauses.length > 0) tail.push(s.exitCauses.join('/'));
      lines.push(`  ${i + 1}. ${s.count}× ${truncateTo(s.signature, FAILURE_SIGNATURE_LINE_MAX)} — ${tail.join(' · ')}`);
    });
    const omitted = signatures.length - shown.length;
    if (omitted > 0) {
      lines.push(`  … ${omitted} more (raise limit, max ${FAILURE_SIGNATURES_MAX}, or pass error=<text> to look one up)`);
    }
  }

  return lines.join('\n');
}

/**
 * Failure Pattern Sentinel incident list, newest/most-severe first (the route
 * already sorted it). Every field on `FailureIncident` surfaces: severity,
 * rule/reasonCode, first/last seen, occurrence/recurrence counts, impact,
 * a representative ref, alert state and any linked fix task.
 */
function formatIncidentsList(
  incidents: FailureIncident[],
  counts: { total: number; bySeverity: Record<FailureIncidentSeverity, number> },
): string {
  const bySeverityLine = `${counts.bySeverity.critical} critical, ${counts.bySeverity.high} high, `
    + `${counts.bySeverity.medium} medium, ${counts.bySeverity.low} low in scope`;
  if (incidents.length === 0) return `No matching incidents (${bySeverityLine}).`;

  const header = `${counts.total} incident(s) matched — ${bySeverityLine}`
    + (counts.total > incidents.length ? ` (showing ${incidents.length}, raise limit for more)` : '');
  const lines: string[] = [header];

  incidents.forEach((inc, i) => {
    const ref = [
      inc.affectedRefs.taskIds[0] ? `task ${inc.affectedRefs.taskIds[0].slice(0, 8)}` : null,
      inc.affectedRefs.prNumbers[0] !== undefined ? `PR #${inc.affectedRefs.prNumbers[0]}` : null,
    ].filter(Boolean).join(' · ');
    const alert = inc.lastAlertSeverity ? `alerted ${inc.lastAlertSeverity} @ ${inc.lastAlertedAt}` : 'not alerted';
    const fix = inc.linkedFixTaskId ? `fix task ${inc.linkedFixTaskId.slice(0, 8)}` : 'no fix task';
    const recurrence = inc.recurrenceCount > 0 ? ` · recurred ${inc.recurrenceCount}x` : '';
    lines.push(
      `  ${i + 1}. [${inc.severity.toUpperCase()}] ${inc.status} — ${truncateTo(inc.title, 160)}\n` +
      `     ${inc.rule} (${inc.reasonCode}) · ${inc.occurrenceCount} occurrence(s)${recurrence}` +
      ` · first ${inc.firstSeenAt} · last ${inc.lastSeenAt}\n` +
      `     ${alert} · ${fix}${ref ? ` · e.g. ${ref}` : ''} · id ${inc.id}`,
    );
  });

  return lines.join('\n');
}

/** One gate's outcome mix, compacted: "12 rejected · 3 bypassed". */
function formatGateOutcomes(outcomes: GateRow['outcomes']): string {
  return (['rejected', 'deferred', 'bypassed', 'warned', 'stranded'] as const)
    .filter(k => outcomes[k] > 0)
    .map(k => `${outcomes[k]} ${k}`)
    .join(' · ');
}

/**
 * The gate ledger overview.
 *
 * Leads with the bypass rate rather than the raw count, because that is the
 * number this whole table exists to publish: a gate whose refusals are mostly
 * being overridden is a gate that is wrong about something, and it used to take
 * several friction reports and a human reading logs to notice.
 */
function formatGateOverview(gates: GateAnalytics, limit: number): string {
  const { totals, window } = gates;
  if (totals.events === 0) {
    return `No gate events in the last ${window}. Gates record server-side refusals, deferrals, advisory warnings and explicit bypasses — a quiet table means nothing was refused, not that nothing was checked.`;
  }

  const lines: string[] = [];
  lines.push(
    `**Gates — last ${window}**: ${totals.events} event(s) across ${totals.distinctGates} gate(s) · `
    + `${totals.rejected} rejected · ${totals.deferred} deferred · ${totals.bypassed} bypassed · ${totals.warned} warned`,
  );
  lines.push('');
  lines.push('Top gates:');
  gates.gates.slice(0, limit).forEach(g => {
    lines.push(`  ${g.count}× **${g.gate}** — ${formatGateOutcomes(g.outcomes)} · bypass ${g.bypassRatePct}% · last ${g.lastSeen}`);
    lines.push(`      ${g.surfaces.join(', ')} · first seen ${g.firstSeen} · ${g.distinctReasons} distinct reason(s)`);
    g.topReasons.slice(0, 3).forEach(r => {
      lines.push(`      ${r.count}× ${truncateTo(r.reason, FAILURE_SIGNATURE_LINE_MAX)}`);
    });
  });
  const omitted = gates.truncatedGates + Math.max(0, gates.gates.length - limit);
  if (omitted > 0) lines.push(`  … ${omitted} more gate(s) (raise limit, max ${FAILURE_SIGNATURES_MAX})`);
  lines.push('');
  lines.push('Bypass % = bypassed / (bypassed + rejected + warned). For a lint, that IS its false-positive rate.');
  return lines.join('\n');
}

const fmtDuration = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;
};

/**
 * Landing scoreboard: how long approved-and-green PRs wait to merge, and how
 * many are waiting past the target right now. Unmeasured landings are reported
 * rather than folded in as zeros — a missing clock is not a fast merge.
 */
function formatLandingMetrics(landing: LandingMetrics): string {
  const { timeToLand: t, stuck } = landing;
  const lines: string[] = [`**PR landing — last ${landing.window}**`];
  lines.push(
    t
      ? `  time to land (approved + green → merged): p50 ${fmtDuration(t.p50Ms)} · p90 ${fmtDuration(t.p90Ms)} · max ${fmtDuration(t.maxMs)} · ${t.count} measured of ${landing.landed} landed`
      : `  time to land: no measured landings (${landing.landed} landed, ${landing.unmeasured} unmeasured)`,
  );
  if (t && landing.unmeasured > 0) lines.push(`  ${landing.unmeasured} landed with no derivable start (excluded from the percentiles)`);
  lines.push(
    stuck.count > 0
      ? `  stuck: ${stuck.count} PR(s) approved and green for over ${fmtDuration(stuck.thresholdMs)} without merging · oldest ${fmtDuration(stuck.oldestMs ?? 0)}`
      : `  stuck: none past ${fmtDuration(stuck.thresholdMs)}`,
  );
  lines.push('  Only merges through the landing function are measured; a merge done directly on GitHub is not.');
  return lines.join('\n');
}

/**
 * Full knowledge-ingest jobs no runner has taken. They never become failed
 * workers, so this block is the only place the overview shows them.
 */
function formatStalledIngest(report: StalledIngestReport): string {
  const lines: string[] = [
    `**Stalled knowledge ingest** — ${report.stalled} waiting for the serverless fallback, ` +
      `${report.inFallback} being ingested by it · oldest ${fmtDuration(report.oldestAgeMs)}`,
  ];
  for (const j of report.jobs) {
    const progress = j.progress ? ` · ${j.progress.cursor}/${j.progress.total ?? '?'} files` : '';
    lines.push(`  ${j.id.slice(0, 8)} ${j.repo} — ${j.state}, waiting ${fmtDuration(j.ageMs)}${progress}`);
    if (j.checkoutReason) lines.push(`    runner handed it back: ${j.checkoutReason}`);
    if (j.lastError) lines.push(`    last fallback error: ${j.lastError}`);
  }
  const listed = report.jobs.length;
  const total = report.stalled + report.inFallback;
  if (total > listed) lines.push(`  … ${total - listed} more`);
  return lines.join('\n');
}

/** Prefix rollup over gate reasons — the gate-ledger twin of formatFailureFamily. */
function formatGateFamily(family: GateReasonFamily, window: GateWindow): string {
  const nextCall = `context: { frictionSignature: "${family.frictionSignature}", frictionExcerpt: "<the refusal you saw>" }`;
  if (!family.known) {
    return [
      `No gate reason starts with "${truncateTo(family.prefix, 200)}" in the last ${window}.`,
      `Next: file a friction report with ${nextCall} so later occurrences dedupe onto it.`,
    ].join('\n');
  }
  const lines: string[] = [];
  lines.push(
    `Gate reason family "${truncateTo(family.prefix, 200)}" — ${family.count} event(s) across `
    + `${family.distinctReasons} distinct reason(s) in the last ${window}.`,
  );
  lines.push([
    `gates: ${family.gates.join(', ')}`,
    formatGateOutcomes(family.outcomes),
    `bypass ${family.bypassRatePct}%`,
    `first seen ${family.firstSeen}`,
    `last seen ${family.lastSeen}`,
  ].join(' · '));
  if (family.exampleTaskId) lines.push(`example task: ${family.exampleTaskId}`);
  if (family.topReasons.length > 0) {
    lines.push('Top variants:');
    family.topReasons.forEach(r => {
      lines.push(`  ${r.count}× ${truncateTo(r.reason, FAILURE_SIGNATURE_LINE_MAX)}`);
    });
  }
  lines.push(`Next: file your friction report with ${nextCall} — it appends to the existing report instead of filing a duplicate.`);
  return lines.join('\n');
}

/**
 * Heuristic hint for what a scheduled task actually *does* (where its output lands).
 * Surfaced in list_schedules + trace_schedule output so a caller can identify the
 * schedule behind a stray notification without reading the task template.
 *
 * Looks at task template skillSlugs and description/title for known notification
 * patterns. Returns null when nothing recognisable matches.
 */
export function describeOutputChannel(taskTemplate: unknown): string | null {
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
  // Matches the CAPABILITY, never a connector's name: this repo is public and
  // connector names are production identifiers. A real tool name carries the
  // verb (`mcp__<connector>__send_pushover`), which `send_pushover` already
  // covers. See mcp-tools-output-channel.test.ts.
  if (/pushover|send_pushover|send_notification|mcp__dispatch/.test(haystack)) {
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
  if (!workerId) throw new Error('workerId is required — pass it explicitly, or connect with ?worker=<workerId> in the MCP URL. A connector authenticated as a different account than the worker owner is refused with Forbidden; use the worker-pinned endpoint.');
  return workerId;
}

/**
 * Render what a `consumer: 'agent'` check-in was served (human messages,
 * mission-note replies, worker→worker messages) into tool-result text, then
 * acknowledge it. The text is in the result the agent reads this turn, so it
 * is delivered AND read at once: one PATCH carries `instructionsDelivered` /
 * `instructionIdsDelivered` and `instructionsAcknowledged`. Unconfirmed
 * (the ack PATCH failed) means it stays queued and is served again.
 *
 * Returns null when nothing was served.
 */
async function renderAndAckMessages(api: ApiFn, workerId: string, response: any): Promise<string | null> {
  const parts: string[] = [];

  if (response?.instructions) {
    parts.push(`**ADMIN INSTRUCTION:** ${response.instructions}`);
    const ids = Array.isArray(response.instructionIds)
      ? (response.instructionIds as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    if (typeof response.instructionsAck === 'string' || ids.length > 0) {
      try {
        await api(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...(typeof response.instructionsAck === 'string' ? { instructionsDelivered: response.instructionsAck } : {}),
            ...(ids.length > 0 ? { instructionIdsDelivered: ids, instructionsAcknowledged: ids } : {}),
          }),
        });
      } catch {
        // Unconfirmed: it stays queued and is served again next time.
      }
    }
  }

  // Worker→worker messages: same protocol, acked by id.
  const pendingMessages = Array.isArray(response?.pendingMessages)
    ? (response.pendingMessages as WorkerMessage[])
    : [];
  if (pendingMessages.length > 0) {
    parts.push(formatWorkerMessages(pendingMessages));
    const deliveredIds = pendingMessages.map(m => m?.id).filter((v): v is string => !!v);
    if (deliveredIds.length > 0) {
      try {
        await api(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({ workerMessagesDelivered: deliveredIds }),
        });
      } catch {
        // Unconfirmed: they stay queued and are served again next time.
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
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
/** The personal roles GET /api/roles lets the caller see: their own, and others' shared ones. */
async function listVisiblePersonalRoles(api: ApiFn): Promise<Array<Record<string, any>>> {
  const listed = await api('/api/roles');
  return ((listed?.roles ?? []) as Array<Record<string, any>>).filter(r => r.personal === true);
}

/** A slug resolves to the caller's own personal role first, else a shared one they can see. */
async function resolvePersonalRole(api: ApiFn, slug: unknown): Promise<Record<string, any>> {
  if (!slug) throw new Error('slug is required to identify the personal role');
  const candidates = (await listVisiblePersonalRoles(api)).filter(r => r.slug === slug);
  const role = candidates.find(r => r.mine === true) ?? candidates[0];
  if (!role) {
    throw new Error(`No personal role with slug "${slug}" that you can see (yours, or one shared with the team). Another member's private role is never visible.`);
  }
  return role;
}

function personalRoleOwnerLabel(r: Record<string, any>): string {
  return r.mine === true ? 'yours' : `by ${r.ownerName ?? 'another member'}`;
}

/**
 * The personal-role path of the skill actions ({ personal: true }): roles
 * owned by a person, through /api/roles with the caller's own credentials.
 * It never touches workspace skills. list_skills / get_skill read the
 * caller's own personal roles and the ones shared with the team; a slug
 * resolves to the caller's own personal role first, else a shared one they
 * can see (an admin may edit a shared role); the route decides who may write.
 */
async function handlePersonalRole(
  api: ApiFn,
  action: 'register_skill' | 'update_skill' | 'delete_skill' | 'list_skills' | 'get_skill',
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ToolResult> {
  if (ctx.principal === 'task_token') return errorResult(PERSONAL_ROLE_TASK_TOKEN_REFUSAL);
  if (ctx.principal === 'key') return errorResult(PERSONAL_ROLE_KEY_REFUSAL);

  if (action === 'list_skills') {
    const roles = await listVisiblePersonalRoles(api);
    if (roles.length === 0) {
      return text('No personal roles: you have none, and none is shared with the team. Create one with register_skill { personal: true, name, content }.');
    }
    const lines = roles.map(r => {
      const tags = [r.visibility === 'team' ? 'shared' : 'private', personalRoleOwnerLabel(r), r.model && r.model !== 'inherit' ? r.model : '']
        .filter(Boolean).join(', ');
      return `- **${r.name}** (\`${r.slug}\`) [${tags}]${r.description ? `\n  ${r.description}` : ''}`;
    });
    return text(`${roles.length} personal role(s):\n\n${lines.join('\n')}`);
  }

  if (action === 'get_skill') {
    const role = await resolvePersonalRole(api, params.slug);
    const data = await api(`/api/roles/${role.id}`);
    const s = data?.skill;
    if (!s) throw new Error(`No personal role with slug "${params.slug}" that you can see.`);
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
      requiredEnvVars: s.requiredEnvVars ?? {},
      connectorRefs: s.connectorRefs ?? [],
      whenToUse: s.metadata?.routing?.whenToUse ?? null,
      notFor: s.metadata?.routing?.notFor ?? null,
      personal: true,
      visibility: s.visibility ?? role.visibility ?? 'private',
      mine: role.mine === true,
      ownerName: role.ownerName ?? null,
    };
    return text(`// scope: personal role (${personalRoleOwnerLabel(role)}); edit with update_skill { slug, personal: true, ... }\n${JSON.stringify(payload, null, 2)}`);
  }
  const visibility = params.visibility;
  if (visibility !== undefined && visibility !== 'team' && visibility !== 'private') {
    throw new Error("visibility must be 'team' (everyone in the team can use it) or 'private' (only you)");
  }

  const fields = buildSkillBody(params);
  // A personal row is always a role and always team-level.
  delete fields.isRole;
  delete fields.source;

  if (action === 'register_skill') {
    if (!params.name || !params.content) throw new Error('name and content are required');
    const body: Record<string, unknown> = { ...fields, personal: true };
    if (typeof params.slug === 'string' && params.slug) body.slug = params.slug;
    if (typeof params.teamId === 'string' && params.teamId) body.teamId = params.teamId;
    const data = await api('/api/roles', { method: 'POST', body: JSON.stringify(body) });
    let skill = data.skill;
    if (visibility === 'team') {
      const shared = await api(`/api/roles/${skill.id}/share`, { method: 'POST', body: JSON.stringify({ visibility: 'team' }) });
      skill = shared.skill ?? skill;
    }
    const who = skill.visibility === 'team'
      ? 'shared: everyone in the team can use it'
      : `private: only you can use it. Share it with update_skill { slug: "${skill.slug}", personal: true, visibility: "team" }`;
    return text(`Personal role created: "${skill.name}" (slug: ${skill.slug}, id: ${skill.id})\nVisibility: ${skill.visibility} (${who})`);
  }

  const role = await resolvePersonalRole(api, params.slug);

  if (action === 'delete_skill') {
    await api(`/api/roles/${role.id}`, { method: 'DELETE' });
    return text(`Personal role "${params.slug}" deleted.`);
  }

  if (Object.keys(fields).length === 0 && visibility === undefined) {
    throw new Error('No fields to update. Provide visibility ("team" | "private") or at least one field (name, content, description, model, ...)');
  }
  const lines: string[] = [];
  let skill: Record<string, any> = role;
  if (Object.keys(fields).length > 0) {
    const data = await api(`/api/roles/${role.id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    skill = data.skill ?? skill;
    lines.push(`Personal role updated: "${skill.name}" (slug: ${skill.slug})`);
  }
  if (visibility !== undefined) {
    const data = await api(`/api/roles/${role.id}/share`, { method: 'POST', body: JSON.stringify({ visibility }) });
    skill = data.skill ?? skill;
    lines.push(`Visibility: ${skill.visibility} (${skill.visibility === 'team' ? 'everyone in the team can use it' : 'only its owner can use it'})`);
  }
  return text(lines.join('\n'));
}

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
  // Routing text (knowledge-base: buildd/design/role-routing.md §2); the API validates the limits.
  if (params.whenToUse !== undefined) body.whenToUse = params.whenToUse;
  if (params.notFor !== undefined) body.notFor = params.notFor;
  if (params.claudeAiArtifacts !== undefined) body.claudeAiArtifacts = params.claudeAiArtifacts;
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
  // Same shape as list_tasks: without an explicit workspaceId it would
  // silently resolve to ctx.getWorkspaceId()'s pick for a multi-workspace
  // OAuth token instead of erroring.
  'list_discrepancies',
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

/** Minute-precision UTC stamp: `2026-09-27 17:07Z`. */
const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

/**
 * list_releases text: one line per release and the tasks it shipped. The raw
 * rows (archetype, SHAs, run metadata) cost the reader ~1K tokens each and
 * answered "what shipped?" with nothing; get_release has the full record.
 */
export function renderReleaseList(
  rows: Array<Record<string, any>>,
  sinceDays: number | null,
): string {
  if (rows.length === 0) return sinceDays ? `No releases in the last ${sinceDays} days.` : 'No releases found.';
  const MAX_TASKS = 15;
  return rows.map((r) => {
    const state = r.failureReason && r.state !== 'healthy' ? `${r.state} (${r.failureReason})` : r.state;
    const when = r.deployedAt ? `deployed ${stamp(r.deployedAt)}` : `created ${stamp(r.createdAt)}`;
    const head = [r.version ?? 'unversioned', state, when, r.headSha ? String(r.headSha).slice(0, 7) : null]
      .filter(Boolean).join(' · ');
    const shipped: Array<{ title: string | null; prNumber: number | null; missionTitle?: string | null }> = r.tasks ?? [];
    const lines = shipped.slice(0, MAX_TASKS)
      .map((t) => `    - ${t.prNumber ? `#${t.prNumber} ` : ''}${t.title ?? 'untracked change'}${t.missionTitle ? ` (mission: ${t.missionTitle})` : ''}`);
    if (shipped.length > MAX_TASKS) lines.push(`    - …and ${shipped.length - MAX_TASKS} more (get_release)`);
    return [`- ${head} (id ${r.id})`, ...lines].join('\n');
  }).join('\n');
}

/**
 * Resolve workspace ID from a UUID, repo name (e.g. "buildd-ai/buildd"), or workspace name.
 * No param → the connection's workspace (null when it has none).
 * An explicit param that matches nothing the caller can see THROWS, naming the
 * workspaces it can see: dropping the filter (or swapping in the connection's
 * workspace) answers about the wrong workspace. UUIDs pass through; the API
 * authorizes them.
 */
async function resolveWorkspaceId(
  api: ApiFn,
  param: unknown,
  ctx: ActionContext,
): Promise<string | null> {
  const explicit = typeof param === 'string' ? param.trim() : '';
  const raw = explicit || ctx.workspaceId;
  if (raw && UUID_RE.test(raw)) return raw;

  // Try context fallback first
  if (!raw) return ctx.getWorkspaceId();

  // Not a UUID — resolve by repo name or workspace name
  // Try by-repo first (handles "owner/repo" format). It searches only the
  // caller's reachable workspaces and answers 404 otherwise, which `api`
  // throws on; that is a miss, not an error, so fall through to the list.
  if (raw.includes('/')) {
    try {
      const data = await api(`/api/workspaces/by-repo?repo=${encodeURIComponent(raw)}`);
      if (data?.workspace?.id) return data.workspace.id;
    } catch {
      // not reachable / not found — fall through
    }
  }

  // Fall back to name match across accessible workspaces. A per-task token
  // (cloud container / worker session running under a `bldt_` token) has no
  // auth path into this listing endpoint at all — it always 401s here,
  // regardless of which name was passed, because listing is inherently
  // team-wide and the token can only ever reach its own task's workspace.
  // Such a caller already has that one workspace bound unambiguously
  // (ctx.getWorkspaceId()), so a name match against it is a convenience
  // confirmation, not a real lookup: fall back to the bound workspace instead
  // of surfacing this scope-shaped 401 as a raw API error. Any other failure
  // (a genuine outage, etc.) still propagates.
  let wsData;
  try {
    wsData = await api('/api/workspaces');
  } catch (err) {
    if (err instanceof Error && /^API error: 401\b/.test(err.message)) {
      const bound = await ctx.getWorkspaceId();
      if (bound) return bound;
    }
    throw err;
  }
  const workspaces: Array<{ id: string; name: string; repo?: string | null }> = wsData?.workspaces || [];
  const match = workspaces.find((ws: any) =>
    ws.name.toLowerCase() === raw.toLowerCase() ||
    ws.repo?.toLowerCase() === raw.toLowerCase() ||
    ws.repo?.toLowerCase().endsWith('/' + raw.toLowerCase())
  );
  if (match) return match.id;
  if (explicit) throw new Error(unknownWorkspaceMessage(explicit, workspaces));
  return null;
}

/** One audit line for a schedule's delegation, or '' when it has none. */
export function describeScheduleDelegation(value: unknown): string {
  const grants = readScheduleDelegation(value);
  if (!grants.length) return '';
  const d = value as { grantedAt?: string; grantedByUserId?: string | null; grantedByAccountId?: string | null };
  const who = d.grantedByUserId ? `user ${d.grantedByUserId}` : d.grantedByAccountId ? `account ${d.grantedByAccountId}` : 'unknown';
  const list = grants.map(g => `${g.workspaceId} (${g.capabilities.join(', ')})`).join('; ');
  return `Delegates: ${list}; granted by ${who}${d.grantedAt ? ` at ${d.grantedAt}` : ''}`;
}

/** `Could not resolve workspace "x": not visible to this key. You can see: a, b.` */
export function unknownWorkspaceMessage(value: string, visible: Array<{ name: string }>): string {
  const MAX = 20;
  const names = visible.map((w) => w.name);
  const seen = names.length === 0
    ? 'This key can see no workspaces.'
    : `You can see: ${names.slice(0, MAX).join(', ')}${names.length > MAX ? ` (+${names.length - MAX} more; manage_workspaces list)` : ''}.`;
  return `Could not resolve workspace "${value}": not visible to this key. ${seen}`;
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

/**
 * Find missions whose title contains `query` (any status, newest activity
 * first). One exact-title hit among several counts as the match.
 */
async function findMissionByTitle(
  api: ApiFn,
  query: string,
  workspaceId: string | null,
): Promise<{ id: string } | { message: string }> {
  const LIMIT = 10;
  const qs = new URLSearchParams({ q: query, sort: 'recent', limit: String(LIMIT) });
  if (workspaceId) qs.set('workspaceId', workspaceId);
  const data = await api(`/api/missions?${qs}`);
  const rows: Array<{ id: string; title: string; status: string }> = data?.missions || [];
  if (rows.length === 1) return { id: rows[0].id };
  const exact = rows.filter((m) => m.title.toLowerCase() === query.trim().toLowerCase());
  if (exact.length === 1) return { id: exact[0].id };
  if (rows.length === 0) return { message: `No mission title contains "${query}" (all statuses searched).` };
  const total = typeof data?.total === 'number' ? data.total : rows.length;
  const lines = rows.map((m) => `- ${m.title} [${m.status}] ${m.id}`);
  const more = total > rows.length ? `\nShowing ${rows.length} of ${total}. Narrow the title.` : '';
  return { message: `${total} missions match "${query}"; pass missionId:\n${lines.join('\n')}${more}` };
}

/**
 * manage_missions get/update target. A UUID missionId (or a hex id prefix, left
 * for the API's prefix hint) is used as-is. Otherwise missionId, then title /
 * query, is a title to look up, scoped to workspaceId when given.
 */
async function resolveMissionTarget(
  api: ApiFn,
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<{ id: string; lookup: boolean } | { message: string }> {
  const raw = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (raw && (UUID_RE.test(raw) || /^[0-9a-f]{1,35}$/i.test(raw))) return { id: raw, lookup: false };
  const byTitle = raw || ((params.title ?? params.query) as string | undefined);
  if (!byTitle) throw new Error('missionId or title is required');
  const wsId = params.workspaceId ? await resolveWorkspaceId(api, params.workspaceId, ctx) : null;
  const found = await findMissionByTitle(api, byTitle, wsId);
  return 'message' in found ? found : { id: found.id, lookup: true };
}

// Actions that require at least worker level (trigger tokens cannot use these)
const workerOnlyActions = new Set(
  (workerActions as readonly string[]).filter(a => !(triggerActions as readonly string[]).includes(a))
);

/**
 * Structured 403-style refusal for a call above the caller's token level.
 * Shared by every privilege gate so a caller can always distinguish "wrong
 * level" (this — a 403-shaped JSON body) from "expired/invalid auth" (a real
 * 401), rather than guessing from prose that varied per call site.
 */
function forbiddenResult(reason: string, tokenLevel: string, requiredLevel: 'worker' | 'admin'): ToolResult {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'forbidden',
        reason,
        tokenLevel,
        requiredLevel,
      }),
    }],
    isError: true,
  };
}

async function requireWorkerLevel(ctx: ActionContext, action: string): Promise<ToolResult | null> {
  if (!workerOnlyActions.has(action)) return null;
  const level = await ctx.getLevel();
  if (level === 'trigger') {
    return forbiddenResult(
      `action '${action}' requires a worker or admin token. Trigger tokens can only use: ${triggerActions.join(', ')}`,
      level,
      'worker',
    );
  }
  return null;
}

// Actions that require admin level (non-admin tokens must get a structured 403)
const adminActionsSet = new Set<string>([...adminActions]);

/**
 * Pre-flight admin level check. Returns a structured 403-style error result for
 * non-admin tokens so that callers can distinguish privilege failures from
 * authentication failures (expired/invalid tokens → 401; wrong level → 403).
 *
 * Using `return` instead of `throw` keeps the error in-band as a ToolResult
 * and prevents the route-level catch from re-wrapping it as a generic "Error: …".
 */
async function requireAdminLevel(ctx: ActionContext, action: string, params?: Record<string, unknown>): Promise<ToolResult | null> {
  if (!adminActionsSet.has(action)) return null;
  const level = await ctx.getLevel();
  if (level === 'admin') return null;
  // A personal role is any member's own (PERSONAL_ROLE_ACTIONS): worker level.
  if (isPersonalRoleCall(action, params)) {
    return level === 'worker' ? null : forbiddenResult(`action '${action}' with personal: true requires a worker or admin token`, level, 'worker');
  }
  return forbiddenResult(`action '${action}' requires admin token level`, level, 'admin');
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
// Not 'memory': that namespace is team-wide, and entity-keyed supersession
// would flip other projects' memories. Memory supersession goes only through
// explicit `supersedes` narrowed to the caller's project (ownSupersedes).
const ENTITY_SUPERSEDABLE_CORPORA: ReadonlySet<string> = new Set(['task', 'plan', 'artifact']);

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
    // Team-scoped corpora (memory, initiative) namespace by teamId so they're
    // recallable across every workspace in the team; work-product corpora
    // (task, pr, plan, artifact, session) are per-workspace.
    let ns: string | null;
    if (corpus === 'memory' || corpus === 'initiative') {
      ns = ctx.teamId ? buildNamespace(ctx.teamId, corpus) : null;
    } else {
      const wsId = ctx.workspaceId || (await ctx.getWorkspaceId());
      ns = wsId ? buildNamespace(wsId, corpus) : null;
    }
    if (!ns) return null;
    const result = await ctx.knowledgeStore.upsert(ns, [chunk]);
    return result ?? null;
  } catch {
    // Best-effort — never fail the underlying action if indexing fails.
    return null;
  }
}


/** A bounded artifact read (GET /api/artifacts/:id?view=…), as text an agent can act on. */
function renderArtifactRead(read: any): string {
  const n = (x: number) => Number(x).toLocaleString('en-US');
  switch (read.view) {
    case 'outline': {
      const rows = (read.sections as any[]).map((s) => `${'  '.repeat(Math.max(0, s.level - 1))}- ${s.id}: ${s.title} (${n(s.chars)} chars)`);
      return [
        `## Outline (${n(read.chars)} characters, ${n(read.sections.length)} sections)`,
        '',
        rows.length ? rows.join('\n') : '(no headings: read it with view "range", offset and length)',
        '',
        'Read one part with view "section" and its id, search with view "grep" and grep, or pass full: true for the whole body.',
      ].join('\n');
    }
    case 'section':
      return `## Section ${read.section.id}: ${read.section.title} (${n(read.section.chars)} chars${read.truncated ? ', cut at 20,000; read the rest with view "range"' : ''})\n\n${read.text}`;
    case 'range':
      return `## Characters ${n(read.offset)}–${n(read.offset + read.length)} of ${n(read.chars)}${read.truncated ? ' (cut at 20,000)' : ''}\n\n${read.text}`;
    case 'grep':
      return [
        `## ${n(read.matches.length)} match(es) for "${read.pattern}"${read.truncated ? ' (first 50)' : ''}`,
        '',
        ...(read.matches as any[]).map((m) => `line ${n(m.line)} (offset ${n(m.offset)}):\n${m.text}`),
      ].join('\n');
    case 'meta':
      return `## ${n(read.chars)} characters, ${n(read.sections)} sections. Read the outline with view "outline".`;
    default:
      return '';
  }
}

export async function handleBuilddAction(
  api: ApiFn,
  action: string,
  params: Record<string, unknown>,
  ctx: ActionContext,
): Promise<ToolResult> {
  const tokenScopes = await ctx.getScopes?.();
  if (tokenScopes != null) {
    const requiredScope = requiredScopeForAction(action, params);
    if (requiredScope && !hasTokenScope(tokenScopes, requiredScope)) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          error: 'forbidden', requiredScope,
          reason: `action '${action}' requires scope '${requiredScope}'`,
        }) }],
      };
    }
  } else {
    // Existing tokens keep their level-based permissions.
    const levelErr = await requireWorkerLevel(ctx, action);
    if (levelErr) return levelErr;
    const adminErr = await requireAdminLevel(ctx, action, params);
    if (adminErr) return adminErr;
  }

  // claim_task is the first lifecycle call agents are instructed to make, but
  // hosted agents can arrive with a worker already assigned in their MCP URL.
  // Make that call idempotent: without this check, the generic claim endpoint
  // either returned "No tasks available" or assigned an unrelated pending task
  // while the caller continued working on its pre-provisioned assignment.
  //
  // This intentionally runs before the multi-workspace guard. The worker lookup
  // is account-scoped and identifies one exact assignment, so no ambiguous
  // workspace selection or new mutation occurs.
  if (action === 'claim_task' && ctx.workerId) {
    try {
      const worker = await api(`/api/workers/${ctx.workerId}`);
      const workerIsActive = ['idle', 'running', 'starting', 'waiting_input'].includes(worker?.status);
      const taskIsActive = ['assigned', 'in_progress'].includes(worker?.task?.status);
      // An explicit taskId naming a different task is a deliberate pickup, not
      // the "first lifecycle call" this shortcut exists for.
      const explicitOther = typeof params.taskId === 'string' && params.taskId !== worker?.task?.id;
      if (workerIsActive && taskIsActive && !explicitOther) {
        return text(
          `Current assignment already active (no new task claimed):\n\n` +
          `${formatClaimedAssignment(worker, '')}\n\n` +
          'Continue using this worker ID for progress reporting and completion.',
        );
      }
    } catch {
      // Preserve the existing claim flow when contextual worker recovery fails.
      // The claim endpoint remains the source of truth for unassigned callers.
    }
  }

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
    case 'list_workspaces': {
      if (ctx.listWorkspaces) return text(renderWorkspaceListing(await ctx.listWorkspaces(), params));
      const data = await api('/api/workspaces');
      const level = await ctx.getLevel();
      const rows: WorkspaceListing[] = (data?.workspaces || []).map((w: any) => ({
        workspaceId: w.id,
        name: w.name,
        repo: w.repo ?? null,
        teamId: w.teamId ?? null,
        teamName: w.team?.name ?? null,
        level,
      }));
      return text(renderWorkspaceListing(rows, params));
    }

    case 'list_tasks': {
      // Every filter here narrows the result, so one that is misspelled, malformed
      // or unsupported must fail loudly: dropped silently, the call returns the
      // whole workspace and reads as a filtered answer.
      const allowedListTaskParams = new Set(['workspaceId', 'limit', 'offset', 'status', 'missionId']);
      const unknownListParams = Object.keys(params).filter(key => !allowedListTaskParams.has(key));
      if (unknownListParams.length > 0) {
        throw new Error(`Unknown list_tasks parameter(s): ${unknownListParams.join(', ')}. Supported: ${[...allowedListTaskParams].join(', ')}.`);
      }
      if (params.status !== undefined && !['active', 'completed', 'failed', 'cancelled'].includes(params.status as string)) {
        throw new Error(`list_tasks status must be one of: active, completed, failed, cancelled — received ${JSON.stringify(params.status)}.`);
      }
      if (params.missionId !== undefined) requireFullUuid(params.missionId, 'missionId');
      // An explicit workspaceId (the guard above asks for one) wins over the default.
      const wsId = params.workspaceId
        ? await resolveWorkspaceId(api, params.workspaceId, ctx)
        : ctx.workspaceId || await ctx.getWorkspaceId();
      const rawLimit = params.limit;
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50)
        : 5;
      const offset = Math.max((params.offset as number) || 0, 0);
      // status was hardcoded to 'active' — a caller auditing completed work had no
      // way to reach it through this action at all, and had to detour through
      // get_task/get_artifact one row at a time. A terminal status here switches
      // the REST route into its audit mode: exact-status match, no 24h window,
      // fully paginated, with per-row deliverable attribution.
      const status = typeof params.status === 'string' ? params.status : 'active';
      const isTerminalAudit = status !== 'active';
      // Server handles status filter, workspace scoping, sort (pending-first /
      // priority-desc, or updatedAt-desc for a terminal audit), and pagination —
      // no client-side fan-out needed.
      const query = new URLSearchParams({ status, limit: String(limit), offset: String(offset) });
      if (wsId) query.set('workspaceId', wsId);
      const missionId = typeof params.missionId === 'string' ? params.missionId : null;
      if (missionId) query.set('missionId', missionId);
      const data = await api(`/api/tasks?${query.toString()}`);
      const paginated: any[] = data.tasks || [];
      const scope = missionId ? ` in mission ${missionId}` : '';

      if (paginated.length === 0 && offset === 0) return text(`No ${status} tasks found${scope}.`);

      const total: number = data.total ?? paginated.length;
      const pendingCount: number = data.pendingCount ?? paginated.filter((t: any) => t.status === 'pending').length;
      const hasMore: boolean = data.hasMore ?? false;

      const summary = paginated.map((t: any) => {
        const catPrefix = t.category ? `[${t.category}] ` : '';
        const statusSuffix = t.status !== 'pending' ? ` [${t.status}]` : '';
        const desc = t.descriptionPreview || 'No description';
        if (!isTerminalAudit) {
          return `- ${catPrefix}${t.title}${statusSuffix} (id: ${t.id})\n  ${desc}`;
        }
        // Deliverable attribution: what a completed/failed/cancelled row actually
        // shipped, so a fallback summary with nothing merged doesn't read as a
        // real outcome (see the AC-3 completion-gate false-positive class).
        const provenance = t.summarySource ? ` summary:${t.summarySource}` : '';
        const deliverable = t.prNumber ? ` PR #${t.prNumber}` : t.hasArtifact ? ' artifact' : ' no-deliverable';
        const updated = t.updatedAt ? ` (updated ${new Date(t.updatedAt).toISOString()})` : '';
        return `- ${catPrefix}${t.title}${statusSuffix}${updated} (id: ${t.id})${provenance}${deliverable}\n  ${desc}`;
      }).join('\n\n');

      const header = isTerminalAudit
        ? `${total} ${status} task${total === 1 ? '' : 's'}${scope}:`
        : `${total} active task${total === 1 ? '' : 's'}${scope} (${pendingCount} pending, ${total - pendingCount} in progress):`;
      const moreHint = hasMore ? `\n\nCall with offset=${offset + limit} to see more.` : '';
      const claimHint = isTerminalAudit || ctx.surface === 'chat'
        ? ''
        : `\n\nTo claim a task, call action=claim_task: it auto-assigns the highest-priority pending task, or pass params.taskId to pick up a specific one.`;
      return text(`${header}\n\n${summary}${moreHint}${claimHint}`);
    }

    case 'get_task': {
      const taskId = requireFullUuid(params.taskId, 'taskId');

      const includeParam = params.include;
      const includes = Array.isArray(includeParam)
        ? (includeParam as string[])
        : ['workers', 'artifacts'];
      const unknownIncludes = includes.filter(i => !GET_TASK_INCLUDES.includes(i));
      if (unknownIncludes.length > 0) {
        throw new Error(`get_task include must be drawn from: ${GET_TASK_INCLUDES.join(', ')} — unsupported: ${unknownIncludes.join(', ')}.`);
      }
      // `scheduling` is rendered from the task row the route already returns;
      // only workers/artifacts need a server-side expansion.
      const serverIncludes = includes.filter(i => i !== 'scheduling');
      const qs = serverIncludes.length > 0 ? `?include=${encodeURIComponent(serverIncludes.join(','))}` : '';

      const task = await api(`/api/tasks/${encodeURIComponent(taskId)}${qs}`).catch((e: unknown) => {
        // The id is often a mission's, read off a mission list: say where to go.
        if (e instanceof Error && /^API error: 404\b/.test(e.message)) {
          throw new Error(`${e.message}. If this id came from a mission list it is a mission id: read it with manage_missions (action "get").`);
        }
        throw e;
      });

      const appBase = ctx.appBaseUrl || 'https://buildd.dev';
      const taskUrl = `${appBase}/app/tasks/${task.id}`;
      // Workers, artifacts and loop iterations are capped to the newest few
      // unless all:true; each cut says how many it left out.
      const showAll = params.all === true;

      const lines: string[] = [];
      lines.push(`**Task:** ${task.title} (${task.id})`);
      lines.push(`**Status:** ${task.status}${task.category ? ` [${task.category}]` : ''} (priority ${task.priority ?? 0})`);
      lines.push(`**Task URL:** ${taskUrl}`);
      // Stored legibility facts — the mission phase this task belongs to and the
      // shape of its work. Printed rather than left to the JSON body so a reader
      // asking "which phase is this in?" gets an answer without a second call.
      if (task.missionPhaseIndex != null && task.missionPhaseLabel) {
        lines.push(`**Phase:** ${task.missionPhaseIndex} · ${task.missionPhaseLabel}`);
      }
      if (task.kind) lines.push(`**Kind:** ${task.kind}${task.roleSlug ? ` (role: ${task.roleSlug})` : ''}`);
      // Only when it says something: a claim/failover moved the task, or the
      // backend is pinned so failover will leave it alone.
      const backendRouting = describeBackendRouting(task.context, task.backend);
      if (backendRouting) {
        lines.push(`**Backend:** ${backendLabel(backendRouting.backend)} (${backendRouting.summary})`);
      } else if (isBackendPinned(task.context)) {
        lines.push(`**Backend:** ${backendLabel(task.backend)} (pinned: failover will not move it)`);
      }
      if (task.startAt) lines.push(`**Starts at:** ${new Date(task.startAt).toISOString()}`);
      if (task.loopConfig) {
        const maxLoops = task.loopConfig.maxLoops ?? 5;
        const attempt = Math.min((task.loopIteration ?? 0) + 1, maxLoops);
        lines.push(`**Loop:** ${task.loopState ?? 'pending'} — attempt ${attempt}/${maxLoops}`);
        const condition = task.loopConfig.exitCondition;
        const conditionDetail = condition.type === 'command' && condition.command
          ? `: \`${condition.command}\``
          : '';
        lines.push(`**Exit condition:** ${condition.type}${conditionDetail}`);

        const history = Array.isArray(task.result?.loopHistory)
          ? task.result.loopHistory
          : Array.isArray(task.context?.loopHistory)
            ? task.context.loopHistory
            : [];
        lines.push('', `## Loop history (${history.length})`);
        if (history.length === 0) {
          lines.push('No iterations evaluated yet.');
        } else {
          // Newest last, as stored: keep the latest iterations.
          const omittedIterations = showAll ? 0 : Math.max(history.length - GET_TASK_LOOP_ITERATIONS_SHOWN, 0);
          if (omittedIterations > 0) lines.push(`(${omittedIterations} earlier iteration${omittedIterations === 1 ? '' : 's'} omitted — pass all:true for every one.)`);
          const kept = history.slice(omittedIterations);
          for (const [i, entry] of kept.entries()) {
            // The latest iteration's evidence at full preview; earlier ones short.
            const evidenceChars = showAll || i === kept.length - 1 ? 300 : 100;
            const evidence = entry.evidence && typeof entry.evidence === 'object'
              ? entry.evidence as Record<string, unknown>
              : {};
            const durationMs = typeof evidence.durationMs === 'number' ? evidence.durationMs : null;
            const duration = durationMs === null ? '' : ` · ${(durationMs / 1000).toFixed(2)}s`;
            const excerptValue = evidence.output ?? evidence.stderr ?? evidence.stdout;
            const excerpt = typeof excerptValue === 'string'
              ? `\n  Evidence: ${excerptValue.slice(0, evidenceChars)}${excerptValue.length > evidenceChars ? `… (+${excerptValue.length - evidenceChars} chars)` : ''}`
              : '';
            lines.push(`- **Iteration ${(entry.iteration ?? 0) + 1}:** ${entry.satisfied ? 'met' : 'unmet'} · ${entry.conditionType}${duration}\n  ${entry.summary ?? 'No summary'}${excerpt}`);
          }
        }
      }
      if (task.workspace?.name || task.workspace?.repo) {
        lines.push(`**Workspace:** ${task.workspace.name}${task.workspace.repo ? ` (${task.workspace.repo})` : ''}`);
      }
      if (task.mission) {
        lines.push(`**Mission:** ${task.mission.title} (${task.mission.id}) — ${task.mission.status}`);
      }
      if (includes.includes('scheduling')) lines.push(...formatTaskScheduling(task));
      if (task.description) {
        const desc = params.fullDescription === true
          ? task.description
          : truncate(task.description, GET_TASK_DESCRIPTION_PREVIEW_CHARS);
        lines.push('', '## Description', desc);
        if (params.fullDescription !== true && task.description.length > GET_TASK_DESCRIPTION_PREVIEW_CHARS) {
          lines.push('Call get_task with fullDescription:true to read the complete instructions and policy sections.');
        }
      }

      const result = task.result;
      const hasResult = !!(result && (result.summary || result.prUrl || result.prNumber || result.sha));
      if (hasResult) {
        lines.push('', '## Result');
        if (result.summary) {
          const fallbackNote = result.summarySource === 'fallback'
            ? ' _(auto-captured last message — the agent never called complete_task with a summary; treat as unverified, not a confirmed outcome)_'
            : '';
          lines.push(`**Summary:** ${result.summary}${fallbackNote}`);
        }
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

      // Why it ended as it did: written when the task failed or completed with a
      // caveat, so "did it fail, why" needs no second call.
      const mismatchLines = formatTaskMismatch(result?.mismatch);
      if (mismatchLines.length > 0) lines.push('', ...mismatchLines);
      const evidenceLines = formatTaskEvidence(result?.evidence);
      if (evidenceLines.length > 0) lines.push('', ...evidenceLines);
      if (result?.error && typeof result.error === 'string' && !result.evidence) {
        lines.push('', `**Error:** ${String(result.error).slice(0, 400)}`);
      }
      const evidenceObjectLines = formatEvidenceObjects(task.evidenceObjects);
      if (evidenceObjectLines.length > 0) lines.push('', ...evidenceObjectLines);

      const workers = Array.isArray(task.workers) ? task.workers : [];
      if (workers.length > 0) {
        lines.push('', `## Workers (${workers.length})`);
        // Newest first, as the route orders them. Every worker's page is the
        // task URL above, so it is not repeated per worker.
        const { shown: shownWorkers, omitted: omittedWorkers } = capList(workers, GET_TASK_WORKERS_SHOWN, showAll);
        for (const w of shownWorkers as any[]) {
          const wlines: string[] = [];
          wlines.push(`- **${w.id}** — ${w.status}${w.branch ? ` on \`${w.branch}\`` : ''}`);
          if (w.currentAction) wlines.push(`  Current action: ${w.currentAction}`);
          if (w.prUrl || w.prNumber) wlines.push(`  PR: ${w.prUrl || `#${w.prNumber}`}`);
          if (w.supersededByPrNumber) {
            wlines.push(`  Superseded by: PR #${w.supersededByPrNumber}${w.supersededByPrUrl ? ` (${w.supersededByPrUrl})` : ''} — ${w.supersededReason ?? 'no reason recorded'}`);
          }
          if (w.lastCommitSha) wlines.push(`  Last commit: ${String(w.lastCommitSha).slice(0, 7)}`);
          if (w.completedAt) wlines.push(`  Completed: ${w.completedAt}`);
          if (w.error) wlines.push(`  Error: ${showAll ? w.error : truncate(String(w.error), 400)}`);
          // A gate-rejected completion (outputRequirement 400) persists the
          // agent's summary here instead of discarding it — surface it
          // plainly as a REJECTED deliverable, never as a satisfied one.
          if (w.rejectedCompletionPayload) {
            const rc = w.rejectedCompletionPayload;
            wlines.push(`  ⚠️ **Rejected deliverable** (outputRequirement '${rc.reason}' not satisfied, not a completed outcome)`);
            if (rc.salvagedArtifactId) wlines.push(`  Salvaged as artifact: ${rc.salvagedArtifactId} (use get_artifact to read it)`);
            if (rc.summary) wlines.push(`  Rejected summary: ${rc.summary}`);
          }
          if (w.waitingFor) {
            const actionUrl = `${taskUrl}/respond`;
            wlines.push(`  **Needs input:** ${w.waitingFor.prompt || 'Awaiting response'}`);
            wlines.push(`  Action URL: ${actionUrl}`);
          }
          lines.push(wlines.join('\n'));
        }
        if (omittedWorkers > 0) lines.push(`(${omittedWorkers} older worker${omittedWorkers === 1 ? '' : 's'} omitted — pass all:true for every one.)`);
      }

      const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
      if (artifacts.length > 0) {
        lines.push('', `## Artifacts (${artifacts.length})`);
        const { shown: shownArtifacts, omitted: omittedArtifacts } = capList(artifacts, GET_TASK_ARTIFACTS_SHOWN, showAll);
        if (omittedArtifacts > 0) lines.push(`(${omittedArtifacts} more not shown — pass all:true, or list_artifacts.)`);
        for (const a of shownArtifacts as any[]) {
          const meta = a.key ? `, key: ${a.key}` : '';
          const share = a.shareUrl ? `\n  Share: ${a.shareUrl}` : '';
          lines.push(`- **${a.title}** (${a.type}${meta})\n  ID: ${a.id}${share}`);
        }
      }

      if (includes.includes('dispatch')) lines.push('', ...formatDispatchTrail(task.dispatch));

      if (workers.length === 0 && !hasResult) {
        const hint = task.status === 'pending'
          ? '\nTask is pending — not yet claimed by a worker.'
          : task.status === 'completed'
          ? '\nTask completed but no result snapshot available.'
          : '';
        if (hint) lines.push(hint);
      }

      return text(lines.join('\n'));
    }

    case 'claim_task': {
      const taskId = params.taskId === undefined || params.taskId === null
        ? undefined
        : requireFullUuid(params.taskId, 'taskId');
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      let data: any;
      try {
        data = await api('/api/workers/claim', {
          method: 'POST',
          body: JSON.stringify({
            maxTasks: params.maxTasks || 1,
            workspaceId: wsId,
            runner: 'mcp',
            ...(taskId ? { taskId } : {}),
            // Admin-only on the server, and only with a taskId; see
            // ClaimTasksInput.forceOverride.
            ...(taskId && params.force === true ? { forceOverride: true } : {}),
          }),
        });
      } catch (err) {
        const limit = describeAccountLimitError(err);
        if (limit) return text(limit);
        throw err;
      }

      const workers = data.workers || [];
      if (workers.length === 0) return text(describeEmptyClaim(data, taskId));

      // Push to this exact branch. create_pr also accepts a different branch
      // you actually pushed to instead — as long as no other worker already
      // owns that name — but the generated one below always works and needs
      // no extra checks, so prefer it over inventing another name.
      const claimed = workers.map((w: any) =>
        formatClaimedAssignment(w, " (push here — create_pr's head must be this branch, or another name nobody else is using)")
      ).join('\n\n---\n\n');

      // Proactively fetch relevant memory. Invariant: only memory from the
      // claimed task's own workspace, never from a sensitive one. The store is
      // team-keyed, so the search must also carry the workspace's project key —
      // a bare title search ranks every workspace in the team. Anything we can't
      // scope (no workspace on the payload, no project key) gets no memory.
      let memorySection = '';
      try {
        const claimedTask = workers[0]?.task;
        const claimedWs = claimedTask?.workspace;
        // The key is memoryProjectKey's, the same rule every other memory read
        // uses: it also closes a key shared with a sensitive workspace in the
        // team, which the payload alone cannot show. retrieveMemory resolves it
        // from the workspace itself and searches nothing when there is none.
        const claimedWsId = claimedTask?.workspaceId ?? claimedWs?.id;
        const memClient = claimedWs && claimedWs.dataClass !== 'sensitive' && claimedWsId
          && claimedTask?.title && ctx.getMemoryClient
          ? await ctx.getMemoryClient(claimedWsId)
          : null;
        if (memClient) {
          const indexOn = isMemoryIndexEnabled(claimedWs.gitConfig);
          const { memories, commitLedger } = await retrieveMemory<any>({
            strategy: 'store-search',
            searcher: memClient,
            search: { query: claimedTask.title, limit: 5 },
            scope: { teamId: claimedWs.teamId, workspaceId: claimedWsId },
            caller: 'claim_task_reply',
            attribution: { taskId: workers[0]?.taskId ?? claimedTask.id, workerId: workers[0]?.id },
            ledger: ctx.memoryLedger,
            // Index mode holds the ledger until the budget has decided what shows.
            ...(indexOn ? { deferLedger: true } : {}),
          });
          if (indexOn) {
            // Index injection (see ./memory-claim-index): the claim route's entries
            // first, since this reply is the only place an MCP agent sees
            // them, then this search's, deduped, under one budget.
            const entries: MemoryIndexEntry[] = [
              ...readMemoryIndexEntries(claimedTask.context),
              ...memories.map((m: any) => ({ id: String(m.id), type: String(m.type ?? 'memory'), title: String(m.title ?? ''), why: 'title' as const })),
            ];
            const index = buildMemoryIndex(entries, { budgetTokens: memoryIndexTokenBudget(claimedWs.gitConfig) });
            // Shown here, or already shown by the claim-time block (a dedupe, not a drop).
            const shownIds = new Set(index.shown.map(e => e.id));
            commitLedger(h => (shownIds.has(h.memoryId) ? null : 'char_budget'));
            if (index.lines.length > 0) memorySection = `\n\n## Relevant Memory\n${index.lines.join('\n')}`;
          } else if (memories.length > 0) {
            const memoryLines = memories.map((m: any) => {
              const truncContent = m.content.length > CLAIM_MEMORY_PREVIEW_CHARS ? `${m.content.slice(0, CLAIM_MEMORY_PREVIEW_CHARS)}… (+${m.content.length - CLAIM_MEMORY_PREVIEW_CHARS} chars${m.id ? `: recall {id: "${m.id}"}` : ''})` : m.content;
              return `- **[${m.type}] ${m.title}**: ${truncContent}`;
            });
            memorySection = `\n\n## Relevant Memory\nREAD these memories before starting work:\n${memoryLines.join('\n')}\n\nCall recall with scope=["memory","task"] for prior lessons + recent outcomes in one fused call.`;
          }
        }
      } catch {
        // Memory fetch is non-fatal
      }

      // Open PRs section: inform agent about concurrent work
      const firstWorkerPRs = workers[0]?.openPRs;
      const openPRsSection = Array.isArray(firstWorkerPRs) && firstWorkerPRs.length > 0
        ? formatClaimOpenPRs(firstWorkerPRs, workers[0]?.task?.pathManifest)
        : '';

      return text(`Claimed ${workers.length} task(s):\n\n${claimed}${openPRsSection}${memorySection}\n\nUse the worker ID to report progress and completion.`);
    }

    case 'update_progress': {
      const workerId = resolveWorkerId(params.workerId, ctx);

      let response;
      try {
        const milestoneTs = Date.now();
        const appendMilestones = [
          ...(params.plan ? [{
            type: 'plan',
            origin: 'agent',
            label: params.plan,
            ...(typeof params.progress === 'number' && { progress: params.progress }),
            ts: milestoneTs,
          }] : []),
          ...(params.message ? [{
            type: 'status',
            origin: 'agent',
            label: params.message,
            ...(typeof params.progress === 'number' && { progress: params.progress }),
            ts: milestoneTs,
          }] : []),
        ];

        const progressBody: Record<string, unknown> = {
          status: 'running',
          ...(typeof params.progress === 'number' && { progress: params.progress }),
          ...(appendMilestones.length > 0 && { appendMilestones }),
          // The agent consumer. The server serves it messages only on an
          // interactive worker (no runner exists to deliver them); on a
          // runner-managed worker the runner delivers at the next turn boundary
          // and this call gets nothing, so the two never race for one queue.
          // Nothing depends on this call any more: receive_messages is the
          // dedicated read.
          consumer: 'agent',
        };
        if (params.message) progressBody.currentAction = params.message;
        // Worker self-classification. The server writes it only when the task
        // has no kind yet, so this is always safe to send.
        if (typeof params.kind === 'string') progressBody.kind = params.kind;
        if (typeof params.inputTokens === 'number') progressBody.inputTokens = params.inputTokens;
        if (typeof params.outputTokens === 'number') progressBody.outputTokens = params.outputTokens;
        if (typeof params.costUsd === 'number') progressBody.costUsd = params.costUsd;
        if (typeof params.costBasis === 'string') progressBody.costBasis = params.costBasis;
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

      const resultText = `Progress updated${params.message ? ` - ${params.message}` : ''}`;
      // Back-compat for interactive sessions whose hooks predate
      // receive_messages: whatever the server served is rendered and acked here.
      const messages = await renderAndAckMessages(api, workerId, response);
      return text(messages ? `${resultText}\n\n${messages}` : resultText);
    }

    case 'receive_messages': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      let response;
      try {
        // Nothing but the consumer declaration: this is a read, not progress.
        response = await api(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({ consumer: 'agent' }),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('409')) {
          return errorResult('**ABORT: Your worker has been terminated.** STOP working on this task immediately.');
        }
        throw err;
      }
      const messages = await renderAndAckMessages(api, workerId, response);
      return text(messages ?? 'No messages for you right now.');
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
            // The agent's own call, not the runner's end-of-session report: it
            // can read a 400 and retry, so the server refuses a fixable verdict
            // instead of failing the worker.
            viaCompleteTask: true,
            ...(params.summary ? { summary: params.summary, summarySource: 'agent' } : {}),
            ...(params.structuredOutput ? { structuredOutput: params.structuredOutput } : {}),
            ...(params.nextSuggestion ? { nextSuggestion: params.nextSuggestion } : {}),
            ...(params.discardEdits ? { discardEdits: params.discardEdits } : {}),
            ...(params.alreadyShippedIn != null ? { alreadyShippedIn: params.alreadyShippedIn } : {}),
            // Self-reported usage: the only way an interactive MCP session (no
            // runner watching the process to measure tokens/cost) can attribute
            // its own consumption. Same fields update_progress accepts; both go
            // through the ordinary PATCH path (plain overwrite, not the
            // metricsOnly-gated monotonic raise() in route.ts).
            ...(typeof params.inputTokens === 'number' ? { inputTokens: params.inputTokens } : {}),
            ...(typeof params.outputTokens === 'number' ? { outputTokens: params.outputTokens } : {}),
            ...(typeof params.costUsd === 'number' ? { costUsd: params.costUsd } : {}),
            ...(typeof params.costBasis === 'string' ? { costBasis: params.costBasis } : {}),
          }),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('409')) {
          // A local session whose task already completed (its PR merged) has its
          // slot released by the server; the task's outcome is already recorded.
          if (errMsg.includes('Worker already completed')) {
            return text('Task already completed; this session\'s slot was released. Nothing more to record.');
          }
          return errorResult('**WARNING: Worker was already terminated.** The task may have been reassigned. Your work may have been superseded by another worker.');
        }
        // Handle output requirement validation errors (400) — return hint so agent can fix
        if (errMsg.includes('400')) {
          try {
            const jsonMatch = errMsg.match(/\{.*\}/s);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.hint) {
                // `hint` is a gate slug, not always a callable action — only
                // some values (create_pr, create_artifact) name a real tool to
                // retry with. For the rest, `parsed.error` already spells out
                // the actual fix (e.g. the structuredOutput field to set), so
                // don't invent a "use `<hint>`" instruction pointing at a tool
                // that doesn't exist.
                const hintNames = String(parsed.hint).split(' or ').map(h => h.trim());
                const retryLine = hintNames.every(h => RETRY_HINT_ACTIONS.has(h))
                  ? `Please use \`${parsed.hint}\` before calling complete_task again.`
                  : 'Address this, then call complete_task again.';
                return errorResult(`**Cannot complete task:** ${parsed.error}\n\n${retryLine}`);
              }
            }
          } catch { /* fall through to generic error */ }
          return errorResult(`**Cannot complete task:** ${errMsg}\n\nIf you created a PR using \`gh pr create\`, use \`create_pr\` instead so Buildd can track it.`);
        }
        throw err;
      }

      // The route answers 200 with the row it actually wrote, which is not the
      // `completed` this call asked for when a server-side guard (review or
      // planning contract) overrode it. Report that, not a success: a caller
      // that is told "completed" will not retry the verdict that was dropped.
      if (result?.status === 'failed' || result?.status === 'error') {
        return errorResult(
          `**Task NOT recorded as completed.** The server marked this worker ${result.status}` +
          `${result.error ? `: ${result.error}` : '.'}\n\n` +
          'Nothing you reported was applied. Check the task with get_task — it may have been requeued for another attempt — and fix what the message above names before reporting again.',
        );
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
            // The persisted result.summary can predate THIS call (e.g. a retry's
            // complete_task with no summary param, reading back what an earlier
            // worker on this task left behind). Only trust it as an outcome when
            // it was agent-authored — a 'fallback' summary (runner's last-message
            // capture, see apps/runner/src/workers.ts) must never be re-ingested
            // into the KB as if it were a real result just because it happens to
            // sit in the DB row.
            const persistedSummaryIsAuthored = taskData?.result?.summarySource !== 'fallback';
            const authoredPersistedSummary = persistedSummaryIsAuthored ? (taskData?.result?.summary ?? null) : null;
            const taskChunk = buildTaskCard({
              taskId,
              title: taskData?.title ?? null,
              description: taskData?.description ?? null,
              summary: (params.summary as string) ?? authoredPersistedSummary,
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
                summary: (params.summary as string) ?? authoredPersistedSummary,
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

      // ── lede: required, and enforced HERE ────────────────────────────────
      // Before the HTTP call, so an absent lede cannot leave a half-created PR
      // behind: the throw happens while GitHub still knows nothing about this.
      //
      // The one exemption is the `prUrl` adoption path, which registers a pull
      // request that ALREADY EXISTS on GitHub. Refusing that would strand a
      // real PR over a missing sentence — so it gets a deterministic fallback
      // derived from its own title instead of a hard failure.
      const suppliedLede = normalizeLede(params.lede);
      const isAdoption = Boolean(params.prUrl);
      if (!suppliedLede && !isAdoption) {
        throw new Error(LEDE_REQUIRED_ERROR);
      }
      const lede = suppliedLede || deriveLedeFromTitle(String(params.title));
      const ledeIsDerived = !suppliedLede;

      const data = await api('/api/github/pr', {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          title: params.title,
          body: params.body,
          lede,
          ledeDerived: ledeIsDerived,
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
          // The corpus gets the same lede-first body GitHub does — including on
          // the adoption path, where buildd does not own the PR body on GitHub
          // and the derived lede leads only the record buildd stores.
          body: composeBodyWithLede(lede, (params.body as string) ?? null, { derived: ledeIsDerived }),
          url: data.pr.url ?? (params.prUrl as string) ?? null,
          taskId,
          missionId,
        });
        // Stamp with PR creation time for recency decay scoring.
        const prCreatedAt = data.pr.createdAt ?? data.pr.created_at;
        if (prCreatedAt) prChunk.sourceTs = new Date(prCreatedAt);
        await mirrorWorkProduct(ctx, 'pr', prChunk);
      } catch { /* non-fatal */ }

      const headline = data.deduplicated
        ? `No new pull request was opened — an existing one for this ${params.prUrl ? 'prUrl' : 'task/head branch'} was returned (deduplicated).`
        : 'Pull request created!';
      const created = `${headline}\n\n**PR #${data.pr.number}:** ${data.pr.title}\n**URL:** ${data.pr.url}\n**State:** ${data.pr.state}`;

      // requestReview folds "open the PR" and "ask for a review" into one call.
      // A failed review request never hides the PR — the PR exists either way,
      // and the agent needs its number more than it needs the review.
      if (!params.requestReview) return text(created);

      try {
        const review = await api('/api/github/pr/review', {
          method: 'POST',
          body: JSON.stringify({
            prNumber: data.pr.number,
            ...(params.workspaceId != null ? { workspaceId: params.workspaceId } : {}),
            ...(params.reviewerRole != null ? { reviewerRole: params.reviewerRole } : {}),
            ...(params.callbackUrl != null ? { callbackUrl: params.callbackUrl } : {}),
            ...(params.callbackOn != null ? { callbackOn: params.callbackOn } : {}),
          }),
        });
        const state = review.alreadyRequested
          ? `already under review (${review.status?.state})`
          : `reviewer role \`${review.reviewerRole}\``;
        return text(
          `${created}\n\n**Review requested** — ${state}, review task ${review.reviewTaskId}.\n` +
          `Wait for the verdict: action=get_pr_review { prNumber: ${data.pr.number}, waitSeconds: 45 }.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return text(
          `${created}\n\n**Review NOT requested** — the review request failed: ${message}\n` +
          `Retry with action=request_pr_review { prNumber: ${data.pr.number} }.`,
        );
      }
    }

    case 'close_pr': {
      // workerId is optional — route resolves worker from prNumber when absent.
      const workerId = String(params.workerId ?? '') || ctx.workerId || null;
      if (!params.prNumber) throw new Error('prNumber is required');

      const data = await api('/api/github/pr', {
        method: 'PATCH',
        body: JSON.stringify({
          workerId,
          prNumber: params.prNumber,
          ...(params.workspaceId != null ? { workspaceId: params.workspaceId } : {}),
        }),
      });

      const titlePart = data.pr.title ? ` — ${data.pr.title}` : '';
      return text(`Pull request #${data.pr.number} closed${titlePart}\n**URL:** ${data.pr.url}\n**State:** ${data.pr.state}`);
    }

    case 'update_pr': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      if (!params.prNumber) throw new Error('prNumber is required');
      if (params.draft === false && params.body === undefined) {
        const ready = await api('/api/github/pr', {
          method: 'PATCH',
          body: JSON.stringify({ workerId, prNumber: params.prNumber, draft: false }),
        });
        return text(`Pull request #${ready.pr.number} marked ready for review\n**URL:** ${ready.pr.url}\n**State:** ${ready.pr.state}`);
      }
      if (typeof params.body !== 'string') throw new Error('body is required (or draft:false to mark ready for review)');

      const data = await api('/api/github/pr', {
        method: 'PATCH',
        body: JSON.stringify({ workerId, prNumber: params.prNumber, body: params.body }),
      });

      const titlePart = data.pr.title ? ` — ${data.pr.title}` : '';
      return text(`Pull request #${data.pr.number} body updated${titlePart}\n**URL:** ${data.pr.url}\n**State:** ${data.pr.state}`);
    }

    case 'merge_pr': {
      // workerId is optional — route resolves worker from prNumber when absent.
      const workerId = String(params.workerId ?? '') || ctx.workerId || null;
      if (!params.prNumber) throw new Error('prNumber is required');

      const mergeMethod = params.mergeMethod ?? 'squash';
      const overrideFields = {
        ...(params.overrides != null ? { overrides: params.overrides } : {}),
        ...(params.reason != null ? { reason: params.reason } : {}),
      };

      // Chat is a signed-in person in process: it merges through the dashboard's
      // own merge route (the landing page's rails), not the runner-key route.
      if (ctx.surface === 'chat') {
        const res = await api(`/api/prs/${encodeURIComponent(String(params.prNumber))}/merge`, {
          method: 'POST',
          body: JSON.stringify({ ...(params.workspaceId != null ? { workspaceId: params.workspaceId } : {}), ...overrideFields }),
        });
        if (!res.merged) return text(`PR #${params.prNumber} merge failed: ${res.error ?? res.message ?? 'not merged'}`);
        return text(`PR #${params.prNumber} merged successfully.${res.message ? `\n**Message:** ${res.message}` : ''}`);
      }

      const data = await api('/api/github/pr', {
        method: 'PUT',
        body: JSON.stringify({
          workerId,
          prNumber: params.prNumber,
          mergeMethod,
          ...(params.workspaceId != null ? { workspaceId: params.workspaceId } : {}),
          ...overrideFields,
        }),
      });

      if (!data.merged) {
        const hint = data.hint ? `\n\n**Action required:** ${data.hint}` : '';
        return text(`PR #${data.pr?.number ?? params.prNumber} merge failed: ${data.message ?? data.error}${hint}`);
      }
      return text(`PR #${data.pr.number} merged successfully.\n**URL:** ${data.pr.url}\n**Message:** ${data.message}`);
    }

    case 'list_prs': {
      const state = typeof params.state === 'string' && params.state ? params.state : 'open';
      if (state === 'closed') return errorResult('Closed PRs are not listed. Read one with get_pr (prNumber).');
      const qs = new URLSearchParams({ state });
      if (params.workspaceId) {
        const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
        if (wsId) qs.set('workspaceId', wsId);
      }
      if (typeof params.sinceDays === 'number' && params.sinceDays > 0) qs.set('sinceDays', String(Math.trunc(params.sinceDays)));
      if (typeof params.limit === 'number' && params.limit > 0) qs.set('limit', String(Math.trunc(params.limit)));
      const data = await api(`/api/prs?${qs}`);
      return text(renderPrList(data));
    }

    case 'get_pr': {
      // workerId is optional — pass prNumber to resolve from account's workspaces when absent.
      const workerId = String(params.workerId ?? '') || ctx.workerId || null;
      if (!workerId && !params.prNumber) throw new Error('workerId or prNumber is required');

      const includeComments = params.includeComments === true;
      const includeCiFailures = params.includeCiFailures === true;

      const parts: string[] = [];
      if (workerId) parts.push(`workerId=${encodeURIComponent(workerId)}`);
      if (params.prNumber) parts.push(`prNumber=${encodeURIComponent(String(params.prNumber))}`);
      if (params.workspaceId) parts.push(`workspaceId=${encodeURIComponent(String(params.workspaceId))}`);
      if (includeComments) parts.push('includeComments=true');
      if (includeCiFailures) parts.push('includeCiFailures=true');

      const data = await api(`/api/github/pr${parts.length ? '?' + parts.join('&') : ''}`);

      const pr = data.pr;
      const checks = data.checks;
      const reviews = data.reviews;

      const ciLine = checks.total === 0
        ? 'CI: none configured'
        : `CI: ${checks.state} (${checks.passed}/${checks.total} passed${checks.failed > 0 ? `, ${checks.failed} failed` : ''}${checks.pending > 0 ? `, ${checks.pending} pending` : ''})`;

      const showAll = params.all === true;
      const failing = Array.isArray(checks.failedChecks) ? checks.failedChecks as Array<{ name: string; url: string | null }> : [];
      const { shown: shownFailing, omitted: omittedFailing } = capList(failing, GET_PR_FAILING_SHOWN, showAll);
      const failingLine = failing.length > 0
        ? `Failing: ${shownFailing.map(c => (c.url ? `${c.name} (${c.url})` : c.name)).join(', ')}${omittedFailing > 0 ? ` (+${omittedFailing} more — all:true lists every one)` : ''}`
        : '';

      const reviewLine = reviews.approved > 0 || reviews.changesRequested > 0
        ? `Reviews: ${reviews.approved} approved${reviews.changesRequested > 0 ? `, ${reviews.changesRequested} changes requested` : ''}`
        : 'Reviews: none';

      const mergeableLine = pr.mergeable === true ? 'Mergeable: yes'
        : pr.mergeable === false ? `Mergeable: no (${pr.mergeableState ?? 'blocked'})`
        : `Mergeable: unknown (${pr.mergeableState ?? 'computing'})`;

      const generatedNote = pr.generatedFiles > 0
        ? ` (+${pr.generatedAdditions + pr.generatedDeletions} generated across ${pr.generatedFiles} file(s), excluded)`
        : '';
      const statsLine = pr.additions !== null
        ? `Diff: +${pr.additions}/-${pr.deletions} across ${pr.changedFiles} file(s) reviewable${generatedNote}`
        : '';

      const bodyPreview = pr.body
        ? `\n\n**Agent summary:**\n${params.fullBody === true ? pr.body : truncate(pr.body, GET_PR_BODY_PREVIEW_CHARS)}`
        : '';

      const supersededLine = pr.supersededByPrNumber
        ? `Superseded by: PR #${pr.supersededByPrNumber}${pr.supersededByPrUrl ? ` (${pr.supersededByPrUrl})` : ''} — ${pr.supersededReason ?? 'no reason recorded'}`
        : (pr.state === 'closed_unmerged'
          ? 'Closed without merging — no supersession recorded (record_pr_supersession if the work shipped elsewhere)'
          : '');

      const commentsSection = includeComments
        ? (() => {
            const c = data.comments as
              | { items: Array<{ author: string; kind: string; at: string | null; body: string; url: string | null }>; total: number; omitted: number }
              | undefined;
            if (!c || c.total === 0) return '\n\nComments: none';
            const lines = c.items.map((item) => {
              const tag = item.kind === 'buildd' ? 'buildd' : item.kind === 'bot' ? 'bot' : 'human';
              const when = item.at ? ` ${item.at}` : '';
              const link = item.url ? ` (${item.url})` : '';
              return `- [${tag}]${when} ${item.author}: ${item.body}${link}`;
            });
            const omittedNote = c.omitted > 0 ? `\n_(${c.omitted} more omitted)_` : '';
            return `\n\n**Comments** (buildd decision-trail first, ${c.total} total):\n${lines.join('\n')}${omittedNote}`;
          })()
        : '';

      // Log excerpts are already cleaned and redacted by the route; the fence
      // is the only thing to defend here.
      const ciFailuresSection = includeCiFailures
        ? (() => {
            const f = Array.isArray(data.ciFailures)
              ? data.ciFailures as Array<{ name: string; url: string | null; step: string | null; excerpt: string | null }>
              : [];
            if (f.length === 0) return '\n\nNo failing checks to read logs for.';
            const blocks = f.map((c) => {
              const head = `**CI failure: ${c.name}**${c.step ? ` — failing step: ${c.step}` : ''}${c.url ? `\n${c.url}` : ''}`;
              return c.excerpt
                ? `${head}\n\`\`\`\n${c.excerpt.replace(/\`\`\`/g, "'''")}\n\`\`\``
                : `${head}\n(no log available)`;
            });
            return `\n\n${blocks.join('\n\n')}`;
          })()
        : '';

      // Fix attempts on this PR's chain (after CI #N / after review #N), each with
      // why it ended as it did. A PR opened on a new branch by a resumed attempt
      // shows its own number.
      const attemptRows = Array.isArray(data.attempts)
        ? data.attempts as Array<{
            taskId: string; title: string; status: string; prNumber: number | null;
            evidence: { errorClass: string; keyLines: string[] } | null;
            mismatch: Array<{ kind: string; detail: string }>;
          }>
        : [];
      // Oldest first, as the route returns them: keep the latest attempts.
      const omittedAttempts = showAll ? 0 : Math.max(attemptRows.length - GET_PR_ATTEMPTS_SHOWN, 0);
      const attemptsSection = attemptRows.length > 0
        ? `\n\n**Fix attempts (${attemptRows.length}):**${omittedAttempts > 0 ? `\n(${omittedAttempts} earlier attempt${omittedAttempts === 1 ? '' : 's'} omitted — all:true lists every one.)` : ''}\n${attemptRows.slice(omittedAttempts).map((a) => {
            const pr2 = a.prNumber ? ` PR #${a.prNumber}` : '';
            const why = a.evidence ? ` — ${a.evidence.errorClass}${a.evidence.keyLines[0] ? `: ${truncate(a.evidence.keyLines[0], 160)}` : ''}` : '';
            const flags = a.mismatch.length > 0 ? ` ⚠️ ${a.mismatch.map((m) => m.kind).join(', ')}` : '';
            return `- ${a.taskId.slice(0, 8)} ${a.status}${pr2} ${truncate(a.title, 80)}${why}${flags}`;
          }).join('\n')}\nRead one: action=get_task { taskId }, action=get_error_traces { taskId }.`
        : '';

      const evidenceObjectLines = formatEvidenceObjects(data.evidenceObjects);
      const evidenceObjectsSection = evidenceObjectLines.length > 0 ? `\n${evidenceObjectLines.join('\n')}` : '';

      return text([
        `**PR #${pr.number}: ${pr.title ?? '(no title)'}**`,
        `State: ${pr.state} | ${mergeableLine}`,
        ciLine,
        failingLine,
        reviewLine,
        statsLine,
        supersededLine,
        `URL: ${pr.url}`,
        bodyPreview,
        commentsSection,
        ciFailuresSection,
        attemptsSection,
        evidenceObjectsSection,
      ].filter(Boolean).join('\n'));
    }

    case 'request_pr_review': {
      if (!params.prNumber) throw new Error('prNumber is required');

      const data = await api('/api/github/pr/review', {
        method: 'POST',
        body: JSON.stringify({
          prNumber: Number(params.prNumber),
          ...(params.workspaceId != null ? { workspaceId: params.workspaceId } : {}),
          ...(params.reviewerRole != null ? { reviewerRole: params.reviewerRole } : {}),
          ...(params.callbackUrl != null ? { callbackUrl: params.callbackUrl } : {}),
          ...(params.callbackOn != null ? { callbackOn: params.callbackOn } : {}),
          ...(params.force != null ? { force: params.force } : {}),
        }),
      });

      const waitHint = `\n\nWait for the verdict: action=get_pr_review { prNumber: ${data.prNumber}, waitSeconds: 45 } (repeat while terminal is false).`;

      if (data.carriedForward) {
        return text(
          `PR #${data.prNumber}: no re-review dispatched — the approval (review task ${data.reviewTaskId}) ` +
          `still covers the current head (${data.carriedForwardReason ?? 'PR diff unchanged'}). ` +
          `The merge proceeds once CI is green on this head.`,
        );
      }

      if (data.alreadyRequested) {
        return text(
          `PR #${data.prNumber} is already under review — state: **${data.status?.state}** ` +
          `(review task ${data.reviewTaskId}). Pass force=true to re-review a finished review.${waitHint}`,
        );
      }

      const lines = [
        `Review requested for **PR #${data.prNumber}** — reviewer role \`${data.reviewerRole}\` (review task ${data.reviewTaskId}).`,
        data.adopted
          ? `The PR was adopted as task ${data.taskId} (buildd did not open it), so the verdict, PR comment and merge policy now apply to it.`
          : `Mapped to existing task ${data.taskId}.`,
        data.autoMergeExpected
          ? 'On approval buildd will merge it once checks are green.'
          : 'On approval the merge is left to a human (merge policy).',
        data.callback ? `Callback: ${data.callback.url} on ${data.callback.on}.` : null,
      ].filter(Boolean);

      return text(lines.join('\n') + waitHint);
    }

    case 'get_pr_review': {
      if (!params.prNumber) throw new Error('prNumber is required');

      const query = new URLSearchParams({ prNumber: String(Number(params.prNumber)) });
      if (params.workspaceId != null) query.set('workspaceId', String(params.workspaceId));
      if (params.waitFor != null) query.set('waitFor', String(params.waitFor));
      if (params.waitSeconds != null) query.set('waitSeconds', String(params.waitSeconds));

      const data = await api(`/api/github/pr/review?${query.toString()}`);
      const s = data.status ?? {};

      const lines = [
        `**PR #${data.prNumber} review — ${s.state}** (terminal: ${s.terminal ? 'yes' : 'no'})`,
        s.verdict ? `Verdict: ${s.verdict}${typeof s.confidence === 'number' ? ` (confidence ${s.confidence})` : ''}` : null,
        s.summary ? `Summary: ${s.summary}` : null,
        s.feedback ? `Feedback: ${s.feedback}` : null,
        s.escalationReason ? `Escalation: ${s.escalationReason}` : null,
        s.state === 'review_failed'
          ? `Reason: ${s.failureReason ?? 'no verdict was produced and no failure reason was recorded'}`
          : null,
        typeof s.iteration === 'number' && typeof s.maxIterations === 'number'
          ? `Retry iteration: ${s.iteration}/${s.maxIterations}`
          : null,
        `PR: ${s.prState}${s.merged ? ' (merged)' : ''}`,
        s.mergeBlocked === 'awaiting_human' ? 'Approved, but the merge policy leaves the merge to a human.' : null,
        data.timedOut && !s.terminal
          ? `The wait elapsed and the review is still ${s.state} — call again to keep waiting.`
          : null,
      ].filter(Boolean);

      return text(lines.join('\n'));
    }

    case 'record_pr_supersession': {
      // workerId names the calling run (as close_pr sends it); with prNumber the
      // route resolves the PR from prNumber and checks it belongs to this run's task.
      const workerId = params.workerId ?? ctx.workerId ?? null;
      if (!workerId && !params.prNumber) throw new Error('workerId or prNumber is required');
      if (params.supersedingPrNumber == null) throw new Error('supersedingPrNumber is required');
      if (!params.reason || !String(params.reason).trim()) throw new Error('reason is required');

      const data = await api('/api/github/pr/supersede', {
        method: 'POST',
        body: JSON.stringify({
          ...(workerId ? { workerId } : {}),
          ...(params.prNumber != null ? { prNumber: Number(params.prNumber) } : {}),
          ...(params.workspaceId != null ? { workspaceId: params.workspaceId } : {}),
          supersedingPrNumber: Number(params.supersedingPrNumber),
          ...(params.supersedingRepo ? { supersedingRepo: String(params.supersedingRepo) } : {}),
          reason: String(params.reason),
        }),
      });

      return text(
        `PR #${data.supersededPrNumber} recorded as superseded by ${data.supersedingRepo && params.supersedingRepo ? `${data.supersedingRepo}#` : 'PR #'}${data.supersedingPrNumber}.\n`
        + `**Successor:** ${data.supersedingPrUrl}\n`
        + `canCompleteMission, get_pr, get_task and explain now treat PR #${data.supersededPrNumber}'s deliverable as shipped.`,
      );
    }

    case 'update_task': {
      requireFullUuid(params.taskId, 'taskId');

      const updateFields: Record<string, unknown> = {};
      if (params.title !== undefined) updateFields.title = params.title;
      if (params.description !== undefined) updateFields.description = params.description;
      if (params.priority !== undefined) updateFields.priority = normalizePriority(params.priority);
      if (params.project !== undefined) updateFields.project = params.project;
      if (params.status !== undefined) updateFields.status = params.status;
      // Cancelling a task an agent is working on stops it mid-run; the server
      // refuses that unless the caller says abort: true.
      // Pause instead of cancel: its own request, keeps the session for Resume.
      if (params.pause !== undefined) {
        if (params.pause !== true) throw new Error('pause must be true');
        const others = Object.keys(params).filter(k => k !== 'taskId' && k !== 'pause' && k !== 'workspaceId');
        if (others.length > 0) throw new Error(`pause is sent on its own; drop ${others.join(', ')}`);
        const data = await api(`/api/tasks/${params.taskId}`, { method: 'PATCH', body: JSON.stringify({ pause: true }) });
        return text(`Pausing the agent on task ${params.taskId} (worker ${data.workerId}) at its next safe point. Its session is kept; Resume on the task page continues it.`);
      }
      if (params.abort !== undefined) {
        if (params.status !== 'cancelled') throw new Error('abort only applies to status: cancelled');
        if (typeof params.abort !== 'boolean') throw new Error('abort must be true or false');
        updateFields.abort = params.abort;
      }
      if (params.backend !== undefined) {
        // null/'' clears the override (back to mission/role/workspace default).
        const requested = params.backend === null || params.backend === '' ? null : String(params.backend);
        if (requested !== null && !DISPATCHABLE_BACKENDS.includes(requested as typeof DISPATCHABLE_BACKENDS[number])) {
          throw new Error(`backend must be one of: ${DISPATCHABLE_BACKENDS.join(', ')} (or null to clear)`);
        }
        updateFields.backend = requested;
      }
      // Model pins apply at the NEXT claim or retry; a running session keeps
      // its model. null/'' clears so routing decides again.
      if (params.tier !== undefined) {
        const requested = params.tier === null || params.tier === '' ? null : String(params.tier);
        if (requested !== null && !isTaskTier(requested)) {
          throw new Error(`tier must be one of: ${TIERS.join(', ')} (or null to clear)`);
        }
        updateFields.tier = requested;
      }
      if (params.model !== undefined) {
        const requested = params.model === null || params.model === '' ? null : String(params.model).trim();
        if (requested !== null && !isAcceptableModelPin(requested)) {
          throw new Error('model must be an Anthropic model id (e.g. claude-…) or null to clear');
        }
        updateFields.model = requested;
      }
      if (params.maxLoops !== undefined) {
        if (
          typeof params.maxLoops !== 'number'
          || !Number.isInteger(params.maxLoops)
          || params.maxLoops < LOOP_MAX_LOOPS_MIN
          || params.maxLoops > LOOP_MAX_LOOPS_MAX
        ) {
          throw new Error(`maxLoops must be an integer between ${LOOP_MAX_LOOPS_MIN} and ${LOOP_MAX_LOOPS_MAX}`);
        }
        updateFields.maxLoops = params.maxLoops;
      }

      // Reschedule a waiting task: startAt (ISO, or null = as soon as possible)
      // or startIn (45m|3h|2d). The route validates and refuses a started task.
      if (params.startAt !== undefined) updateFields.startAt = params.startAt;
      if (params.startIn !== undefined) updateFields.startIn = params.startIn;

      if (params.pathManifest !== undefined) {
        throw new Error('pathManifest cannot be changed via update_task — it is set at create_task and only grows through check_path_claim (which takes the path locks).');
      }

      if (Object.keys(updateFields).length === 0) {
        throw new Error('At least one field (title, description, priority, project, status, backend, tier, model, maxLoops, startAt, startIn) must be provided');
      }

      const updated = await api(`/api/tasks/${params.taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateFields),
      });

      const backendInfo = params.backend !== undefined
        ? `\nBackend: ${updateFields.backend ? backendLabel(updateFields.backend as string) : 'default (mission/role/workspace)'}`
        : '';

      const modelParts: string[] = [];
      if (params.tier !== undefined) modelParts.push(`Tier: ${updateFields.tier ?? 'cleared'}`);
      if (params.model !== undefined) modelParts.push(`Model: ${updateFields.model ?? 'cleared'}`);
      const pinCleared = (params.tier !== undefined && updateFields.tier === null)
        || (params.model !== undefined && updateFields.model === null);
      const modelInfo = modelParts.length > 0
        ? `\n${modelParts.join('\n')}\nNote: takes effect on the next claim or retry; does not change a running session.${pinCleared ? ' Cleared pins mean routing decides the model again.' : ''}`
        : '';

      const startInfo = params.startAt !== undefined || params.startIn !== undefined
        ? (updated.startAt ? `\nStarts at: ${new Date(updated.startAt).toISOString()}` : '\nStarts: as soon as possible')
        : '';

      const loopInfo = params.maxLoops !== undefined
        ? `\nMax loops: ${updated.loopConfig?.maxLoops ?? params.maxLoops}\nNote: this does not alter an in-flight worker prompt; use send_agent_message to steer active work.`
        : '';

      // When description is edited on a task with an active worker, the running
      // agent is locked to the previous brief. Auto-deliver the new description
      // via an urgent instruct message so the durable record and live worker stay
      // in sync without requiring a manual second call.
      // Title-only changes don't need to reach running agents — title is a label.
      let workerNote = '';
      if (updateFields.description !== undefined) {
        try {
          const taskData = await api(`/api/tasks/${params.taskId}?include=workers`);
          const activeStatuses = ['running', 'assigned', 'waiting_input'];
          // The caller's own worker is not told about its own edit: it made it.
          const activeWorker = (taskData.workers || []).find(
            (w: { id: string; status: string }) => activeStatuses.includes(w.status) && w.id !== ctx.workerId,
          );
          if (activeWorker) {
            const noteEndpoint = updated.missionId
              ? `/api/missions/${updated.missionId}/notes`
              : `/api/tasks/${params.taskId}/notes`;
            try {
              // Option B: auto-deliver the new description as an urgent message.
              const deliveryMessage = [
                'TASK DESCRIPTION UPDATED: The task specification has changed while you are working.',
                'Updated description:',
                '',
                params.description as string,
                '',
                'Please review the updated specification and adjust your work accordingly.',
              ].join('\n');
              await api(`/api/workers/${activeWorker.id}/instruct`, {
                method: 'POST',
                body: JSON.stringify({ message: deliveryMessage, priority: 'urgent' }),
              });
              workerNote = `\nNOTE: Description change auto-delivered to worker ${activeWorker.id} (${activeWorker.status}) as an urgent message.`;
              // Fire-and-forget: record the delivery on the task feed.
              api(noteEndpoint, {
                method: 'POST',
                body: JSON.stringify({
                  type: 'update',
                  title: 'Description updated — worker notified',
                  bodyText: `Worker ${activeWorker.id} (${activeWorker.status}) was sent an urgent message with the updated description.`,
                  authorType: 'system',
                  status: 'answered',
                }),
              }).catch(() => {});
            } catch {
              // Option A fallback: auto-delivery failed — return a ready-to-send payload.
              workerNote = `\nWARNING: worker ${activeWorker.id} is currently ${activeWorker.status} on this task and is running against the PREVIOUS description. Auto-delivery failed. To steer the running work, call send_agent_message with:\n  taskId: ${params.taskId}\n  message: (the new description)\n  priority: "urgent"`;
              api(noteEndpoint, {
                method: 'POST',
                body: JSON.stringify({
                  type: 'warning',
                  title: 'Description edit while worker is active — delivery failed',
                  bodyText: `Worker ${activeWorker.id} (${activeWorker.status}) is running against the previous description. Auto-delivery failed. Use send_agent_message (taskId=${params.taskId}) to redirect it.`,
                  authorType: 'system',
                  status: 'answered',
                }),
              }).catch(() => {});
            }
          }
        } catch {
          // Non-fatal — don't block the update response if the worker check fails
        }
      }

      return text(`Task updated: "${updated.title}" (ID: ${updated.id})\nStatus: ${updated.status}\nPriority: ${updated.priority}${backendInfo}${modelInfo}${startInfo}${loopInfo}${workerNote}`);
    }

    case 'correct_task_result': {
      requireFullUuid(params.taskId, 'taskId');
      const hasSummary = params.summary !== undefined;
      const hasPr = params.prUrl !== undefined || params.prNumber !== undefined;
      if (!hasSummary && !hasPr) {
        throw new Error('summary, prUrl or prNumber is required');
      }
      if (hasSummary && (typeof params.summary !== 'string' || params.summary.trim() === '')) {
        throw new Error('summary is required and must be a non-empty string');
      }

      const lines: string[] = [];
      // PR first: if the PR cannot be verified, the summary (which usually
      // cites it) is left untouched rather than half-applied.
      if (hasPr) {
        const attached = await api(`/api/tasks/${params.taskId}/attach-pr`, {
          method: 'POST',
          body: JSON.stringify({
            ...(params.prUrl !== undefined ? { prUrl: params.prUrl } : {}),
            ...(params.prNumber !== undefined ? { prNumber: params.prNumber } : {}),
          }),
        });
        lines.push(
          `PR #${attached.prNumber} (${attached.prState}) ${attached.alreadyAttached ? 'was already attached' : 'attached'} `
          + `to task "${attached.title}" (ID: ${attached.taskId}).`,
          `PR: ${attached.prUrl}`,
        );
      }

      if (hasSummary) {
        const correctedBy = ctx.workerId ? `worker:${ctx.workerId}` : 'admin_token';
        const updated = await api(`/api/tasks/${params.taskId}`, {
          method: 'PATCH',
          body: JSON.stringify({ resultSummary: params.summary, correctedBy }),
        });
        const previous = updated.result?.previousSummary;
        lines.push(
          `Result summary corrected for task "${updated.title}" (ID: ${updated.id}).`,
          `New summary: ${updated.result?.summary}`,
          ...(previous ? [`Previous summary: ${previous}`] : []),
          `Corrected at: ${updated.result?.summaryCorrectedAt}`,
        );
      }

      return text(lines.join('\n'));
    }

    case 'create_task': {
      if (!params.title || !params.description) throw new Error('title and description are required');
      const allowedCreateTaskParams = new Set([
        'title', 'description', 'workspaceId', 'priority', 'category', 'outputRequirement',
        'outputSchema', 'project', 'missionId', 'parentTaskId', 'dependsOn', 'pathManifest',
        'roleSlug', 'baseBranch', 'headBranch', 'verificationCommand', 'iteration', 'maxIterations',
        'failureContext', 'skillSlugs', 'tier', 'model', 'effort', 'callbackUrl',
        'callbackToken', 'release', 'backend', 'startAt', 'startIn', 'startAfter',
        'loopConfig', 'loopUntilVerified', 'loopUntilMerged', 'subjectAnchor', 'fileAnywayReason', 'context',
        'kind', 'complexity', 'emitsPlan', 'label',
      ]);
      const unknownParams = Object.keys(params).filter(key => !allowedCreateTaskParams.has(key));
      if (unknownParams.length > 0) {
        // taskClass is a common guess (it gates completion behavior elsewhere —
        // see the bookkeeping exemptions in PR #2380/#2386) but it is stamped
        // server-side per creation path, never client-settable. Naming the
        // real fix inline saves the caller a round trip.
        const hints = unknownParams.map(key =>
          key === 'taskClass'
            ? `${key} (not settable — taskClass is stamped server-side; use outputRequirement instead)`
            : key
        );
        throw new Error(`Unknown create_task parameter(s): ${hints.join(', ')}`);
      }

      // Routing inputs: kind × complexity feed the claim-time model matrix.
      // Validated up front and rejected — never dropped — because a silently
      // ignored routing hint is indistinguishable from one that was honoured.
      if (params.kind !== undefined && !(TASK_KINDS as readonly string[]).includes(params.kind as string)) {
        throw new Error(`kind must be one of: ${TASK_KINDS.join(', ')}`);
      }
      if (params.complexity !== undefined && !(TASK_COMPLEXITIES as readonly string[]).includes(params.complexity as string)) {
        throw new Error(`complexity must be one of: ${TASK_COMPLEXITIES.join(', ')}`);
      }
      // Short display label: validated here (not silently dropped) and capped
      // server-side. Omitted, POST /api/tasks derives one from the title.
      if (params.label !== undefined && typeof params.label !== 'string') {
        throw new Error('label must be a string (2–4 words, max 48 chars)');
      }

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      // Similarity check: run BEFORE creating the task so we don't find our own task.
      // Skip for child tasks, retry tasks, reviewer tasks, and friction tasks — they
      // legitimately share a subject with their parent and generate constant false positives.
      const SIMILAR_TASK_WARN_THRESHOLD = 0.82;
      const suppressedTitlePattern = /^\[(CI Retry|reviewer retry|reviewer|friction)\b/i;
      const isChildOrRetryTask =
        !!params.parentTaskId ||
        suppressedTitlePattern.test(String(params.title));

      // Shared query text for both the near-dupe check (task corpus only, gates on
      // isChildOrRetryTask) and the broader prior-work retrieval below (memory+task+pr,
      // runs for every filing — a child/retry task benefits from prior-incident context
      // just as much as a top-level one).
      const authoringQueryText = [params.title, params.description]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n')
        .slice(0, 2000);

      type SimilarCandidate = { id: string; similarity: number; content: string };
      let priorSimilarCandidates: SimilarCandidate[] = [];
      if (!isChildOrRetryTask && ctx.knowledgeStore?.nearDupeCheck && wsId) {
        const taskNs = buildNamespace(wsId, 'task');
        priorSimilarCandidates = await ctx.knowledgeStore.nearDupeCheck(taskNs, authoringQueryText, 5).catch(() => []);
      }

      const taskBody: Record<string, unknown> = {
        workspaceId: wsId,
        title: params.title,
        description: params.description,
        priority: normalizePriority(params.priority),
        creationSource: 'mcp',
      };
      if (typeof params.label === 'string' && params.label.trim() !== '') taskBody.label = params.label;
      if (params.subjectAnchor && typeof params.subjectAnchor === 'object' && !Array.isArray(params.subjectAnchor)) {
        taskBody.subjectAnchor = params.subjectAnchor;
      }
      if (params.fileAnywayReason !== undefined) {
        if (typeof params.fileAnywayReason !== 'string' || params.fileAnywayReason.trim() === '') {
          throw new Error('fileAnywayReason must be a non-blank string');
        }
        taskBody.fileAnywayReason = params.fileAnywayReason.trim();
      }
      if (params.context && typeof params.context === 'object' && !Array.isArray(params.context)) {
        taskBody.context = { ...params.context };
      }
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
      if (params.startAt !== undefined) taskBody.startAt = params.startAt;
      if (params.startIn !== undefined) taskBody.startIn = params.startIn;
      if (params.startAfter !== undefined) taskBody.startAfter = params.startAfter;

      if (params.loopUntilVerified !== undefined && params.loopUntilVerified !== true) {
        throw new Error('loopUntilVerified must be true when provided');
      }
      if (params.loopUntilMerged !== undefined && params.loopUntilMerged !== true) {
        throw new Error('loopUntilMerged must be true when provided');
      }
      const loopShorthands = [params.loopUntilVerified, params.loopUntilMerged, params.loopConfig].filter(Boolean).length;
      if (loopShorthands > 1) {
        throw new Error('Provide at most one of loopConfig, loopUntilVerified, or loopUntilMerged');
      }
      if (params.loopUntilVerified === true) {
        if (typeof params.verificationCommand !== 'string' || params.verificationCommand.trim() === '') {
          throw new Error('loopUntilVerified requires a non-blank verificationCommand');
        }
        taskBody.loopConfig = parseLoopConfig(
          { exitCondition: { type: 'command' } },
          params.verificationCommand,
        );
      } else if (params.loopUntilMerged === true) {
        taskBody.loopConfig = parseLoopConfig({
          exitCondition: { type: 'pr_merged' },
          maxLoops: 6,
          waitExpiryMinutes: 240,
        });
      } else if (params.loopConfig !== undefined) {
        taskBody.loopConfig = parseLoopConfig(
          params.loopConfig,
          typeof params.verificationCommand === 'string' ? params.verificationCommand : undefined,
        );
      }

      // Auto-link to mission: explicit param takes precedence, then inherit from caller's task
      if (params.missionId) {
        taskBody.missionId = params.missionId;
      } else if (ctx.workerId) {
        // Fetch caller worker's task to inherit missionId
        try {
          const workerData = await api(`/api/workers/${ctx.workerId}`);
          const callerMissionId = workerData?.task?.missionId || workerData?.task?.context?.missionId;
          if (callerMissionId) {
            // A friction report is a platform fix, not mission work: linking it
            // would make the mission's integration branch its PR base and trap
            // the fix behind the mission. Keep only a related-mission pointer.
            const ctxIn = taskBody.context as Record<string, unknown> | undefined;
            const isFriction = String(params.title ?? '').startsWith('[friction]')
              || typeof ctxIn?.frictionSignature === 'string';
            if (isFriction) {
              taskBody.context = { ...(ctxIn ?? {}), relatedMissionId: callerMissionId };
            } else {
              taskBody.missionId = callerMissionId;
            }
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
      if (params.tier && TIERS.includes(params.tier as Tier)) {
        taskBody.tier = params.tier;
      }
      if (params.kind !== undefined) taskBody.kind = params.kind;
      if (params.complexity !== undefined) taskBody.complexity = params.complexity;
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
      // Read by generateTaskBranchName (packages/core/branch-names.ts) as
      // sharedHeadBranch, and by verifyPrOwnership's stacked_base check — so
      // setting it here, not in the title or description, is what actually
      // makes claim_task assign this exact branch and create_pr accept a PR
      // headed at it.
      if (params.headBranch && typeof params.headBranch === 'string') {
        taskContext.headBranch = params.headBranch;
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
      if (params.emitsPlan === true) {
        taskBody.emitsPlan = true;
      }

      const task = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(taskBody),
      });

      // Index the new (pending) task into the knowledge store so future create_task
      // calls can find it via nearDupeCheck. Best-effort — never fail task creation.
      // Uses the same source_id format as buildTaskCard so complete_task overwrites
      // the placeholder with the full outcome when the task finishes.
      if (!isChildOrRetryTask && ctx.knowledgeStore && task?.id && task?.title) {
        const pendingContent = [
          `# Task: ${task.title}`,
          task.description ? `## Description\n${task.description}` : null,
        ].filter((s): s is string => s !== null).join('\n\n');
        mirrorWorkProduct(ctx, 'task', {
          id: `task:${task.id}`,
          content: pendingContent,
          lexicalText: [task.title, task.description].filter(Boolean).join('\n'),
          sourceType: 'task',
          sourceUrl: `/app/tasks/${task.id}`,
          metadata: { phase: 'pending', taskId: task.id },
        }).catch(() => {});
      }

      // Cross-reference priorSimilarCandidates against currently-open tasks to build
      // the warning. Only call the active-tasks endpoint when there are candidates
      // above the threshold (avoids a needless round-trip on clean filings).
      // The server resolved this filing's anchor against live tasks and found a
      // match too imprecise to attach on (same PR, unknown commit; or a sibling
      // in the same mission). Say so — it used to be computed and discarded.
      const suggestion = task?.duplicateSuggestion as
        | { taskId?: string; title?: string; keyType?: string }
        | undefined;
      const subjectSuggestion = suggestion?.taskId
        ? `\n\n⚠ Task ${suggestion.taskId} — "${suggestion.title ?? 'untitled'}" — is already live on the same subject (${suggestion.keyType}). Check it before starting: two agents on one subject is how PRs get superseded.`
        : '';

      let similarTasksWarning = '';
      const aboveThreshold = priorSimilarCandidates.filter(c => c.similarity >= SIMILAR_TASK_WARN_THRESHOLD);
      if (aboveThreshold.length > 0 && task?.id) {
        let activeTaskIds = new Set<string>();
        try {
          const activePage = await api(`/api/tasks?status=active&workspaceId=${wsId}&limit=100`);
          for (const t of (activePage?.tasks ?? [])) {
            if (t?.id) activeTaskIds.add(t.id);
          }
        } catch { /* best-effort */ }

        const openSimilar = aboveThreshold.filter(c => {
          const candidateTaskId = c.id.startsWith('task:') ? c.id.slice(5) : c.id;
          return candidateTaskId !== task.id && activeTaskIds.has(candidateTaskId);
        });

        if (openSimilar.length > 0) {
          const lines = openSimilar.map(c => {
            const candidateTaskId = c.id.startsWith('task:') ? c.id.slice(5) : c.id;
            const titleLine = c.content.split('\n')[0].replace(/^#+ Task: /, '').replace(/^#+ Task /, '').trim();
            return `  - ${candidateTaskId} — "${titleLine}" (similarity ${c.similarity.toFixed(2)})`;
          });
          similarTasksWarning = `\n\n⚠ ${openSimilar.length} open task(s) with a similar subject:\n${lines.join('\n')}\nIf filing a genuinely distinct task, pass fileAnywayReason to create_task.`;
        }
      }

      const createAppBase = ctx.appBaseUrl || 'https://buildd.dev';
      const createdTaskUrl = `${createAppBase}/app/tasks/${task.id}`;

      if (task.deduplicated) {
        // Two gates return this: the friction-signature gate, and the subject
        // dedupe that recognises an identifying anchor (same PR generation, same
        // traced error) already owned by a live task.
        const how = task.duplicateKeyType
          ? `A live task already owns this subject (${task.duplicateKeyType})`
          : 'Friction task already open';
        return text(`${how}: "${task.title}" (ID: ${task.id})\nYour report has been attached rather than dispatching a second agent onto a separate branch. Follow progress with get_task (taskId ${task.id}), or re-file with fileAnywayReason if this is genuinely distinct work.`);
      }

      const statusLabel = task.startAt
        ? `Deferred until ${new Date(task.startAt).toISOString()}`
        : task.status === 'assigned'
          ? 'Assigned — a runner has already claimed it'
          : 'Queued — no runner has claimed it yet';

      // Surface prior incidents/lessons/PRs related to this filing so the author
      // doesn't have to remember to run recall themselves — the CTA-derives-from-
      // server-state defect was re-fixed 3x (PRs #1463, #2339, #2361) because this
      // context wasn't in front of whoever was filing. Best-effort: a retrieval
      // failure must never fail a task that already exists.
      const priorWorkBlock = await buildAuthoringPriorWork(
        authoringQueryText,
        wsId,
        ctx.teamId,
        ctx.knowledgeStore,
        {
          paths: Array.isArray(taskBody.pathManifest) ? taskBody.pathManifest as string[] : undefined,
          ledger: ctx.memoryLedger,
        },
      ).catch(() => '');

      const routingLine = task.routing
        ? `\nModel routing: ${task.routing.reason}`
        : '';

      return text(`Task created: "${task.title}" (ID: ${task.id})\nStatus: ${statusLabel}; follow progress with get_task (taskId ${task.id}).\nPriority: ${task.priority}\nTask URL: ${createdTaskUrl}${routingLine}${task.startAt ? `\nStart at: ${new Date(task.startAt).toISOString()}\nResolution: ${task.context?.startResolution || 'mission_floor'}` : ''}${taskBody.parentTaskId ? `\nParent: ${taskBody.parentTaskId}` : ''}${taskBody.missionId ? `\nLinked to mission: ${taskBody.missionId}` : ''}${ctx.workerId ? `\nCreated by worker: ${ctx.workerId}` : ''}${subjectSuggestion}${similarTasksWarning}${priorWorkBlock ? `\n\n${priorWorkBlock}` : ''}`);
    }

    case 'create_schedule': {
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

      if (typeof params.roleSlug === 'string' && params.roleSlug.trim()) {
        taskTemplate.roleSlug = params.roleSlug.trim();
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
          // Omitted on purpose when the caller gave none: the schedules route
          // resolves an absent timezone to the team's zone. Sending 'UTC' here
          // would pin every agent-created schedule to a clock nobody uses.
          ...(params.timezone ? { timezone: params.timezone } : {}),
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
      if (!params.scheduleId) throw new Error('scheduleId is required');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace.');

      const updateBody: Record<string, unknown> = {};
      if (params.cronExpression !== undefined) updateBody.cronExpression = params.cronExpression;
      if (params.timezone !== undefined) updateBody.timezone = params.timezone;
      if (params.enabled !== undefined) updateBody.enabled = params.enabled;
      if (params.name !== undefined) updateBody.name = params.name;
      if (params.taskTemplate !== undefined) updateBody.taskTemplate = params.taskTemplate;
      // Explicit cross-workspace reach for this schedule's tasks; null clears it (team admin only).
      if (params.delegation !== undefined) updateBody.delegation = params.delegation;

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
        throw new Error('At least one field (cronExpression, timezone, enabled, name, taskTemplate, skillSlugs, delegation) must be provided');
      }

      const updated = await api(`/api/workspaces/${wsId}/schedules/${params.scheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateBody),
      });

      const updSched = updated.schedule;
      const delegationLine = describeScheduleDelegation(updSched.delegation);
      return text(`Schedule updated: "${updSched.name}" (ID: ${updSched.id})\nCron: ${updSched.cronExpression} (${updSched.timezone})\nEnabled: ${updSched.enabled}\nNext run: ${updSched.nextRunAt || 'not scheduled'}${delegationLine ? `\n${delegationLine}` : ''}`);
    }

    case 'delete_schedule': {
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
      const scheduleType = typeof params.type === 'string' ? params.type : 'all';

      const isHeartbeat = (s: any): boolean => s.taskTemplate?.context?.heartbeat === true;

      const matchesFilters = (s: any): boolean => {
        if (filterCutoff !== null) {
          const last = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
          if (!Number.isFinite(last) || last < filterCutoff) return false;
        }
        if (nameContains && !s.name.toLowerCase().includes(nameContains)) return false;
        if (scheduleType === 'heartbeat' && !isHeartbeat(s)) return false;
        if (scheduleType === 'workspace' && isHeartbeat(s)) return false;
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
        const delegation = describeScheduleDelegation(s.delegation);
        const delegationLine = delegation ? `\n  ${delegation}` : '';
        return `- **${s.name}**${status}${wsTag}\n  Cron: ${s.cronExpression} (${s.timezone})\n  Next: ${s.nextRunAt || 'N/A'} | ${last} | Runs: ${s.totalRuns}${failures}\n  Task: ${s.taskTemplate.title}${channelLine}${delegationLine}${err}\n  ID: ${s.id}`;
      };

      // If workspace specified, list its schedules; otherwise aggregate across all workspaces
      if (wsId) {
        const data = await api(`/api/workspaces/${wsId}/schedules`);
        const schedules = (data.schedules || []).filter(matchesFilters);

        if (schedules.length === 0) {
          if (minutesAgo !== null || nameContains || scheduleType !== 'all') return text('No schedules matched the filter.');
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
        if (minutesAgo !== null || nameContains || scheduleType !== 'all') return text('No schedules matched the filter across any workspace.');
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
      if (isPersonalRoleCall(action, params)) return handlePersonalRole(api, 'register_skill', params, ctx);
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
      if (params.whenToUse !== undefined) skillBody.whenToUse = params.whenToUse;
      if (params.notFor !== undefined) skillBody.notFor = params.notFor;
      if (params.claudeAiArtifacts !== undefined) skillBody.claudeAiArtifacts = params.claudeAiArtifacts;

      const data = await api(`/api/workspaces/${wsId}/skills`, {
        method: 'POST',
        body: JSON.stringify(skillBody),
      });

      const skill = data.skill;
      return text(`Skill registered: "${skill.name}" (slug: ${skill.slug})\nOrigin: ${skill.origin}\nEnabled: ${skill.enabled}`);
    }

    case 'list_skills': {
      if (isPersonalRoleCall(action, params)) return handlePersonalRole(api, 'list_skills', params, ctx);

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

        function skillLine(s: any, scopeLabel?: string): string {
          const mcpCount = s.mcpServers
            ? (Array.isArray(s.mcpServers) ? s.mcpServers.length : Object.keys(s.mcpServers).length)
            : 0;
          const scope = s.workspaceId === null ? 'team-level' : (scopeLabel ?? '');
          const tags = [
            s.isRole ? 'role' : 'skill',
            scope,
            s.enabled ? '' : 'DISABLED',
            s.model !== 'inherit' ? s.model : '',
            mcpCount > 0 ? `${mcpCount} MCP(s)` : '',
          ].filter(Boolean).join(', ');
          const suffix = scopeLabel && s.workspaceId !== null ? ` — ${scopeLabel}` : '';
          return `- **${s.name}** (\`${s.slug}\`) [${tags}]${suffix}${s.description ? `\n  ${s.description}` : ''}`;
        }

        const summary = skills.map((s: any) => skillLine(s)).join('\n');

        return text(`${skills.length} skill(s):\n\n${summary}`);
      }

      // No workspace — list across all accessible workspaces, deduplicating
      // team-level roles (workspaceId === null) so they appear only once.
      const wsData = await api('/api/workspaces');
      const workspaces = wsData.workspaces || [];
      if (workspaces.length === 0) return text('No workspaces found.');

      const allSkills: { workspace: string; skill: any }[] = [];
      const seenTeamLevelSlugs = new Set<string>();
      for (const ws of workspaces) {
        const qp = new URLSearchParams();
        if (typeof params.enabled === 'boolean') qp.set('enabled', String(params.enabled));
        if (typeof params.isRole === 'boolean') qp.set('isRole', String(params.isRole));
        const qs = qp.toString() ? `?${qp.toString()}` : '';
        const data = await api(`/api/workspaces/${ws.id}/skills${qs}`);
        for (const s of (data.skills || [])) {
          if (s.workspaceId === null) {
            // Team-level role — deduplicate across all workspace calls.
            if (!seenTeamLevelSlugs.has(s.slug)) {
              seenTeamLevelSlugs.add(s.slug);
              allSkills.push({ workspace: 'All workspaces (team-level)', skill: s });
            }
          } else {
            allSkills.push({ workspace: ws.name, skill: s });
          }
        }
      }

      if (allSkills.length === 0) return text('No skills found across any workspace.');

      function skillLineCross(s: any, workspace: string): string {
        const mcpCount = s.mcpServers
          ? (Array.isArray(s.mcpServers) ? s.mcpServers.length : Object.keys(s.mcpServers).length)
          : 0;
        const scope = s.workspaceId === null ? 'team-level' : '';
        const tags = [
          s.isRole ? 'role' : 'skill',
          scope,
          s.enabled ? '' : 'DISABLED',
          s.model !== 'inherit' ? s.model : '',
          mcpCount > 0 ? `${mcpCount} MCP(s)` : '',
        ].filter(Boolean).join(', ');
        return `- **${s.name}** (\`${s.slug}\`) [${tags}] — ${workspace}${s.description ? `\n  ${s.description}` : ''}`;
      }

      const summary = allSkills.map(({ workspace, skill: s }) => skillLineCross(s, workspace)).join('\n');

      return text(`${allSkills.length} skill(s) across ${workspaces.length} workspace(s):\n\n${summary}`);
    }

    case 'get_skill': {
      if (isPersonalRoleCall(action, params)) return handlePersonalRole(api, 'get_skill', params, ctx);
      if (!params.slug) throw new Error('slug is required to identify the skill to fetch');

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Could not determine workspace. Provide workspaceId.');

      // resolveSkillId now finds both workspace-scoped and team-level skills
      // (the workspace skills endpoint returns effective skills: workspace override
      // wins over team default, falling back to team-level when no override exists).
      const skillId = await resolveSkillId(api, wsId, params.slug as string);
      // GET /api/workspaces/[id]/skills/[skillId] also falls back to team-level reads.
      const data = await api(`/api/workspaces/${wsId}/skills/${skillId}`);
      const s = data.skill;
      if (!s) throw new Error(`Skill with slug "${params.slug}" not found`);

      const isTeamLevel = s.workspaceId === null;
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
        whenToUse: s.metadata?.routing?.whenToUse ?? null,
        notFor: s.metadata?.routing?.notFor ?? null,
        enabled: s.enabled,
        repoUrl: s.repoUrl ?? null,
        source: s.source ?? null,
        // Scope metadata — workspaceId null = team-level default
        workspaceId: s.workspaceId ?? null,
        scope: isTeamLevel ? 'team' : 'workspace',
      };

      const scopeNote = isTeamLevel
        ? `\n// scope: team-level (applies to all workspaces; resolved as team default for workspace ${wsId})`
        : `\n// scope: workspace-scoped override for ${wsId}`;

      return text(`${scopeNote}\n${JSON.stringify(payload, null, 2)}`);
    }

    case 'update_skill': {
      if (isPersonalRoleCall(action, params)) return handlePersonalRole(api, 'update_skill', params, ctx);
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
      if (isPersonalRoleCall(action, params)) return handlePersonalRole(api, 'delete_skill', params, ctx);
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
        const purpose = typeof params.purpose === 'string' && params.purpose ? params.purpose : 'mcp_credential';
        if (modelCredentialPurposes().includes(purpose)) return errorResult(MODEL_PURPOSE_REFUSAL(purpose));
        if (!params.label) throw new Error('label is required (env var name, e.g. "buildd-api-key")');
        if (!params.value) throw new Error('value is required (the secret value)');

        const data = await api('/api/secrets', {
          method: 'POST',
          body: JSON.stringify({
            value: params.value,
            purpose,
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
      const missing = ['type', 'title'].filter(field => !params[field]);
      if (missing.length > 0) {
        const parameterLabel = missing.length === 1 ? 'parameter' : 'parameters';
        const parts = [`post_note missing required ${parameterLabel}: ${missing.join(', ')}.`];
        if (missing.includes('type')) {
          parts.push(`type must be one of: ${NOTE_TYPES.join(', ')}.`);
        }
        parts.push(`Full schema: { type (required: ${NOTE_TYPES.join('|')}), title (required), body?, defaultChoice?, workerId?, missionId? }`);
        throw new Error(parts.join(' '));
      }

      if (!NOTE_TYPES.includes(params.type as typeof NOTE_TYPES[number])) {
        throw new Error(`Invalid type. Must be one of: ${NOTE_TYPES.join(', ')}`);
      }

      const workerId = resolveWorkerId(params.workerId, ctx);
      const workerData = await api(`/api/workers/${workerId}`);
      const taskId = workerData.taskId || workerData.task?.id;

      // Resolve missionId from task context if not provided.
      let missionId = params.missionId as string | undefined;
      if (!missionId) {
        missionId = workerData.task?.missionId;
      }
      if (!missionId && !taskId) {
        throw new Error('Could not resolve a task or mission from the current worker');
      }

      const noteBody: Record<string, unknown> = {
        type: params.type,
        title: params.title,
        authorType: 'agent',
        taskId,
        workerId,
        status: params.type === 'question' ? 'open' : 'answered',
      };
      if (params.body) noteBody.bodyText = params.body;
      if (params.defaultChoice) noteBody.defaultChoice = params.defaultChoice;

      const endpoint = missionId
        ? `/api/missions/${missionId}/notes`
        : `/api/tasks/${taskId}/notes`;
      const posted = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(noteBody),
      }) as { gate?: { disposition?: string; reason?: string } } | null;

      // Needs You admission: a question describing a recoverable platform
      // blocker is not shown to a person — a repair task owns it instead.
      if (posted?.gate?.disposition === 'recovered') {
        return text(`Note posted: "${params.title}" (question, not shown to a person)\n${posted.gate.reason ?? 'A repair task owns this blocker.'}`);
      }

      // Needs You admission: a question describing a recoverable platform
      // blocker is not shown to a person — a repair task owns it instead.
      if (posted?.gate?.disposition === 'recovered') {
        return text(`Note posted: "${params.title}" (question, not shown to a person)\n${posted.gate.reason ?? 'A repair task owns this blocker.'}`);
      }

      return text(`Note posted: "${params.title}" (${params.type})${params.type === 'question' ? `\nDefault choice: ${params.defaultChoice || 'none'}\nUser reply will be delivered at your next turn boundary (or call receive_messages).` : ''}`);
    }

    case 'create_artifact': {
      if (!params.type || !params.title) throw new Error('type and title are required');

      // One vocabulary, shared with every route that persists an artifact
      // (@buildd/shared ARTIFACT_TYPES). This list used to hold 12 of the 17
      // types, so `screenshot` / `diff` / `walkthrough` / `impl_plan` were
      // rejected here while the routes below accepted them.
      if (!isArtifactType(params.type)) {
        throw new Error(`Invalid type. Must be one of: ${ARTIFACT_TYPES.join(', ')}`);
      }

      const artifactBody: Record<string, unknown> = {
        type: params.type,
        title: params.title,
      };
      if (params.content) artifactBody.content = params.content;
      if (params.url) artifactBody.url = params.url;
      if (params.metadata && typeof params.metadata === 'object') artifactBody.metadata = params.metadata;
      if (params.key) artifactBody.key = params.key;
      if (params.taskId) artifactBody.taskId = params.taskId;

      // Support initiative-level, mission-level (no worker required), or worker artifacts
      let artifactData;
      if (params.initiativeId) {
        artifactData = await api(`/api/initiatives/${params.initiativeId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify(artifactBody),
        });
      } else if (params.missionId) {
        artifactData = await api(`/api/missions/${params.missionId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify(artifactBody),
        });
      } else {
        const workerId = (params.workerId as string) || ctx.workerId;
        if (!workerId) {
          throw new Error(
            'workerId is required — pass it explicitly, ensure the MCP server has worker context, ' +
            'or pass missionId or initiativeId instead to create a mission- or initiative-level artifact with no worker.',
          );
        }
        // Resolve taskId from worker data if not explicitly provided
        if (!artifactBody.taskId) {
          const workerData = await api(`/api/workers/${workerId}`);
          const taskId = workerData.taskId || workerData.task?.id;
          if (taskId) artifactBody.taskId = taskId;
        }

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
        initiativeId: (params.initiativeId as string) ?? art.initiativeId ?? null,
      }));

      const visibilityLine = art.shareUrl
        ? `Share URL: ${art.shareUrl}`
        : `Visibility: private (not shared)`;
      return text(`Artifact created${upserted}: "${art.title}" (${art.type})\nID: ${art.id}\n${visibilityLine}`);
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
      // Optional: the server defaults to the worker's task mission and checks
      // an explicit value against the worker's workspace.
      if (typeof params.missionId === 'string' && params.missionId) uploadBody.missionId = params.missionId;

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
        `  Readable by this workspace, and by anyone once the artifact is shared.`,
        ``,
        `Share URL: ${data.shareUrl ?? 'not shared — publish the artifact to mint one'}`,
        `Artifact ID: ${data.artifactId}`,
      ];

      if (mimeStr.startsWith('image/')) {
        lines.push(``, `Markdown image: ![${params.title || params.filename}](${data.downloadUrl})`);
      }

      return text(lines.join('\n'));
    }

    case 'list_artifacts': {
      const formatArtifact = (a: any, workspace?: string) => {
        const preview = a.content && a.content.length > 200 ? a.content.slice(0, 200) + '...' : a.content;
        return `- **${a.title}** (${a.type}${a.key ? `, key: ${a.key}` : ''})${workspace ? ` [${workspace}]` : ''}\n  ID: ${a.id}\n  Updated: ${a.updatedAt}\n  Share: ${a.shareUrl || 'N/A'}${preview ? `\n  Preview: ${preview}` : ''}`;
      };

      // Initiative-scoped: one call returns initiative-level + rolled-up child-mission artifacts.
      if (params.initiativeId) {
        const data = await api(`/api/initiatives/${params.initiativeId}/artifacts`);
        const artifactsList = data.artifacts || [];
        if (artifactsList.length === 0) return text('No artifacts found for this initiative.');
        const summary = artifactsList.map((a: any) => formatArtifact(a)).join('\n\n');
        return text(`${artifactsList.length} artifact(s) for initiative ${params.initiativeId} (including child missions):\n\n${summary}`);
      }

      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);

      const searchParams = new URLSearchParams();
      if (params.missionId) searchParams.set('missionId', params.missionId as string);
      if (params.key) searchParams.set('key', params.key as string);
      if (params.type) searchParams.set('type', params.type as string);
      // Server-side prominence filter — the rule lives in the API, not here,
      // so the dashboard and this action cannot disagree about what "review"
      // means. Anything other than an explicit true is left off entirely.
      if (params.review === true || params.review === 'true') searchParams.set('review', 'true');
      if (params.limit) searchParams.set('limit', String(params.limit));

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
      if (!params.artifactId) throw new Error(`artifactId is required${params.id ? ' (you passed "id" — the field for this action is artifactId)' : ''}`);

      const qs = new URLSearchParams();
      if (params.revision !== undefined) qs.set('revision', String(params.revision));
      qs.set('view', params.full === true ? 'full' : String(params.view ?? 'auto'));
      for (const k of ['section', 'offset', 'length', 'grep', 'context'] as const) {
        if (params[k] !== undefined) qs.set(k, String(params[k]));
      }
      const data = await api(`/api/artifacts/${params.artifactId}?${qs}`);
      const art = data.artifact;

      const meta = [
        `**Title:** ${art.title || '(untitled)'}`,
        `**Type:** ${art.type}`,
        `**ID:** ${art.id}`,
        art.key && `**Key:** ${art.key}`,
        `**Created:** ${art.createdAt}`,
        `**Updated:** ${art.updatedAt}`,
        art.revision && `**Revision:** ${art.revision.revision} of ${art.currentRevision}${art.revision.contentHash ? ` (sha256 ${art.revision.contentHash})` : ''}`,
        art.shareUrl && `**Share URL:** ${art.shareUrl}`,
        art.downloadUrl && `**Download URL (presigned, expires in 1 hour — fetch it directly, no credentials needed):** ${art.downloadUrl}`,
        art.metadata && Object.keys(art.metadata).length > 0 && `**Metadata:** ${JSON.stringify(art.metadata)}`,
      ].filter(Boolean).join('\n');

      if (art.read && art.read.view !== 'full') return text(`${meta}\n\n${renderArtifactRead(art.read)}`);
      const content = art.read?.text ?? (art.content || (art.downloadUrl ? '(file artifact — see Download URL above)' : '(no content)'));

      return text(`${meta}\n\n## Content\n\n${content}`);
    }

    case 'update_artifact': {
      if (!params.artifactId) throw new Error(`artifactId is required${params.id ? ' (you passed "id" — the field for this action is artifactId)' : ''}`);

      const updateBody: Record<string, unknown> = {};
      if (params.title !== undefined) updateBody.title = params.title;
      if (params.content !== undefined) updateBody.content = params.content;
      if (params.metadata !== undefined) updateBody.metadata = params.metadata;
      if (params.expectedRevision !== undefined) updateBody.expectedRevision = params.expectedRevision;

      if (Object.keys(updateBody).length === 0) {
        throw new Error('At least one field (title, content, metadata) must be provided');
      }

      const updated = await api(`/api/artifacts/${params.artifactId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateBody),
      });

      const updatedArt = updated.artifact;
      return text(`Artifact updated: "${updatedArt.title}" (${updatedArt.type})\nID: ${updatedArt.id}\nRevision: ${updatedArt.currentRevision ?? 'n/a'}\nShare URL: ${updatedArt.shareUrl || 'N/A'}`);
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

    case 'explain': {
      // Scoping is not re-implemented here: GET /api/explain derives the team
      // from the caller's bearer token and 404s any subject outside it, so this
      // handler cannot widen its own visibility. It also resolves a prNumber
      // through the same `resolveWorkerByPrNumber` that `get_pr` uses.
      const parts: string[] = [];
      if (params.taskId) parts.push(`taskId=${encodeURIComponent(String(params.taskId))}`);
      if (params.missionId) parts.push(`missionId=${encodeURIComponent(String(params.missionId))}`);
      if (params.prNumber != null) parts.push(`prNumber=${encodeURIComponent(String(params.prNumber))}`);
      if (params.workspaceId) {
        const wsId = await resolveWorkspaceId(api, String(params.workspaceId), ctx);
        if (!wsId) return errorResult('workspaceId did not resolve.');
        parts.push(`workspaceId=${encodeURIComponent(wsId)}`);
      }
      if (parts.length === 0) {
        return errorResult('Pass exactly one of taskId, missionId, workspaceId or prNumber.');
      }

      const data = await api(`/api/explain?${parts.join('&')}`);
      // Returned as JSON. `explain` is evidence, not a report: any prose
      // rendering here would be this tool narrating, which is exactly the job
      // it leaves to the caller. Compact JSON: indentation was a quarter of it.
      if (data?.scope === 'workspace' && !params.prNumber) return text(JSON.stringify(pageWorkspaceExplain(data, params)));
      return text(JSON.stringify(data));
    }

    case 'get_error_traces': {
      // Resolution modes, in priority:
      //   1. explicit workerId in params
      //   2. explicit taskId in params (returns cumulative traces across all
      //      workers that ran on this task — useful when retrying)
      //   3. explicit workspaceId → per-pattern rollup across the workspace
      //   4. infer from ctx.workerId (default: this agent's task)
      //   5. the session workspace rollup
      // An explicit worker/task scope always beats workspaceId: agents pass
      // workspaceId out of habit, and silently widening a narrow question to a
      // workspace rollup would hide that the narrow scope was ignored.
      const limitNum = typeof params.limit === 'number'
        ? Math.min(Math.max(params.limit, 1), 500)
        : 50;
      const limitQs = `limit=${limitNum}`;
      const sinceQs = params.since && typeof params.since === 'string'
        ? `&since=${encodeURIComponent(params.since)}`
        : '';

      const hasWorkspaceParam = typeof params.workspaceId === 'string' && params.workspaceId.length > 0;
      const hasNarrowScope = (typeof params.workerId === 'string' && params.workerId.length > 0)
        || (typeof params.taskId === 'string' && params.taskId.length > 0);
      if (!hasNarrowScope && (hasWorkspaceParam || !ctx.workerId)) {
        const wsId = await resolveWorkspaceId(api, hasWorkspaceParam ? params.workspaceId : undefined, ctx);
        if (!wsId) {
          return errorResult(hasWorkspaceParam
            ? `Workspace "${params.workspaceId}" not found or not accessible.`
            : 'get_error_traces needs a scope: pass taskId, workerId, or workspaceId (worker sessions default to their own task).');
        }
        const qs = [
          typeof params.limit === 'number' ? `limit=${Math.min(Math.max(params.limit, 1), 100)}` : '',
          sinceQs.slice(1),
        ].filter(Boolean).join('&');
        const data = await api(`/api/workspaces/${encodeURIComponent(wsId)}/error-traces${qs ? `?${qs}` : ''}`);
        const patterns = (data.patterns || []) as Array<{
          pattern: string; count: number; taskCount: number; firstSeen: string; lastSeen: string;
          exampleExcerpt: string; exampleSource: string | null; exampleTaskIds: string[];
        }>;
        const window = data.since ? ` since ${data.since}` : '';
        if (patterns.length === 0) return text(`No error traces in workspace ${wsId}${window}.`);
        const lines = patterns.map((p) => {
          const src = p.exampleSource ? ` [${p.exampleSource}]` : '';
          const tasksHit = `${p.taskCount} task${p.taskCount === 1 ? '' : 's'}`;
          const examples = p.exampleTaskIds?.length ? ` — e.g. ${p.exampleTaskIds.join(', ')}` : '';
          return `- **${p.pattern}** ${p.count}× across ${tasksHit} (first ${p.firstSeen}, last ${p.lastSeen})${examples}\n  latest${src}: ${p.exampleExcerpt}`;
        }).join('\n');
        return text(`${patterns.length} error-trace pattern(s) in workspace ${wsId}${window}:\n\n${lines}`);
      }

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
        return errorResult('get_error_traces needs a scope: pass taskId, workerId, or workspaceId (worker sessions default to their own task).');
      }

      const data = await api(endpoint);
      const traces = (data.traces || []) as Array<{ pattern: string; excerpt: string; source: string | null; ts: string }>;
      // A task-scoped answer also carries the record written when it ended.
      const evidenceBlock = [
        ...formatTaskMismatch(data.mismatch),
        ...formatTaskEvidence(data.evidence),
      ];

      if (traces.length === 0) {
        return text(evidenceBlock.length > 0
          ? `No error traces for ${scope}.\n\n${evidenceBlock.join('\n')}`
          : `No error traces for ${scope}.`);
      }

      const summary = traces.map((t) => {
        const src = t.source ? ` [${t.source}]` : '';
        return `- **${t.pattern}**${src} at ${t.ts}\n  ${t.excerpt}`;
      }).join('\n');

      return text(`${traces.length} error trace(s) for ${scope}:\n\n${summary}${evidenceBlock.length > 0 ? `\n\n${evidenceBlock.join('\n')}` : ''}`);
    }

    case 'read_evidence': {
      // Every read goes through the evidence routes, which check reach and the
      // object's task lineage and audit the read. This never asks for, and the
      // routes never return, a presigned URL.
      const strParam = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const taskIdParam = strParam(params.taskId);
      const evidenceId = strParam(params.evidenceId);
      const prNumber = typeof params.prNumber === 'number' ? params.prNumber
        : typeof params.prNumber === 'string' && /^\d+$/.test(params.prNumber) ? Number(params.prNumber) : null;
      if (!taskIdParam && !evidenceId && !prNumber) {
        return errorResult('read_evidence needs taskId, prNumber or evidenceId.');
      }
      const kind = strParam(params.kind);
      const readQs = new URLSearchParams();
      if (typeof params.tail === 'number' || typeof params.tail === 'string') readQs.set('tail', String(params.tail));
      if (strParam(params.grep)) readQs.set('grep', params.grep as string);
      if (typeof params.cursor === 'number' || strParam(params.cursor)) readQs.set('cursor', String(params.cursor));
      const wantsRead = !!evidenceId || [...readQs.keys()].length > 0;
      const kindQs = kind ? `kind=${encodeURIComponent(kind)}` : '';

      type EvidenceRow = { id: string; taskId: string | null; rootTaskId: string | null; scoutRunId?: string | null; kind: string; bytes: number; uploadState: string; createdAt: string; prNumber: number | null };
      const kib = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);
      const ownerLabel = (o: EvidenceRow) => (o.taskId ? `task ${o.taskId.slice(0, 8)}` : o.scoutRunId ? `scout run ${o.scoutRunId.slice(0, 8)}` : 'no owner');
      const row = (o: EvidenceRow) =>
        `- ${o.kind} ${kib(o.bytes)} [${o.uploadState}] ${o.createdAt} ${ownerLabel(o)}${o.prNumber ? ` PR #${o.prNumber}` : ''} (id: ${o.id})`;

      let objects: EvidenceRow[] = [];
      let scope: string;
      // The read path of one object: its task's evidence route, or, for a
      // runner-hosted Scout run's command log (no task), the run's.
      let readVia: (o: EvidenceRow) => string;
      const viaTask = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/evidence`;
      if (evidenceId) {
        const id = requireFullUuid(evidenceId, 'evidenceId');
        let path = taskIdParam ? viaTask(taskIdParam) : null;
        if (!path) {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) return errorResult('read_evidence with only evidenceId needs a workspace: pass workspaceId or taskId.');
          const data = await api(`/api/evidence?workspaceId=${encodeURIComponent(wsId)}&evidenceId=${encodeURIComponent(id)}`);
          const found = data?.objects?.[0] as EvidenceRow | undefined;
          path = found?.taskId ? viaTask(found.taskId)
            : found?.scoutRunId ? `/api/quality-scout/runs/${encodeURIComponent(found.scoutRunId)}/evidence`
            : null;
          if (!path) return errorResult(`Evidence object ${id} not found.`);
        }
        objects = [{ id } as EvidenceRow];
        scope = `evidence ${id}`;
        readVia = () => path!;
      } else if (taskIdParam) {
        const data = await api(`/api/tasks/${encodeURIComponent(taskIdParam)}/evidence${kindQs ? `?${kindQs}` : ''}`);
        objects = (data?.objects ?? []) as EvidenceRow[];
        const resolvedTask = (data?.taskId as string) || taskIdParam;
        scope = `task ${resolvedTask}`;
        readVia = () => viaTask(resolvedTask);
      } else {
        const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
        if (!wsId) return errorResult('read_evidence with prNumber needs a workspace: pass workspaceId.');
        const data = await api(`/api/evidence?workspaceId=${encodeURIComponent(wsId)}&prNumber=${prNumber}${kindQs ? `&${kindQs}` : ''}`);
        objects = (data?.objects ?? []) as EvidenceRow[];
        scope = `PR #${prNumber}`;
        readVia = (o) => viaTask(o.taskId!);
      }

      const kindLabel = kind ? `${kind} ` : '';
      if (!wantsRead) {
        if (objects.length === 0) return text(`No ${kindLabel}evidence stored for ${scope}.`);
        return text(`${objects.length} ${kindLabel}evidence object(s) for ${scope}, newest first:\n${objects.map(row).join('\n')}\n\nRead one with tail or grep (and evidenceId to pick a specific object).`);
      }

      const target = evidenceId ? objects[0] : objects.find(o => o.uploadState === 'stored');
      if (!target) {
        return text(objects.length === 0
          ? `No ${kindLabel}evidence stored for ${scope}.`
          : `No readable ${kindLabel}evidence for ${scope}: ${objects.length} object(s), none stored.\n${objects.map(row).join('\n')}`);
      }
      const qs = new URLSearchParams(readQs);
      qs.set('evidenceId', target.id);
      const read = await api(`${readVia(target)}?${qs}`);
      const o = read.object as EvidenceRow;
      const span = read.fromLine ? `lines ${read.fromLine}-${read.toLine}` : 'no lines';
      const more = read.truncated
        ? read.cursor
          ? `\nTRUNCATED at 64 KB: continue with cursor=${read.cursor}.`
          : '\nTRUNCATED at 64 KB: earlier lines were dropped; narrow with grep or a smaller tail.'
        : '';
      const others = !evidenceId && objects.length > 1 ? `\n(${objects.length - 1} other object(s) for ${scope}; pass evidenceId to read one.)` : '';
      return text(
        `${o.kind} evidence ${o.id} (${read.scoutRunId ? `scout run ${read.scoutRunId}` : `task ${read.taskId}`}, ${span}, ${read.lineCount} line(s) returned, ${read.scannedLines} scanned)${more}${others}\n\n${read.text || '(no matching lines)'}`,
      );
    }

    case 'get_budget_forecast': {
      const rawWsId = typeof params.workspaceId === 'string' ? params.workspaceId : null;
      const wsId = rawWsId ? await resolveWorkspaceId(api, rawWsId, ctx) : null;
      const endpoint = wsId
        ? `/api/health/budget?workspaceId=${encodeURIComponent(wsId)}`
        : '/api/health/budget';

      const data = await api(endpoint);
      const f = data?.forecast;
      if (!f) return text('No budget forecast data available.');

      const lines: string[] = [];

      // OAuth session rows
      for (const s of (f.oauthSessions ?? [])) {
        if (s.state === 'learning' && s.episodes >= 3) {
          lines.push(`Claude session (${s.accountName}): unknown — stale or invalid observation, forecast inert · ${s.episodes} historical episodes · provider usage: unknown`);
        } else if (s.state === 'learning') {
          lines.push(`Claude session (${s.accountName}): learning — ${s.episodes} episode(s) recorded, need 3+ for estimates`);
        } else {
          const resetsIn = timeUntilFromIso(s.windowEndsAt);
          const observationAge = typeof s.observationAgeMs === 'number'
            ? `${Math.round(s.observationAgeMs / 60_000)}m` : 'unknown';
          lines.push(`Claude session (${s.accountName}): ${s.pressurePct}% forecast floor pressure · inferred reset in ${resetsIn} · estimate confidence: ${s.confidence ?? 'low'}${s.limiter ? ` · binding: ${s.limiter}` : ''} · source: ${s.source ?? 'learned_exhaustion_floor'} · ${s.episodes} episodes, quantile ${s.sampleBasis?.quantile ?? 'unknown'} · observation age: ${observationAge} · provider usage: unknown`);
        }
      }

      // Monthly dollar budget
      if (f.monthly) {
        const m = f.monthly;
        const resetsIn = timeUntilFromIso(m.resetsAt);
        let budgetLine = `Monthly budget: $${m.spentUsd.toFixed(2)} est. / $${m.budgetUsd.toFixed(0)} (${m.pctUsed}%) · resets in ${resetsIn}`;
        if (m.daysToDepletion !== null) {
          budgetLine += m.daysToDepletion < 1
            ? ` · depletes in ${Math.round(m.daysToDepletion * 24)}h`
            : ` · depletes in ${m.daysToDepletion.toFixed(1)}d`;
        }
        budgetLine += ` · confidence: ${m.confidence}`;
        lines.push(budgetLine);
      }

      // Provider walls. Codex is read from its own pause log; the Dispatch
      // tenant row is a Claude pool, so it is labelled as one.
      if (f.codex?.isExhausted) {
        const resetsIn = f.codex.resetsAt ? timeUntilFromIso(f.codex.resetsAt) : 'unknown';
        lines.push(f.codex.reason === 'auth'
          ? `Codex credential: rejected · resets in ${resetsIn}`
          : `Codex budget: exhausted · resets in ${resetsIn}`);
      }
      if (f.claudeTenant?.isExhausted) {
        const resetsIn = f.claudeTenant.resetsAt ? timeUntilFromIso(f.claudeTenant.resetsAt) : 'unknown';
        lines.push(`Claude tenant budget: exhausted · resets in ${resetsIn}`);
      }

      // Mission budgets
      const missionRows: string[] = (f.missions ?? []).slice(0, 5).map((m: any) =>
        `  Mission "${m.missionTitle}": $${m.spentUsd.toFixed(2)} est. / $${m.budgetUsd.toFixed(2)} (${m.pctUsed}%)${m.status === 'budget_exhausted' ? ' — exhausted' : ''}`
      );
      if (missionRows.length > 0) {
        lines.push(`Mission budgets (by % used):\n${missionRows.join('\n')}`);
      }

      if (lines.length === 0) return text('No active budgets configured. All backends are running uncapped.');
      if (f.monthly || missionRows.length > 0) {
        lines.push('Dollar figures are estimates at API list price; on a subscription (OAuth) seat they are a list-price equivalent, not a charge.');
      }
      return text(lines.join('\n'));
    }

    case 'get_manifest_coverage':
    case 'get_path_claim_stats': {
      const rawWindow = typeof params.window === 'string' ? params.window : null;
      if (rawWindow !== null && !(USAGE_WINDOW_VALUES as readonly string[]).includes(rawWindow)) {
        return errorResult(`Invalid window "${rawWindow}". Expected one of ${USAGE_WINDOW_VALUES.join(', ')}.`);
      }
      const rawWsId = typeof params.workspaceId === 'string' ? params.workspaceId : null;
      const wsId = rawWsId ? await resolveWorkspaceId(api, rawWsId, ctx) : null;
      const query = new URLSearchParams();
      if (wsId) query.set('workspace', wsId);
      if (typeof params.missionId === 'string') query.set('mission', params.missionId);
      if (rawWindow) query.set('window', rawWindow);
      const data = await api(`/api/stats/coordination${query.size ? `?${query}` : ''}`);
      const metric = action === 'get_manifest_coverage' ? data?.manifestCoverage : data?.pathClaims;
      return text(JSON.stringify(metric ?? {}, null, 2));
    }

    case 'get_decision_stats': {
      const rawWindow = typeof params.window === 'string' ? params.window : null;
      if (rawWindow !== null && !(USAGE_WINDOW_VALUES as readonly string[]).includes(rawWindow)) {
        return errorResult(`Invalid window "${rawWindow}". Expected one of ${USAGE_WINDOW_VALUES.join(', ')}.`);
      }
      const capability = typeof params.capability === 'string' && params.capability.trim() ? params.capability.trim() : null;
      if (!capability && ['since', 'until', 'limit', 'overriddenOnly', 'disagreementOnly'].some(k => params[k] !== undefined)) {
        return errorResult('since, until, limit, overriddenOnly and disagreementOnly read the decision ledger: pass capability (e.g. "question_gate") with them.');
      }
      // Every outcome carries `status`: OK / NO_DATA reached the data; a
      // failed read is FORBIDDEN / UNAUTHORIZED / TOOL_UNAVAILABLE and is
      // never evidence of zero rows (a review that cannot see must say so).
      const subject = capability ? `decision ledger (${capability})` : 'orchestration decision stats';
      try {
        const rawWsId = typeof params.workspaceId === 'string' ? params.workspaceId : null;
        const wsId = rawWsId ? await resolveWorkspaceId(api, rawWsId, ctx) : null;
        if (capability) {
          // The generic decision ledger (decision_records): one row per decision
          // with confidence, reason, the answer in effect, any human override
          // and late outcome labels. For the question gate, `verdict` is the
          // decide / hold / ask disposition and `taskId` links the question.
          const target = wsId ?? (await ctx.getWorkspaceId());
          if (!target) return errorResult('Could not determine workspace. Provide workspaceId.');
          const query = new URLSearchParams({ workspaceId: target, capability });
          if (rawWindow) query.set('window', rawWindow);
          for (const k of ['since', 'until'] as const) if (typeof params[k] === 'string') query.set(k, params[k] as string);
          if (params.limit !== undefined) query.set('limit', String(params.limit));
          if (params.overriddenOnly === true) query.set('overriddenOnly', 'true');
          if (params.disagreementOnly === true) query.set('disagreementOnly', 'true');
          const data = await api(`/api/decisions?${query}`);
          return text(JSON.stringify(data ?? {}, null, 2));
        }
        const query = new URLSearchParams({ metric: 'orchestrationDecisions' });
        if (wsId) query.set('workspace', wsId);
        if (typeof params.missionId === 'string') query.set('mission', params.missionId);
        if (rawWindow) query.set('window', rawWindow);
        const data = await api(`/api/stats/coordination?${query}`);
        const total = Number(data?.decisions?.total ?? 0) + Number(data?.manifestPredictions?.total ?? 0);
        return text(JSON.stringify({ status: total > 0 ? 'OK' : 'NO_DATA', ...(data ?? {}) }, null, 2));
      } catch (err) {
        return errorResult(formatAnalyticsReadFailure(err, subject));
      }
    }

    case 'get_usage_stats': {
      const rawWindow = typeof params.window === 'string' ? params.window : null;
      if (rawWindow !== null && !(USAGE_WINDOW_VALUES as readonly string[]).includes(rawWindow)) {
        return errorResult(`Invalid window "${rawWindow}". Expected one of ${USAGE_WINDOW_VALUES.join(', ')}.`);
      }

      const rawWsId = typeof params.workspaceId === 'string' ? params.workspaceId : null;
      const wsId = rawWsId ? await resolveWorkspaceId(api, rawWsId, ctx) : null;
      const query = new URLSearchParams();
      if (wsId) query.set('workspace', wsId);
      if (rawWindow) query.set('window', rawWindow);
      if (typeof params.groupBy === 'string') query.set('groupBy', params.groupBy);

      const data = await api(`/api/stats/usage${query.size > 0 ? `?${query}` : ''}`);
      if (!data || data.totals?.tasks === 0) {
        return text(`No completed work in the last ${data?.window ?? '7d'}.`);
      }

      const t = data.totals;
      const p = data.perTask;
      // Per-task metrics are DerivedMetric<Distribution> — absent for seat auth
      // (no cost) and for workers that died before recording anything. Print the
      // reason rather than a zero that reads as a measurement.
      const dist = (m: any) => (m && m.kind === 'value' ? m.value : null);
      const nOf = (metric: string) => p?.contributing?.[metric] ?? 0;
      const overN = (metric: string) =>
        p?.tasks && nOf(metric) < p.tasks ? ` [n=${nOf(metric)}/${p.tasks}]` : '';

      const lines: string[] = [
        `Usage over ${data.window} — ${t.tasks} task(s), ${t.workers} worker(s)`,
      ];
      // A truncated scan keeps the NEWEST rows (the query is ordered), so the
      // totals are a floor for the requested window and every median/p90 below
      // describes [completeSince, now) instead. Saying only "row cap hit" left
      // the distributions looking like they covered the whole window.
      if (data.truncatedScan) {
        const since = data.scan?.completeSince;
        lines.push(
          `Row cap hit (${data.scan?.rows ?? '?'}/${data.scan?.limit ?? '?'}): totals are a floor for ${data.window}` +
          `${since ? `, and every median/p90 below covers only since ${since}` : ''}`,
        );
      }

      const totalsParts = [`${fmtTokens(t.inputTokens)} in / ${fmtTokens(t.outputTokens)} out`];
      if (t.cacheReadTokens > 0) totalsParts.push(`${fmtTokens(t.cacheReadTokens)} cache read`);
      // With a basis split, the dollar total is only ever printed as "combined"
      // next to it (docs/specs/real-and-virtual-cost.md).
      const basisSplit = data.byBasis?.total;
      if (t.costUsd > 0) totalsParts.push(basisSplit ? `$${t.costUsd.toFixed(2)} combined` : `$${t.costUsd.toFixed(2)}`);
      totalsParts.push(`${t.turns} turns`, `${t.toolCalls} tool calls`);
      lines.push(`Totals: ${totalsParts.join(' · ')}`);
      const basisLine = (split: any): string | null => {
        if (!split) return null;
        const parts: string[] = [];
        if (split.real?.costUsd > 0) parts.push(`real $${split.real.costUsd.toFixed(2)}`);
        if (split.virtual?.costUsd > 0) parts.push(`virtual $${split.virtual.costUsd.toFixed(2)} (list price)`);
        if (split.mixed?.costUsd > 0) parts.push(`mixed $${split.mixed.costUsd.toFixed(2)}`);
        if (split.unknown?.workers > 0) parts.push(`basis not reported $${(split.unknown.costUsd ?? 0).toFixed(2)} (${split.unknown.workers} worker(s))`);
        return parts.length > 0 ? parts.join(' · ') : null;
      };
      const totalBasis = basisLine(basisSplit);
      if (totalBasis) lines.push(`Cost: ${totalBasis}`);
      for (const [key, label] of [['interactive', 'Interactive'], ['runner', 'Runners']] as const) {
        const line = basisLine(data.byBasis?.byExecutor?.[key]);
        if (line) lines.push(`  ${label}: ${line}`);
      }

      const perTaskParts: string[] = [];
      const inputDist = dist(p?.inputTokens);
      perTaskParts.push(inputDist
        ? `input ${fmtTokens(inputDist.median)} median / ${fmtTokens(inputDist.p90)} p90 / ${fmtTokens(inputDist.max)} max${overN('inputTokens')}`
        : `input — (${p?.inputTokens?.reason ?? 'unavailable'})`);
      const costDist = dist(p?.costUsd);
      if (costDist) {
        perTaskParts.push(`$${costDist.median.toFixed(2)} median${overN('costUsd')}`);
      }
      const turnsDist = dist(p?.turns);
      if (turnsDist) perTaskParts.push(`${Math.round(turnsDist.median)} turns median${overN('turns')}`);
      const toolDist = dist(p?.toolCalls);
      if (toolDist) perTaskParts.push(`${Math.round(toolDist.median)} tool calls median${overN('toolCalls')}`);
      lines.push(`Per task: ${perTaskParts.join(' · ')}`);

      if (!costDist && p?.costUsd?.reason) lines.push(`Cost: ${p.costUsd.reason}`);

      const cov = data.tools?.coverage;
      if (cov) {
        lines.push(
          `Tool coverage: ${cov.histogram}/${cov.tasks} task(s) with exact counts` +
          `${cov.derived > 0 ? `, ${cov.derived} reconstructed (floor)` : ''}` +
          `${cov.none > 0 ? `, ${cov.none} unmeasured` : ''}`
        );
      }

      // Every tool, not a top slice: the long tail (recall, learn,
      // ToolSearch) is exactly what a top-8 list hid.
      const allTools: string[] = (data.tools?.byTool ?? []).map((tool: any) =>
        `  ${tool.name}: ${tool.calls} (${pctOf(tool.share)}) across ${tool.tasks} task(s)`
      );
      if (allTools.length > 0) lines.push(`Tools (all ${allTools.length}):\n${allTools.join('\n')}`);

      const servers: string[] = (data.tools?.byServer ?? []).slice(0, 6).map((s: any) =>
        `  ${s.server}: ${s.calls}`
      );
      if (servers.length > 0) lines.push(`By server:\n${servers.join('\n')}`);

      lines.push(...renderUsageBreakdowns(data));

      const models: string[] = (data.byModel ?? []).slice(0, 5).map((m: any) =>
        `  ${m.model}: ${fmtTokens(m.inputTokens)} in / ${fmtTokens(m.outputTokens)} out (${Math.round(m.share * 100)}%)`
      );
      if (models.length > 0) {
        lines.push(`By model:\n${models.join('\n')}`);
      } else if (t.inputTokens > 0) {
        // modelUsage is only populated on API-key auth; seat auth leaves it empty.
        lines.push('By model: unavailable — the SDK reports no per-model usage on seat-based (OAuth) auth');
      }

      const groups: string[] = (data.groups ?? []).slice(0, 10).map((g: any) => {
        const success = g.successRate === null ? 'n/a' : `${Math.round(g.successRate * 100)}%`;
        const gIn = dist(g.perTask?.inputTokens);
        const gCost = dist(g.perTask?.costUsd);
        const parts = [`${g.tasks} task(s)`];
        if (typeof g.completed === 'number') parts.push(`${g.completed} completed`);
        parts.push(gIn ? `${fmtTokens(gIn.median)} median in` : 'no tokens recorded');
        if (gCost) parts.push(`$${gCost.median.toFixed(2)} median`);
        parts.push(`${success} success`);
        // Role groups only: how long its tasks waited to be claimed. A routed
        // (· inferred) role waiting longer than (unassigned) is one no runner picks up.
        const lat = dist(g.claimLatencyMs);
        const wait = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : fmtDuration(ms));
        if (lat) parts.push(`claimed in ${wait(lat.median)} median / ${wait(lat.p90)} p90`);
        return `  ${g.label ?? g.key}: ${parts.join(' · ')}`;
      });
      if (groups.length > 0) lines.push(`By ${data.groupBy}:\n${groups.join('\n')}`);

      return text(lines.join('\n'));
    }

    case 'get_page_source': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      const qs = new URLSearchParams();
      if (typeof params.sha === 'string' && params.sha) qs.set('sha', params.sha);
      if (params.prNumber !== undefined && params.prNumber !== null) qs.set('prNumber', String(params.prNumber));
      if (params.waitSeconds !== undefined && params.waitSeconds !== null) qs.set('waitSeconds', String(params.waitSeconds));
      const data = await api(`/api/workers/${workerId}/page-source${qs.size ? `?${qs}` : ''}`);
      return text(JSON.stringify(data, null, 2));
    }

    case 'deploy': {
      const workerId = resolveWorkerId(params.workerId, ctx);
      // Passed through as-is: the route validates, authorizes and audits.
      const body = {
        provider: params.provider,
        project: params.project,
        environment: params.environment,
        credentialRef: params.credentialRef,
        operation: params.operation,
        params: params.params ?? {},
      };
      const data = await api(`/api/workers/${workerId}/deployments`, { method: 'POST', body: JSON.stringify(body) });
      return text(JSON.stringify(data, null, 2));
    }

    case 'list_runners':
      return runListRunners(api, params, (p) => resolveWorkspaceId(api, p, ctx));

    case 'get_visual_review':
      return runGetVisualReview(api, params, (p) => resolveWorkspaceId(api, p, ctx), ctx.appBaseUrl || 'https://buildd.dev', ctx.workspaceId || null);

    case 'resolve_capability': {
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) {
        throw new Error('Cannot resolve workspace. Pass ?workspace=<id> in the MCP URL, use a workspace-pinned endpoint, or include workspaceId in params.');
      }
      const q = new URLSearchParams({ workspaceId: wsId });
      if (typeof params.capability === 'string' && params.capability.trim()) q.set('capability', params.capability.trim());
      if (typeof params.roleSlug === 'string' && params.roleSlug.trim()) q.set('roleSlug', params.roleSlug.trim());
      const data = await api(`/api/connectors/capabilities?${q.toString()}`);
      return text(JSON.stringify(data, null, 2));
    }

    case 'list_connectors': {
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) {
        throw new Error('Cannot resolve workspace. Pass ?workspace=<id> in the MCP URL, use a workspace-pinned endpoint, or include workspaceId in params.');
      }
      const data = await api(`/api/connectors/mounted?workspaceId=${encodeURIComponent(wsId)}`);
      return text(JSON.stringify({ connectors: data.connectors ?? [] }));
    }

    case 'list_incidents': {
      // Read-only. Scoping is not re-implemented here: GET /api/health/incidents
      // derives the team from the caller's bearer token and 404s a workspaceId
      // outside it, exactly like get_failure_analytics above.
      const rawWsId = typeof params.workspaceId === 'string' && params.workspaceId.trim()
        ? params.workspaceId.trim()
        : null;
      let wsId: string | null = null;
      if (rawWsId) {
        wsId = await resolveWorkspaceId(api, rawWsId, ctx);
      }

      const qs: string[] = [];
      if (wsId) qs.push(`workspaceId=${encodeURIComponent(wsId)}`);
      for (const [key, max] of [['status', Infinity], ['severity', Infinity], ['rule', Infinity]] as const) {
        const raw = typeof params[key] === 'string' && params[key].trim() ? params[key].trim() : null;
        if (raw) qs.push(`${key}=${encodeURIComponent(raw.slice(0, max === Infinity ? 200 : max))}`);
      }
      const rawSignature = typeof params.signature === 'string' && params.signature.trim() ? params.signature.trim() : null;
      if (rawSignature) qs.push(`signature=${encodeURIComponent(rawSignature.slice(0, 300))}`);
      const limit = typeof params.limit === 'number' ? Math.min(Math.max(Math.round(params.limit), 1), 200) : null;
      if (limit) qs.push(`limit=${limit}`);

      const data = await api(`/api/health/incidents${qs.length ? `?${qs.join('&')}` : ''}`);
      const incidents = (data?.incidents ?? []) as FailureIncident[];
      const counts = (data?.counts ?? { total: 0, bySeverity: { low: 0, medium: 0, high: 0, critical: 0 } }) as {
        total: number;
        bySeverity: Record<FailureIncidentSeverity, number>;
      };
      return text(formatIncidentsList(incidents, counts));
    }
    case 'get_failure_analytics': {
      // Read-only. Scoping is not re-implemented here: GET /api/health/failures
      // derives the team from the caller's bearer token and 404s a workspaceId
      // outside it, so this handler cannot widen its own visibility.
      const rawWindow = params.window === undefined || params.window === null ? '7d' : String(params.window);
      if (!FAILURE_WINDOW_VALUES.includes(rawWindow as FailureWindow)) {
        return errorResult(`Invalid window "${rawWindow}". Expected one of ${FAILURE_WINDOW_VALUES.join(', ')}.`);
      }
      const window = rawWindow as FailureWindow;

      const limit = typeof params.limit === 'number'
        ? Math.min(Math.max(Math.round(params.limit), 1), FAILURE_SIGNATURES_MAX)
        : FAILURE_SIGNATURES_DEFAULT;

      const rawWsId = typeof params.workspaceId === 'string' && params.workspaceId.trim()
        ? params.workspaceId.trim()
        : null;
      let wsId: string | null = null;
      if (rawWsId) {
        wsId = await resolveWorkspaceId(api, rawWsId, ctx);
      }

      // The route only ever normalizes the first line, so a long trace adds URL
      // length and nothing else.
      const rawError = typeof params.error === 'string' && params.error.trim() ? params.error : null;
      const rawErrorPrefix = typeof params.errorPrefix === 'string' && params.errorPrefix.trim()
        ? params.errorPrefix.trim()
        : null;

      // family='gate' switches to the GATE LEDGER — refusals, deferrals,
      // advisory warnings and bypasses that never became a failed worker and
      // are therefore structurally invisible to every other mode here.
      const rawFamily = typeof params.family === 'string' && params.family.trim()
        ? params.family.trim()
        : null;
      if (rawFamily !== null && rawFamily !== 'gate') {
        return errorResult(`Invalid family "${rawFamily}". The only supported value is "gate".`);
      }

      const qs = [`window=${window}`];
      if (wsId) qs.push(`workspaceId=${encodeURIComponent(wsId)}`);
      if (rawError) qs.push(`error=${encodeURIComponent(rawError.slice(0, FAILURE_LOOKUP_INPUT_MAX))}`);
      if (rawErrorPrefix) qs.push(`errorPrefix=${encodeURIComponent(rawErrorPrefix.slice(0, FAILURE_PREFIX_INPUT_MAX))}`);
      if (rawFamily) qs.push(`family=${encodeURIComponent(rawFamily)}`);

      const data = await api(`/api/health/failures?${qs.join('&')}`);
      const analytics = data?.analytics as FailureAnalytics | undefined;
      if (!analytics) return text('No failure analytics available.');

      if (rawFamily === 'gate') {
        const gateFamily = data?.gateFamily as GateReasonFamily | undefined;
        if (gateFamily) return text(formatGateFamily(gateFamily, window));
        const gates = data?.gates as GateAnalytics | undefined;
        if (!gates) return text('No gate analytics available.');
        const landing = data?.landing as LandingMetrics | undefined;
        const overview = formatGateOverview(gates, limit);
        return text(landing ? `${overview}\n\n${formatLandingMetrics(landing)}` : overview);
      }

      const lookup = data?.lookup as FailureSignatureLookup | undefined;
      if (lookup) return text(formatFailureLookup(lookup, window, analytics.totals.failed));

      const family = data?.family as FailureSignatureFamily | undefined;
      if (family) return text(formatFailureFamily(family, window));

      const overview = formatFailureOverview(analytics, limit);
      const stalledIngest = data?.stalledIngest as StalledIngestReport | undefined;
      return text(stalledIngest ? `${overview}\n\n${formatStalledIngest(stalledIngest)}` : overview);
    }

    case 'dispatch_health': {
      // Read-only. GET /api/health/dispatch derives the team from the bearer
      // token and 404s a workspaceId outside it, so this cannot widen scope.
      const rawWsId = typeof params.workspaceId === 'string' && params.workspaceId.trim() ? params.workspaceId.trim() : null;
      const wsId = rawWsId ? await resolveWorkspaceId(api, rawWsId, ctx) : null;
      const data = await api(`/api/health/dispatch${wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : ''}`);
      if (!data || typeof data.verdict !== 'string') return text('No dispatch health available.');
      return text(formatDispatchHealth(data as DispatchHealthReport));
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
      requireFullUuid(params.taskId, 'taskId');

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
      requireFullUuid(params.taskId, 'taskId');
      if (!params.feedback) throw new Error('feedback is required');

      const data = await api(`/api/tasks/${params.taskId}/reject-plan`, {
        method: 'POST',
        body: JSON.stringify({ feedback: params.feedback }),
      });

      return text(`Plan rejected. Revised planning task created: ${data.taskId}`);
    }

    // Discrepancy ledger mutations (§13).
    case 'adjudicate_discrepancy': {
      requireFullUuid(params.discrepancyId, 'discrepancyId');
      const adjudicateAction = params.action as string;
      if (adjudicateAction !== 'accept' && adjudicateAction !== 'flip_direction') {
        throw new Error(`action must be "accept" or "flip_direction", got: ${adjudicateAction}`);
      }

      const body: Record<string, unknown> = { action: adjudicateAction, reason: params.reason };
      if (params.newDirection !== undefined) body.newDirection = params.newDirection;

      const data = await api(`/api/discrepancies/${params.discrepancyId}/adjudicate`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const d = data.discrepancy;
      return text(
        adjudicateAction === 'accept'
          ? `Discrepancy accepted: ${d.specPath} \`${d.assertionId}\` — reason: ${d.acceptedReason}`
          : `Discrepancy direction flipped: ${d.specPath} \`${d.assertionId}\` → ${d.direction}`
      );
    }

    case 'promote_discrepancy': {
      requireFullUuid(params.discrepancyId, 'discrepancyId');

      const row = (await api(`/api/discrepancies/${params.discrepancyId}`)).discrepancy;

      if (row.promotedMissionId) {
        return text(`Already promoted — mission ${row.promotedMissionId} (${row.specPath} \`${row.assertionId}\`).`);
      }
      // Fail fast on the §8 gate before minting a mission nobody can link.
      // The authoritative check still lives at the write in
      // /api/discrepancies/[id]/promote — this is a cheaper early exit.
      // Dynamic import: spec-discrepancy-ledger.ts pulls in the real `db`/schema
      // module at its top level, which mcp-tools.ts otherwise never touches
      // statically (it stays DB-free so drizzle-orm-mocking unit tests can
      // import it safely) — load it lazily so that stays true.
      const { assertPromotable } = await import('./spec-discrepancy-ledger');
      assertPromotable(row.direction as Direction);

      const title = (params.title as string) || `Spec discrepancy: ${row.assertionId} in ${row.specPath}`;
      const description =
        (params.description as string) ||
        `Promoted from discrepancy ledger row ${row.id} (docs/design/spec-conformance.md §13).\n\n` +
        `Spec: ${row.specPath}\nAssertion: ${row.assertionId}\nDirection: ${row.direction}\n\n` +
        `Evidence:\n${JSON.stringify(row.evidence, null, 2)}`;

      // Same primitive every other mission-creating caller uses — see
      // manage_missions action=create above, which makes this identical call.
      const mission = await api('/api/missions', {
        method: 'POST',
        body: JSON.stringify({ title, description, workspaceId: row.workspaceId }),
      });

      const linked = await api(`/api/discrepancies/${params.discrepancyId}/promote`, {
        method: 'POST',
        body: JSON.stringify({ missionId: mission.id }),
      });

      return text(
        `Promoted "${row.specPath}" \`${row.assertionId}\` → mission "${mission.title}" (ID: ${mission.id})` +
        (linked.alreadyPromoted ? '\n(row was already linked to this mission by a concurrent call)' : '')
      );
    }

    case 'manage_missions': {

      const missionAction = params.action as string;
      if (!missionAction) throw new Error('action is required (list, create, get, update, delete, link_task, unlink_task)');

      switch (missionAction) {
        case 'list': {
          const qs = new URLSearchParams();
          if (params.workspaceId) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (wsId) qs.set('workspaceId', wsId);
          }
          // Default: open missions only. Unfiltered, this was the team's whole
          // history (every mission with all its tasks), for a question about now.
          // status "all" still reaches it.
          // A title query searches every status unless one is given.
          const query = typeof params.query === 'string' ? params.query.trim() : '';
          const status = typeof params.status === 'string' && params.status ? params.status : query ? 'all' : 'open';
          if (status !== 'all') qs.set('status', status);
          const rawLimit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.trunc(params.limit) : 20;
          qs.set('limit', String(Math.min(Math.max(rawLimit, 1), 100)));
          if (query) qs.set('q', query);
          qs.set('sort', 'recent');
          const data = await api(`/api/missions?${qs}`);
          const missions = data.missions || [];
          if (missions.length === 0) {
            const what = query ? `No ${status === 'all' ? '' : `${status} `}missions with "${query}" in the title.` : status === 'open' ? 'No open missions.' : 'No missions found.';
            return text(status === 'all' ? what : `${what} Pass status: "all" for past ones.`);
          }
          const total = typeof data.total === 'number' ? data.total : missions.length;
          const truncated = total > missions.length
            ? `\n\nShowing ${missions.length} of ${total}. Raise limit (max 100) or pass query.`
            : '';
          const summary = missions.map((m: any) => {
            const activityLine = m.lastActivityAt
              ? `\n  Last activity: ${new Date(m.lastActivityAt).toISOString()}`
              : '';
            const createdLine = m.createdAt
              ? `\n  Created: ${new Date(m.createdAt).toISOString()}`
              : '';
            return `- **${m.title}** [${m.status}]${m.isHeld ? ' [HELD]' : ''}${m.executor === 'local' ? ' [LOCAL]' : ''} — ${m.progress}% (${m.completedTasks}/${m.totalTasks} tasks)\n  ID: ${m.id}${m.workspace ? `\n  Workspace: ${m.workspace.name}` : ''}${activityLine}${createdLine}`;
          }).join('\n\n');
          return text(`${missions.length} mission(s), most recent activity first:\n\n${summary}${truncated}`);
        }
        case 'create': {
          if (!params.title) throw new Error('title is required');
          await assertMissionControlCapabilities(api, requestedMissionControlCapabilities(params));
          const body: Record<string, unknown> = { title: params.title };
          if (params.description) body.description = params.description;
          if (params.workspaceId) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (!wsId) throw new Error(`Workspace not found: ${params.workspaceId}`);
            body.workspaceId = wsId;
          } else {
            // Like create_task: a connector/session bound to a workspace puts
            // the mission there, rather than minting a workspace-less mission
            // whose tasks land in a workspace the mission itself isn't in.
            const bound = ctx.workspaceId || (await ctx.getWorkspaceId());
            if (bound) body.workspaceId = bound;
          }
          if (params.cronExpression) body.cronExpression = params.cronExpression;
          if (params.priority !== undefined) body.priority = normalizePriority(params.priority);
          if (params.initiativeId !== undefined) body.initiativeId = params.initiativeId;
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
          if (params.decomposition !== undefined) body.decomposition = params.decomposition;
          if (params.costBudgetUsd !== undefined) body.costBudgetUsd = params.costBudgetUsd;
          if (params.pacingMode !== undefined) body.pacingMode = params.pacingMode;
          if (params.pacingMaxPerHour !== undefined) body.pacingMaxPerHour = params.pacingMaxPerHour;
          if (params.startAt !== undefined) body.startAt = params.startAt;
          if (params.startIn !== undefined) body.startIn = params.startIn;
          if (params.startAfter !== undefined) body.startAfter = params.startAfter;
          if (params.startMode !== undefined) body.startMode = params.startMode;
          if (params.executor !== undefined) body.executor = params.executor;
          if (params.goalCriteria !== undefined) body.goalCriteria = params.goalCriteria;
          if (params.autoVerify !== undefined) body.autoVerify = params.autoVerify;
          if (params.branchStrategy !== undefined) body.branchStrategy = params.branchStrategy;
          if (params.autoSurfaceAudit !== undefined) body.autoSurfaceAudit = params.autoSurfaceAudit;
          const data = await api('/api/missions', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          const modeInfo = data.orchestrationMode === 'manual'
            ? 'Orchestration: manual (orchestrator idle — use "Run now" or set orchestrationMode=auto to arm)'
            : data.heartbeatInfo
              ? `Orchestration: auto — ${data.heartbeatInfo}`
              : 'Orchestration: auto';
          const heldInfo = data.isHeld ? '\nStart mode: held — tasks are not claimable until armed (use action=arm)' : '';
          const executorInfo = data.executor === 'local' ? `\nExecutor: ${LOCAL_EXECUTOR}` : '';

          // Same prior-work surfacing as create_task — best-effort, never fails
          // an already-created mission.
          const missionQueryText = [params.title, params.description]
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .join('\n')
            .slice(0, 2000);
          const priorWorkBlock = await buildAuthoringPriorWork(
            missionQueryText,
            data.workspaceId ?? null,
            data.teamId ?? ctx.teamId ?? null,
            ctx.knowledgeStore,
            { ledger: ctx.memoryLedger },
          ).catch(() => '');

          return text(`Mission created: "${data.title}" (ID: ${data.id})\nStatus: ${data.status}\nPriority: ${data.priority}\n${modeInfo}${heldInfo}${executorInfo}${data.startAt ? `\nStarts at: ${new Date(data.startAt).toISOString()}\nResolution: ${data.startResolution}` : ''}${data.organizerTask ? `\nOrganizer task: ${data.organizerTask.id}` : ''}${priorWorkBlock ? `\n\n${priorWorkBlock}` : ''}`);
        }
        case 'get': {
          const target = await resolveMissionTarget(api, params, ctx);
          if ('message' in target) return text(target.message);
          const missionId = target.id;
          const data = await api(`/api/missions/${missionId}`);
          // Unfinished tasks first (route order kept within each half), capped
          // unless all:true; the cut says how many of each status it left out.
          const showAll = params.all === true;
          const allTasks: any[] = data.tasks || [];
          const orderedTasks = [...allTasks.filter(t => !isTerminalTaskStatus(t.status)), ...allTasks.filter(t => isTerminalTaskStatus(t.status))];
          const { shown: shownTasks, omitted: omittedTaskCount } = capList(orderedTasks, MISSION_TASKS_SHOWN, showAll);
          const omittedByStatus = new Map<string, number>();
          for (const t of orderedTasks.slice(shownTasks.length)) omittedByStatus.set(t.status, (omittedByStatus.get(t.status) ?? 0) + 1);
          const taskList = shownTasks.map((t: any) =>
            `  - [${t.status}] ${t.title} (${t.id})`
          ).join('\n') + (omittedTaskCount > 0
            ? `\n  (${omittedTaskCount} more: ${[...omittedByStatus].map(([k, n]) => `${n} ${k}`).join(', ')} — all:true, or list_tasks {missionId, status})`
            : '');
          const description = typeof data.description === 'string' && data.description
            ? (!showAll && params.fullDescription !== true && data.description.length > MISSION_DESCRIPTION_PREVIEW_CHARS
              ? `${truncate(data.description, MISSION_DESCRIPTION_PREVIEW_CHARS)} (fullDescription:true for all of it)`
              : data.description)
            : '';
          const schedCtx = data.schedule?.taskTemplate?.context;
          const heartbeatRunning = schedCtx?.heartbeat && data.schedule?.enabled !== false && data.status !== 'paused';
          const isManual = data.orchestrationMode === 'manual';
          const modeInfo = isManual
            ? '\nOrchestration: manual — orchestrator idle (use Run now or set orchestrationMode=auto to arm)'
            : schedCtx?.heartbeat
              ? `\nOrchestration: auto\nHeartbeat: ${heartbeatRunning ? 'enabled' : 'paused'}${schedCtx.activeHoursStart != null && schedCtx.activeHoursEnd != null ? ` (active ${schedCtx.activeHoursStart}:00-${schedCtx.activeHoursEnd}:00${schedCtx.activeHoursTimezone ? ` ${schedCtx.activeHoursTimezone}` : ''})` : ''}${schedCtx.heartbeatChecklist ? `\nChecklist: ${schedCtx.heartbeatChecklist}` : ''}`
              : '\nOrchestration: auto';
          const concurrentInfo = data.maxConcurrentTasks != null ? `\nMax concurrent tasks: ${data.maxConcurrentTasks} (mission-level cap)` : '';
          const depInfo = data.dependsOnMissionId ? `\nDependency: ${data.dependsOnMissionId} (gate: ${data.gateCondition})${data.blocked ? ` — BLOCKED: ${data.blockedReason}` : ' — unblocked'}` : '';
          const budgetInfo = data.costBudgetUsd != null ? `\nBudget: $${parseFloat(data.costBudgetUsd).toFixed(2)} limit${data.status === 'budget_exhausted' ? ' — EXHAUSTED (raise to resume)' : ''}` : '';
          const pacingInfo = data.pacingMode === 'paced'
            ? `\nPacing: max ${data.pacingMaxPerHour ?? 1} task(s)/hr${data.lastTaskStartedAt ? ` (last start ${new Date(data.lastTaskStartedAt).toISOString()})` : ''}`
            : '';
          const startInfo = data.startAt ? `\nStarts at: ${new Date(data.startAt).toISOString()} (${data.startResolution || 'resolved'})` : '';
          const heldInfo = data.isHeld ? '\nStart mode: HELD — tasks not claimable; use action=arm to release' : '';
          const executorInfo = `\nExecutor: ${data.executor === 'local' ? LOCAL_EXECUTOR : 'runner — background runners claim its tasks'}`;

          // goalCriteria + autoVerify + last evaluation state
          const criteriaArr = Array.isArray(data.goalCriteria) ? data.goalCriteria : [];
          let criteriaInfo = '';
          if (criteriaArr.length > 0) {
            const autoVerifyLabel = data.autoVerify === false ? 'manual-only' : 'auto';
            criteriaInfo = `\nGoal criteria (${criteriaArr.length}, autoVerify=${autoVerifyLabel}):`;
            const state = data.goalCriteriaState as Record<string, any> | null | undefined;
            if (state?.criteria && state.criteria.length > 0) {
              criteriaInfo += ` overall=${state.overall} (as of ${state.evaluatedAt})`;
              let evidenceCut = false;
              criteriaInfo += '\n' + (state.criteria as any[]).map((c: any) => {
                const ev = typeof c.evidence === 'string' && !showAll && c.evidence.length > MISSION_CRITERION_EVIDENCE_CHARS
                  ? (evidenceCut = true, truncate(c.evidence, MISSION_CRITERION_EVIDENCE_CHARS))
                  : c.evidence;
                return `  • [${c.verdict}] ${c.label ?? c.description ?? c.type}${ev ? ': ' + ev : ''}`;
              }).join('\n');
              if (evidenceCut) criteriaInfo += '\n  (Full evidence: action=get_criteria_state.)';
            } else {
              criteriaInfo += ' (not yet evaluated — use action=evaluate or action=get_criteria_state)';
              criteriaInfo += '\n' + criteriaArr.map((c: any) =>
                `  • ${c.label ?? c.description ?? c.type ?? '(malformed criterion — missing type field)'}`
              ).join('\n');
            }
            // The gate, stated plainly: anything other than a passing verdict
            // keeps the mission open, so an agent knows not to declare victory.
            if (state?.overall !== 'pass') {
              criteriaInfo += '\n  ⚠ Completion is BLOCKED until every criterion passes. An unevaluated criterion is not a pass.';
            }
          }

          return text(`**${data.title}** [${data.status}]${data.blocked ? ' [BLOCKED]' : ''}${data.isHeld ? ' [HELD]' : ''}${data.executor === 'local' ? ' [LOCAL]' : ''}\nID: ${data.id}\nProgress: ${data.progress}% (${data.completedTasks}/${data.totalTasks})\n${description ? `Description: ${description}\n` : ''}${modeInfo}${heldInfo}${executorInfo}${concurrentInfo}${depInfo}${budgetInfo}${pacingInfo}${startInfo}${criteriaInfo}${taskList ? `\nLinked tasks:\n${taskList}` : '\nNo linked tasks.'}`);
        }
        case 'update': {
          // No UUID missionId: the mission is FOUND by title (missionId, else
          // title/query), scoped to workspaceId. Lookup mode never moves it,
          // and title renames only when missionId carried the lookup.
          const target = await resolveMissionTarget(api, params, ctx);
          if ('message' in target) throw new Error(target.message);
          const missionId = target.id;
          const titleIsLookup = target.lookup && !(typeof params.missionId === 'string' && params.missionId.trim());
          await assertMissionControlCapabilities(api, requestedMissionControlCapabilities(params));
          const body: Record<string, unknown> = {};
          if (params.title !== undefined && !titleIsLookup) body.title = params.title;
          if (params.description !== undefined) body.description = params.description;
          if (params.status !== undefined) body.status = params.status;
          if (params.cronExpression !== undefined) body.cronExpression = params.cronExpression;
          if (params.priority !== undefined) body.priority = normalizePriority(params.priority);
          if (params.workspaceId !== undefined && !target.lookup) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (!wsId) throw new Error(`Workspace not found: ${params.workspaceId}`);
            body.workspaceId = wsId;
          }
          if (params.initiativeId !== undefined) body.initiativeId = params.initiativeId;
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
          if (params.costBudgetUsd !== undefined) body.costBudgetUsd = params.costBudgetUsd;
          if (params.pacingMode !== undefined) body.pacingMode = params.pacingMode;
          if (params.pacingMaxPerHour !== undefined) body.pacingMaxPerHour = params.pacingMaxPerHour;
          if (params.startAt !== undefined) body.startAt = params.startAt;
          if (params.startIn !== undefined) body.startIn = params.startIn;
          if (params.startAfter !== undefined) body.startAfter = params.startAfter;
          if (params.startMode !== undefined) body.startMode = params.startMode;
          if (params.executor !== undefined) body.executor = params.executor;
          if (params.goalCriteria !== undefined) body.goalCriteria = params.goalCriteria;
          if (params.autoVerify !== undefined) body.autoVerify = params.autoVerify;
          if (params.branchStrategy !== undefined) body.branchStrategy = params.branchStrategy;
          if (params.autoSurfaceAudit !== undefined) body.autoSurfaceAudit = params.autoSurfaceAudit;
          if (params.surfaceAuditWaiver !== undefined) body.surfaceAuditWaiver = params.surfaceAuditWaiver;
          if (Object.keys(body).length === 0) throw new Error('At least one field to update is required');
          // Names the calling worker's task on the mission-feed entry this PATCH
          // produces, so an in-task agent's edit reads as "agent (task X)"
          // instead of collapsing into an anonymous API call.
          if (ctx.workerId) body.actorWorkerId = ctx.workerId;
          const data = await api(`/api/missions/${missionId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          const heldStatus = data.isHeld ? ' [HELD — tasks not claimable]' : '';
          const localStatus = data.executor === 'local' ? ' [LOCAL — runs in a local session]' : '';
          return text(`Mission updated: "${data.title}" [${data.status}]${heldStatus}${localStatus} (ID: ${data.id})`);
        }
        case 'arm': {
          if (!params.missionId) throw new Error('missionId is required');
          await assertMissionControlCapabilities(api, ['startMode']);
          const data = await api(`/api/missions/${params.missionId}`, {
            method: 'PATCH',
            body: JSON.stringify({ arm: true, ...(ctx.workerId ? { actorWorkerId: ctx.workerId } : {}) }),
          });
          return text(`Mission armed: "${data.title}" (ID: ${data.id}) — tasks are now claimable by workers.`);
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
            body: JSON.stringify({ missionId: params.missionId, ...(ctx.workerId ? { actorWorkerId: ctx.workerId } : {}) }),
          });
          return text(`Task ${params.taskId} linked to mission ${params.missionId}`);
        }
        case 'unlink_task': {
          if (!params.taskId) throw new Error('taskId is required');
          await api(`/api/tasks/${params.taskId}`, {
            method: 'PATCH',
            body: JSON.stringify({ missionId: null, ...(ctx.workerId ? { actorWorkerId: ctx.workerId } : {}) }),
          });
          return text(`Task ${params.taskId} unlinked from mission`);
        }
        case 'evaluate': {
          if (!params.missionId) throw new Error('missionId is required');
          const data = await api(`/api/missions/${params.missionId}/evaluate`, { method: 'POST' });
          if (data.message) return text(data.message);
          const state = data.goalCriteriaState;
          const criteriaLines = (state?.criteria ?? []).map((c: any) =>
            `  • [${c.verdict}] ${c.label ?? c.type}${c.evidence ? ': ' + c.evidence : ''}`
          ).join('\n');
          return text(`Goal criteria evaluated — Overall: **${state?.overall ?? 'unknown'}**\n${criteriaLines}`);
        }
        case 'get_criteria_state': {
          if (!params.missionId) throw new Error('missionId is required');
          const data = await api(`/api/missions/${params.missionId}/evaluate`);
          if (!data.goalCriteriaState) return text('No criteria evaluation on record for this mission.');
          const state = data.goalCriteriaState;
          const criteriaLines = (state.criteria ?? []).map((c: any) =>
            `  • [${c.verdict}] ${c.label ?? c.type}${c.evidence ? ': ' + c.evidence : ''}`
          ).join('\n');
          return text(`Last evaluation: ${state.evaluatedAt} (by ${state.evaluatedBy})\nOverall: **${state.overall}**\n${criteriaLines}`);
        }
        default:
          throw new Error(`Unknown missions action: ${missionAction}. Use one of: list, create, get, update, arm, delete, link_task, unlink_task, evaluate, get_criteria_state`);
      }
    }

    // ── Initiatives ────────────────────────────────────────────────────────
    // An initiative is an execution-free planning container above missions
    // (initiative → mission → task). It has NO orchestration engine of its own.

    case 'manage_initiatives': {
      const initiativeAction = params.action as string;
      if (!initiativeAction) throw new Error('action is required (list, create, get, update, delete, link_mission, unlink_mission)');

      switch (initiativeAction) {
        case 'list': {
          const qs = new URLSearchParams();
          if (params.workspaceId) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (wsId) qs.set('workspaceId', wsId);
          }
          if (params.status) qs.set('status', params.status as string);
          const data = await api(`/api/initiatives?${qs}`);
          const initiatives = data.initiatives || [];
          if (initiatives.length === 0) return text('No initiatives found.');
          const summary = initiatives.map((i: any) => {
            const motionLine = i.lastMotionAt
              ? `\n  Last activity: ${new Date(i.lastMotionAt).toISOString()}`
              : '';
            const createdLine = i.createdAt
              ? `\n  Created: ${new Date(i.createdAt).toISOString()}`
              : '';
            return `- **${i.title}** [${i.status}] — ${i.progress?.progress ?? 0}% (${i.progress?.completedMissions ?? 0}/${i.progress?.totalMissions ?? 0} missions, ${i.progress?.completedTasks ?? 0}/${i.progress?.totalTasks ?? 0} tasks)\n  ID: ${i.id}${i.workspace ? `\n  Workspace: ${i.workspace.name}` : ''}${motionLine}${createdLine}`;
          }).join('\n\n');
          return text(`${initiatives.length} initiative(s):\n\n${summary}`);
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
          if (params.status !== undefined) body.status = params.status;
          if (params.priority !== undefined) body.priority = normalizePriority(params.priority);
          if (params.targetDate !== undefined) body.targetDate = params.targetDate;
          if (params.ownerUserId !== undefined) body.ownerUserId = params.ownerUserId;
          const data = await api('/api/initiatives', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          // Best-effort: mirror into the team-scoped `initiative` corpus so it's recallable.
          await mirrorWorkProduct(ctx, 'initiative', buildInitiativeCard({
            initiativeId: data.id,
            title: data.title,
            description: data.description ?? (params.description as string | undefined) ?? null,
            status: data.status,
          }));
          return text(`Initiative created: "${data.title}" (ID: ${data.id})\nStatus: ${data.status}\nPriority: ${data.priority}\n\nCreate missions under it with manage_missions action=create initiativeId=${data.id}.`);
        }
        case 'get': {
          // KB-optimized brief: rolled-up progress + child missions + initiative-level artifacts.
          if (!params.initiativeId) throw new Error('initiativeId is required');
          const data = await api(`/api/initiatives/${params.initiativeId}`);
          const p = data.progress || {};
          // Group missions by workspace so cross-repo rollups are explicit.
          const missionsArr: any[] = data.missions || [];
          const wsGroups: Record<string, any[]> = {};
          for (const m of missionsArr) {
            const wsLabel = m.workspace?.name ?? (m.workspaceId ? m.workspaceId.slice(0, 8) : '(no workspace)');
            if (!wsGroups[wsLabel]) wsGroups[wsLabel] = [];
            wsGroups[wsLabel].push(m);
          }
          const missionList = Object.entries(wsGroups)
            .map(([ws, ms]) => {
              const lines = ms.map((m: any) =>
                `    - [${m.status}] ${m.title} — ${m.progress ?? 0}% (${m.completedTasks ?? 0}/${m.totalTasks ?? 0}) (${m.id})`
              ).join('\n');
              return `  ${ws}:\n${lines}`;
            })
            .join('\n');
          const artifactList = (data.artifacts || []).map((a: any) =>
            `  - ${a.title} (${a.type}) — ${a.id}`
          ).join('\n');

          return text(
            `**${data.title}** [${data.status}]\nID: ${data.id}\n` +
            `${data.ownerUserId ? `Owner: ${data.ownerUserId}\n` : ''}` +
            `${data.targetDate ? `Target date: ${data.targetDate}\n` : ''}` +
            `Rollup: ${p.progress ?? 0}% — ${p.completedMissions ?? 0}/${p.totalMissions ?? 0} missions, ${p.completedTasks ?? 0}/${p.totalTasks ?? 0} tasks [${p.status ?? 'empty'}]\n` +
            `${data.description ? `Description: ${data.description}\n` : ''}` +
            `${missionList ? `\nMissions:\n${missionList}` : '\nNo missions yet.'}` +
            `${artifactList ? `\n\nInitiative artifacts:\n${artifactList}` : ''}`
          );
        }
        case 'update': {
          if (!params.initiativeId) throw new Error('initiativeId is required');
          const body: Record<string, unknown> = {};
          if (params.title !== undefined) body.title = params.title;
          if (params.description !== undefined) body.description = params.description;
          if (params.status !== undefined) body.status = params.status;
          if (params.priority !== undefined) body.priority = normalizePriority(params.priority);
          if (params.workspaceId !== undefined) {
            const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
            if (!wsId) throw new Error(`Workspace not found: ${params.workspaceId}`);
            body.workspaceId = wsId;
          }
          if (params.targetDate !== undefined) body.targetDate = params.targetDate;
          if (params.ownerUserId !== undefined) body.ownerUserId = params.ownerUserId;
          if (Object.keys(body).length === 0) throw new Error('At least one field to update is required');
          const data = await api(`/api/initiatives/${params.initiativeId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          // Best-effort: keep the team-scoped `initiative` corpus card in sync.
          await mirrorWorkProduct(ctx, 'initiative', buildInitiativeCard({
            initiativeId: data.id,
            title: data.title,
            description: data.description ?? null,
            status: data.status,
          }));
          return text(`Initiative updated: "${data.title}" [${data.status}] (ID: ${data.id})`);
        }
        case 'delete': {
          if (!params.initiativeId) throw new Error('initiativeId is required');
          await api(`/api/initiatives/${params.initiativeId}`, { method: 'DELETE' });
          return text(`Initiative deleted: ${params.initiativeId} (child missions were unlinked, not deleted)`);
        }
        case 'link_mission': {
          if (!params.initiativeId || !params.missionId) throw new Error('initiativeId and missionId are required');
          await api(`/api/missions/${params.missionId}`, {
            method: 'PATCH',
            body: JSON.stringify({ initiativeId: params.initiativeId }),
          });
          return text(`Mission ${params.missionId} linked to initiative ${params.initiativeId}`);
        }
        case 'unlink_mission': {
          if (!params.missionId) throw new Error('missionId is required');
          await api(`/api/missions/${params.missionId}`, {
            method: 'PATCH',
            body: JSON.stringify({ initiativeId: null }),
          });
          return text(`Mission ${params.missionId} unlinked from its initiative`);
        }
        default:
          throw new Error(`Unknown initiatives action: ${initiativeAction}. Use one of: list, create, get, update, delete, link_mission, unlink_mission`);
      }
    }

    // ── External tracker links ─────────────────────────────────────────────

    case 'link_tracker': {
      const entityType = (params.entityType as string) ?? 'mission';
      const entityId = params.entityId as string;
      const url = params.url as string;
      if (!entityId) throw new Error('entityId is required');
      if (!url) throw new Error('url is required');
      // Phase 1 supports mission ↔ Linear project only. The shape is generic so
      // task/initiative links are a later add, not a redesign.
      if (entityType !== 'mission') {
        throw new Error(`Unsupported entityType: ${entityType}. Phase 1 supports "mission" only.`);
      }
      const data = await api(`/api/missions/${entityId}/link`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      return text(
        `Linked mission ${entityId} to ${data.provider ?? 'linear'} ${data.externalId ?? ''}\n` +
        `URL: ${data.externalUrl ?? url}`,
      );
    }

    // ── Workspaces ─────────────────────────────────────────────────────────

    case 'manage_workspaces': {

      const wsAction = params.action as string;
      if (!wsAction) throw new Error('action is required (list, get, create, update, create_repo, init, readiness, scaffold, author_spec)');

      switch (wsAction) {
        case 'create': {
          if (!params.name && !params.repoUrl) throw new Error('name or repoUrl is required');
          const body: Record<string, unknown> = {};
          if (params.name) body.name = params.name;
          if (params.repoUrl) body.repoUrl = params.repoUrl;
          if (params.accessMode) body.accessMode = params.accessMode;
          // Put defaultBranch in gitConfig so the runner can read it
          const gitConfig: Record<string, unknown> = {};
          if (params.defaultBranch) gitConfig.defaultBranch = params.defaultBranch;
          if (Object.keys(gitConfig).length > 0) body.gitConfig = gitConfig;
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
        case 'get': {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for get');
          const config = await api(`/api/workspaces/${wsId}/config`);
          return text(`Workspace ${wsId} config:\n${JSON.stringify(config, null, 2)}`);
        }
        case 'update': {
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for update');
          // A workspace changes team only through the checked move; PATCH refuses
          // teamId, and dropping it here would make the caller think it moved.
          if ('teamId' in params) {
            throw new Error(
              'teamId cannot be changed with update. Move a workspace to another team from the dashboard '
              + '(Move to team), which runs POST /api/workspaces/[id]/migrate/precheck and then /migrate/execute.',
            );
          }
          const body: Record<string, unknown> = {};
          if (params.name !== undefined) body.name = params.name;
          if (params.repoUrl !== undefined) body.repoUrl = params.repoUrl;
          if (params.accessMode !== undefined) body.accessMode = params.accessMode;
          if (params.releaseConfig !== undefined) body.releaseConfig = params.releaseConfig;
          if (params.maxConcurrentTasks !== undefined) body.maxConcurrentTasks = params.maxConcurrentTasks;

          // Partial gitConfig: accept a gitConfig object. Shallow-merged server-side (PATCH).
          const gitConfig: Record<string, unknown> = {
            ...(params.gitConfig && typeof params.gitConfig === 'object' ? params.gitConfig as Record<string, unknown> : {}),
          };
          // Put defaultBranch in gitConfig so the runner can read it
          if (params.defaultBranch !== undefined) gitConfig.defaultBranch = params.defaultBranch;
          // Hand-written merge-policy paths are refused (the API 400s too); say why
          // before the round-trip. Paths come from action=init's repo scan.
          const removedPathField = findRemovedPathFieldInGitConfig(params, '')
            ?? findRemovedPathFieldInGitConfig(gitConfig, 'gitConfig');
          if (removedPathField) throw new Error(removedPolicyPathFieldError(removedPathField));
          // Validate mergePolicy if provided — reject unknown keys rather than silently strip
          if (gitConfig.mergePolicy !== undefined && gitConfig.mergePolicy !== null) {
            const parsed = parseMergePolicy(gitConfig.mergePolicy);
            if (!parsed.ok) {
              throw new Error(`gitConfig.mergePolicy: ${parsed.error}`);
            }
            gitConfig.mergePolicy = parsed.policy;
          }
          if ('executor' in gitConfig && gitConfig.executor !== null && !isWorkspaceExecutor(gitConfig.executor)) {
            throw new Error("gitConfig.executor must be 'cloud', 'host', 'any' or null");
          }
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
          return text(`Workspace ${wsId} updated.${body.repoUrl ? ` Repo set to: ${body.repoUrl}` : ''}${body.name ? ` Name set to: ${body.name}` : ''}${params.releaseConfig !== undefined ? ' Release config updated.' : ''}${body.gitConfig ? ` gitConfig merged: ${JSON.stringify(gitConfig)}.` : ''}${body.maxConcurrentTasks !== undefined ? ` Concurrency cap set to ${body.maxConcurrentTasks}.` : ''}`);
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
          // Scan the workspace's GitHub repo and propose a semantic risk-class policy.
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for init');

          const preset = params.preset ?? 'balanced';

          // Call the policy-init scan endpoint
          let scanResult: {
            proposed: Record<string, unknown>;
            repoFullName: string;
            fileCount: number;
            detectedClassCount: number;
            hint: string;
            derivedFiles?: { proposed: Array<{ glob: string; regenerate: string }>; hint: string };
            specConformance: {
              detected: { specsRoot: string | null; designRoot: string | null };
              proposed: { specsRoot: string; designRoot: string };
              hint: string;
              tier3Schedule: { params: Record<string, unknown>; hint: string };
            };
          } | null = null;
          try {
            scanResult = await api(`/api/workspaces/${wsId}/policy-init`, {
              method: 'POST',
              body: JSON.stringify({
                preset,
                reviewerRole: params.reviewerRole,
              }),
            });
          } catch (err) {
            // Non-fatal: if the scan fails (e.g. no GitHub repo linked), return setup instructions
            return text(
              `Workspace ${wsId}: no GitHub repository linked or scan failed.\n\n` +
              `To enable semantic risk-class policy detection:\n` +
              `1. Link a GitHub repo: manage_workspaces action=update workspaceId=${wsId} repoUrl=<url>\n` +
              `2. Re-run: manage_workspaces action=init workspaceId=${wsId} preset=${preset}\n\n` +
              `Workspace directory is auto-created when a task is claimed.`,
            );
          }

          if (!scanResult) {
            return text(`policy-init scan returned no result for workspace ${wsId}`);
          }

          const { proposed, repoFullName, fileCount, detectedClassCount, specConformance, derivedFiles } = scanResult;

          // Format proposed policy for human confirmation
          const riskClasses = (proposed as any).riskClasses ?? [];
          const classLines = riskClasses
            .filter((c: any) => c.detectedPaths?.length > 0)
            .map((c: any) => `  - ${c.name}: ${(c.detectedPaths as string[]).join(', ')}`)
            .join('\n');

          const specRootsLine = specConformance.detected.specsRoot || specConformance.detected.designRoot
            ? `detected specsRoot=${specConformance.detected.specsRoot ?? '(none — using default)'}, designRoot=${specConformance.detected.designRoot ?? '(none — using default)'}`
            : `no docs/ tree detected — proposing buildd's own defaults`;

          return text(
            `## Proposed Policy for ${repoFullName}\n\n` +
            `**Preset:** ${(proposed as any).preset} (${detectedClassCount}/${riskClasses.length} classes detected across ${fileCount} files)\n\n` +
            `**Detected risk classes:**\n${classLines || '  (none detected — repo may be empty or use an unsupported ORM)'}\n\n` +
            `**To apply:** Update the workspace config with the proposed policyConfig:\n` +
            `\`\`\`\n` +
            `manage_workspaces action=update workspaceId=${wsId} gitConfig={\n` +
            `  "policyConfig": ${JSON.stringify(proposed, null, 2)}\n` +
            `}\n` +
            `\`\`\`\n\n` +
            `Paths are derived from the repo — they cannot be typed. Re-run action=init after the repo changes to refresh them.\n` +
            `To change the preset: re-run with preset=cautious or preset=autonomous.\n\n` +
            (derivedFiles && derivedFiles.proposed.length > 0
              ? `## Proposed Derived Files\n\n` +
                `Lockfiles runners regenerate instead of merging, so a conflict in one never needs an agent:\n` +
                derivedFiles.proposed.map((r) => `  - ${r.glob} → \`${r.regenerate}\``).join('\n') + `\n\n` +
                `**To apply:** manage_workspaces action=update workspaceId=${wsId} gitConfig={ "derivedFiles": ${JSON.stringify(derivedFiles.proposed)} }\n` +
                `Add a generated index with its own generator the same way (e.g. { "glob": "docs/specs/INDEX.md", "regenerate": "bun run specs:check" }).\n\n`
              : '') +
            `## Proposed Spec Conformance Setup (docs/design/spec-conformance.md §14)\n\n` +
            `${specRootsLine}.\n\n` +
            `**To apply:** manage_workspaces action=update workspaceId=${wsId} gitConfig={ "specConformance": ${JSON.stringify(specConformance.proposed)} }\n\n` +
            `**To opt into the weekly Tier-3 cron** (specs with zero assertions only — never a hardcoded schedule ID, one row per workspace that opts in):\n` +
            `\`\`\`\n` +
            `create_schedule workspaceId=${wsId} name="${specConformance.tier3Schedule.params.name}" ` +
            `cronExpression="${specConformance.tier3Schedule.params.cronExpression}" ` +
            `timezone="${specConformance.tier3Schedule.params.timezone}" ` +
            `title="${specConformance.tier3Schedule.params.title}" ` +
            `description=<the generated description in the tool result>\n` +
            `\`\`\``,
          );
        }
        case 'readiness': {
          // Read-only: a GET that recomputes the checklist from the repo. Never writes.
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for readiness');

          const report = await api(`/api/workspaces/${wsId}/readiness`);
          const items: Array<{
            id: string; status: string; importance: string; value?: string;
            waived?: { reason: string };
            fix: { kind: string; summary: string; configPatch?: Record<string, unknown> } | null;
          }> = report.items ?? [];
          const lines = items.map((i) => {
            const fix = i.fix && i.fix.kind !== 'none'
              ? ` -> ${i.fix.kind}: ${i.fix.summary}${i.fix.configPatch ? ` ${JSON.stringify(i.fix.configPatch)}` : ''}`
              : '';
            return `- [${i.status}] ${i.id} (${i.importance})${i.value ? ` = ${i.value}` : ''}${i.waived ? ` (waived: ${i.waived.reason})` : ''}${fix}`;
          });
          return text(
            `## Readiness for workspace ${wsId}\n\n` +
            `Next step: ${report.nextStep}\n` +
            `Skill: ${report.skill}\n` +
            `${report.truncated ? 'The repo tree was truncated, so missing files read as unknown.\n' : ''}` +
            `\n${lines.join('\n')}`,
          );
        }
        case 'scaffold': {
          // Writes nothing unless confirm: true, and then only creates one task.
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for scaffold');

          const confirm = params.confirm === true;
          const result = await api(`/api/workspaces/${wsId}/onboarding/scaffold`, {
            method: 'POST',
            body: JSON.stringify({
              itemIds: Array.isArray(params.itemIds) ? params.itemIds : [],
              ...(typeof params.dryRun === 'boolean' ? { dryRun: params.dryRun } : {}),
              confirm,
            }),
          });
          const files: Array<{ path: string; group: string; commitMessage: string; content: string }> = result.files ?? [];
          const skipped: Array<{ itemId: string; reason: string }> = result.skipped ?? [];
          const head = result.task
            ? `Created task ${result.task.id} (PR base: ${result.task.baseBranch}). A human merges the PR.`
            : result.note
              ? result.note
              : `Dry run: nothing created. Re-run with confirm=true to create one PR task.`;
          return text(
            `## Scaffold for workspace ${wsId}\n\n${head}\n` +
            `Skill: ${result.skill}\n` +
            (result.prs?.length ? `PRs: ${result.prs.map((p: { title: string; paths: string[] }) => `${p.title} (${p.paths.join(', ')})`).join('; ')}\n` : '') +
            (skipped.length ? `\nSkipped:\n${skipped.map((i) => `- ${i.itemId}: ${i.reason}`).join('\n')}\n` : '') +
            (result.task ? '' : files.map((f) => `\n### ${f.path} (${f.commitMessage})\n\`\`\`\n${f.content}\n\`\`\``).join('\n')),
          );
        }
        case 'author_spec': {
          // Writes nothing unless confirm: true, and then only creates one task.
          const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
          if (!wsId) throw new Error('workspaceId is required for author_spec');

          const confirm = params.confirm === true;
          const result = await api(`/api/workspaces/${wsId}/onboarding/spec`, {
            method: 'POST',
            body: JSON.stringify({
              answers: params.answers,
              ...(typeof params.owner === 'string' ? { owner: params.owner } : {}),
              ...(typeof params.dryRun === 'boolean' ? { dryRun: params.dryRun } : {}),
              confirm,
            }),
          });
          const warnings: string[] = result.warnings ?? [];
          const head = result.task
            ? `Created task ${result.task.id} (PR base: ${result.task.baseBranch}). A human merges the PR.`
            : `Dry run: nothing created. Re-run with confirm=true to create one PR task.`;
          return text(
            `## Draft spec for workspace ${wsId}\n\n${head}\nPath: ${result.path} (${result.format} format, status: draft)\n` +
            (warnings.length ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : '') +
            (result.task ? '' : `\n\`\`\`markdown\n${result.markdown}\n\`\`\``),
          );
        }
        default:
          throw new Error(`Unknown workspaces action: ${wsAction}. Use one of: list, get, create, update, create_repo, init, readiness, scaffold, author_spec`);
      }
    }

    case 'manage_watched_projects': {

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
      if (!params.workspaceId && !params.repo) throw new Error('workspaceId or repo is required (owner/name)');

      const body: Record<string, unknown> = {};
      if (params.workspaceId !== undefined) {
        // An explicit workspaceId that does not resolve throws, even with repo.
        const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
        if (wsId) body.workspaceId = wsId;
      }
      if (params.repo !== undefined) body.repo = params.repo;
      if (params.ref !== undefined) body.ref = params.ref;
      if (params.workflowFile !== undefined) body.workflowFile = params.workflowFile;
      if (params.inputs !== undefined) body.inputs = params.inputs;
      if (params.force !== undefined) body.force = params.force;

      let data: Record<string, unknown>;
      try {
        data = await api('/api/releases/trigger', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } catch (err) {
        // api() throws on non-2xx: "API error: NNN - <body>". Unwrap the inner
        // error field so the caller sees the GitHub/route error, not the wrapper.
        const raw = err instanceof Error ? err.message : String(err);
        const match = raw.match(/^API error: \d+ - ([\s\S]*)$/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]) as Record<string, unknown>;
            const detail = (parsed.error ?? parsed.message ?? match[1]) as string;
            return errorResult(`Release trigger failed: ${detail}`);
          } catch {
            return errorResult(`Release trigger failed: ${match[1] || raw}`);
          }
        }
        return errorResult(`Release trigger failed: ${raw}`);
      }
      if (data.deduped) {
        return text(
          `Not dispatched: a release for this commit is already in flight (release ${data.releaseId}, repo ${data.repo}).\n` +
            `Pass force: true to dispatch anyway.`,
        );
      }
      if (!data.workflowFile || !data.ref) {
        return errorResult(
          `Release trigger returned an incomplete response (missing workflowFile/ref) — treating as failed, not dispatched. Raw: ${JSON.stringify(data)}`,
        );
      }
      const runLine = data.runUrl
        ? `\nRun: ${data.runUrl} (status: ${data.runStatus ?? 'unknown'}${data.runConclusion ? `, ${data.runConclusion}` : ''})`
        : `\nNo run has surfaced yet — follow: ${data.runsUrl}`;
      return text(
        `Release dispatched on ${data.repo} (${data.workflowFile}, ref=${data.ref}).${runLine}\n` +
          `Note: this opens the release PR — it does not deploy. Prod ships when that PR passes CI and merges.`,
      );
    }

    case 'release_status': {
      if (!params.workspaceId && !params.repo) throw new Error('workspaceId or repo is required (owner/name)');

      const qs = new URLSearchParams();
      if (params.workspaceId) {
        // An explicit workspaceId that does not resolve throws, even with repo.
        const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
        if (wsId) qs.set('workspaceId', wsId);
      }
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
      // Advisory and never folded into ciState (apps/web/src/lib/release/
      // dispatch.ts), so this line is the only place a caller sees it.
      const pmi = data.postMergeIntegration as { state?: string; checks?: string[] } | undefined;
      const pmiLine = pmi?.state
        ? `\nPost-merge integration (advisory): ${pmi.state}` +
          (pmi.state === 'failing' && (pmi.checks ?? []).length ? ` (${(pmi.checks ?? []).join(', ')})` : '')
        : '';
      const prLine = data.openReleasePr
        ? `\nOpen release PR: #${data.openReleasePr.number} — ${data.openReleasePr.url}`
        : '\nNo open release PR.';
      const commits = (data.shippableCommits ?? [])
        .slice(0, 15)
        .map((c: { sha: string; message: string }) => `  - ${c.sha} ${c.message}`)
        .join('\n');
      return text(
        `Release preflight for ${data.repo} (${data.ref} → ${data.prodBranch}):\n` +
          `Strategy: ${data.strategy ?? 'unconfigured'} | CI on ${data.ref}: ${ci} | ${data.aheadBy} commit(s) ahead${pmiLine}${prLine}` +
          (commits ? `\nWould ship:\n${commits}` : '\nNothing to ship.'),
      );
    }

    case 'list_releases': {
      const wsId = await resolveWorkspaceId(api, params.workspaceId, ctx);
      if (!wsId) throw new Error('Cannot resolve workspace. Pass workspaceId in params.');

      const qs = new URLSearchParams({ workspaceId: wsId });
      if (typeof params.missionId === 'string') qs.set('missionId', params.missionId);
      if (typeof params.state === 'string') qs.set('state', params.state);
      if (typeof params.limit === 'number') qs.set('limit', String(params.limit));
      const sinceDays = typeof params.sinceDays === 'number' && params.sinceDays > 0 ? params.sinceDays : null;
      if (sinceDays) qs.set('sinceDays', String(sinceDays));
      qs.set('include', 'tasks');

      const data = await api(`/api/releases?${qs.toString()}`);
      return text(renderReleaseList(data.releases ?? [], sinceDays));
    }

    case 'get_release': {
      if (!params.releaseId || typeof params.releaseId !== 'string') {
        throw new Error('releaseId is required');
      }
      const data = await api(`/api/releases/${params.releaseId}`);
      return text(JSON.stringify(data));
    }

    // ── Agent-Facing Interactive Actions ─────────────────────────────────────

    case 'get_task_messages': {
      requireFullUuid(params.taskId, 'taskId');

      const data = await api(`/api/tasks/${params.taskId}/messages`);
      // `state` is derived server-side (messageDeliveryStatus); `deliveryState`
      // is the stored field, read only as a fallback for an older server.
      const messages: Array<{
        type: string;
        message?: string;
        timestamp: number;
        state?: 'queued' | 'delivered' | 'acknowledged' | 'undelivered';
        deliveryState?: 'pending' | 'delivered' | 'acknowledged';
      }> = data.messages || [];

      if (messages.length === 0) {
        return text(`No messages for task ${params.taskId}. Messages appear when instructions are sent to or responses received from the running agent.`);
      }

      const stateOf = (m: typeof messages[number]) =>
        m.state ?? (m.deliveryState === 'pending' ? 'queued' : m.deliveryState ?? 'queued');
      const TAG: Record<string, string> = {
        queued: '⏳ QUEUED (waits for the agent\'s next turn)',
        delivered: '📨 DELIVERED (in the session, not read yet)',
        acknowledged: '✓ ACKNOWLEDGED (read by the agent)',
        undelivered: '✗ UNDELIVERED (the run ended first)',
      };

      const lines = messages.map((m) => {
        const when = new Date(m.timestamp).toISOString();
        const label = m.type === 'instruction' ? '→ [human→agent]' : '← [agent→human]';
        const deliveryTag = m.type === 'instruction' ? ` ${TAG[stateOf(m)] ?? stateOf(m).toUpperCase()}` : '';
        return `${when} ${label}${deliveryTag}\n  ${m.message ?? '(hidden in a sensitive workspace)'}`;
      });

      const unread = messages.filter(m => m.type === 'instruction' && stateOf(m) !== 'acknowledged');
      const undelivered = unread.filter(m => stateOf(m) === 'undelivered').length;
      const header = undelivered > 0
        ? `⚠️  ${messages.length} message(s) for task ${params.taskId} — ${undelivered} never reached the agent (the run ended first):`
        : unread.length > 0
        ? `${messages.length} message(s) for task ${params.taskId} — ${unread.length} not yet read by the agent:`
        : `${messages.length} message(s) for task ${params.taskId}:`;

      return text(`${header}\n\n${lines.join('\n\n')}`);
    }

    case 'send_agent_message': {
      if (!params.message) throw new Error('taskId and message are required');
      requireFullUuid(params.taskId, 'taskId');

      // Fetch task with workers so we can find the live worker by worker.status,
      // not task.status. task.status stays 'assigned' the entire time a worker is
      // running — it only transitions to 'completed'/'failed' on terminal status —
      // so checking task.status causes false-negatives for tasks that are actively
      // being worked on.
      const task = await api(`/api/tasks/${params.taskId}?include=workers`);
      // Newest first by (createdAt, id), whatever order the API listed them in:
      // with two live rows created in the same instant the pick must not flip.
      const workerTime = (w: any) => { const t = Date.parse(w?.createdAt ?? ''); return Number.isFinite(t) ? t : 0; };
      const allWorkers: any[] = (Array.isArray(task.workers) ? task.workers.slice() : [])
        .sort((a: any, b: any) => workerTime(b) - workerTime(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      // Every terminal status is terminal here, superseded included. 'error' in
      // particular: the check-in route rejects that worker's next PATCH, so a
      // queued message would never be collected. Selecting an errored worker as
      // "the active one" produced a cheerful "queued for delivery on next worker
      // check-in" for a check-in that can never happen.
      const liveWorker = allWorkers.find((w) => !isTerminalWorkerStatus(w.status));
      const erroredWorker = allWorkers.find((w) => w.status === 'error');
      const isUrgent = params.priority === 'urgent';
      // Urgent goes over Pusher, which can still reach a session the runner holds
      // in memory (it restarts an errored session on a follow-up message).
      const activeWorker = liveWorker ?? (isUrgent ? erroredWorker : undefined);
      const workerId = activeWorker?.id;

      if (!workerId) {
        const hint = allWorkers.length === 0
          ? 'Task is still pending — not yet claimed by a worker.'
          : erroredWorker
          ? `Worker ${erroredWorker.id} is in state 'error', so a queued message would never be collected. ` +
            "Retry with priority:'urgent' to attempt immediate delivery to a resident session, or recover the worker."
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

      // Do not restate delivery here: the server owns that claim, and delivery is
      // only confirmed once the agent actually receives the text. get_task_messages
      // shows each message as QUEUED / DELIVERED / ACKNOWLEDGED / UNDELIVERED.
      const stateNote = result.deliveryState === 'pending'
        ? "Queued: it reaches the agent at its next turn boundary. get_task_messages shows when it is DELIVERED and ACKNOWLEDGED (read)."
        : '';
      return text([
        `Message sent to worker ${workerId} (status: ${activeWorker.status}).`,
        result.message || '',
        stateNote,
      ].filter(Boolean).join('\n'));
    }

    // Spec-drift compare (admin/dev only). Two-hop retrieval bridges the prose→code
    // vocabulary gap: query :spec first, extract implementation anchors (file paths,
    // camelCase symbols, PascalCase types, route paths), then issue a SECOND lexical
    // :code query using those anchors. Results are fused with the direct semantic
    // code query. No LLM in core — judging is done by the calling agent reading snippets.
    case 'spec_compare': {

      const feature = (params.feature || params.query) as string | undefined;
      if (!feature) throw new Error('feature (or query) is required');

      const wsId = await ctx.getWorkspaceId();
      if (!wsId) throw new Error('workspaceId is required for spec_compare — connect with ?workspace=<id>');

      const topK = Math.min((params.topK as number) || 5, 20);
      // Reranker passed here too: without it this fallback ranked by age decay
      // while the server-built store ranked by cross-encoder relevance, so the
      // same query got different semantics depending on which path served it.
      const ks =
        ctx.knowledgeStore ?? new PgVectorStore(ctx.embedder ?? null, getVoyageReranker());

      // Step 1: query the doc corpus and direct :code in parallel (prose
      // vocabulary works for prose).
      //
      // This reads `docs`, NOT `spec`. `spec` had no writer anywhere: the
      // per-merged-PR ingest classifies every file as `code` or `docs` and
      // never emits `spec`, and neither does the full-repo ingest. So the
      // spec side of this comparison was permanently empty, and the tool's
      // whole purpose — spotting documented-not-built and
      // shipped-not-documented — could only ever return the code half.
      // `docs` is where `docs/SPEC.md` and every `.md`/`.mdx` land.
      const [specHits, directCodeHits] = await Promise.all([
        ks.query(buildNamespace(wsId, 'docs'), { text: feature, mode: 'hybrid', topK }),
        ks.query(buildNamespace(wsId, 'code'), { text: feature, mode: 'hybrid', topK }),
      ]);

      // Step 2: extract implementation anchors from spec chunks to bridge the vocabulary gap
      const anchors = extractImplementationAnchors(specHits);

      // Step 3: lexical code query using anchors (identifier tokens = high-signal exact matches)
      let anchorCodeHits: QueryResult[] = [];
      if (anchors.length > 0) {
        anchorCodeHits = await ks.query(buildNamespace(wsId, 'code'), {
          text: anchors.join(' '),
          mode: 'lexical',
          topK,
          trackHits: false,
        });
      }

      // Step 4: fuse direct + anchor code results; prefer higher score when ids collide
      const codeById = new Map<string, QueryResult>();
      for (const r of [...anchorCodeHits, ...directCodeHits]) {
        const existing = codeById.get(r.id);
        if (!existing || r.score > existing.score) codeById.set(r.id, r);
      }
      const codeHits = [...codeById.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      const fmt = (hits: QueryResult[]) => hits.length
        ? hits.map((r, i) => `${i + 1}. [${r.score.toFixed(3)}] ${r.sourcePath ?? r.sourceType}\n   ${r.content.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')
        : '   (no matches)';

      const anchorSection = anchors.length > 0
        ? `**Spec→Code bridges** (${anchors.length} anchor(s) extracted from SPEC — used for lexical code retrieval):\n` +
          anchors.slice(0, 10).map(a => `  • ${a}`).join('\n') + '\n\n'
        : `**No implementation anchors found in SPEC** — code evidence below is from semantic search only. ` +
          `Low scores here may indicate inconclusive retrieval rather than absent implementation. ` +
          `Retry with implementation-vocabulary terms (function names, file paths).\n\n`;

      const codeSection = codeHits.length === 0 && anchors.length === 0
        ? `   (retrieval inconclusive — no implementation anchors could be extracted from spec; ` +
          `semantic-only search returned no code matches. Search directly with identifiers such as ` +
          `function names, type names, or file paths for higher-confidence results.)`
        : fmt(codeHits);

      return text(
        `# spec_compare: "${feature}"\n\n` +
        anchorSection +
        `## CODE evidence (what is actually implemented)\n${codeSection}\n\n` +
        `## SPEC evidence (what the spec/docs claim)\n${fmt(specHits)}\n\n` +
        `## How to judge\n` +
        `Scores SURFACE candidates; they do NOT decide. Read the CODE snippets: do they ` +
        `actually implement "${feature}" (a real table/route/impl), or are they only ` +
        `semantic neighbours? Rule one of: IMPLEMENTED · DOCUMENTED-NOT-BUILT · ` +
        `SHIPPED-NOT-DOCUMENTED · CONTRADICTED. The verdict is yours, not the scores'.`
      );
    }

    // Discrepancy ledger reads (§13) — filtered list and single-row evidence
    // read over the spec_discrepancies table Slice 2 writes.
    case 'list_discrepancies': {
      const wsId = params.workspaceId
        ? await resolveWorkspaceId(api, params.workspaceId, ctx)
        : await ctx.getWorkspaceId();
      if (!wsId) throw new Error('workspaceId is required for list_discrepancies — connect with ?workspace=<id> or pass it explicitly');

      const qs = new URLSearchParams({ workspaceId: wsId });
      if (params.direction) qs.set('direction', params.direction as string);
      if (params.status) qs.set('status', params.status as string);
      const data = await api(`/api/discrepancies?${qs}`);
      const rows = data.discrepancies || [];
      if (rows.length === 0) return text('No discrepancies found.');

      const summary = rows.map((r: any) =>
        `- **${r.specPath}** \`${r.assertionId}\` — ${r.direction} / ${r.status}` +
        `${r.promotedMissionId ? ` (promoted → mission ${r.promotedMissionId})` : ''}\n` +
        `  ID: ${r.id}\n  First seen: ${new Date(r.firstSeenAt).toISOString()} · Last checked: ${new Date(r.lastCheckedAt).toISOString()}`
      ).join('\n\n');
      return text(`${rows.length} discrepancy(ies):\n\n${summary}`);
    }

    case 'get_discrepancy': {
      requireFullUuid(params.discrepancyId, 'discrepancyId');
      const data = await api(`/api/discrepancies/${params.discrepancyId}`);
      const d = data.discrepancy;
      const acceptedLine = d.status === 'accepted' && d.acceptedReason ? `\nAccepted reason: ${d.acceptedReason}` : '';
      const promotedLine = d.promotedMissionId ? `\nPromoted mission: ${d.promotedMissionId}` : '';
      return text(
        `**${d.specPath}** \`${d.assertionId}\`\n` +
        `Direction: ${d.direction} · Status: ${d.status}\n` +
        `First seen: ${new Date(d.firstSeenAt).toISOString()} · Last checked: ${new Date(d.lastCheckedAt).toISOString()}` +
        `${acceptedLine}${promotedLine}\n\n` +
        `Evidence (the exact read that produced this verdict):\n${JSON.stringify(d.evidence, null, 2)}`
      );
    }

    case 'manage_providers': {
      const op = params.action as string;
      if (!op || !(PROVIDER_OPS as readonly string[]).includes(op)) {
        throw new Error(`action must be one of: ${PROVIDER_OPS.join(', ')}`);
      }
      const writes = op === 'set' || op === 'delete';
      const scope = typeof params.scope === 'string' ? params.scope : writes ? defaultProvidersScope(ctx) : undefined;
      if (scope !== undefined && !['team', 'workspace', 'mine'].includes(scope)) {
        throw new Error("scope must be 'team', 'workspace' or 'mine'");
      }
      if ((writes || op === 'set_policy') && ctx.principal === 'task_token') {
        return errorResult(scope === 'mine' ? PROVIDER_MINE_TASK_TOKEN_REFUSAL : PROVIDER_TASK_TOKEN_READ_ONLY);
      }
      if (tokenScopes == null && providersNeedsAdmin(op as ProvidersOp, scope)) {
        const level = await ctx.getLevel();
        if (level !== 'admin') {
          return forbiddenResult(`manage_providers action '${op}'${op === 'set_policy' ? '' : ` with scope ${scope}`} requires admin token level (scope mine is your own, at worker level)`, level, 'admin');
        }
      }
      if (writes && scope === 'mine' && ctx.principal === 'key') return errorResult(PROVIDER_MINE_KEY_REFUSAL);
      const wsId = params.workspaceId
        ? await resolveWorkspaceId(api, params.workspaceId, ctx)
        : scope === 'workspace' || op === 'list' || op === 'explain' ? await ctx.getWorkspaceId() : null;
      if (scope === 'workspace' && !wsId) throw new Error('workspaceId is required with scope workspace');
      return text(await handleProvidersAction(api, op as ProvidersOp, params, wsId, scope));
    }

    case 'manage_experiments': {
      const op = params.action as string;
      const ops = [...EXPERIMENT_READ_OPS, ...EXPERIMENT_WRITE_OPS] as readonly string[];
      if (!op || !ops.includes(op)) {
        throw new Error(`action must be one of: ${ops.join(', ')}`);
      }
      if (tokenScopes == null && (EXPERIMENT_WRITE_OPS as readonly string[]).includes(op)) {
        const level = await ctx.getLevel();
        if (level !== 'admin') {
          return forbiddenResult(`manage_experiments action '${op}' requires admin token level`, level, 'admin');
        }
      }

      const wsId = params.workspaceId
        ? await resolveWorkspaceId(api, params.workspaceId, ctx)
        : await ctx.getWorkspaceId();
      const qs = new URLSearchParams();
      if (wsId) qs.set('workspaceId', wsId);
      const q = qs.toString() ? `?${qs}` : '';

      const pct = (v: number | null | undefined) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
      const line = (e: any) =>
        `- ${e.key} [${e.status}] "${e.title}" — treatment ${pct(e.treatmentFraction)}, policy v${e.policyVersion}, ` +
        `visibility ${e.visibility}${e.startedAt ? `, started ${e.startedAt}` : ''} (id: ${e.id})`;

      // Enrolment health findings (packages/core/experiment-health.ts), indented under the experiment.
      const healthLines = (findings: any[] | null | undefined) =>
        (findings ?? []).map((f: any) => `    ⚠ ${f.severity === 'critical' ? 'CRITICAL ' : ''}${f.code}: ${f.detail}`).join('\n');

      if (op === 'list') {
        const data = await api(`/api/experiments${q}`);
        const list = (data?.experiments ?? []) as any[];
        if (list.length === 0) {
          return text('No experiments visible to this token on this team.' + (data?.canManage ? ' Create one with manage_experiments action=create.' : ''));
        }
        const health = (data?.health ?? {}) as Record<string, any[]>;
        const rows = list.map((e: any) => {
          const h = healthLines(health[e.id]);
          return h ? `${line(e)}\n${h}` : line(e);
        });
        return text(`Experiments (${list.length}):\n${rows.join('\n')}`);
      }

      if (op === 'create') {
        if (!params.key || !params.title) throw new Error('key and title are required for create');
        const body: Record<string, unknown> = { key: params.key, title: params.title };
        for (const f of ['kind', 'hypothesis', 'treatmentFraction', 'config', 'visibility'] as const) {
          if (params[f] !== undefined) body[f] = params[f];
        }
        const data = await api(`/api/experiments${q}`, { method: 'POST', body: JSON.stringify(body) });
        return text(
          `Created draft experiment:\n${line(data.experiment)}\n\n` +
          `Nothing enrolls until you run manage_experiments action=start experimentId=${data.experiment.id}.`
        );
      }

      const id = requireFullUuid(params.experimentId, 'experimentId');

      if (op === 'get') {
        const data = await api(`/api/experiments/${id}${q}`);
        const e = data.experiment;
        return text(
          `${line(e)}\n` +
          (e.hypothesis ? `Hypothesis: ${e.hypothesis}\n` : '') +
          `Config: ${JSON.stringify(e.config)}\n` +
          (e.decision ? `Decision: ${e.decision}\n` : '')
        );
      }

      if (op === 'readout') {
        const rq = new URLSearchParams(qs);
        if (params.policyVersion !== undefined) rq.set('policyVersion', String(params.policyVersion));
        const data = await api(`/api/experiments/${id}/readout${rq.toString() ? `?${rq}` : ''}`);
        const r = data.readout;
        const h = healthLines(data.health);
        const healthBlock = h ? `Enrolment health:\n${h}\n` : '';
        const arm = (name: string, a: any) =>
          `  ${name}: n=${a.n} resolved (${a.assigned} assigned, ${a.pending} pending), clean ${pct(a.cleanRate)} ` +
          `[95% ${pct(a.cleanInterval?.lower)}–${pct(a.cleanInterval?.upper)}], served ${pct(a.servedRate)}`;
        const d = r.difference;
        const verdict = r.verdict === 'insufficient_n'
          ? `insufficient data — fewer than ${r.minSamplePerArm} resolved tasks in at least one arm`
          : r.verdict.replace(/_/g, ' ');
        return text(
          `Readout for ${data.experiment.key} (policy v${data.policyVersion}, intent-to-treat):\n` +
          `${arm('control', r.control)}\n${arm('treatment', r.treatment)}\n` +
          `  difference (treatment − control): ${d ? `${pct(d.difference)} [95% ${pct(d.lower)} to ${pct(d.upper)}]` : 'n/a'}\n` +
          `  verdict: ${verdict}\n` +
          (r.inheritedExcluded ? `  ${r.inheritedExcluded} inherited attempt rows excluded from the unit count\n` : '') +
          healthBlock
        );
      }

      let patch: Record<string, unknown>;
      if (op === 'start') patch = { status: 'running' };
      else if (op === 'pause') patch = { status: 'paused' };
      else if (op === 'conclude') {
        if (typeof params.decision !== 'string' || !params.decision.trim()) {
          throw new Error('decision is required for conclude: what was decided and why');
        }
        patch = { status: 'concluded', decision: params.decision };
      } else {
        patch = {};
        for (const f of ['title', 'hypothesis', 'treatmentFraction', 'config', 'visibility'] as const) {
          if (params[f] !== undefined) patch[f] = params[f];
        }
        if (Object.keys(patch).length === 0) {
          throw new Error('update needs at least one of: title, hypothesis, treatmentFraction, config, visibility');
        }
      }
      const data = await api(`/api/experiments/${id}${q}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const note =
        op === 'start' ? '\nFrom the next claim, eligible tasks are randomly split between control and treatment (the claim-side cache refreshes within a minute).'
        : op === 'pause' ? '\nNew enrolment stops within a minute; existing assignments are kept.'
        : op === 'conclude' ? '\nConcluded is final.'
        : data.policyVersionBumped ? `\npolicyVersion bumped to v${data.experiment.policyVersion}: new draws are analysed separately from earlier ones.`
        : '';
      return text(`Experiment updated:\n${line(data.experiment)}${note}`);
    }

    case 'manage_evidence_backends': {
      const op = params.action as string;
      const ops = ['list', 'get', 'create', 'update', 'delete', 'verify'];
      if (!op || !ops.includes(op)) {
        throw new Error(`action must be one of: ${ops.join(', ')}`);
      }

      const wsId = params.workspaceId
        ? await resolveWorkspaceId(api, params.workspaceId, ctx)
        : null;
      const q = wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : '';

      const bytes = (n: number) => (n >= 1048576 ? `${Math.round(n / 1048576)} MiB` : `${Math.round(n / 1024)} KiB`);
      const line = (b: any) =>
        `- ${b.workspaceId ? `workspace ${b.workspaceId}` : 'team default'}: ${b.provider}` +
        `${b.provider === 'buildd_default' ? '' : ` bucket=${b.bucket}${b.endpoint ? ` endpoint=${b.endpoint}` : ''}`}` +
        ` prefix=${b.prefix} sse=${b.sse} retention=${b.retentionDays}d cap=${bytes(b.maxBytesPerTask)}/task` +
        ` [${b.status}${b.lastVerifiedAt ? `, verified ${b.lastVerifiedAt}` : ''}]${b.lastError ? ` (${b.lastError})` : ''} (id: ${b.id})`;
      const verification = (v: any) => {
        if (!v) return '';
        const head = v.status === 'ok' ? 'Verified: ok.' : `Verification FAILING: ${v.error}`;
        const warns = (v.warnings ?? []).map((w: string) => `\nWarning: ${w}`).join('');
        return `\n${head}${warns}`;
      };

      if (op === 'list') {
        const data = await api(`/api/evidence-backends${q}`);
        const list = (data?.backends ?? []) as any[];
        if (list.length === 0) {
          return text('No evidence backends configured: run evidence goes to the buildd-managed bucket. Configure one with manage_evidence_backends action=create.');
        }
        return text(`Evidence backends (${list.length}):\n${list.map(line).join('\n')}`);
      }

      if (op === 'create') {
        if (!params.provider) throw new Error('provider is required for create');
        const body: Record<string, unknown> = { provider: params.provider };
        if (wsId) body.workspaceId = wsId;
        for (const f of ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'sse', 'kmsKeyId', 'retentionDays', 'maxBytesPerTask', 'credentials'] as const) {
          if (params[f] !== undefined) body[f] = params[f];
        }
        const data = await api('/api/evidence-backends', { method: 'POST', body: JSON.stringify(body) });
        return text(`Created evidence backend:\n${line(data.backend)}${verification(data.verification)}`);
      }

      const id = requireFullUuid(params.backendId, 'backendId');

      if (op === 'get') {
        const data = await api(`/api/evidence-backends/${id}${q}`);
        return text(`${line(data.backend)}\nCredential: ${data.backend.hasCredential ? 'set' : 'none'}`);
      }

      if (op === 'verify') {
        const data = await api(`/api/evidence-backends/${id}/verify${q}`, { method: 'POST' });
        return text(`Probe finished at ${data.verifiedAt}.${verification(data)}`);
      }

      if (op === 'delete') {
        await api(`/api/evidence-backends/${id}${q}`, { method: 'DELETE' });
        return text(`Evidence backend ${id} deleted. Its credential was removed; runs fall back to the next backend in precedence.`);
      }

      const patch: Record<string, unknown> = {};
      for (const f of ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'sse', 'kmsKeyId', 'retentionDays', 'maxBytesPerTask', 'credentials'] as const) {
        if (params[f] !== undefined) patch[f] = params[f];
      }
      if (Object.keys(patch).length === 0) {
        throw new Error('update needs at least one of: endpoint, region, bucket, prefix, forcePathStyle, sse, kmsKeyId, retentionDays, maxBytesPerTask, credentials');
      }
      const data = await api(`/api/evidence-backends/${id}${q}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return text(`Evidence backend updated:\n${line(data.backend)}${verification(data.verification)}`);
    }

    case 'manage_model_tiers': {

      const wsId = params.workspaceId
        ? await resolveWorkspaceId(api, params.workspaceId, ctx)
        : await ctx.getWorkspaceId();

      const tierAction = params.action as 'list' | 'set' | 'delete' | 'policy' | 'set_policy' | 'adopt' | 'model';
      if (!tierAction || !['list', 'set', 'delete', 'policy', 'set_policy', 'adopt', 'model'].includes(tierAction)) {
        throw new Error('action must be "list", "set", "delete", "policy", "set_policy", "adopt", or "model"');
      }

      if (tierAction === 'policy' || tierAction === 'set_policy' || tierAction === 'adopt' || tierAction === 'model') {
        return text(await handleModelUpgradeAction(api, tierAction, params, ctx));
      }

      if (tierAction === 'list') {
        const qs = new URLSearchParams();
        if (wsId) qs.set('workspaceId', wsId);
        const data = await api(`/api/model-tiers?${qs}`);
        type ListedEntry = { model: string; provider: string; source?: string; surface?: string };
        const tiers = data as Record<string, ListedEntry & { bySurface?: Record<string, ListedEntry> }>;
        const describe = (e: ListedEntry) => `${e.model} (provider: ${e.provider}, source: ${e.source})`;
        return text(
          `Model tier registry (effective):\n\n` +
          Object.entries(tiers).map(([tier, entry]) => {
            const by = entry.bySurface;
            const split = by && Object.values(by).some(e => e?.surface);
            if (!split) return `  ${tier}: ${describe(entry)}`;
            return `  ${tier}:\n` + Object.entries(by!).map(([s, e]) =>
              `    ${s}: ${describe(e)}${e.surface ? '' : ' [shared row]'}`
            ).join('\n');
          }).join('\n') +
          `\n\nChange a tier with manage_model_tiers action=set tier=<tier> model=<id> [surface=agent|chat].\n` +
          `See why each tier runs its model, and whether a newer certified one is withheld, with action=policy.\n` +
          `A registry update takes effect on the next claim cycle (within 60s cache TTL).\n` +
          `NOTE: For provider='openrouter', the runner-side backend is not yet implemented — dispatch will fail with a clear error.`
        );
      }

      if (tierAction === 'set') {
        const tier = params.tier as string;
        const provider = params.provider as string;
        const model = params.model as string;
        if (!tier || !TIERS.includes(tier as Tier)) {
          throw new Error(`tier must be one of ${TIERS.join(', ')}`);
        }
        if (!provider || !['anthropic', 'openai', 'openai-codex', 'openrouter'].includes(provider)) {
          throw new Error('provider must be "anthropic", "openai", "openai-codex", or "openrouter"');
        }
        if (!model) throw new Error('model is required for set');
        const surface = parseTierSurfaceParam(params.surface);

        const body: Record<string, unknown> = { tier, provider, model };
        if (surface) body.surface = surface;
        if (wsId) body.workspaceId = wsId;
        if (params.defaultEffort) body.defaultEffort = params.defaultEffort;
        if (typeof params.defaultMaxTurns === 'number') body.defaultMaxTurns = params.defaultMaxTurns;

        await api('/api/model-tiers', { method: 'POST', body: JSON.stringify(body) });
        const scope = (wsId ? `workspace ${wsId}` : 'team-wide') + (surface ? `, ${surface} only` : ', agent and chat');
        return text(
          `Model tier updated: ${tier} → ${model} (provider: ${provider}, scope: ${scope}).\n` +
          `Takes effect on the next claim cycle (within 60s cache TTL).\n` +
          `Already-queued tasks will pick up this model on their next claim attempt.`
        );
      }

      if (tierAction === 'delete') {
        const tier = params.tier as string;
        if (!tier || !TIERS.includes(tier as Tier)) {
          throw new Error(`tier must be one of ${TIERS.join(', ')}`);
        }
        const surface = parseTierSurfaceParam(params.surface);
        const qs = new URLSearchParams({ tier });
        if (surface) qs.set('surface', surface);
        if (wsId) qs.set('workspaceId', wsId);

        await api(`/api/model-tiers?${qs}`, { method: 'DELETE' });
        const scope = (wsId ? `workspace override` : `team default`) + (surface ? ` (${surface})` : '');
        return text(
          `Model tier ${scope} for "${tier}" removed. The resolution chain will now fall back to the next level.`
        );
      }

      throw new Error('Unknown manage_model_tiers action');
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ── Memory Action Handler ────────────────────────────────────────────────────

import { MemoryStore, type MemoryRecord } from './memory-store';
import { MEMORY_CONTEXT_LIMIT, renderMemoryContext } from './memory-context';
import type { KnowledgeStore, QueryResult, Embedder, Corpus, UpsertChunk, UpsertResult, EntityRef, RelationRef, EntityBinding } from './knowledge-store/types';
import { PgVectorStore, buildNamespace } from './knowledge-store/pg-vector-store';
import { getVoyageReranker } from './knowledge-store/reranker';
import { buildAuthoringPriorWork } from './prior-work-render';
import { keepOwnProjectMemoryHits, memoryOverfetchTopK, type MemoryHitScope } from './memory-hit-scope';
import { retrieveMemory, recordMemoryPulls, type MemoryCaller, type MemoryLedgerWriter, type MemoryStoreSearcher } from './memory-retrieval';
import { memoryStateOf, type MemoryProvenance } from './memory-candidates';
import {
  buildMemoryIndex,
  isMemoryIndexEnabled,
  memoryIndexTokenBudget,
  parseMemoryIdRef,
  readMemoryIndexEntries,
  type MemoryIndexEntry,
} from './memory-claim-index';
import {
  fallbackLearnJudgement,
  FALLBACK_UPDATE_JUDGEMENT,
  KEEP_NOT_DURABLE_TAG,
  type LearnJudgement,
  type MemoryDecider,
  type MemoryDecisionType,
  type UpdateJudgement,
} from './memory-decisions';
import { findNearDuplicates, findDecayedUnused, archiveChunks } from './knowledge-store/consolidation';
import {
  buildTaskCard,
  buildSessionCard,
  buildPrCard,
  buildArtifactCard,
  buildPlanCard,
  buildInitiativeCard,
  renderPlanText,
  truncate,
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
  // memory and initiative are team-scoped (initiatives span the whole team);
  // every other corpus is workspace-scoped.
  if (corpus === 'memory' || corpus === 'initiative') {
    return ctx.teamId ? buildNamespace(ctx.teamId, corpus) : null;
  }
  return ctx.workspaceId ? buildNamespace(ctx.workspaceId, corpus) : null;
}

function formatMemoryFreshness(r: { createdAt?: Date | null; isCurrent?: boolean }): string {
  const superseded = r.isCurrent === false ? 'true' : 'false';
  if (!r.createdAt) return `\n[superseded: ${superseded}]`;
  const ageMs = Date.now() - r.createdAt.getTime();
  const days = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  const age = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `\n[savedAt: ${age} · superseded: ${superseded}]`;
}

/** Render a Date as a compact relative age string. */
function relativeAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1d ago' : `${days}d ago`;
}

/**
 * Parse the source path from a chunk ID (which for file corpora is "path#startLine").
 * Returns null when the ID does not have this structure.
 */
function parseSourcePath(id: string): string | null {
  const hashIdx = id.lastIndexOf('#');
  if (hashIdx <= 0) return null;
  const path = id.slice(0, hashIdx);
  const line = id.slice(hashIdx + 1);
  if (!path || !/^\d+$/.test(line)) return null;
  return `${path}#L${line}`;
}

/**
 * Format a single QueryResult into a human-readable block showing corpus, path,
 * timestamps, score breakdown, and lifecycle state.
 * Memory corpus keeps the legacy savedAt/superseded format for backward compat.
 */
function formatKnowledgeResult(
  r: import('./knowledge-store/types').QueryResult,
  index: number,
): string {
  const typeTag = r.metadata?.type ? `[${r.metadata.type}] ` : '';

  if (r.corpus === 'memory') {
    // Memory corpus: no file path, use existing savedAt/superseded format
    const freshness = formatMemoryFreshness(r);
    const linkOrType = r.sourceUrl ? `[source](${r.sourceUrl})` : r.sourceType;
    return `### ${index + 1}. ${typeTag}${linkOrType}\n**Score:** ${r.score.toFixed(4)}${freshness}\n\n${r.content}`;
  }

  // Non-memory: show corpus · path · timestamps · score breakdown
  const path = r.sourcePath ?? parseSourcePath(r.id);
  const pathStr = path ? `\`${path}\`` : r.sourceType;
  const urlSuffix = r.sourceUrl ? ` [↗](${r.sourceUrl})` : '';
  const header = `### ${index + 1}. ${typeTag}${r.corpus} · ${pathStr}${urlSuffix}`;

  const sb = r.scoreBreakdown;
  let scoreStr = `**Score:** ${r.score.toFixed(4)}`;
  if (sb) {
    const parts: string[] = [];
    if (sb.dense !== undefined) parts.push(`dense: ${sb.dense.toFixed(3)}`);
    if (sb.lexical !== undefined) parts.push(`lex: ${sb.lexical.toFixed(3)}`);
    if (sb.rrf !== undefined) parts.push(`rrf: ${sb.rrf.toFixed(4)}`);
    if (sb.rerank !== undefined) parts.push(`rerank: ${sb.rerank.toFixed(3)}`);
    if (parts.length) scoreStr += ` (${parts.join(' · ')})`;
  }

  const metaParts: string[] = [scoreStr];
  if (r.sourceTs) metaParts.push(`committed ${relativeAge(r.sourceTs)}`);
  if (r.updatedAt) metaParts.push(`ingested ${relativeAge(r.updatedAt)}`);
  if (r.isCurrent === false) {
    metaParts.push(r.supersededBy ? `⚠ superseded by \`${r.supersededBy}\`` : '⚠ superseded');
  }

  return `${header}\n${metaParts.join(' · ')}\n\n${r.content}`;
}

// ── Shared memory action context type ────────────────────────────────────────

type MemoryActionCtx = {
  project?: string;
  workerId?: string;
  /** The caller's task, when known; attributes ledger rows. */
  taskId?: string;
  workspaceId?: string;
  teamId?: string;
  knowledgeStore?: KnowledgeStore;
  embedder?: Embedder | null;
  api?: ApiFn;
  /** Workspace is dataClass='sensitive' — memory reads/writes are blocked. */
  isSensitive?: boolean;
  /**
   * Same-team workspaces whose docs corpus this caller may also read, already
   * authorised by the web layer (link config, team, sensitivity, token
   * restriction, account reach). Core never decides access: it only widens the
   * docs corpus over exactly these ids, and never code/task/memory.
   */
  linkedDocsWorkspaceIds?: string[];
  /**
   * The web layer's opt-in GitHub repo check for the person behind an OAuth
   * session (apps/web/src/lib/member-repo-access.ts). Returns a refusal
   * message when this caller may not read the `code` corpus, else null.
   * Omitted (API keys, runners): code reads as before. Core never decides.
   */
  codeAccessRefusal?: () => Promise<string | null>;
  /** Memory use ledger writer for reads; default fire-and-forget. See ActionContext. */
  memoryLedger?: MemoryLedgerWriter;
  /** Jev decisions on writes (keep, type, update). Omitted: today's rules. See ActionContext. */
  memoryDecider?: MemoryDecider;
  /**
   * Whether new writes land as candidates (workspace flag
   * `memoryCandidateWrites`). Omitted: read from the workspace, off on any
   * failure. See ./memory-candidates.
   */
  memoryCandidateWrites?: boolean;
  /** Where this write came from. Omitted: a `learn` by the caller's task. */
  memoryProvenance?: MemoryProvenance;
  /**
   * Any near-duplicate (the conflict band and up) means "already known":
   * write nothing, supersede nothing. For background extraction, which must
   * never replace a memory an agent wrote.
   */
  memoryDedupeOnly?: boolean;
};

/** Whether this write lands as a candidate. Never throws; off on any doubt. */
async function candidateWritesOn(ctx: MemoryActionCtx): Promise<boolean> {
  if (typeof ctx.memoryCandidateWrites === 'boolean') return ctx.memoryCandidateWrites;
  // Unit tests never reach a database through a default.
  if (!ctx.workspaceId || process.env.NODE_ENV === 'test') return false;
  try {
    const { resolveMemoryCandidateWrites } = await import('./memory-scope');
    return await resolveMemoryCandidateWrites(ctx.workspaceId);
  } catch {
    return false;
  }
}

/**
 * The lifecycle fields for a new row. Empty (so the row is active, exactly as
 * before) unless the workspace flag is on.
 */
async function candidateWriteFields(ctx: MemoryActionCtx): Promise<{
  state?: 'candidate'; sourceKind?: MemoryProvenance['kind']; sourceId?: string; external?: boolean;
}> {
  if (!(await candidateWritesOn(ctx))) return {};
  const prov = ctx.memoryProvenance;
  const sourceId = prov?.id ?? ctx.taskId ?? undefined;
  return {
    state: 'candidate',
    sourceKind: prov?.kind ?? 'learn',
    ...(sourceId ? { sourceId } : {}),
    ...(prov?.external ? { external: true } : {}),
  };
}

/**
 * Where a candidate write's supersedes go. An ACTIVE target is deferred to
 * the candidate's `pendingSupersedes` and superseded only when the candidate
 * is promoted, so a candidate never hides an active memory from push. Any
 * other state is superseded now. Not a candidate write: everything now, as
 * before. A failed lookup defers everything (never hide on a doubt).
 */
async function splitSupersedes(
  mc: MemoryStore,
  ids: string[] | undefined,
  candidate: boolean,
): Promise<{ now: string[] | undefined; pending: string[]; rows: Map<string, MemoryRecordShape> }> {
  const rows = new Map<string, MemoryRecordShape>();
  if (!ids || ids.length === 0) return { now: ids, pending: [], rows };
  if (!candidate) return { now: ids, pending: [], rows };
  try {
    for (const m of (await mc.batch(ids)).memories as MemoryRecordShape[]) rows.set(m.id, m);
  } catch {
    return { now: undefined, pending: [...ids], rows };
  }
  const now = ids.filter(id => rows.has(id) && memoryStateOf(rows.get(id)!) !== 'active');
  const pending = ids.filter(id => !now.includes(id));
  return { now: now.length > 0 ? now : undefined, pending, rows };
}

/**
 * The corroboration link: set ONLY for the automatic near-duplicate match,
 * when that row is an own-project, non-external candidate or active memory
 * from another episode. Promotion re-checks all of it (and that the tasks
 * differ) in SQL; this only refuses what it can already see.
 */
function corroborationLink(
  match: MemoryRecordShape | undefined,
  lifecycle: Awaited<ReturnType<typeof candidateWriteFields>>,
  ctx: MemoryActionCtx,
): string | undefined {
  if (!match || lifecycle.state !== 'candidate' || lifecycle.sourceKind !== 'learn' || lifecycle.external) return undefined;
  if (!isOwnMemory(match, ctx) || match.external) return undefined;
  const st = memoryStateOf(match);
  if (st !== 'candidate' && st !== 'active') return undefined;
  if (lifecycle.sourceId && match.sourceId && lifecycle.sourceId === match.sourceId) return undefined;
  return match.id;
}

const CANDIDATE_NOTE = ' | saved as a candidate: recall with includeCandidates=true finds it; it is shown at claim time once its task\'s PR merges or another task records the same lesson';

/**
 * Start the keep/type judgement for a write. Bounded by the decider's own
 * deadline (5s) and never rejects; no decider, no team or a sensitive
 * workspace is today's behaviour.
 */
function judgeMemoryWrite(ctx: MemoryActionCtx, title: string, content: string, type: MemoryDecisionType): Promise<LearnJudgement> {
  if (!ctx.memoryDecider || !ctx.teamId || ctx.isSensitive) return Promise.resolve(fallbackLearnJudgement(type));
  return ctx.memoryDecider
    .judgeLearn({ scope: { teamId: ctx.teamId, workspaceId: ctx.workspaceId ?? null }, title, content, type })
    .catch(() => fallbackLearnJudgement(type));
}

/** Reply suffix for what the keep/type decisions changed. Empty when nothing did. */
function learnJudgementNote(j: LearnJudgement): string {
  const parts: string[] = [];
  if (j.type.overridden) parts.push(`type set to ${j.type.type}`);
  if (j.keep.flag) parts.push(`tagged ${KEEP_NOT_DURABLE_TAG}: reads as a task summary, not a durable lesson`);
  return parts.length ? ` | ${parts.join(' | ')}` : '';
}

const unionStrings = (...lists: Array<readonly string[] | null | undefined>): string[] =>
  [...new Set(lists.flatMap(l => l ?? []).filter((v): v is string => typeof v === 'string'))];

// ── Memory project scoping ───────────────────────────────────────────────────
//
// Invariant: memory surfaced to an agent comes only from the requesting
// workspace, never from a sensitive one. The store and the `{teamId}:memory`
// namespace are team-wide; the only thing separating one workspace's memories
// from another's is the project key, and `ctx.project` is that key as the
// server resolved it for this connection. Callers never choose it: a project
// named in params is refused, and no key means no memory.

const NO_MEMORY_SCOPE = 'no memory scope for this workspace';

/** The caller's own project key, or an error when the caller named another one or has none. */
function ownMemoryProject(ctx: MemoryActionCtx, requested?: unknown): { project: string } | { error: string } {
  const own = normalizeProject(ctx.project);
  if (!own) return { error: NO_MEMORY_SCOPE };
  if (typeof requested === 'string' && requested.trim() !== '' && normalizeProject(requested) !== own) {
    return { error: `project "${requested}" is not this workspace's — memory is scoped to the calling workspace` };
  }
  return { project: own };
}

/** Whether a stored memory belongs to the caller's workspace. */
function isOwnMemory(m: { project?: string | null }, ctx: MemoryActionCtx): boolean {
  const own = normalizeProject(ctx.project);
  return !!own && normalizeProject(m.project) === own;
}

/**
 * Narrow `{teamId}:memory` hits to the caller's project, by the shared rule in
 * ./memory-hit-scope (the memories table decides, not chunk metadata; a hit
 * with no backing row, or a row with no project, is dropped).
 */
async function ownMemoryHits<T extends { id: string; metadata?: Record<string, unknown> | null }>(
  mc: MemoryStore | null,
  ctx: MemoryActionCtx,
  hits: T[],
): Promise<T[]> {
  if (!mc) return [];
  return keepOwnProjectMemoryHits(hits, { project: ctx.project ?? null, lookup: ids => mc.batch(ids) });
}

/** The caller's memory scope for retrieveMemory, or null (no memory) with no store. */
function ownMemoryScope(mc: MemoryStore | null, ctx: MemoryActionCtx): MemoryHitScope | null {
  return mc ? { project: ctx.project ?? null, lookup: ids => mc.batch(ids) } : null;
}

/**
 * Narrow explicit `supersedes` ids to the caller's own project memories, by the
 * same rule as reads. The index flips whatever ids it is given across the whole
 * team namespace, so a foreign id and a missing id must both drop out here, and
 * identically: the superseded count in the reply then says nothing about ids
 * outside the caller's project. A failed lookup supersedes nothing.
 */
async function ownSupersedes(
  mc: MemoryStore | null,
  ctx: MemoryActionCtx,
  ids: string[] | undefined,
): Promise<string[] | undefined> {
  if (!ids || ids.length === 0) return undefined;
  const own = await ownMemoryHits(mc, ctx, ids.map(id => ({ id }))).catch(() => []);
  return own.length > 0 ? own.map(h => h.id) : undefined;
}

/**
 * Extracts implementation anchors from spec chunks for two-hop code retrieval.
 * Captures file paths, route paths, camelCase symbols, and PascalCase types —
 * the identifiers spec docs use to reference implementing code. These anchors
 * bridge the prose→identifier vocabulary gap when querying the :code namespace
 * with lexical search.
 */
type AnchorKind = 'symbol' | 'path' | 'route';

/**
 * Max anchors sent to the second-hop lexical query. Raised from 20: at 20 the cap
 * was binding on ~80% of candidates (see the ranking note below), so the limit
 * itself was suppressing recall rather than controlling query cost.
 */
const ANCHOR_LIMIT = 40;

function extractImplementationAnchors(chunks: QueryResult[]): string[] {
  const combined = chunks.map(r => r.content).join('\n');
  const anchors = new Set<string>();
  const kind = new Map<string, AnchorKind>();

  // File paths: apps/* and packages/*
  for (const m of combined.matchAll(/\b(?:apps|packages)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|json|sql|md|mdx)\b/g)) {
    anchors.add(m[0]);
    kind.set(m[0], 'path');
  }

  // Route paths: /api/...
  for (const m of combined.matchAll(/\/api\/[a-zA-Z0-9/[\]_-]+/g)) {
    anchors.add(m[0]);
    kind.set(m[0], 'route');
  }

  // camelCase symbols (function/variable names): lowercase start, uppercase within, ≥6 chars
  for (const m of combined.matchAll(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g)) {
    if (m[0].length >= 6) { anchors.add(m[0]); kind.set(m[0], 'symbol'); }
  }

  // PascalCase types/classes/interfaces: uppercase start, ≥6 chars
  for (const m of combined.matchAll(/\b[A-Z][a-z][a-zA-Z0-9]{4,}\b/g)) {
    anchors.add(m[0]);
    kind.set(m[0], 'symbol');
  }

  // Rank before truncating. Previously this returned insertion order, which is
  // pass order: every file path, then every /api/ route, then camelCase, then
  // PascalCase. Measured over this repo's own design docs there are ~97 candidates
  // per call against a 20-slot cap, so paths and route strings routinely consumed
  // the whole budget and PascalCase types were dropped structurally — even though
  // the second hop is a lexical identifier query where symbols are the high-signal
  // terms. Symbols now rank ahead of paths, and paths ahead of bare route strings.
  const RANK: Record<AnchorKind, number> = { symbol: 0, path: 1, route: 2 };
  const ranked = [...anchors].sort((a, b) => {
    const byKind = RANK[kind.get(a) ?? 'route'] - RANK[kind.get(b) ?? 'route'];
    if (byKind !== 0) return byKind;
    // Within a kind, prefer more specific (longer) anchors.
    if (b.length !== a.length) return b.length - a.length;
    return a.localeCompare(b);
  });

  return ranked.slice(0, ANCHOR_LIMIT);
}

/**
 * Heuristic: short queries without whitespace (IDs, symbol names, error codes)
 * are better served by lexical search. Natural-language queries use hybrid.
 */
function chooseModeForQuery(query: string): 'lexical' | 'hybrid' {
  const trimmed = query.trim();
  if (trimmed.length <= 20 && !/\s/.test(trimmed)) return 'lexical';
  return 'hybrid';
}

/**
 * `recall`/`query_knowledge` `type` and `files` filters. The tool schemas have
 * advertised these since the knowledge-tool-surface spec shipped, but nothing
 * ever read them — a caller passing type/files got an unfiltered result set
 * with no indication the filter was silently ignored.
 *
 * `type` matches `metadata.type` (set by `learn`/save on memory-corpus chunks;
 * absent elsewhere, so the filter naturally excludes non-memory corpora).
 * `files` matches against `sourcePath` or `metadata.files` (set on memory
 * chunks), either side treated as a path or a directory prefix of the other —
 * a caller narrowing to `packages/core/` should hit a chunk filed under
 * `packages/core/mcp-tools.ts`, and vice versa.
 */
/**
 * True when `prefix` equals `path` or names a directory containing it, on a
 * path-segment boundary — `packages/core` covers `packages/core/x.ts` but not
 * `packages/core-utils/x.ts`.
 */
function isPathOrDirPrefix(prefix: string, path: string): boolean {
  if (!prefix) return false;
  if (path === prefix) return true;
  const dir = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(dir);
}

function matchesRecallFilters(
  r: QueryResult,
  params: { type?: string; files?: string[] },
): boolean {
  if (params.type && r.metadata?.type !== params.type) return false;
  if (params.files && params.files.length > 0) {
    const candidates: string[] = [];
    if (r.sourcePath) candidates.push(r.sourcePath);
    if (Array.isArray(r.metadata?.files)) {
      candidates.push(...(r.metadata.files as unknown[]).filter((f): f is string => typeof f === 'string'));
    }
    const hit = params.files.some(f => candidates.some(p => isPathOrDirPrefix(f, p) || isPathOrDirPrefix(p, f)));
    if (!hit) return false;
  }
  return true;
}

interface CorpusFailure {
  corpus: Corpus;
  reason: string;
}

/** Render a "N corpora failed: ..." suffix, or '' when nothing failed. */
function formatCorpusFailures(failures: CorpusFailure[]): string {
  if (failures.length === 0) return '';
  const list = failures.map(f => `${f.corpus} (${f.reason})`).join(', ');
  return `\n\n(${failures.length} ${failures.length === 1 ? 'corpus' : 'corpora'} failed: ${list})`;
}

/**
 * Query one corpus namespace. For `docs`, also query each linked workspace's
 * docs namespace and fuse by rank (RRF, k=60 as elsewhere; raw scores are not
 * comparable across namespaces). A linked workspace failing is dropped — it is
 * an add-on, not the caller's own corpus; the own namespace still throws.
 */
async function queryCorpus(
  ks: KnowledgeStore,
  ctx: MemoryActionCtx,
  corpus: Corpus,
  ns: string,
  opts: { text: string; mode: 'lexical' | 'hybrid' | 'vector'; topK: number },
): Promise<QueryResult[]> {
  const linked = corpus === 'docs'
    ? Array.from(new Set(ctx.linkedDocsWorkspaceIds ?? [])).filter(id => id && id !== ctx.workspaceId)
    : [];
  if (linked.length === 0) return ks.query(ns, opts);

  const [own, ...rest] = await Promise.all([
    ks.query(ns, opts),
    ...linked.map(id => ks.query(buildNamespace(id, 'docs'), opts).catch((): QueryResult[] => [])),
  ]);
  const k = 60;
  const fused = new Map<string, { rrf: number; result: QueryResult }>();
  [own, ...rest].forEach(results => {
    results.forEach((r, rank) => {
      const key = `${r.namespace}:${r.id}`;
      const prev = fused.get(key);
      fused.set(key, { rrf: (prev?.rrf ?? 0) + 1 / (k + rank + 1), result: r });
    });
  });
  return Array.from(fused.values()).sort((a, b) => b.rrf - a.rrf).slice(0, opts.topK).map(v => v.result);
}

/**
 * Fan a query out across corpora concurrently, tracking which corpora failed
 * and why instead of the previous `.catch(() => [])` that made a retrieval
 * outage or an unresolvable namespace indistinguishable from "no hits".
 *
 * A sensitive-workspace skip of memory/initiative is NOT a failure — that
 * suppression is deliberate and must stay silent (memory 0ff1a5c7's
 * bidirectional isolation decision).
 */
/** The code corpus refusal, if any. A throwing check refuses (fails closed). */
async function codeRefusal(ctx: MemoryActionCtx): Promise<string | null> {
  if (!ctx.codeAccessRefusal) return null;
  try {
    return await ctx.codeAccessRefusal();
  } catch {
    return 'could not confirm GitHub access to this workspace repository';
  }
}

async function fanOutCorpora(
  ks: KnowledgeStore,
  mc: MemoryStore | null,
  ctx: MemoryActionCtx,
  corpora: Corpus[],
  opts: { text: string; mode: 'lexical' | 'hybrid' | 'vector'; topK: number },
  caller: Extract<MemoryCaller, 'recall' | 'query_knowledge'>,
  memoryOpts: { includeCandidates?: boolean } = {},
): Promise<{ perCorpus: QueryResult[][]; failures: CorpusFailure[] }> {
  const failures: CorpusFailure[] = [];
  const perCorpus = await Promise.all(
    corpora.map(async (c): Promise<QueryResult[]> => {
      if (ctx.isSensitive && SENSITIVE_WITHHELD_CORPORA.has(c)) return [];
      if (c === 'memory' && !normalizeProject(ctx.project)) {
        failures.push({ corpus: c, reason: NO_MEMORY_SCOPE });
        return [];
      }
      if (c === 'code') {
        const refusal = await codeRefusal(ctx);
        if (refusal) {
          failures.push({ corpus: c, reason: refusal });
          return [];
        }
      }
      const ns = knowledgeNamespace(ctx, c);
      if (!ns) {
        failures.push({ corpus: c, reason: (c === 'memory' || c === 'initiative') ? 'teamId required' : 'workspaceId required' });
        return [];
      }
      try {
        // The memory namespace is team-wide: over-fetch, then keep the caller's project.
        if (c === 'memory') {
          return (await retrieveMemory({
            query: opts.text,
            scope: { teamId: ctx.teamId, workspaceId: ctx.workspaceId, memoryScope: ownMemoryScope(mc, ctx) },
            caller,
            budget: { topK: opts.topK },
            store: ks,
            mode: opts.mode,
            excludeSuperseded: true,
            ...(memoryOpts.includeCandidates ? { includeCandidates: true } : {}),
            attribution: { workerId: ctx.workerId },
            ledger: ctx.memoryLedger,
            onError: 'throw',
          })).results;
        }
        const raw = await queryCorpus(ks, ctx, c, ns, opts);
        return raw.filter(r => r.isCurrent !== false);
      } catch (e) {
        failures.push({ corpus: c, reason: e instanceof Error ? e.message : 'unknown error' });
        return [];
      }
    }),
  );
  return { perCorpus, failures };
}

// ── recall — read ─────────────────────────────────────────────────────────────

/**
 * Team knowledge base. Query this BEFORE starting work or diagnosing a failure —
 * it holds prior gotchas, architecture decisions, and outcomes of past tasks,
 * and will frequently contain the answer already. Pass the task title and any
 * error message.
 */
export async function handleRecallAction(
  memoryClient: MemoryStore,
  params: Record<string, unknown>,
  ctx: MemoryActionCtx,
): Promise<ToolResult> {
  // id present → direct fetch, all other params ignored. Accepts a full id or
  // the claim-time index's 8-char short id (`m:<id>` too); see ./memory-claim-index.
  if (params.id) {
    const notFound = () => errorResult(`Memory not found: ${params.id}`);
    // Memory is off for a sensitive workspace; say so the way a miss does.
    if (ctx.isSensitive) return notFound();
    const ref = parseMemoryIdRef(params.id);
    let m: Awaited<ReturnType<MemoryStore['get']>>['memory'] | null | undefined;
    if (ref?.kind === 'prefix') {
      // Resolved inside the caller's own project, so a prefix can never reach
      // another workspace's memory, and a foreign one reads as a miss.
      const own = normalizeProject(ctx.project);
      if (!own || typeof memoryClient.findByIdPrefix !== 'function') return notFound();
      const rows = await memoryClient.findByIdPrefix(ref.value, own, 2).catch(() => []);
      if (rows.length > 1) {
        return errorResult(`Memory id ${params.id} matches more than one memory; pass more characters or the full id`);
      }
      m = rows[0];
    } else {
      // A miss throws in the store; a foreign row is returned and refused
      // below. Both end as the same message.
      m = (await memoryClient.get(ref ? ref.value : params.id as string).catch(() => null))?.memory;
    }
    // Same message as a miss, so a foreign id is not confirmed to exist.
    if (!m || !isOwnMemory(m, ctx)) return notFound();
    recordMemoryPulls({
      memoryIds: [m.id],
      teamId: ctx.teamId,
      workspaceId: ctx.workspaceId,
      caller: 'recall',
      attribution: { taskId: ctx.taskId, workerId: ctx.workerId },
      ledger: ctx.memoryLedger,
    });
    const meta = [
      `Type: ${m.type}`,
      m.project && `Project: ${m.project}`,
      m.tags?.length && `Tags: ${m.tags.join(', ')}`,
      m.files?.length && `Files: ${m.files.join(', ')}`,
      m.source && `Source: ${m.source}`,
      memoryStateOf(m) !== 'active' && `State: ${memoryStateOf(m)}`,
      m.reverifyFlaggedAt && `Re-verify: files it names changed since it was written${m.reverifyRef ? ` (${m.reverifyRef})` : ''}`,
    ].filter(Boolean).join('\n');
    return text(`# ${m.title}\n\n${meta}\n\n${m.content}`);
  }

  if (!params.query) {
    return errorResult('query is required (or pass id for a direct fetch)');
  }

  const corporaErr = parseCorpora(params.scope);
  if (corporaErr) return errorResult(corporaErr.error);

  const typeFilter = params.type as string | undefined;
  if (typeFilter && !(MEMORY_TYPES as readonly string[]).includes(typeFilter)) {
    return errorResult(`Invalid type filter. Must be one of: ${MEMORY_TYPES.join(', ')}`);
  }
  const filesFilter = Array.isArray(params.files)
    ? (params.files as unknown[]).filter((f): f is string => typeof f === 'string')
    : undefined;
  const filterParams = { type: typeFilter, files: filesFilter };
  const isFiltered = !!typeFilter || !!(filesFilter && filesFilter.length > 0);
  const filterNote = isFiltered
    ? ` (filtered: ${[typeFilter && `type=${typeFilter}`, filesFilter?.length && `files=${filesFilter.join(',')}`].filter(Boolean).join(', ')})`
    : '';

  const limit = Math.min((params.limit as number) || 10, 50);
  const query = params.query as string;
  const includeCandidates = params.includeCandidates === true;
  // Filtering happens after retrieval, so over-fetch when a filter is active —
  // otherwise a topK=limit fetch can come back entirely filtered out even when
  // enough matching chunks exist further down the ranking.
  const fetchTopK = isFiltered ? Math.min(limit * 5, 100) : limit;

  // Multi-scope: fan out concurrently, fuse results with Reciprocal Rank Fusion.
  // Uses k=60 — the same constant as reciprocalRankFusion() in pg-vector-store.ts.
  // Scores are not comparable across namespaces; rank position is the invariant.
  if (Array.isArray(params.scope)) {
    const scopes = (params.scope as string[]).map(s => s as Corpus);
    const mode = chooseModeForQuery(query);
    const ks = ctx.knowledgeStore ?? new PgVectorStore(ctx.embedder ?? null, getVoyageReranker());

    const { perCorpus, failures } = await fanOutCorpora(ks, memoryClient, ctx, scopes, { text: query, mode, topK: fetchTopK }, 'recall', { includeCandidates });

    if (scopes.length > 0 && failures.length === scopes.length) {
      return errorResult(`All corpora failed: ${failures.map(f => `${f.corpus} (${f.reason})`).join(', ')}`);
    }
    const failureNote = formatCorpusFailures(failures);

    const k = 60;
    const fusionScores = new Map<string, { rrf: number; result: QueryResult }>();
    perCorpus.forEach((results, listIdx) => {
      results.forEach((r, rank) => {
        const key = `${scopes[listIdx]}:${r.namespace}:${r.id}`;
        const prev = fusionScores.get(key);
        fusionScores.set(key, { rrf: (prev?.rrf ?? 0) + 1 / (k + rank + 1), result: r });
      });
    });

    let fused = Array.from(fusionScores.values())
      .sort((a, b) => b.rrf - a.rrf)
      .map(v => v.result);
    if (isFiltered) fused = fused.filter(r => matchesRecallFilters(r, filterParams));
    fused = fused.slice(0, limit);

    if (fused.length === 0) return text(`No knowledge found for: "${query}"${filterNote}${failureNote}`);
    const formatted = fused.map((r, i) => formatKnowledgeResult(r, i)).join('\n\n---\n\n');
    return text(`Found ${fused.length} result(s)${filterNote}:\n\n${formatted}${failureNote}`);
  }

  // Single scope — original path (unchanged).
  const scope = ((params.scope as string) || 'memory') as Corpus;

  if (ctx.isSensitive && scope === 'memory') {
    return text('(No results — memory access is disabled for sensitive workspaces.)');
  }
  if (ctx.isSensitive && scope === 'evidence') {
    return text('(No results — evidence is not indexed for sensitive workspaces.)');
  }
  if (scope === 'memory' && !normalizeProject(ctx.project)) {
    return errorResult(`${NO_MEMORY_SCOPE} — recall scope=memory is unavailable`);
  }
  if (scope === 'code') {
    const refusal = await codeRefusal(ctx);
    if (refusal) return errorResult(`recall scope=code is unavailable: ${refusal}`);
  }

  // Resolve namespace — namespace resolution is internal to the server.
  const ns = knowledgeNamespace(ctx, scope);
  if (!ns) {
    return errorResult(scope === 'memory' || scope === 'initiative'
      ? `teamId required for recall with scope=${scope}`
      : `workspaceId required for recall with scope=${scope}`);
  }

  // Retrieval mode is server-chosen. Hybrid by default; lexical for short
  // exact-match queries (IDs, symbol names, error codes).
  const mode = chooseModeForQuery(query);

  // Reranker passed here too: without it this fallback ranked by age decay
  // while the server-built store ranked by cross-encoder relevance, so the
  // same query got different semantics depending on which path served it.
  const ks =
    ctx.knowledgeStore ?? new PgVectorStore(ctx.embedder ?? null, getVoyageReranker());
  // Exclude superseded entries by default, apply type/files filters, then the
  // caller limit. Memory goes through the one door, which over-fetches the
  // team-wide namespace and keeps the caller's project.
  let results: QueryResult[];
  if (scope === 'memory') {
    results = (await retrieveMemory({
      query,
      scope: { teamId: ctx.teamId, workspaceId: ctx.workspaceId, memoryScope: ownMemoryScope(memoryClient, ctx) },
      caller: 'recall',
      budget: { topK: limit, candidates: fetchTopK },
      store: ks,
      mode,
      excludeSuperseded: true,
      ...(includeCandidates ? { includeCandidates: true } : {}),
      filter: isFiltered ? r => matchesRecallFilters(r, filterParams) : undefined,
      attribution: { workerId: ctx.workerId },
      ledger: ctx.memoryLedger,
      onError: 'throw',
    })).results;
  } else {
    const raw = await queryCorpus(ks, ctx, scope, ns, { text: query, mode, topK: fetchTopK });
    results = raw.filter(r => r.isCurrent !== false);
    if (isFiltered) results = results.filter(r => matchesRecallFilters(r, filterParams));
    results = results.slice(0, limit);
  }

  if (results.length === 0) {
    if (scope === 'code' || scope === 'docs') {
      // Empty results don't mean an empty index: the session hint counts the
      // same namespace, so only claim "no index" when that count is zero.
      let indexed = 0;
      try {
        indexed = (await ks.countNamespace?.(ns)) ?? 0;
      } catch {
        // fall through to the not-indexed message
      }
      if (indexed > 0) {
        return text(`No ${scope} match for: "${query}"${filterNote} (${indexed.toLocaleString()} chunks are indexed — try different terms or a symbol name).`);
      }
      return text(`No ${scope} index found. Run ingestion first: WORKSPACE_ID=<id> bun packages/core/scripts/ingest-knowledge.ts <repo-dir>`);
    }
    return text(`No knowledge found for: "${query}"${filterNote}`);
  }

  const formatted = results.map((r, i) => formatKnowledgeResult(r, i)).join('\n\n---\n\n');

  return text(`Found ${results.length} result(s)${filterNote}:\n\n${formatted}`);
}

// ── learn — write ─────────────────────────────────────────────────────────────

/**
 * Record a durable lesson for the team — a gotcha, pattern, decision,
 * discovery, or architecture fact. Write what the next agent would have wanted
 * to know. Near-duplicates are merged automatically.
 */
export async function handleLearnAction(
  memoryClient: MemoryStore,
  params: Record<string, unknown>,
  ctx: MemoryActionCtx,
): Promise<ToolResult> {
  if (!params.type || !params.title || !params.content) {
    return errorResult('type, title, and content are required');
  }

  const validTypes = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'];
  if (!validTypes.includes(params.type as string)) {
    return errorResult(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
  }

  if (ctx.isSensitive) {
    return errorResult('workspace is sensitive — memory writes disabled');
  }
  // Written under the caller's own project key only — a memory filed under
  // another workspace's key would surface there.
  const learnScope = ownMemoryProject(ctx, params.scope);
  if ('error' in learnScope) return errorResult(learnScope.error);

  const supersedesParam = parseSupersedesParam(params.supersedes);
  if (supersedesParam.error) return errorResult(supersedesParam.error);

  const title = params.title as string;
  const content = params.content as string;
  const callerType = params.type as MemoryDecisionType;
  // Jev's keep/type judgement runs alongside the near-duplicate check, inside
  // its own 5s deadline, and falls back to the caller's type on any failure.
  const judging = judgeMemoryWrite(ctx, title, content, callerType);

  // Dedupe check — embed the candidate and compare cosine similarity against the
  // team memory namespace. Skip when the caller already supplied explicit supersedes
  // (they've resolved the conflict) or when the store lacks nearDupeCheck.
  const THRESH_AUTO     = 0.94;
  const THRESH_CONFLICT = 0.88;
  // Set when Jev resolved the 0.88 to 0.94 band into a write (ADD or SUPERSEDE).
  let bandDecision: UpdateJudgement | null = null;
  // The automatic (> THRESH_AUTO) match: the only source of a corroboration link.
  let autoMatchId: string | null = null;

  if (!supersedesParam.ids && ctx.teamId && ctx.knowledgeStore?.nearDupeCheck) {
    const ns = buildNamespace(ctx.teamId, 'memory');
    const embedText = `${title}\n\n${content}`;
    // The namespace is team-wide: over-fetch, then keep the caller's project, so
    // another workspace's memory is neither quoted back nor auto-superseded.
    const nearest = await ctx.knowledgeStore.nearDupeCheck(ns, embedText, memoryOverfetchTopK(5)).catch(() => []);
    const candidates = (await ownMemoryHits(memoryClient, ctx, nearest).catch(() => [])).slice(0, 5);

    const top = candidates[0];
    if (ctx.memoryDedupeOnly && top && top.similarity >= THRESH_CONFLICT) {
      (await judging).record(null);
      return text(`Memory already recorded: ID: ${top.id} (similarity: ${top.similarity.toFixed(3)}) | nothing written`);
    }
    if (top && top.similarity > THRESH_AUTO) {
      // Auto-supersede: fold the best match into the supersedes list so the
      // upsert marks it as not-current. The caller gets back superseded: 1.
      supersedesParam.ids = [top.id];
      autoMatchId = top.id;
    } else {
      const conflicts = candidates.filter(c => c.similarity >= THRESH_CONFLICT);
      if (conflicts.length > 0) {
        // The band: ask Jev whether this is new (ADD), a refinement (UPDATE),
        // a replacement (SUPERSEDE) or a repeat (NOOP) of the closest match.
        // Below its threshold (or on any failure) the reply is today's conflict.
        const band = await resolveNearDuplicateBand(memoryClient, ctx, { title, content, type: callerType }, conflicts[0]);
        if (band.action === 'SUPERSEDE') {
          supersedesParam.ids = [conflicts[0].id];
          bandDecision = band.judgement;
        } else if (band.action === 'ADD') {
          bandDecision = band.judgement;
        } else if (band.action === 'NOOP' && band.existing) {
          band.judgement.record(band.existing.id, true);
          (await judging).record(null);
          return text(
            `Memory already recorded: "${band.existing.title}" (${band.existing.type})\nID: ${band.existing.id}` +
            ` | nothing new to add (decision: NOOP). To replace it anyway, re-call learn with supersedes: ${JSON.stringify([band.existing.id])}`,
          );
        } else if (band.action === 'UPDATE' && band.existing) {
          // A merge is a new row, never an overwrite: the new row carries the
          // existing text plus the incoming text, and the old row is only
          // superseded (reversible, still readable by id).
          const existing = band.existing;
          const judgement = await judging;
          const mergeSupersedes = await ownSupersedes(memoryClient, ctx, [existing.id]);
          // External text never merges into a row: the merged row would carry
          // it under the caller's provenance. Refuse, as the conflict reply.
          if (!mergeSupersedes || existing.external) {
            band.judgement.record(existing.id, false);
            judgement.record(null);
            return text(`Near-duplicate detected. Re-call with explicit \`supersedes\` to confirm replacement.\n\n- ID: ${existing.id}`);
          }
          let merged: Awaited<ReturnType<typeof saveMemory>>;
          const mergeLifecycle = await candidateWriteFields(ctx);
          const mergeSplit = await splitSupersedes(memoryClient, mergeSupersedes, mergeLifecycle.state === 'candidate');
          try {
            merged = await saveMemory(memoryClient, {
              ...mergeLifecycle,
              ...(mergeSplit.pending.length ? { pendingSupersedes: mergeSplit.pending } : {}),
              type: existing.type,
              title,
              content: mergeMemoryContent(existing.content, content),
              project: learnScope.project,
              tags: unionStrings(existing.tags, params.tags as string[] | undefined, judgement.addTags),
              files: unionStrings(existing.files, params.files as string[] | undefined),
              source: ctx.workerId ? `worker:${ctx.workerId}` : 'mcp-agent',
            }, { teamId: ctx.teamId, knowledgeStore: ctx.teamId ? ctx.knowledgeStore : null, via: 'learn', supersedes: mergeSplit.now });
          } catch (err) {
            band.judgement.record(existing.id, false);
            judgement.record(null);
            throw err;
          }
          band.judgement.record(merged.memory.id, true);
          judgement.record(merged.memory.id);
          return text(
            `Memory saved: "${merged.memory.title}" (${merged.memory.type})\nID: ${merged.memory.id}` +
            ` | merged with near-duplicate ${existing.id}, which is superseded (decision: UPDATE) | superseded: ${merged.superseded}` +
            (mergeLifecycle.state ? CANDIDATE_NOTE : ''),
          );
        } else {
          band.judgement.record(null, false);
          (await judging).record(null);
          const list = conflicts
            .map(c => `- ID: ${c.id} (similarity: ${c.similarity.toFixed(3)})\n  ${c.content.slice(0, 200)}`)
            .join('\n\n');
          const ids = JSON.stringify(conflicts.map(c => c.id));
          return text(
            `Near-duplicate detected. Re-call with explicit \`supersedes\` to confirm replacement, ` +
            `or modify the content to make the distinction clear.\n\n${list}\n\n` +
            `To replace: re-call learn with supersedes: ${ids}`,
          );
        }
      }
    }
  }

  // Explicit ids are narrowed to the caller's own project before they reach the
  // team-wide index (auto-supersede ids above already were).
  const learnSupersedes = await ownSupersedes(memoryClient, ctx, supersedesParam.ids);
  const judgement = await judging;
  const lifecycle = await candidateWriteFields(ctx);
  const split = await splitSupersedes(memoryClient, learnSupersedes, lifecycle.state === 'candidate');
  const corroboratedBy = autoMatchId && lifecycle.state === 'candidate'
    ? corroborationLink(split.rows.get(autoMatchId), lifecycle, ctx)
    : undefined;

  // Saved and mirrored through the one write helper; a failed mirror is
  // recorded there and picked up by the reconcile pass. A "not durable"
  // verdict only adds a tag: nothing is dropped.
  let saved: Awaited<ReturnType<typeof saveMemory>>;
  try {
    saved = await saveMemory(memoryClient, {
      ...lifecycle,
      ...(split.pending.length ? { pendingSupersedes: split.pending } : {}),
      ...(corroboratedBy ? { corroboratedBy } : {}),
      type: judgement.type.type,
      title,
      content,
      project: learnScope.project,
      tags: judgement.addTags.length ? unionStrings(params.tags as string[] | undefined, judgement.addTags) : params.tags as string[] | undefined,
      files: params.files as string[] | undefined,
      source: ctx.workerId ? `worker:${ctx.workerId}` : 'mcp-agent',
    }, { teamId: ctx.teamId, knowledgeStore: ctx.teamId ? ctx.knowledgeStore : null, via: 'learn', supersedes: split.now });
  } catch (err) {
    judgement.record(null);
    bandDecision?.record(null, false);
    throw err;
  }
  judgement.record(saved.memory.id);
  bandDecision?.record(saved.memory.id, true);
  const data = { memory: saved.memory };
  const learnSuperseded = saved.superseded;

  const supersededStr = supersedesParam.ids !== undefined
    ? ` | superseded: ${learnSuperseded}`
    : '';
  const pendingStr = split.pending.length ? ` | replaces ${split.pending.length} active memory(s) once promoted` : '';
  return text(`Memory saved: "${data.memory.title}" (${data.memory.type})\nID: ${data.memory.id}${supersededStr}${pendingStr}${learnJudgementNote(judgement)}${lifecycle.state ? CANDIDATE_NOTE : ''}`);
}

/**
 * Jev's verdict on the 0.88 to 0.94 near-duplicate band, against the closest
 * match. The match came from `ownMemoryHits`, and the row is re-read here and
 * re-checked as the caller's own before anything can act on it. No decider,
 * no row, or a verdict below threshold: `action: null` (the conflict reply).
 */
async function resolveNearDuplicateBand(
  mc: MemoryStore,
  ctx: MemoryActionCtx,
  incoming: { title: string; content: string; type: string },
  match: { id: string; content: string },
): Promise<{ action: UpdateJudgement['action']; judgement: UpdateJudgement; existing: MemoryRecordShape | null }> {
  const none = { action: null, judgement: FALLBACK_UPDATE_JUDGEMENT, existing: null };
  if (!ctx.memoryDecider || !ctx.teamId || ctx.isSensitive) return none;
  const existing = await mc.get(match.id).then(r => r.memory as MemoryRecordShape).catch(() => null);
  if (!existing || !isOwnMemory(existing, ctx)) return none;
  const judgement = await ctx.memoryDecider.judgeUpdate({
    scope: { teamId: ctx.teamId, workspaceId: ctx.workspaceId ?? null },
    incoming,
    existing: { id: existing.id, title: existing.title, content: existing.content || match.content, type: existing.type },
  }).catch(() => FALLBACK_UPDATE_JUDGEMENT);
  return { action: judgement.action, judgement, existing };
}

/**
 * The text of a merged memory: the existing memory, then what the new write
 * adds. No generative merge here; the superseded original stays readable.
 */
function mergeMemoryContent(existing: string, incoming: string): string {
  const a = (existing ?? '').trim();
  const b = (incoming ?? '').trim();
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  return `${a}\n\nUpdate:\n${b}`;
}

type MemoryRecordShape = {
  id: string; title: string; content: string; type: string; project?: string | null; tags?: string[]; files?: string[];
  state?: string | null; sourceKind?: string | null; sourceId?: string | null; external?: boolean;
};

/** Log prefix for deprecated `buildd_memory` dispatches — grep prod logs for this. */
export const BUILDD_MEMORY_DEPRECATION_TAG = '[buildd_memory-deprecated]';

/**
 * Actions that arrive through this dispatcher but are NOT deprecated: they were
 * promoted to the `buildd` admin action set rather than replaced by recall/learn.
 * Counting them would drown the signal that decides when buildd_memory can go.
 */
const NON_DEPRECATED_MEMORY_ACTIONS = new Set(['consolidate_knowledge', 'query_knowledge']);

const builddMemoryDeprecationCounts = new Map<string, number>();

/**
 * Per-action call counts for the deprecated `buildd_memory` tool, for the life of
 * this process. Serverless instances are short-lived, so treat this as a probe for
 * tests and local runs — the durable signal is the log line below.
 */
export function getBuilddMemoryDeprecationCounts(): Record<string, number> {
  return Object.fromEntries(builddMemoryDeprecationCounts);
}

export function resetBuilddMemoryDeprecationCounts(): void {
  builddMemoryDeprecationCounts.clear();
}

/**
 * Record one deprecated-tool call. `buildd_memory` was superseded by `recall` and
 * `learn` in #1944 but stays routed for compatibility; step 6 of
 * docs/design/knowledge-tool-surface.md ("remove buildd_memory") needs evidence
 * that nothing still calls it, and static description strings produce none. One
 * single-line, greppable record per call is that evidence.
 */
function recordBuilddMemoryDeprecation(action: string, ctx: MemoryActionCtx): void {
  if (NON_DEPRECATED_MEMORY_ACTIONS.has(action)) return;
  const next = (builddMemoryDeprecationCounts.get(action) ?? 0) + 1;
  builddMemoryDeprecationCounts.set(action, next);
  console.warn(
    `${BUILDD_MEMORY_DEPRECATION_TAG} action=${action} workspace=${ctx.workspaceId ?? 'unknown'}`
    + ` worker=${ctx.workerId ?? 'none'} calls=${next} — migrate to recall/learn`,
  );
}

export async function handleMemoryAction(
  memoryClient: MemoryStore | null,
  action: string,
  params: Record<string, unknown>,
  ctx: MemoryActionCtx,
): Promise<ToolResult> {
  recordBuilddMemoryDeprecation(action, ctx);
  // consolidate_knowledge and query_knowledge operate directly on the PgVectorStore
  // and do not call memoryClient — null is acceptable for those ops.
  const clientRequired = ['context', 'search', 'save', 'get', 'update', 'delete'];
  if (clientRequired.includes(action) && !memoryClient) {
    return errorResult('Memory store not available — teamId could not be resolved');
  }
  // Safe non-null ref for client-requiring cases (guarded above).
  const mc = memoryClient as MemoryStore;

  switch (action) {
    case 'context': {
      if (ctx.isSensitive) return text('(No results — memory access is disabled for sensitive workspaces.)');
      const scoped = ownMemoryProject(ctx, params.project);
      if ('error' in scoped) return errorResult(scoped.error);
      // The same rows getContext reads (the newest active memories), through
      // the door so the use ledger records what the agent was shown.
      const { memories } = await retrieveMemory<MemoryRecord>({
        strategy: 'store-search',
        searcher: mc,
        search: { limit: MEMORY_CONTEXT_LIMIT },
        scope: { teamId: ctx.teamId, workspaceId: ctx.workspaceId, project: scoped.project },
        caller: 'buildd_memory_context',
        attribution: { taskId: ctx.taskId, workerId: ctx.workerId },
        ledger: ctx.memoryLedger,
      });
      return text(renderMemoryContext(memories).markdown || '(No memories yet)');
    }

    case 'search': {
      if (ctx.isSensitive) return text('(No results — memory access is disabled for sensitive workspaces.)');
      const scoped = ownMemoryProject(ctx, params.project);
      if ('error' in scoped) return errorResult(scoped.error);
      // Through the door, so the use ledger records each memory returned. A
      // failed hydration still answers with the search's summary rows.
      let searched: { results: any[]; total: number } = { results: [], total: 0 };
      const searcher: MemoryStoreSearcher = {
        search: async (p) => (searched = await mc.search(p)),
        batch: async (ids) => {
          try { return await mc.batch(ids); } catch { return { memories: [] }; }
        },
      };
      const { memories: fetched } = await retrieveMemory<any>({
        strategy: 'store-search',
        searcher,
        search: {
          query: params.query as string | undefined,
          type: params.type as string | undefined,
          files: params.files as string[] | undefined,
          limit: Math.min((params.limit as number) || 10, 50),
          offset: params.offset as number | undefined,
        },
        scope: { teamId: ctx.teamId, workspaceId: ctx.workspaceId, project: scoped.project },
        caller: 'buildd_memory_search',
        // A pull: active memories, and candidates when asked for.
        includeCandidates: params.includeCandidates === true,
        attribution: { taskId: ctx.taskId, workerId: ctx.workerId },
        ledger: ctx.memoryLedger,
      });
      const data = searched;

      if (!data.results || data.results.length === 0) {
        return text(`No memories found${params.query ? ` matching "${params.query}"` : ''}. Use \`learn\` to record memories.`);
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
      if (ctx.isSensitive) return errorResult('workspace is sensitive — memory writes disabled');
      if (!params.type || !params.title || !params.content) throw new Error('type, title, and content are required');

      const validTypes = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'];
      if (!validTypes.includes(params.type as string)) {
        throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
      }

      const saveScope = ownMemoryProject(ctx, params.project);
      if ('error' in saveScope) return errorResult(saveScope.error);

      const saveSupersedes = parseSupersedesParam(params.supersedes);
      if (saveSupersedes.error) throw new Error(saveSupersedes.error);

      // Same keep/type judgement as learn (bounded, fails open to the caller's type).
      const saveJudging = judgeMemoryWrite(ctx, params.title as string, params.content as string, params.type as MemoryDecisionType);
      const saveIds = await ownSupersedes(mc, ctx, saveSupersedes.ids);
      const saveJudgement = await saveJudging;
      const saveLifecycle = await candidateWriteFields(ctx);
      const saveSplit = await splitSupersedes(mc, saveIds, saveLifecycle.state === 'candidate');
      let saved: Awaited<ReturnType<typeof saveMemory>>;
      try {
        saved = await saveMemory(mc, {
          ...saveLifecycle,
          ...(saveSplit.pending.length ? { pendingSupersedes: saveSplit.pending } : {}),
          type: saveJudgement.type.type,
          title: params.title as string,
          content: params.content as string,
          project: saveScope.project,
          tags: saveJudgement.addTags.length ? unionStrings(params.tags as string[] | undefined, saveJudgement.addTags) : params.tags as string[] | undefined,
          files: params.files as string[] | undefined,
          source: (params.source as string) || (ctx.workerId ? `worker:${ctx.workerId}` : 'mcp-agent'),
        }, { teamId: ctx.teamId, knowledgeStore: ctx.teamId ? ctx.knowledgeStore : null, via: 'buildd_memory:save', supersedes: saveSplit.now });
      } catch (err) {
        saveJudgement.record(null);
        throw err;
      }
      saveJudgement.record(saved.memory.id);
      const data = { memory: saved.memory };
      const memSuperseded = saved.superseded;

      let memEntityBinding: EntityBinding | null = null;
      // Entity refs bind to the chunk, so only once the chunk exists.
      if (ctx.teamId && ctx.knowledgeStore && saved.mirrored) {
        const ns = buildNamespace(ctx.teamId, 'memory');
        const m = data.memory;
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
      return text(`Memory saved: "${data.memory.title}" (${data.memory.type})\nID: ${data.memory.id}${bindingStr}${saveSupersededStr}${learnJudgementNote(saveJudgement)}`);
    }

    case 'get': {
      if (ctx.isSensitive) return text('(No results — memory access is disabled for sensitive workspaces.)');
      if (!params.id) throw new Error('id is required');
      const data = await mc.get(params.id as string);
      const m = data.memory;
      if (!isOwnMemory(m, ctx)) return errorResult(`Memory not found: ${params.id}`);
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
      if (ctx.isSensitive) return errorResult('workspace is sensitive — memory writes disabled');
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

      // Only the caller's own memories, and never moved to another project key.
      const updateScope = ownMemoryProject(ctx, params.project);
      if ('error' in updateScope) return errorResult(updateScope.error);
      const existing = await mc.get(params.id as string);
      if (!isOwnMemory(existing.memory, ctx)) return errorResult(`Memory not found: ${params.id}`);

      const updateIds = await ownSupersedes(mc, ctx, updateSupersedes.ids);
      const updated = await updateMemory(mc, params.id as string, updateFields, {
        teamId: ctx.teamId, knowledgeStore: ctx.teamId ? ctx.knowledgeStore : null, via: 'buildd_memory:update', supersedes: updateIds,
      });
      const data = { memory: updated.memory };
      const updateSuperseded = updated.superseded;

      let updateEntityBinding: EntityBinding | null = null;
      if (ctx.teamId && ctx.knowledgeStore && updated.mirrored) {
        const ns = buildNamespace(ctx.teamId, 'memory');
        const m = data.memory;
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
      if (ctx.isSensitive) return errorResult('workspace is sensitive — memory writes disabled');
      if (!params.id) throw new Error('id is required');

      // Only the caller's own memories. The store is team-wide, so without
      // this any id in the team was deletable. A foreign id and a missing one
      // get the same reply, so the reply does not confirm the id exists.
      const deleteScope = ownMemoryProject(ctx);
      if ('error' in deleteScope) return errorResult(deleteScope.error);
      const notFound = errorResult(`Memory not found: ${params.id}`);
      const target = await mc.get(params.id as string).catch(() => null);
      if (!target || !isOwnMemory(target.memory, ctx)) return notFound;

      await mc.delete(params.id as string);

      // Remove from KnowledgeStore (team-scoped)
      if (ctx.teamId && ctx.knowledgeStore) {
        const ns = buildNamespace(ctx.teamId, 'memory');
        await ctx.knowledgeStore.delete(ns, [params.id as string]).catch(() => {});
      }

      return text(`Memory deleted: ${params.id}`);
    }

    case 'query_knowledge': {
      if (!params.query) throw new Error('query is required');

      const corporaErr = parseCorpora(params.corpus);
      if (corporaErr) throw new Error(corporaErr.error);

      const mode = (params.mode as 'hybrid' | 'vector' | 'lexical') || 'hybrid';
      const topK = Math.min((params.topK as number) || 10, 50);
      const ks = ctx.knowledgeStore ?? new PgVectorStore(ctx.embedder ?? null, getVoyageReranker());

      // Multi-corpus: fan out concurrently, fuse with RRF (k=60, same as pg-vector-store).
      if (Array.isArray(params.corpus)) {
        const corpora = (params.corpus as string[]).map(c => c as Corpus);

        const { perCorpus, failures } = await fanOutCorpora(ks, memoryClient, ctx, corpora, { text: params.query as string, mode, topK }, 'query_knowledge');

        if (corpora.length > 0 && failures.length === corpora.length) {
          throw new Error(`All corpora failed: ${failures.map(f => `${f.corpus} (${f.reason})`).join(', ')}`);
        }
        const failureNote = formatCorpusFailures(failures);

        const k = 60;
        const fusionScores = new Map<string, { rrf: number; result: QueryResult }>();
        perCorpus.forEach((results, listIdx) => {
          results.forEach((r, rank) => {
            const key = `${corpora[listIdx]}:${r.namespace}:${r.id}`;
            const prev = fusionScores.get(key);
            fusionScores.set(key, { rrf: (prev?.rrf ?? 0) + 1 / (k + rank + 1), result: r });
          });
        });

        const fused = Array.from(fusionScores.values())
          .sort((a, b) => b.rrf - a.rrf)
          .slice(0, topK)
          .map(v => v.result);

        // Telemetry: emit one milestone labelled with the joined corpus list.
        if (ctx.api && ctx.workerId) {
          const workerId = ctx.workerId;
          const apiCall = ctx.api;
          Promise.resolve(apiCall(`/api/workers/${workerId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              appendMilestones: [{
                type: 'knowledge_query',
                label: corpora.join(','),
                ts: Date.now(),
                metadata: { query: (params.query as string)?.slice(0, 100), topK, hitCount: fused.length },
              }],
            }),
          })).catch(() => {});
        }

        if (fused.length === 0) {
          return text(`No knowledge chunks found for query: "${params.query}" (corpora: ${corpora.join(', ')}, mode: ${mode})${failureNote}`);
        }
        const formatted = fused.map((r, i) => formatKnowledgeResult(r, i)).join('\n\n---\n\n');
        return text(`Found ${fused.length} chunk(s) (mode: ${mode}, corpora: ${corpora.join(', ')}):\n\n${formatted}${failureNote}`);
      }

      // Single corpus — original path (unchanged).
      const corpus = ((params.corpus as string) || 'memory') as Corpus;

      if (ctx.isSensitive && corpus === 'memory') {
        return text('(No results — memory access is disabled for sensitive workspaces.)');
      }
      if (ctx.isSensitive && corpus === 'evidence') {
        return text('(No results — evidence is not indexed for sensitive workspaces.)');
      }
      if (corpus === 'memory' && !normalizeProject(ctx.project)) {
        throw new Error(`${NO_MEMORY_SCOPE} — query_knowledge corpus=memory is unavailable`);
      }
      if (corpus === 'code') {
        const refusal = await codeRefusal(ctx);
        if (refusal) throw new Error(`query_knowledge corpus=code is unavailable: ${refusal}`);
      }

      const ns = knowledgeNamespace(ctx, corpus);

      if (!ns) {
        throw new Error(corpus === 'memory' || corpus === 'initiative'
          ? `teamId required for query_knowledge with corpus=${corpus}`
          : 'workspaceId required for query_knowledge');
      }

      // Reranker passed here too: without it this fallback ranked by age decay
      // while the server-built store ranked by cross-encoder relevance, so the
      // same query got different semantics depending on which path served it.
      // The memory namespace is team-wide, so over-fetch and keep the caller's project.
      const results = corpus === 'memory'
        ? (await retrieveMemory({
            query: params.query as string,
            scope: { teamId: ctx.teamId, workspaceId: ctx.workspaceId, memoryScope: ownMemoryScope(memoryClient, ctx) },
            caller: 'query_knowledge',
            budget: { topK },
            store: ks,
            mode,
            attribution: { workerId: ctx.workerId },
            ledger: ctx.memoryLedger,
            onError: 'throw',
          })).results
        : await queryCorpus(ks, ctx, corpus, ns, { text: params.query as string, mode, topK });

      // Fire-and-forget telemetry — never blocks or fails the query response.
      if (ctx.api && ctx.workerId) {
        const workerId = ctx.workerId;
        const apiCall = ctx.api;
        Promise.resolve(apiCall(`/api/workers/${workerId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            appendMilestones: [{
              type: 'knowledge_query',
              label: corpus,
              ts: Date.now(),
              metadata: {
                query: (params.query as string)?.slice(0, 100),
                topK,
                hitCount: results.length,
              },
            }],
          }),
        })).catch(() => {});
      }

      if (results.length === 0) {
        if (corpus === 'code' || corpus === 'docs') {
          return text(`No ${corpus} index for this workspace (namespace: ${ns}) — run ingestion first: WORKSPACE_ID=${ctx.workspaceId} bun packages/core/scripts/ingest-knowledge.ts <repo-dir>`);
        }
        return text(`No knowledge chunks found for query: "${params.query}" (namespace: ${ns}, mode: ${mode})`);
      }

      const formatted = results.map((r, i) => formatKnowledgeResult(r, i)).join('\n\n---\n\n');

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
        // The memory namespace is team-wide: archive only the caller's own
        // project's memories. A foreign id and a missing one read the same.
        if (corpus === 'memory') {
          const own = await ownMemoryHits(memoryClient, ctx, (sourceIds as string[]).map(id => ({ id })));
          if (own.length !== sourceIds.length) {
            throw new Error('sourceIds include memory that is not in this workspace — memory is scoped to the calling workspace');
          }
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
      // Memory needs a project key as well as a teamId: its namespace is
      // team-wide and results are narrowed to the caller's project below.
      const hasProject = !!normalizeProject(ctx.project);
      const namespaces = corpora
        .filter(c => c !== 'memory' || hasProject)
        .map(c => knowledgeNamespace(ctx, c))
        .filter((ns): ns is string => ns !== null);
      if (namespaces.length === 0) {
        throw new Error(`No namespace resolvable for corpora [${corpora.join(', ')}] — memory needs teamId and a workspace project, other corpora need workspaceId`);
      }
      const memoryNs = ctx.teamId ? buildNamespace(ctx.teamId, 'memory') : null;
      /** Source ids in the memory namespace that belong to the caller's project. */
      const ownMemoryIds = async (ids: string[]): Promise<Set<string>> => {
        const unique = [...new Set(ids)];
        const own = await ownMemoryHits(memoryClient, ctx, unique.map(id => ({ id })));
        return new Set(own.map(h => h.id));
      };

      if (op === 'find_duplicates') {
        const found = await findNearDuplicates(namespaces, {
          threshold: params.threshold as number | undefined,
          limit: params.limit as number | undefined,
        });
        const memPairs = found.filter(p => p.namespace === memoryNs);
        const allowed = memPairs.length > 0
          ? await ownMemoryIds(memPairs.flatMap(p => [p.sourceIdA, p.sourceIdB]))
          : new Set<string>();
        const pairs = found.filter(p =>
          p.namespace !== memoryNs || (allowed.has(p.sourceIdA) && allowed.has(p.sourceIdB)));
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
      const decayedAll = await findDecayedUnused(namespaces, {
        halfLifeMultiple: params.halfLifeMultiple as number | undefined,
        limit: params.limit as number | undefined,
      });
      const memDecayed = decayedAll.filter(d => d.namespace === memoryNs);
      const allowedDecayed = memDecayed.length > 0
        ? await ownMemoryIds(memDecayed.map(d => d.sourceId))
        : new Set<string>();
      const decayed = decayedAll.filter(d => d.namespace !== memoryNs || allowedDecayed.has(d.sourceId));
      if (decayed.length === 0) {
        return text(`No decayed unused chunks found (namespaces: ${namespaces.join(', ')}).`);
      }
      const decayedLines = decayed.map(d =>
        `- ${d.sourceId} [${d.corpus}]${d.sourceTs ? ` ts: ${d.sourceTs.toISOString()}` : ''} hits: ${d.hitCount}\n  > ${d.preview}`
      ).join('\n');
      return text(`Found ${decayed.length} decayed unused chunk(s). Sanity-check previews, then archive with op=archive (corpus + sourceIds):\n${decayedLines}`);
    }

    default:
      throw new Error(`Unknown memory action: ${action}. Use one of: ${memoryActions.join(', ')}`);
  }
}
