/**
 * An advisory verdict on a mission's goal criteria
 * (docs/specs/mission-goal-criteria-quality.md): would a user notice the
 * outcome each criterion states, and can it be checked without a person
 * reading prose? A decision model (Jev) answers per criterion with fixed
 * labels, plus one rewrite label for the whole goal. The text the author would
 * see is a code-owned table keyed by that label; the model writes none of it.
 *
 * What is sent: each criterion's `type`, `label`, and for a `description`
 * criterion its description text. Never a command string, an artifact key, a
 * metric query, the mission title or description, or any id. A sensitive
 * workspace sends nothing.
 *
 * Bookkeeping (`all_prs_merged`, `no_open_tasks`) is true of every finished
 * mission, so it is graded as bookkeeping by type, deterministically, and never
 * sent or warned on. A `command` is graded on the outcome its label says the
 * command asserts, not on the fact that it runs.
 *
 * Shadow first, modelled on `mission_strand_choice`
 * (strand-choice-decision.ts): with the team's `mission_goal_quality`
 * capability on, the verdict is logged as a `[decision-shadow]` line and weak
 * criteria get a `warned` row in the gate ledger. The response is unchanged.
 * `GOAL_QUALITY_MODE` moves to `surface` in code, in its own PR, after the
 * readout; never by configuration.
 *
 * Fails open by construction: disabled, no key, a sensitive workspace, a
 * timeout, an error, an unknown label or a throw all return null.
 */
import { createHash } from 'node:crypto';
import type { GoalCriterion } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import { GATE_SLUGS } from '@buildd/core/gate-slugs';
import type {
  ChoiceQuestion,
  DecisionAccess,
  DecisionReceipt,
  decisionCall,
} from '@buildd/core/decision-client';
import type { GateCallerOrigin, RecordGateEventInput } from '@buildd/core/gate-events';
import { CODE_RUBRIC, GOAL_QUALITY_BASELINE_RUBRIC, type GoalQualityRubric } from './goal-criteria-rubric';

export const DECISION_SHADOW_LOG_PREFIX = '[decision-shadow]';
export const GOAL_QUALITY_CAPABILITY = 'mission_goal_quality' as const;
export const GOAL_QUALITY_DECISION_ID = 'mission_goal_quality';
export const GOAL_QUALITY_LOG_SITE = 'goal_criteria_quality';
export const GOAL_QUALITY_TIMEOUT_MS = 3_000;
/** A weak label counts at or above this. Proposed; set from the shadow readout. */
export const GOAL_QUALITY_MIN_CONFIDENCE = 0.8;
/**
 * Bump when a question, a definition, the code-default rubric or the state
 * shape changes. A rubric read from memory is versioned on its own
 * (`GoalQualityRubric.version`), logged and cached alongside this.
 */
export const GOAL_QUALITY_PROMPT_VERSION = 'gq2';

/**
 * `shadow`: log and ledger only, response unchanged. `surface`: the response
 * carries an advisory (not built yet). Raised in code, in its own PR, after
 * the readout — never by configuration, workspace setting or request flag.
 */
export const GOAL_QUALITY_MODE: 'shadow' | 'surface' = 'shadow';

/** Closing-out checks: true of any finished mission, so they say nothing about this one. */
export const BOOKKEEPING_CRITERION_TYPES = ['all_prs_merged', 'no_open_tasks'] as const;
/** Types whose verdict is a machine's by construction, so `checkable` is not asked. */
const MECHANICALLY_CHECKED_TYPES = ['command', 'artifact_exists', ...BOOKKEEPING_CRITERION_TYPES] as const;

export const NOTICEABLE_LABELS = ['yes', 'no', 'bookkeeping'] as const;
export type NoticeableLabel = typeof NOTICEABLE_LABELS[number];
export const CHECKABLE_LABELS = ['yes', 'no'] as const;
export type CheckableLabel = typeof CHECKABLE_LABELS[number];
export const REWRITE_LABELS = ['state-outcome', 'command-proof', 'artifact-proof', 'none'] as const;
export type RewriteLabel = typeof REWRITE_LABELS[number];

/** What the author would see for each rewrite label. The model only picks the key. */
export const GOAL_QUALITY_REWRITES: Record<RewriteLabel, string | null> = {
  'state-outcome': 'Say what a user can do or see when this is done, in one sentence.',
  'command-proof': 'Back the outcome with a command that exits 0 only when it holds.',
  'artifact-proof': 'Name the deliverable and check it with artifact_exists.',
  none: null,
};

/** The code-owned baseline rubric (lib/goal-criteria-rubric.ts); a team's memory may replace it. */
export const GOAL_QUALITY_RUBRIC = GOAL_QUALITY_BASELINE_RUBRIC;

const NOTICEABLE_DEFINITIONS: Record<NoticeableLabel, { what: string; not_for: string }> = {
  yes: {
    what: 'The criterion names a change a user or the workspace owner would see or be able to do: a page, a behaviour, a result, a deliverable they would use.',
    not_for: 'Process facts about the work itself (tests pass, code merged, build green) or vague qualities with no observable change.',
  },
  no: {
    what: 'The criterion states something about the work or the code that no user would notice, or is too vague to name any change at all.',
    not_for: 'A concrete user-visible change, or pure closing-out of the work (that is bookkeeping).',
  },
  bookkeeping: {
    what: 'The criterion only closes out the work: PRs merged, tasks closed, CI green, branch cleaned up — true of any finished mission.',
    not_for: 'A check that would fail if the user-visible outcome did not hold, even if it runs in CI.',
  },
};

const CHECKABLE_DEFINITIONS: Record<CheckableLabel, { what: string; not_for: string }> = {
  yes: {
    what: 'Two people reading the criterion would agree whether it holds by looking at one concrete thing: a page, a number, a file, a behaviour.',
    not_for: 'Judgement words (feels faster, is cleaner, is better) with no named thing to look at.',
  },
  no: {
    what: 'Whether it holds is a matter of opinion or needs a person to read prose and decide; no concrete thing settles it.',
    not_for: 'A criterion that names exactly what to look at, even if a person does the looking.',
  },
};

const REWRITE_DEFINITIONS: Record<RewriteLabel, { what: string; not_for: string }> = {
  'state-outcome': {
    what: 'The goal never says what a user can do or see when it is done; the most useful change is to state that outcome.',
    not_for: 'A goal that already states its outcome but lacks a check for it.',
  },
  'command-proof': {
    what: 'The outcome is stated, but nothing mechanical checks it; a script that exits 0 only when it holds would.',
    not_for: 'An outcome that is a document or file rather than a behaviour, or a goal that never states an outcome.',
  },
  'artifact-proof': {
    what: 'The outcome is a named deliverable (a report, a design, a doc) that nothing checks exists.',
    not_for: 'A behaviour a command can check, or a goal that never states an outcome.',
  },
  none: {
    what: 'The goal already states a noticeable outcome and checks it.',
    not_for: 'Any goal where one of the three rewrites would make it clearer or checkable.',
  },
};

// ── Facts ────────────────────────────────────────────────────────────────────

export interface GoalQualityFacts {
  missionId: string;
  teamId: string;
  workspaceId: string | null;
  accountId?: string | null;
  userId?: string | null;
  /** `workspaces.gitConfig.dataClass`. A sensitive workspace never sends anything out. */
  dataClass?: string | null;
  /** The criteria as written (POST) or the full array after the write (PATCH). */
  criteria: readonly GoalCriterion[];
  /** PATCH: the criteria stored before the write. Byte-identical ones are not re-graded. */
  stored?: unknown;
}

export interface IndexedCriterion {
  /** Position in the submitted array. */
  index: number;
  criterion: GoalCriterion;
}

function isBookkeeping(c: GoalCriterion): boolean {
  return (BOOKKEEPING_CRITERION_TYPES as readonly string[]).includes(c.type);
}

/** Criteria this write adds or changes: not byte-identical to a stored one (the `validateGoalCriteria` rule). */
function newCriteria(criteria: readonly GoalCriterion[], stored?: unknown): IndexedCriterion[] {
  const unchanged = new Set((Array.isArray(stored) ? stored : []).map(c => JSON.stringify(c)));
  return criteria.flatMap((criterion, index) => (unchanged.has(JSON.stringify(criterion)) ? [] : [{ index, criterion }]));
}

/** What the model is asked about: new, non-bookkeeping criteria. Pure. */
export function gradedCriteria(criteria: readonly GoalCriterion[], stored?: unknown): IndexedCriterion[] {
  return newCriteria(criteria, stored).filter(g => !isBookkeeping(g.criterion));
}

/** What the call may see: type, label, and a prose criterion's description. Nothing else. */
export function buildGoalQualityState(criteria: readonly GoalCriterion[]) {
  return {
    criteria: criteria.map(c => ({
      type: c.type,
      ...(c.label ? { label: c.label } : {}),
      ...(c.type === 'description' ? { description: c.description } : {}),
    })),
  };
}

// ── Questions ────────────────────────────────────────────────────────────────

type Questions = Record<string, ChoiceQuestion<string>>;

function asksCheckable(c: GoalCriterion): boolean {
  return !(MECHANICALLY_CHECKED_TYPES as readonly string[]).includes(c.type);
}

/**
 * Per graded criterion (by its position in the state, `criteria[i]`):
 * `c{i}_noticeable`, and `c{i}_checkable` when its type is not checked by a
 * machine already. One `rewrite` for the whole goal.
 */
export function buildGoalQualityQuestions(graded: readonly IndexedCriterion[], rubric: string = GOAL_QUALITY_RUBRIC) {
  const questions: Questions = {};
  graded.forEach((g, i) => {
    questions[`c${i}_noticeable`] = {
      type: 'choice',
      instructions: {
        question: `Would a user notice the outcome that criteria[${i}] states?`,
        rule: rubric,
      },
      criteria: NOTICEABLE_DEFINITIONS,
    };
    if (asksCheckable(g.criterion)) {
      questions[`c${i}_checkable`] = {
        type: 'choice',
        instructions: {
          question: `Can whether criteria[${i}] holds be checked without a person reading prose and deciding?`,
          rule: rubric,
        },
        criteria: CHECKABLE_DEFINITIONS,
      };
    }
  });
  questions.rewrite = {
    type: 'choice',
    instructions: {
      question: 'Taking the criteria together, which one change would most improve this goal?',
      rule: rubric,
    },
    criteria: REWRITE_DEFINITIONS,
  };
  return questions as Questions & { rewrite: ChoiceQuestion<RewriteLabel> };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export interface CriterionQuality {
  index: number;
  fingerprint: string;
  type: GoalCriterion['type'];
  noticeable: NoticeableLabel;
  noticeableConfidence: number;
  checkable: CheckableLabel;
  checkableConfidence: number;
  weak: boolean;
  weakOn: Array<'noticeable' | 'checkable'>;
}

export interface GoalQualityVerdict {
  /** Every criterion this write added or changed, bookkeeping included (graded by type). */
  criteria: CriterionQuality[];
  weakCount: number;
  rewrite: RewriteLabel;
  rewriteConfidence: number;
  /** The rendered rewrite, only when something is weak. */
  suggestion: string | null;
  model: string;
  promptVersion: string;
  /** `base` for the code default, else the memory rubric's digest. */
  rubricVersion: string;
}

interface Answer { choice: string; confidence: number }
/** What a cache entry holds: the model's answers by question name, not a verdict tied to array positions. */
interface CachedAnswers { answers: Record<string, Answer>; model: string }

function toVerdict(
  fresh: readonly IndexedCriterion[],
  graded: readonly IndexedCriterion[],
  cached: CachedAnswers,
  rubricVersion: string,
): GoalQualityVerdict | null {
  const { answers } = cached;
  const pos = new Map(graded.map((g, i) => [g.index, i]));
  const criteria: CriterionQuality[] = [];
  for (const { index, criterion } of fresh) {
    const base = { index, fingerprint: criterionFingerprint(criterion), type: criterion.type };
    const i = pos.get(index);
    if (i === undefined) {
      criteria.push({ ...base, noticeable: 'bookkeeping', noticeableConfidence: 1, checkable: 'yes', checkableConfidence: 1, weak: false, weakOn: [] });
      continue;
    }
    const n = answers[`c${i}_noticeable`];
    if (!n || !(NOTICEABLE_LABELS as readonly string[]).includes(n.choice)) return null;
    const c = asksCheckable(criterion) ? answers[`c${i}_checkable`] : { choice: 'yes', confidence: 1 };
    if (!c || !(CHECKABLE_LABELS as readonly string[]).includes(c.choice)) return null;
    const weakOn: CriterionQuality['weakOn'] = [];
    if (n.choice === 'no' && n.confidence >= GOAL_QUALITY_MIN_CONFIDENCE) weakOn.push('noticeable');
    if (c.choice === 'no' && c.confidence >= GOAL_QUALITY_MIN_CONFIDENCE) weakOn.push('checkable');
    criteria.push({
      ...base,
      noticeable: n.choice as NoticeableLabel,
      noticeableConfidence: n.confidence,
      checkable: c.choice as CheckableLabel,
      checkableConfidence: c.confidence,
      weak: weakOn.length > 0,
      weakOn,
    });
  }
  const r = answers.rewrite;
  if (!r || !(REWRITE_LABELS as readonly string[]).includes(r.choice)) return null;
  const rewrite = r.choice as RewriteLabel;
  const weakCount = criteria.filter(c => c.weak).length;
  return {
    criteria,
    weakCount,
    rewrite,
    rewriteConfidence: r.confidence,
    suggestion: weakCount > 0 ? GOAL_QUALITY_REWRITES[rewrite] : null,
    model: cached.model,
    promptVersion: GOAL_QUALITY_PROMPT_VERSION,
    rubricVersion,
  };
}

/**
 * Keyed on what is sent and the rubric it is judged by, so the same criteria in
 * any mission do not spend twice, and a rubric change is a fresh judgement.
 */
export function goalQualityCacheKey(graded: readonly IndexedCriterion[], rubricVersion: string = CODE_RUBRIC.version): string {
  const state = buildGoalQualityState(graded.map(g => g.criterion));
  const digest = createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
  return `${GOAL_QUALITY_PROMPT_VERSION}:${rubricVersion}:${digest}`;
}

type DecideFn = typeof decisionCall<Questions>;
type ResolveAccess = (opts: {
  capability: typeof GOAL_QUALITY_CAPABILITY;
  teamId: string;
  workspaceId: string | null;
  accountId: string | null;
  userId: string | null;
}) => Promise<DecisionAccess>;

export interface GoalQualityDeps {
  decide?: DecideFn;
  resolveAccess?: ResolveAccess;
  recordReceipt?: (receipt: DecisionReceipt, scope: { teamId: string; accountId: string | null }) => Promise<void>;
  cache?: Map<string, CachedAnswers>;
  log?: (line: string) => void;
  /** Never throws by contract; a throw is still caught and means the code default. */
  loadRubric?: (scope: { teamId: string; workspaceId: string | null }) => Promise<GoalQualityRubric>;
}

async function rubricFor(facts: GoalQualityFacts, deps: GoalQualityDeps): Promise<GoalQualityRubric> {
  try {
    const load = deps.loadRubric ?? (await import('./goal-criteria-rubric')).loadGoalQualityRubric;
    return await load({ teamId: facts.teamId, workspaceId: facts.workspaceId });
  } catch {
    return CODE_RUBRIC;
  }
}

const MAX_CACHE_ENTRIES = 200;
const sharedCache = new Map<string, CachedAnswers>();

function logLine(record: Record<string, unknown>): string {
  return `${DECISION_SHADOW_LOG_PREFIX} ${JSON.stringify({ site: GOAL_QUALITY_LOG_SITE, ...record })}`;
}

/**
 * Ask, log, return the verdict. Never throws; null means "no verdict", which
 * is today's behaviour. Spends only on a cache miss.
 */
export async function adviseGoalQuality(facts: GoalQualityFacts, deps: GoalQualityDeps = {}): Promise<GoalQualityVerdict | null> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const cache = deps.cache ?? sharedCache;
  try {
    if (facts.dataClass === 'sensitive') return null;
    if (gradedCriteria(facts.criteria, facts.stored).length === 0) return null;

    const client = deps.decide && deps.resolveAccess ? null : await import('@buildd/core/decision-client');
    const resolveAccess = deps.resolveAccess ?? (client!.resolveDecisionAccess as ResolveAccess);
    const access = await resolveAccess({
      capability: GOAL_QUALITY_CAPABILITY,
      teamId: facts.teamId,
      workspaceId: facts.workspaceId,
      accountId: facts.accountId ?? null,
      userId: facts.userId ?? null,
    });
    if (!access.ok) return null;

    // Read only once the team has opted in, so a write costs no memory query
    // otherwise. An accepted pattern suppresses its criterion outright: not
    // sent, not in the verdict, never warned.
    const rubric = await rubricFor(facts, deps);
    const accepted = new Set(rubric.acceptedFingerprints);
    const fresh = newCriteria(facts.criteria, facts.stored)
      .filter(g => !accepted.has(criterionFingerprint(g.criterion)));
    const graded = fresh.filter(g => !isBookkeeping(g.criterion));
    if (graded.length === 0) return null;

    const key = goalQualityCacheKey(graded, rubric.version);
    const hit = cache.get(key);
    if (hit) return toVerdict(fresh, graded, hit, rubric.version);

    const scope = { teamId: facts.teamId, accountId: facts.accountId ?? null };
    const recordReceipt = deps.recordReceipt ?? (async (receipt, s) => {
      const { insertDecisionReceipts } = await import('./memory-decisions');
      await insertDecisionReceipts([receipt], s);
    });
    const receipts: Promise<void>[] = [];
    const decide = deps.decide ?? (client!.decisionCall as DecideFn);
    const res = await decide({
      capability: GOAL_QUALITY_CAPABILITY,
      teamId: facts.teamId,
      workspaceId: facts.workspaceId,
      accountId: facts.accountId ?? null,
      userId: facts.userId ?? null,
      state: buildGoalQualityState(graded.map(g => g.criterion)),
      questions: buildGoalQualityQuestions(graded, rubric.text),
      timeoutMs: GOAL_QUALITY_TIMEOUT_MS,
      decisionId: GOAL_QUALITY_DECISION_ID,
      access,
      onUsage: receipt => { receipts.push(recordReceipt(receipt, scope).catch(() => {})); },
    });
    await Promise.all(receipts);

    const mission = facts.missionId.slice(0, 8);
    if (!res.ok) {
      log(logLine({ v: GOAL_QUALITY_PROMPT_VERSION, rubric: rubric.version, mission, error: res.error.kind, latencyMs: res.latencyMs }));
      return null;
    }
    const answers: Record<string, Answer> = {};
    for (const [name, a] of Object.entries(res.answers as Record<string, Answer>)) {
      answers[name] = { choice: a.choice, confidence: a.confidence };
    }
    const cached: CachedAnswers = { answers, model: res.model };
    const verdict = toVerdict(fresh, graded, cached, rubric.version);

    // Labels, numbers and fingerprints only — never criterion text.
    log(logLine({
      v: `${GOAL_QUALITY_PROMPT_VERSION}|${res.model}`,
      rubric: rubric.version,
      mission,
      mode: GOAL_QUALITY_MODE,
      graded: graded.length,
      weak: verdict?.weakCount ?? null,
      invalid: verdict ? undefined : true,
      criteria: verdict?.criteria.map(c => ({
        i: c.index,
        type: c.type,
        fp: c.fingerprint,
        noticeable: c.noticeable,
        nc: c.noticeableConfidence,
        checkable: c.checkable,
        cc: c.checkableConfidence,
        weak: c.weak,
      })),
      rewrite: verdict?.rewrite,
      rewriteConfidence: verdict?.rewriteConfidence,
      latencyMs: res.latencyMs,
      inputTokens: res.usage?.inputTokens ?? null,
      costUsd: res.usage?.costUsd ?? null,
    }));
    if (!verdict) return null;

    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, cached);
    return verdict;
  } catch (err) {
    console.error(`${DECISION_SHADOW_LOG_PREFIX} ${GOAL_QUALITY_LOG_SITE} failed (non-fatal, write unchanged):`, err);
    return null;
  }
}

// ── Ledger ───────────────────────────────────────────────────────────────────

/** Fixed, so rows coalesce in `get_failure_analytics`; never criterion text. */
export const GOAL_QUALITY_WARNED_REASON = 'goal criterion graded weak: no user-noticeable outcome, or not checkable without reading prose (advisory)';

/** One `warned` gate row per weak criterion. Pure; the caller fires them. */
export function goalQualityWarnings(
  verdict: GoalQualityVerdict,
  ctx: {
    missionId: string;
    workspaceId: string | null;
    surface: 'POST /api/missions' | 'PATCH /api/missions/[id]';
    callerOrigin?: GateCallerOrigin | null;
    mode?: 'shadow' | 'surface';
  },
): RecordGateEventInput[] {
  return verdict.criteria.filter(c => c.weak).map(c => ({
    gate: GATE_SLUGS.GOAL_CRITERIA_QUALITY,
    surface: ctx.surface,
    outcome: 'warned' as const,
    reason: GOAL_QUALITY_WARNED_REASON,
    missionId: ctx.missionId,
    workspaceId: ctx.workspaceId,
    callerOrigin: ctx.callerOrigin ?? null,
    detail: {
      fingerprint: c.fingerprint,
      type: c.type,
      index: c.index,
      noticeable: c.noticeable,
      noticeableConfidence: c.noticeableConfidence,
      checkable: c.checkable,
      checkableConfidence: c.checkableConfidence,
      weakOn: c.weakOn,
      rewrite: verdict.rewrite,
      promptVersion: verdict.promptVersion,
      rubricVersion: verdict.rubricVersion,
      model: verdict.model,
      mode: ctx.mode ?? GOAL_QUALITY_MODE,
    },
  }));
}
