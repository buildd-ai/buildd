/**
 * Mission scope amendments (docs/specs/workflow-kernel-library.md §6 "Scope
 * amendments"; task f3bda4e1 part 2). People learn during a mission: a task
 * added to an existing mission is either a decomposition of the contract it
 * already has (IN_SCOPE), or it changes what "done" means (AMEND_SCOPE), or
 * nobody can safely tell (ASK). The answer is a recorded fact (the Decide
 * port's `decideAndRecord`), and its consequence is durable state: an
 * auditable amendment with the mission's description and goal criteria before
 * and after, the reason, the task that caused it, and the scope version it
 * moved the mission to.
 *
 * This module is the pure half: the decision point and its default, the
 * criteria weakening rule, and `planScope`, which turns the recorded decision
 * into what the host writes. The decision never opens a path the rules close:
 * an amendment that would remove or weaken a completion criterion is held for
 * a person whatever the decider said.
 */
import type { DecisionPoint } from './decide';

export const SCOPE_VERDICTS = ['in_scope', 'amend_scope', 'ask'] as const;
export type ScopeVerdict = (typeof SCOPE_VERDICTS)[number];

/** A goal criterion, as much of it as the weakening rule reads. */
export interface ScopeCriterion {
  type: string;
  label?: string;
  command?: string;
  description?: string;
  [k: string]: unknown;
}

/** What the filer proposed the mission's contract should become, if anything. */
export interface ScopeProposal {
  description?: string | null;
  goalCriteria?: ScopeCriterion[] | null;
  reason?: string | null;
}

export interface ScopeInput extends Record<string, unknown> {
  taskId: string;
  missionTitle: string;
  missionDescription: string;
  /** Criterion labels or summaries (never commands' output). */
  criteria: string[];
  taskTitle: string;
  taskDescription: string;
  /** Deliveries of the mission that already reached trunk. */
  deliveriesMerged: number;
  /** The filer attached an explicit proposal. */
  proposed: boolean;
}

/**
 * `mission_scope`: does this task fit the mission's current contract? The
 * default never nags: with no usable answer a task is a decomposition of
 * the contract (`in_scope`), unless the filer itself proposed an amendment,
 * which is then taken as asked (and still checked for weakening).
 */
export const MISSION_SCOPE_POINT: DecisionPoint<ScopeInput> = {
  name: 'mission_scope',
  verdicts: SCOPE_VERDICTS,
  minConfidence: 0.7,
  fallback: (i) => (i.proposed ? { verdict: 'amend_scope', reason: 'filer_proposed' } : { verdict: 'in_scope', reason: 'default_decomposition' }),
  inputKey: (i) => i.taskId,
};

/** Bounded text for the decider: the mission's words, never anything else. */
export const SCOPE_TEXT_LIMIT = 2_000;
export const clipScopeText = (s: string | null | undefined, n = SCOPE_TEXT_LIMIT): string => {
  const t = (s ?? '').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

// ── Weakening ───────────────────────────────────────────────────────────────

/** Criteria a machine checks: dropping one, or turning it into prose, weakens the gate. */
const MECHANICAL = new Set(['command', 'all_prs_merged', 'no_open_tasks', 'artifact_exists', 'living_spec']);

export interface Weakening {
  criterion: string;
  how: 'removed' | 'command_changed' | 'made_prose' | 'cleared';
}

const identity = (c: ScopeCriterion): string =>
  c.label?.trim() || (c.type === 'command' ? `command: ${c.command ?? ''}` : c.type === 'description' ? `description: ${c.description ?? ''}` : c.type);

/**
 * Does `after` weaken a criterion `before` requires? Removing one, changing a
 * command, replacing a mechanical one with prose, or clearing the list all
 * do. Adding criteria never does; neither does editing prose wording.
 */
export function criteriaWeakening(before: ScopeCriterion[] | null | undefined, after: ScopeCriterion[] | null | undefined): Weakening[] {
  const prior = before ?? [];
  if (after === undefined) return [];
  if (prior.length > 0 && (after === null || after.length === 0)) return prior.map((c) => ({ criterion: identity(c), how: 'cleared' as const }));
  const next = after ?? [];
  const out: Weakening[] = [];
  for (const c of prior) {
    const id = identity(c);
    const same = next.find((n) => identity(n) === id) ?? (c.label ? null : next.find((n) => n.type === c.type && n.command === c.command));
    if (!same) {
      // A labelled criterion whose label survives under another type: is the replacement weaker?
      const relabelled = c.label ? next.find((n) => n.label?.trim() === c.label?.trim()) : null;
      if (relabelled && MECHANICAL.has(c.type) && relabelled.type === 'description') out.push({ criterion: id, how: 'made_prose' });
      else out.push({ criterion: id, how: 'removed' });
      continue;
    }
    if (c.type === 'command' && same.type === 'command' && (same.command ?? '').trim() !== (c.command ?? '').trim()) out.push({ criterion: id, how: 'command_changed' });
    if (MECHANICAL.has(c.type) && same.type === 'description') out.push({ criterion: id, how: 'made_prose' });
  }
  return out;
}

// ── The plan ────────────────────────────────────────────────────────────────

export interface MissionScopeState {
  description: string | null;
  goalCriteria: ScopeCriterion[] | null;
  scopeVersion: number;
}

export type ScopeStatus = 'recorded' | 'applied' | 'held';

export interface ScopePlan {
  decision: ScopeVerdict;
  /** recorded: nothing changes (in scope); applied: the contract moved; held: a person decides. */
  status: ScopeStatus;
  before: { description: string | null; goalCriteria: ScopeCriterion[] | null };
  /** The contract after the amendment (for `held`, what it would have been). Null for `recorded`. */
  after: { description: string | null; goalCriteria: ScopeCriterion[] | null } | null;
  weakens: Weakening[];
  scopeVersionBefore: number;
  /** The version the mission moves to; null unless applied. */
  scopeVersionAfter: number | null;
  /** In words a person can act on. */
  reason: string;
}

/**
 * The recorded decision as what to write. Pure.
 *
 *  - `in_scope`: recorded, nothing changes (scenario 5);
 *  - `amend_scope`: the filer's proposal, or by default the task named in a
 *    scope update line appended to the description; applied and the version
 *    moves (scenario 6), unless it weakens a criterion, then held (scenario 7);
 *  - `ask`: held.
 */
export function planScope(p: {
  verdict: string;
  reason: string;
  mission: MissionScopeState;
  task: { id: string; title: string };
  proposal?: ScopeProposal | null;
}): ScopePlan {
  const before = { description: p.mission.description, goalCriteria: p.mission.goalCriteria };
  const base = { before, scopeVersionBefore: p.mission.scopeVersion, scopeVersionAfter: null, weakens: [] as Weakening[] };
  const verdict: ScopeVerdict = (SCOPE_VERDICTS as readonly string[]).includes(p.verdict) ? (p.verdict as ScopeVerdict) : 'ask';
  if (verdict === 'in_scope') return { ...base, decision: 'in_scope', status: 'recorded', after: null, reason: p.reason };

  const next = p.mission.scopeVersion + 1;
  const proposal = p.proposal ?? null;
  const description = proposal?.description != null && proposal.description.trim()
    ? proposal.description
    : `${(p.mission.description ?? '').trimEnd()}${p.mission.description?.trim() ? '\n\n' : ''}Scope update (version ${next}): ${p.task.title.trim()}${proposal?.reason ? ` (${proposal.reason.trim()})` : ''}.`;
  const goalCriteria = proposal && proposal.goalCriteria !== undefined ? proposal.goalCriteria : p.mission.goalCriteria;
  const after = { description, goalCriteria };
  const weakens = criteriaWeakening(p.mission.goalCriteria, proposal?.goalCriteria);

  if (verdict === 'ask') return { ...base, decision: 'ask', status: 'held', after, weakens, reason: p.reason };
  if (weakens.length > 0) {
    return {
      ...base, decision: 'amend_scope', status: 'held', after, weakens,
      reason: `it would weaken ${weakens.map((w) => `"${w.criterion}" (${w.how.replace('_', ' ')})`).join(', ')}`,
    };
  }
  return { ...base, decision: 'amend_scope', status: 'applied', after, weakens, scopeVersionAfter: next, reason: p.reason };
}
