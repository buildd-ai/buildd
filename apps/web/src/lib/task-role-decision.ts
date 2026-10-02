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
 * Runs only for teams that list `task_role_shadow` in
 * `teams.enabledDecisionShadows` (an `opt_in` capability,
 * packages/core/inference-policy.ts), and only when a decision key resolves.
 * The policy check runs before the candidate query, so a team that has not
 * opted in costs one team-row read.
 *
 * Telemetry: one `[decision-shadow]` line per look, ids, slugs, labels and
 * numbers only — never the task's text or a role's routing text.
 */
import { createHash } from 'node:crypto';
import { EXPLICIT_ROLE_SLUGS } from '@buildd/shared';
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

export const SHADOW_TIMEOUT_MS = 3_000;
export const SHADOW_DESCRIPTION_CHARS = 1_500;
export const SHADOW_MAX_PATHS = 20;
export const DECISION_SHADOW_LOG_PREFIX = '[decision-shadow]';
export const TASK_ROLE_CAPABILITY = 'task_role_shadow' as const;
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
}

/**
 * The effective row per slug for one workspace (§3.1): the workspace override
 * wins, else the team default. `metadata.routing` is field-level (§2): an
 * override without its own `routing` inherits the team default's.
 * Rows must already be the task's team's, workspace NULL or the task's.
 */
export function resolveEffectiveRoles(rows: readonly RoleRow[], workspaceId: string): RoleRow[] {
  const team = new Map<string, RoleRow>();
  const override = new Map<string, RoleRow>();
  for (const r of rows) {
    if (!r.isRole) continue;
    if (r.workspaceId === null) team.set(r.slug, r);
    else if (r.workspaceId === workspaceId) override.set(r.slug, r);
  }
  const out: RoleRow[] = [];
  for (const slug of new Set([...team.keys(), ...override.keys()])) {
    const o = override.get(slug);
    const t = team.get(slug);
    if (!o) { out.push(t!); continue; }
    const ownRouting = (o.metadata as { routing?: unknown } | null | undefined)?.routing;
    const inherited = (t?.metadata as { routing?: unknown } | null | undefined)?.routing;
    out.push(ownRouting == null && inherited != null
      ? { ...o, metadata: { ...((o.metadata as object | null) ?? {}), routing: inherited } }
      : o);
  }
  return out;
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
 * `never_mounted` or `expired_or_revoked`, as `checkConnectorRouting` classifies
 * them, without its HTTP probe (§3.3).
 */
export type ConnectorsUnusable = (slug: string, workspaceId: string, teamId: string) => Promise<boolean>;

async function dbConnectorsUnusable(slug: string, workspaceId: string, teamId: string): Promise<boolean> {
  const { checkConnectorRouting } = await import('@/app/api/workers/claim/connector-gate');
  const failures = await checkConnectorRouting(slug, workspaceId, teamId, { probe: false });
  return !!failures?.some(f => f.mode === 'never_mounted' || f.mode === 'expired_or_revoked');
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
      slug: true, name: true, workspaceId: true, enabled: true, isRole: true,
      metadata: true, allowedTools: true, connectorRefs: true, defaultBackend: true,
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
  const { candidates, excluded } = filterRoleCandidates(resolveEffectiveRoles(rows, task.workspaceId), task);
  const unusable = deps.connectorsUnusable ?? dbConnectorsUnusable;
  const kept: RoleCandidate[] = [];
  for (const c of candidates) {
    if (c.connectorRefs.length > 0) {
      const bad = await unusable(c.slug, task.workspaceId, task.teamId).catch(() => true);
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
      instructions: {
        question: 'Which role should do the work described in `task`?',
        rule: 'Follow the role definitions. The task title often names an action ("fix", "review", "document") that a definition assigns to a different role; the definition wins.',
      },
      criteria,
    },
  };
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
type ResolveAccess = (opts: { capability: typeof TASK_ROLE_CAPABILITY; teamId: string; workspaceId: string; accountId: string | null }) => Promise<DecisionAccess>;
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
  | 'too_few_candidates'
  | 'error';

export interface TaskRoleShadowRecord {
  site: 'task_role';
  v: string;
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
export async function runTaskRoleShadow(input: TaskRoleShadowInput, deps: TaskRoleShadowDeps = {}): Promise<{ outcome: TaskRoleShadowOutcome; record?: TaskRoleShadowRecord }> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    if (input.statedRoleSlug && !inStatedRoleSample(input.taskId)) return { outcome: 'not_sampled' };
    if (input.dataClass === 'sensitive') return { outcome: 'sensitive' };

    // Policy and key first: a team that has not opted in pays no candidate query.
    const client = deps.decide && deps.resolveAccess ? null : await import('@buildd/core/decision-client');
    const resolveAccess = deps.resolveAccess ?? (client!.resolveDecisionAccess as ResolveAccess);
    const access = await resolveAccess({
      capability: TASK_ROLE_CAPABILITY, teamId: input.teamId, workspaceId: input.workspaceId, accountId: input.accountId ?? null,
    });
    if (!access.ok) return { outcome: 'disabled' };

    const { candidates, excluded } = await buildRoleCandidates(input, deps);
    const roleQ = buildRoleQuestion(candidates);
    if (!roleQ) return { outcome: 'too_few_candidates' };

    const askKind = !input.kind;
    const questions: TaskRoleQuestions = askKind
      ? { role: roleQ.question, kind: TASK_KIND_QUESTION }
      : { role: roleQ.question };

    const decide = deps.decide ?? (client!.decisionCall as DecideFn);
    const res: DecisionResult<TaskRoleQuestions> = await decide({
      capability: TASK_ROLE_CAPABILITY,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      state: buildTaskRoleState(input),
      questions,
      timeoutMs: SHADOW_TIMEOUT_MS,
      access,
    });

    if (!res.ok) {
      log(`${DECISION_SHADOW_LOG_PREFIX} ${JSON.stringify({ site: 'task_role', taskId: input.taskId, error: res.error.kind, latencyMs: res.latencyMs })}`);
      return { outcome: 'error' };
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
      v: `${TASK_ROLE_PROMPT_VERSION}|${res.model}`,
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
    return { outcome: 'logged', record };
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
