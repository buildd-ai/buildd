/**
 * The task role shadow (knowledge-base: buildd/design/role-routing.md §3, §5, §6(a)).
 *
 * Most tasks are filed with no `roleSlug`. This asks a decision model (Jev)
 * which of the workspace's roles should do the work, and — when the task has no
 * `kind` — what shape the work is, then LOGS the answer. It never writes: the
 * module holds no handle to a task write path (a test pins that). Applying a
 * role is a separate capability and a separate PR (§6(c)).
 *
 * The candidate set is built in code first (§3). The model never sees a role
 * that is disabled, undescribed (`metadata.routing.whenToUse`), opted out
 * (`routing.disabled`), explicit-opt-in (`EXPLICIT_ROLE_SLUGS`), mounted on an
 * unusable connector, unable to produce the task's required output, or on a
 * different backend from the task. Fewer than two candidates ⇒ no call.
 *
 * Runs only for teams that list `task_role_shadow` or `task_role_apply` in
 * `teams.enabledDecisionShadows` (`opt_in` capabilities,
 * packages/core/inference-policy.ts), and only when a decision key resolves.
 * The policy check runs before the candidate query, so a team that has not
 * opted in costs a team-row read or two.
 *
 * Owner decision 2026-10-03 (knowledge-base: buildd/design/decision-calls.md):
 * applying is now the default once either capability is on — a role-less task
 * no longer needs a second opt-in to have the answer written, it only needs
 * the rails in `task-role-apply.ts` (candidate-set membership, the measured-
 * model check, the confidence gate) to pass. `applyEnabled` is therefore
 * always true once `access.ok`; `task-role-apply.ts` still does the actual
 * writing and gating, this module never does.
 *
 * Telemetry: one `[decision-shadow]` line per look, ids, slugs, labels and
 * numbers only — never the task's text or a role's routing text.
 */
import { resolvedPromptVersion, resolvePromptValueEntry } from '@buildd/core/prompts';
import { createHash } from 'node:crypto';
import { EXPLICIT_ROLE_SLUGS } from '@buildd/shared';
import { effectiveVisibleRoles, TEAM_SCOPED_BY_QUERY } from '@buildd/core/role-visibility';
// Types only at module scope. The client (and the DB layer behind it) is loaded
// lazily inside the run, so importing this module from the task route adds
// nothing to that route's static import graph.
import type {
  ChoiceQuestion,
  DecisionAccess,
  DecisionResult,
  decisionCall,
} from '@buildd/core/decision-client';
import type { TaskKind } from '@buildd/core/model-router';
import { readRoleRouting, renderRoutingCriterion } from './role-routing';
import { registerValuePrompt } from '@buildd/core/prompts';

export const SHADOW_TIMEOUT_MS = 3_000;
export const SHADOW_DESCRIPTION_CHARS = 1_500;
export const SHADOW_MAX_PATHS = 20;
export const DECISION_SHADOW_LOG_PREFIX = '[decision-shadow]';
export const TASK_ROLE_CAPABILITY = 'task_role_shadow' as const;
/** The separate opt-in that lets the answer be written (§6(c), task-role-apply.ts). */
export const TASK_ROLE_APPLY_CAPABILITY = 'task_role_apply' as const;
export type TaskRoleCapability = typeof TASK_ROLE_CAPABILITY | typeof TASK_ROLE_APPLY_CAPABILITY;
/** One in this many tasks that STATED a role is shadowed too, for free labels (§6(a)). */
export const STATED_ROLE_SAMPLE_EVERY = 5;

/**
 * Bump when the question, the kind definitions or the state shape change.
 * Role criteria are per workspace and logged per row, so they do not bump it.
 */
export const TASK_ROLE_PROMPT_VERSION = 'tr1';

// ── Candidates (§3) ──────────────────────────────────────────────────────────

/** A role row as the candidate builder reads it. */
export interface RoleRow {
  slug: string;
  name: string;
  workspaceId: string | null;
  enabled: boolean;
  isRole: boolean;
  metadata: unknown;
  allowedTools: string[] | null;
  connectorRefs: string[] | null;
  defaultBackend: string | null;
  /** Personal roles: the owner (NULL = team role or override) and who may run it. */
  ownerUserId?: string | null;
  visibility?: string | null;
  id?: string;
}

export interface RoleCandidate {
  slug: string;
  name: string;
  whenToUse: string;
  notFor?: string;
  connectorRefs: string[];
}

export type RoleExclusion =
  | 'disabled'
  | 'explicit'
  | 'routing_disabled'
  | 'no_when_to_use'
  | 'tools'
  | 'backend'
  | 'connectors';

/** What the per-task filters read about the task. */
export interface CandidateTask {
  workspaceId: string;
  /** The task's stored backend (resolved at creation). */
  backend?: string | null;
  outputRequirement?: string | null;
  /** A pathManifest that names files (not only the advisory wildcard). */
  pathManifestIsConcrete: boolean;
  emitsPlan: boolean;
  /**
   * Who the task is for. Their own private roles are candidates; another
   * member's never are. Omitted/null = no person: team and shared roles only.
   */
  requesterUserId?: string | null;
}

/**
 * The effective row per slug for one workspace (§3.1), by the shared role
 * precedence (@buildd/core/role-visibility): the workspace override wins, then
 * the requester's own personal role, then a shared personal role, else the
 * team default. Another member's private role is never a candidate, so role
 * inference cannot route work to it. `metadata.routing` is field-level (§2):
 * an override without its own `routing` inherits the team default's.
 * Rows must already be the task's team's, workspace NULL or the task's.
 */
export function resolveEffectiveRoles(
  rows: readonly RoleRow[],
  workspaceId: string,
  requesterUserId: string | null = null,
): RoleRow[] {
  const roles = rows.filter(r => r.isRole);
  const teamDefault = new Map<string, RoleRow>();
  for (const r of roles) if (r.workspaceId === null && r.ownerUserId == null) teamDefault.set(r.slug, r);
  const winners = effectiveVisibleRoles(
    roles.map(r => ({ ...r, teamId: '', ownerUserId: r.ownerUserId ?? null, visibility: r.visibility ?? 'team' })),
    { teamId: TEAM_SCOPED_BY_QUERY, workspaceId, requesterUserId },
  );
  return winners.map(w => {
    const { teamId: _scoped, ...o } = w;
    void _scoped;
    if (o.workspaceId === null) return o;
    const ownRouting = (o.metadata as { routing?: unknown } | null | undefined)?.routing;
    const inherited = (teamDefault.get(o.slug)?.metadata as { routing?: unknown } | null | undefined)?.routing;
    return ownRouting == null && inherited != null
      ? { ...o, metadata: { ...((o.metadata as object | null) ?? {}), routing: inherited } }
      : o;
  });
}

const WRITE_TOOLS = ['Edit', 'Write', 'Bash'];

/** Can a role with this `allowedTools` change files? Empty = all tools (§3.4). */
export function roleCanChangeFiles(allowedTools: string[] | null | undefined): boolean {
  if (!allowedTools || allowedTools.length === 0) return true;
  return allowedTools.some(t => WRITE_TOOLS.includes(t));
}

/**
 * Every structural filter except connectors, which need a DB look (§3.2–§3.5).
 * Pure. Returns candidates sorted by slug (§5: same set ⇒ same request) and the
 * reason each other role was excluded.
 */
export function filterRoleCandidates(
  effective: readonly RoleRow[],
  task: CandidateTask,
): { candidates: RoleCandidate[]; excluded: Record<string, RoleExclusion> } {
  const excluded: Record<string, RoleExclusion> = {};
  const candidates: RoleCandidate[] = [];
  const needsWrite = !task.emitsPlan && (task.outputRequirement === 'pr_required' || task.pathManifestIsConcrete);
  for (const r of [...effective].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const routing = readRoleRouting(r.metadata);
    if (!r.enabled) { excluded[r.slug] = 'disabled'; continue; }
    if (EXPLICIT_ROLE_SLUGS.includes(r.slug)) { excluded[r.slug] = 'explicit'; continue; }
    if (routing?.disabled) { excluded[r.slug] = 'routing_disabled'; continue; }
    if (!routing?.whenToUse) { excluded[r.slug] = 'no_when_to_use'; continue; }
    if (needsWrite && !roleCanChangeFiles(r.allowedTools)) { excluded[r.slug] = 'tools'; continue; }
    if (r.defaultBackend && task.backend && r.defaultBackend !== task.backend) { excluded[r.slug] = 'backend'; continue; }
    candidates.push({
      slug: r.slug,
      name: r.name,
      whenToUse: routing.whenToUse,
      ...(routing.notFor ? { notFor: routing.notFor } : {}),
      connectorRefs: r.connectorRefs ?? [],
    });
  }
  return { candidates, excluded };
}

/**
 * True when a role's connectors cannot be used in the workspace:
 * `never_mounted`, `blocked_by_policy` or `expired_or_revoked`, as `checkConnectorRouting` classifies
 * them, without its HTTP probe (§3.3).
 */
export type ConnectorsUnusable = (slug: string, workspaceId: string, teamId: string, requesterUserId?: string | null) => Promise<boolean>;

async function dbConnectorsUnusable(slug: string, workspaceId: string, teamId: string, requesterUserId: string | null = null): Promise<boolean> {
  const { checkConnectorRouting } = await import('@/app/api/workers/claim/connector-gate');
  const failures = await checkConnectorRouting(slug, workspaceId, teamId, { probe: false, requesterUserId });
  return !!failures?.some(f => f.mode === 'never_mounted' || f.mode === 'blocked_by_policy' || f.mode === 'expired_or_revoked');
}

export type LoadRoles = (teamId: string, workspaceId: string) => Promise<RoleRow[]>;

async function dbLoadRoles(teamId: string, workspaceId: string): Promise<RoleRow[]> {
  const { db } = await import('@buildd/core/db');
  const { workspaceSkills } = await import('@buildd/core/db/schema');
  const { and, eq, isNull, or } = await import('drizzle-orm');
  // Disabled rows are read too: a disabled override must not fall back to an
  // enabled team default.
  const rows = await db.query.workspaceSkills.findMany({
    where: and(
      eq(workspaceSkills.teamId, teamId),
      eq(workspaceSkills.isRole, true),
      or(isNull(workspaceSkills.workspaceId), eq(workspaceSkills.workspaceId, workspaceId)),
    ),
    columns: {
      id: true, slug: true, name: true, workspaceId: true, enabled: true, isRole: true,
      metadata: true, allowedTools: true, connectorRefs: true, defaultBackend: true,
      ownerUserId: true, visibility: true,
    },
  });
  return rows as RoleRow[];
}

/** The full candidate set for a task (§3). Never throws on a connector lookup: a failed look excludes the role. */
export async function buildRoleCandidates(
  task: CandidateTask & { teamId: string },
  deps: { loadRoles?: LoadRoles; connectorsUnusable?: ConnectorsUnusable } = {},
): Promise<{ candidates: RoleCandidate[]; excluded: Record<string, RoleExclusion> }> {
  const rows = await (deps.loadRoles ?? dbLoadRoles)(task.teamId, task.workspaceId);
  const requesterUserId = task.requesterUserId ?? null;
  const { candidates, excluded } = filterRoleCandidates(resolveEffectiveRoles(rows, task.workspaceId, requesterUserId), task);
  const unusable = deps.connectorsUnusable ?? dbConnectorsUnusable;
  const kept: RoleCandidate[] = [];
  for (const c of candidates) {
    if (c.connectorRefs.length > 0) {
      const bad = await unusable(c.slug, task.workspaceId, task.teamId, requesterUserId).catch(() => true);
      if (bad) { excluded[c.slug] = 'connectors'; continue; }
    }
    kept.push(c);
  }
  return { candidates: kept, excluded };
}

// ── Question and state (§5, §4.5) ────────────────────────────────────────────

/**
 * The `kind` labels (`TaskKind`), contrastive like the category criteria. No
 * catch-all: "none fits" shows up as low confidence.
 */
export const TASK_KIND_CRITERIA: Record<TaskKind, { what: string; not_for: string }> = {
  engineering: {
    what: 'Changes code, configuration, tests or infrastructure in a repository.',
    not_for: 'Only reading code to answer a question (research), or only editing prose docs (writing).',
  },
  research: {
    what: 'Investigates an open question by reading code, docs or the web and reports findings. Changes nothing.',
    not_for: 'Deriving a judgment from metrics or records (analysis), or making the change once decided (engineering).',
  },
  writing: {
    what: 'Produces prose: documentation, a spec, a design doc, a post or release notes.',
    not_for: 'Code or config changes (engineering), or a report of investigation findings (research).',
  },
  design: {
    what: 'Produces a visual or interaction artifact: UI layout, mockups, styling, UX flows.',
    not_for: 'Backend or API "design" that is really code (engineering) or a written proposal (writing).',
  },
  analysis: {
    what: 'Derives a judgment from data: metrics, logs, costs, usage or outcomes, measured and interpreted.',
    not_for: 'Open-ended investigation without a dataset (research), or watching for a condition over time (observation).',
  },
  observation: {
    what: 'Watches something (CI, a deploy, a PR, a schedule) and records what it saw, without acting on it.',
    not_for: 'Diagnosing or fixing what it sees (engineering), or planning follow-up work (coordination).',
  },
  coordination: {
    what: 'Plans, routes, splits or reconciles other tasks and missions; its output is other work being organized.',
    not_for: 'Doing any of that work itself.',
  },
};

export const TASK_KIND_QUESTION = {
  type: 'choice',
  instructions: {
    question: 'What shape of work does `task` ask for?',
    rule: 'Follow the definitions. Judge the output the task must produce, not its subject.',
  },
  criteria: TASK_KIND_CRITERIA,
} satisfies ChoiceQuestion<TaskKind>;

export type TaskRoleQuestions = {
  role: ChoiceQuestion<string>;
  kind?: ChoiceQuestion<TaskKind>;
};

/**
 * The role question over the candidates (§5): labels are role names (a shared
 * name gets its slug), criteria are the rendered routing text, sorted by slug.
 * Null with fewer than two candidates.
 */
export function buildRoleQuestion(candidates: readonly RoleCandidate[]): { question: ChoiceQuestion<string>; slugFor: Map<string, string> } | null {
  if (candidates.length < 2) return null;
  const sorted = [...candidates].sort((a, b) => a.slug.localeCompare(b.slug));
  const count = new Map<string, number>();
  for (const c of sorted) count.set(c.name, (count.get(c.name) ?? 0) + 1);
  const slugFor = new Map<string, string>();
  const criteria: Record<string, string> = {};
  for (const c of sorted) {
    const label = (count.get(c.name) ?? 0) > 1 ? `${c.name} (${c.slug})` : c.name;
    slugFor.set(label, c.slug);
    criteria[label] = renderRoutingCriterion(c);
  }
  return {
    slugFor,
    question: {
      type: 'choice',
      instructions: { ...currentTaskRolePrompt().value.roleInstructions },
      criteria,
    },
  };
}

/**
 * The question text of this decision, resolved through the versioned prompts
 * table (`@buildd/core/prompts`): an active row's body is JSON of exactly this
 * shape (the kind labels unchanged), else this public default runs. The role
 * criteria are each workspace's own routing text and are never part of it.
 */
export const TASK_ROLE_PROMPT_ID = 'buildd.task_role';

export const TASK_ROLE_PROMPT_DEFAULT = {
  roleInstructions: {
    question: 'Which role should do the work described in `task`?',
    rule: 'Follow the role definitions. The task title often names an action ("fix", "review", "document") that a definition assigns to a different role; the definition wins.',
  },
  kind: TASK_KIND_QUESTION,
};

function currentTaskRolePrompt() {
  return resolvePromptValueEntry(TASK_ROLE_PROMPT_ID, TASK_ROLE_PROMPT_DEFAULT);
}

/** The prompt version naming the text in effect. */
export function taskRolePromptVersion(): string {
  return resolvedPromptVersion(TASK_ROLE_PROMPT_VERSION, currentTaskRolePrompt());
}

/** The task fields the call may see (§5). Everything else, `context` included, is never sent. */
export interface TaskRoleStateInput {
  title: string;
  label?: string | null;
  /** The kind the caller stated, or null. */
  kind?: string | null;
  description?: string | null;
  pathManifest?: string[] | null;
  pathManifestIsConcrete: boolean;
  creationSource?: string | null;
  inMission: boolean;
  outputRequirement?: string | null;
}

export function buildTaskRoleState(t: TaskRoleStateInput) {
  const desc = (t.description ?? '').trim();
  return {
    task: {
      title: t.title.trim(),
      label: t.label ?? null,
      kind: t.kind ?? null,
      description: desc.length > SHADOW_DESCRIPTION_CHARS ? `${desc.slice(0, SHADOW_DESCRIPTION_CHARS)}…` : desc,
      paths: t.pathManifestIsConcrete && t.pathManifest ? t.pathManifest.slice(0, SHADOW_MAX_PATHS) : null,
      source: t.creationSource ?? null,
      inMission: t.inMission,
      output: t.outputRequirement ?? null,
    },
  };
}

/** Deterministic 1-in-N sample of stated-role tasks, keyed on the task id. */
export function inStatedRoleSample(taskId: string): boolean {
  return createHash('sha256').update(taskId).digest()[0] % STATED_ROLE_SAMPLE_EVERY === 0;
}

/**
 * A hash of the inputs the model is actually asked about (the candidate set
 * and the state it sees), for the decision ledger. Independent of whether the
 * call itself succeeds, so a timed-out or errored look still carries a
 * fingerprint a later look at the same facts can be compared against.
 */
export function taskRoleFingerprint(input: { candidates: readonly string[]; askKind: boolean; state: unknown }): string {
  return createHash('sha256')
    .update(JSON.stringify({ candidates: [...input.candidates].sort(), askKind: input.askKind, state: input.state }))
    .digest('hex')
    .slice(0, 16);
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface TaskRoleShadowInput extends TaskRoleStateInput, CandidateTask {
  taskId: string;
  teamId: string;
  accountId?: string | null;
  /** The role the caller stated; a stated-role task is shadowed only in the sample. */
  statedRoleSlug?: string | null;
  /** The #2616 heuristic's kind when it fired, logged for agreement (§4.5). */
  kindHeuristic?: string | null;
  /** `workspaces.gitConfig.dataClass`. Sensitive workspaces never send content out. */
  dataClass?: string | null;
}

type DecideFn = typeof decisionCall<TaskRoleQuestions>;
type ResolveAccess = (opts: { capability: TaskRoleCapability; teamId: string; workspaceId: string; accountId: string | null }) => Promise<DecisionAccess>;
export type ReadClaimedAt = (taskId: string) => Promise<Date | null>;

async function dbReadClaimedAt(taskId: string): Promise<Date | null> {
  const { db } = await import('@buildd/core/db');
  const { tasks } = await import('@buildd/core/db/schema');
  const { eq } = await import('drizzle-orm');
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId), columns: { claimedAt: true } });
  return row?.claimedAt ?? null;
}

export interface TaskRoleShadowDeps {
  decide?: DecideFn;
  resolveAccess?: ResolveAccess;
  loadRoles?: LoadRoles;
  connectorsUnusable?: ConnectorsUnusable;
  readClaimedAt?: ReadClaimedAt;
  log?: (line: string) => void;
}

export type TaskRoleShadowOutcome =
  | 'logged'
  | 'not_sampled'
  | 'sensitive'
  | 'disabled'
  | 'no_key'
  | 'too_few_candidates'
  | 'error';

export interface TaskRoleShadowRecord {
  site: 'task_role';
  v: string;
  /** Hash of the candidate set and state the model saw (decision ledger). */
  fingerprint: string;
  taskId: string;
  workspaceId: string;
  stated?: string;
  candidates: string[];
  excluded: Record<string, RoleExclusion>;
  decision: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  kindDecision: string | null;
  kindConfidence: number | null;
  kindHeuristic: string | null;
  claimedBeforeDecision: boolean | null;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  costUsd: number | null;
}

/**
 * Look at one task and log what role (and kind) the model would give it.
 * Never throws, never writes.
 */
export interface TaskRoleShadowResult {
  outcome: TaskRoleShadowOutcome;
  record?: TaskRoleShadowRecord;
  /** The call was made under `task_role_apply`: the team allows this answer to be written. */
  applyEnabled?: boolean;
  /** Set once the candidate set is known, even on `too_few_candidates` or `error` (decision ledger). */
  fingerprint?: string;
}

export async function runTaskRoleShadow(input: TaskRoleShadowInput, deps: TaskRoleShadowDeps = {}): Promise<TaskRoleShadowResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    if (input.statedRoleSlug && !inStatedRoleSample(input.taskId)) return { outcome: 'not_sampled' };

    // Policy and key first: a team that has not opted in pays no candidate query.
    // A role-less task asks under the apply capability when the team turned it
    // on, so apply works without the shadow listed too; a stated-role task is
    // never an apply candidate and only ever asks as the shadow.
    const client = deps.decide && deps.resolveAccess ? null : await import('@buildd/core/decision-client');
    const resolveAccess = deps.resolveAccess ?? (client!.resolveDecisionAccess as ResolveAccess);
    const scope = { teamId: input.teamId, workspaceId: input.workspaceId, accountId: input.accountId ?? null };
    let capability: TaskRoleCapability = TASK_ROLE_CAPABILITY;
    let access = input.statedRoleSlug ? null : await resolveAccess({ capability: TASK_ROLE_APPLY_CAPABILITY, ...scope });
    if (access?.ok) capability = TASK_ROLE_APPLY_CAPABILITY;
    else access = await resolveAccess({ capability: TASK_ROLE_CAPABILITY, ...scope });
    if (!access.ok) {
      // Opted in but no key: a row, so it reads differently from a capability that is off.
      return access.error.kind === 'missing_key'
        ? { outcome: 'no_key', applyEnabled: true, fingerprint: 'skip:no_key' }
        : { outcome: 'disabled' };
    }
    // Past the opt-in check, so the apply step can leave a content-free ledger row for it.
    if (input.dataClass === 'sensitive') return { outcome: 'sensitive', applyEnabled: true, fingerprint: 'skip:sensitive' };
    // Apply is the default once the capability is on at all: a separate
    // "shadow only" tier no longer exists for this decision (2026-10-03 owner
    // decision). Listing either capability is enough; the rails in
    // task-role-apply.ts are what actually gate the write.
    const applyEnabled = true;

    const { candidates, excluded } = await buildRoleCandidates(input, deps);
    const askKind = !input.kind;
    const state = buildTaskRoleState(input);
    const fingerprint = taskRoleFingerprint({ candidates: candidates.map(c => c.slug), askKind, state });
    const roleQ = buildRoleQuestion(candidates);
    if (!roleQ) return { outcome: 'too_few_candidates', fingerprint, applyEnabled };

    const questions: TaskRoleQuestions = askKind
      ? { role: roleQ.question, kind: currentTaskRolePrompt().value.kind }
      : { role: roleQ.question };

    const decide = deps.decide ?? (client!.decisionCall as DecideFn);
    const res: DecisionResult<TaskRoleQuestions> = await decide({
      capability,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      state,
      questions,
      timeoutMs: SHADOW_TIMEOUT_MS,
      access,
    });

    if (!res.ok) {
      log(`${DECISION_SHADOW_LOG_PREFIX} ${JSON.stringify({ site: 'task_role', taskId: input.taskId, error: res.error.kind, latencyMs: res.latencyMs })}`);
      return { outcome: 'error', fingerprint };
    }

    // Read-only: the answer is useless for apply once a runner has the task (Open decision 5).
    const claimedAt = await (deps.readClaimedAt ?? dbReadClaimedAt)(input.taskId).catch(() => undefined);

    const role = res.answers.role;
    const kind = askKind ? (res.answers as { kind?: { choice: string; confidence: number } }).kind : undefined;
    const probabilities = role.probabilities
      ? Object.fromEntries(Object.entries(role.probabilities).map(([label, p]) => [roleQ.slugFor.get(label) ?? label, p]))
      : null;
    const record: TaskRoleShadowRecord = {
      site: 'task_role',
      v: `${taskRolePromptVersion()}|${res.model}`,
      fingerprint,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      ...(input.statedRoleSlug ? { stated: input.statedRoleSlug } : {}),
      candidates: candidates.map(c => c.slug),
      excluded,
      decision: roleQ.slugFor.get(role.choice) ?? null,
      confidence: role.confidence,
      probabilities,
      kindDecision: kind?.choice ?? null,
      kindConfidence: kind?.confidence ?? null,
      kindHeuristic: input.kindHeuristic ?? null,
      claimedBeforeDecision: claimedAt === undefined ? null : claimedAt !== null,
      model: res.model,
      latencyMs: res.latencyMs,
      inputTokens: res.usage?.inputTokens ?? null,
      costUsd: res.usage?.costUsd ?? null,
    };
    // Ids, slugs and numbers only: never the task's text or a role's routing text.
    log(`${DECISION_SHADOW_LOG_PREFIX} ${JSON.stringify(record)}`);
    return { outcome: 'logged', record, applyEnabled, fingerprint };
  } catch (err) {
    console.error(`${DECISION_SHADOW_LOG_PREFIX} task_role failed (non-fatal, task unaffected):`, err);
    return { outcome: 'error' };
  }
}

/**
 * Run after the response, so it can never delay or fail task creation.
 * `schedule` is `next/server`'s `after`; outside a request scope it throws, and
 * the run is fired and forgotten instead.
 */
export function scheduleTaskRoleShadow(
  input: TaskRoleShadowInput,
  schedule: (fn: () => Promise<unknown>) => void,
  deps: TaskRoleShadowDeps = {},
): void {
  const run = () => runTaskRoleShadow(input, deps);
  try {
    schedule(run);
  } catch {
    void run();
  }
}

// Registered for the deploy seed and the fallback alert (`@buildd/core/prompts`).
registerValuePrompt(TASK_ROLE_PROMPT_ID, TASK_ROLE_PROMPT_DEFAULT);
