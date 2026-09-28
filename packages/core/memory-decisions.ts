/**
 * Jev decisions for memory (docs/design/memory-done-right.md, "Where Jev
 * helps"; docs/design/decision-calls.md).
 *
 * Every decision here is typed through `@builddai/ai-kit/decide`, gated by a
 * confidence threshold that lives next to its question, and FAILS OPEN to the
 * rule that ran before it existed: a missing key, an error, the 5s deadline or
 * low confidence all leave today's behaviour untouched.
 *
 * | Decision        | Mode   | Acts on the verdict                                     |
 * |-----------------|--------|---------------------------------------------------------|
 * | keep            | live   | tags a "not durable" memory for the candidate step; never drops it |
 * | type            | live   | overrides the caller's type above a high threshold      |
 * | update          | live   | resolves the 0.88 to 0.94 near-duplicate band           |
 * | use             | live   | writes memory_uses.outcome used / ignored               |
 * | relevance       | shadow | nothing; logs a verdict per pushed hit                  |
 * | promote         | shadow | nothing; defined for the candidate step                 |
 * | chat_tier       | live   | defined for chat directives (proposes a card)           |
 * | directive_scope | live   | defined for chat directives (preselects a scope)        |
 *
 * Every verdict is logged as a `memory_decisions` row (verdict, confidence,
 * what the rule said, whether it was applied). The thresholds are provisional:
 * there is no labelled memory data yet, so they sit at the high end of the
 * decision-calls starting shape until the readout
 * (scripts/memory-decision-readout.ts) can grade them.
 *
 * No DB import: mcp-tools (which the runner also loads) depends on this. Key
 * resolution and persistence are injected (`MemoryDecisionDeps`); the web app
 * wires them in apps/web/src/lib/memory-decisions.ts.
 */
import {
  choice,
  defineDecision,
  noul,
  type ChoiceAnswer,
  type DecideParams,
  type DecisionQuestions,
  type DecisionReceipt,
  type DecisionRun,
  type Decision,
  type NoulAnswer,
} from '@builddai/ai-kit/decide';

// ── Vocabulary ────────────────────────────────────────────────────────────────

export const MEMORY_DECISION_TYPES = ['gotcha', 'pattern', 'decision', 'discovery', 'architecture'] as const;
export type MemoryDecisionType = typeof MEMORY_DECISION_TYPES[number];

export const MEMORY_UPDATE_ACTIONS = ['ADD', 'UPDATE', 'SUPERSEDE', 'NOOP'] as const;
export type MemoryUpdateAction = typeof MEMORY_UPDATE_ACTIONS[number];

/** Stored in `memory_decisions.decision`. */
export type MemoryDecisionName =
  | 'keep' | 'type' | 'update' | 'use' | 'relevance' | 'promote' | 'chat_tier' | 'directive_scope';

// ── Thresholds (a retune is a reviewed code change) ──────────────────────────

/** Whole-call ceiling, key lookup included. Never block learn past this. */
export const MEMORY_DECISION_TIMEOUT_MS = 5_000;

/**
 * Keep: a yes/no, so confidence is max(p, 1 - p). At 0.8 a memory is tagged
 * "not durable" only when p(durable) <= 0.2. Acting only adds a tag.
 */
export const KEEP_MIN_CONFIDENCE = 0.8;
/** Type: the caller's type is replaced only at or above this. */
export const TYPE_OVERRIDE_MIN_CONFIDENCE = 0.9;
/** Update: ADD, SUPERSEDE and NOOP act at or above this. */
export const UPDATE_MIN_CONFIDENCE = 0.9;
/**
 * UPDATE rewrites the existing row's text, which supersede (an invalidation)
 * does not, so it needs more confidence than the other actions.
 */
export const UPDATE_MERGE_MIN_CONFIDENCE = 0.95;
/** Use label: `used` at p >= 0.8, `ignored` at p <= 0.2, nothing in between. */
export const USE_MIN_CONFIDENCE = 0.8;
/** Chat tier: proposes a card the user confirms. */
export const CHAT_TIER_MIN_CONFIDENCE = 0.8;
/** Directive scope: preselects a scope the user confirms. */
export const DIRECTIVE_SCOPE_MIN_CONFIDENCE = 0.8;

/** Use labels written per completed task. */
export const MAX_USE_LABELS_PER_TASK = 10;
/** Promote verdicts per lifecycle call (shadow). */
export const MAX_PROMOTE_SHADOW_ITEMS = 10;
/** Relevance verdicts per retrieval (shadow). */
export const MAX_RELEVANCE_SHADOW_HITS = 8;
/** Run budget for the off-path fan-outs (use labels, relevance shadow). */
export const MEMORY_DECISION_POOL_BUDGET_MS = 15_000;

/** Tag added to a memory Jev confidently judged a task summary. The candidate step demotes on it. */
export const KEEP_NOT_DURABLE_TAG = 'jev:not-durable';

/**
 * Per-field character caps. Jev's limit is 32K tokens for the state plus the
 * longest question, and accuracy falls as irrelevant state grows; these keep
 * every state well inside that (a few thousand tokens).
 */
export const STATE_CHARS = {
  title: 300,
  content: 4_000,
  summary: 6_000,
  query: 1_500,
  evidence: 4_000,
  message: 2_000,
} as const;

export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── Questions and definitions ────────────────────────────────────────────────

const PROMPT_VERSION = 'md1';

export const MEMORY_LEARN_DECISION = defineDecision({
  id: 'buildd.memory_learn',
  promptVersion: PROMPT_VERSION,
  questions: {
    keep: noul(
      {
        question: 'Is `memory` a durable lesson that a future agent working on a different task would want to know?',
        rule: 'Follow the definitions. A lesson may mention the task it came from; what matters is whether it still helps once that task is done.',
      },
      {
        true: 'A reusable gotcha, pattern, decision, discovery or architecture fact: it tells a later agent how something works, why a choice was made, or what to avoid.',
        false: 'A summary or status report of what one task did ("implemented X", "opened a PR", "tests pass"), a changelog entry, or a note that stops mattering once the task is merged.',
      },
    ),
    type: choice(
      {
        question: 'Which kind of lesson is `memory`?',
        rule: 'Follow the definitions, even when `memory.title` uses a word that points elsewhere.',
      },
      {
        gotcha: 'A trap: something that looks right but fails, a non-obvious constraint, or a mistake to avoid. Not a recommended approach (pattern) or a recorded choice (decision).',
        pattern: 'A recommended, reusable way of doing something here: a recipe, convention or idiom to follow. Not a warning about a failure (gotcha).',
        decision: 'A choice that was made between alternatives, and why. Not a description of how the system works (architecture).',
        discovery: 'A fact learned by investigation: how something actually behaves, a measurement, or a root cause found. Not a standing convention (pattern) or a structural overview (architecture).',
        architecture: 'How the system is structured: components, data flow, ownership and boundaries. Not a single behaviour found by investigation (discovery).',
      },
    ),
  },
  mode: 'gated',
  minConfidence: { keep: KEEP_MIN_CONFIDENCE, type: TYPE_OVERRIDE_MIN_CONFIDENCE },
  timeoutMs: MEMORY_DECISION_TIMEOUT_MS,
});

export const MEMORY_UPDATE_DECISION = defineDecision({
  id: 'buildd.memory_update',
  promptVersion: PROMPT_VERSION,
  questions: {
    action: choice(
      {
        question: 'How should `incoming` be recorded, given the similar memory `existing` already stored?',
        rule: 'Compare what each one says, not how it is worded. Follow the definitions.',
      },
      {
        ADD: '`incoming` records a different lesson from `existing`: both should be kept.',
        UPDATE: '`incoming` is the same lesson as `existing` with extra or corrected detail that does not contradict it: merge them into one memory.',
        SUPERSEDE: '`incoming` replaces `existing`: it contradicts it, or `existing` is out of date and `incoming` is the current truth.',
        NOOP: '`incoming` says nothing that `existing` does not already say.',
      },
    ),
  },
  mode: 'gated',
  minConfidence: UPDATE_MIN_CONFIDENCE,
  timeoutMs: MEMORY_DECISION_TIMEOUT_MS,
});

export const MEMORY_USE_DECISION = defineDecision({
  id: 'buildd.memory_use',
  promptVersion: PROMPT_VERSION,
  questions: {
    used: noul(
      {
        question: 'Does `summary` show that the agent acted on `memory`?',
        rule: 'Judge from what was done, as the summary reports it. Mentioning the same topic is not acting on the memory.',
      },
      {
        true: 'The summary follows, applies, cites or works around what the memory says: the same fix, convention, constraint or decision shows up in what was done.',
        false: 'Nothing in the summary depends on the memory: the work would read the same without it.',
      },
    ),
  },
  mode: 'gated',
  minConfidence: USE_MIN_CONFIDENCE,
  timeoutMs: MEMORY_DECISION_TIMEOUT_MS,
});

export const MEMORY_RELEVANCE_DECISION = defineDecision({
  id: 'buildd.memory_relevance',
  promptVersion: PROMPT_VERSION,
  questions: {
    relevant: noul(
      {
        question: 'Would knowing `memory` change what an agent should do on `task`?',
        rule: 'Follow the definitions. Sharing a keyword with the task is not enough.',
      },
      {
        true: 'It names a trap, constraint, convention or decision that applies to the files, feature or failure this task is about.',
        false: 'It is about a different area, or it is general background that would not change a single step of this task.',
      },
    ),
  },
  mode: 'shadow',
  timeoutMs: MEMORY_DECISION_TIMEOUT_MS,
});

export const MEMORY_PROMOTE_DECISION = defineDecision({
  id: 'buildd.memory_promote',
  promptVersion: PROMPT_VERSION,
  questions: {
    promote: noul(
      {
        question: 'Given `evidence`, should `memory` be promoted to a team memory every agent in the workspace is shown?',
        rule: 'Judge only from `evidence`. The hard floors (minimum uses, no contradiction, team-authored content) are checked in code before this is asked.',
      },
      {
        true: 'Independent tasks acted on it, nothing contradicted it, and it is a durable lesson rather than one task\'s detail.',
        false: 'The evidence is thin or one-sided, something contradicted it, or it only mattered to one task.',
      },
    ),
  },
  mode: 'shadow',
  timeoutMs: MEMORY_DECISION_TIMEOUT_MS,
});

export const CHAT_MEMORY_TIERS = ['directive', 'knowledge', 'neither'] as const;
export type ChatMemoryTier = typeof CHAT_MEMORY_TIERS[number];

export const CHAT_MEMORY_TIER_DECISION = defineDecision({
  id: 'buildd.chat_memory_tier',
  promptVersion: PROMPT_VERSION,
  questions: {
    tier: choice(
      {
        question: 'Does the latest user message in `turn.message` give something to remember, and if so of which kind?',
        rule: 'Follow the definitions. A request to do something now is not an instruction for later.',
      },
      {
        directive: 'An instruction about how agents should behave from now on: "always ...", "never ...", "from now on ...", a standing preference about process or style.',
        knowledge: 'A durable fact about the codebase, the product or the world worth remembering, stated rather than asked for, and not an instruction.',
        neither: 'Conversation, a question, a one-off request, or something true only for this conversation or task.',
      },
    ),
  },
  mode: 'gated',
  minConfidence: CHAT_TIER_MIN_CONFIDENCE,
  timeoutMs: MEMORY_DECISION_TIMEOUT_MS,
});

export const DIRECTIVE_SCOPES = ['everywhere', 'workspace'] as const;
export type DirectiveScope = typeof DIRECTIVE_SCOPES[number];

export const DIRECTIVE_SCOPE_DECISION = defineDecision({
  id: 'buildd.directive_scope',
  promptVersion: PROMPT_VERSION,
  questions: {
    scope: choice(
      {
        question: 'Where should the instruction in `directive` apply, given the workspace in `workspace`?',
        rule: 'Follow the definitions.',
      },
      {
        everywhere: 'It is about how the user wants agents to work in general, whatever the repo: tone, process, review or communication habits.',
        workspace: 'It names or depends on this workspace\'s repo, stack, files, services or conventions.',
      },
    ),
  },
  mode: 'gated',
  minConfidence: DIRECTIVE_SCOPE_MIN_CONFIDENCE,
  timeoutMs: MEMORY_DECISION_TIMEOUT_MS,
});

/** Every memory decision, for fingerprint pinning and the readout. */
export const MEMORY_DECISIONS = {
  learn: MEMORY_LEARN_DECISION,
  update: MEMORY_UPDATE_DECISION,
  use: MEMORY_USE_DECISION,
  relevance: MEMORY_RELEVANCE_DECISION,
  promote: MEMORY_PROMOTE_DECISION,
  chat_tier: CHAT_MEMORY_TIER_DECISION,
  directive_scope: DIRECTIVE_SCOPE_DECISION,
} as const;

// ── State builders (truncated) ───────────────────────────────────────────────

export interface MemoryText { title?: string | null; content: string; type?: string | null }

export function learnState(m: MemoryText) {
  return { memory: { type: m.type ?? null, title: clip(m.title, STATE_CHARS.title), content: clip(m.content, STATE_CHARS.content) } };
}

export function updateState(incoming: MemoryText, existing: MemoryText) {
  return {
    incoming: { type: incoming.type ?? null, title: clip(incoming.title, STATE_CHARS.title), content: clip(incoming.content, STATE_CHARS.content) },
    existing: { type: existing.type ?? null, title: clip(existing.title, STATE_CHARS.title), content: clip(existing.content, STATE_CHARS.content) },
  };
}

export function useLabelState(summary: string, m: MemoryText) {
  return { summary: clip(summary, STATE_CHARS.summary), memory: { title: clip(m.title, STATE_CHARS.title), content: clip(m.content, STATE_CHARS.content) } };
}

export function relevanceState(task: string, m: MemoryText) {
  return { task: clip(task, STATE_CHARS.query), memory: { title: clip(m.title, STATE_CHARS.title), content: clip(m.content, STATE_CHARS.content) } };
}

/** Evidence is assembled by the candidate step; this only bounds it. */
export function promoteState(m: MemoryText, evidence: Record<string, unknown>) {
  const raw = JSON.stringify(evidence ?? {});
  return {
    memory: { type: m.type ?? null, title: clip(m.title, STATE_CHARS.title), content: clip(m.content, STATE_CHARS.content) },
    evidence: raw.length > STATE_CHARS.evidence ? clip(raw, STATE_CHARS.evidence) : evidence,
  };
}

export function chatTierState(message: string, previous?: string | null) {
  return { turn: { message: clip(message, STATE_CHARS.message), previous: clip(previous, STATE_CHARS.message / 2) } };
}

export function directiveScopeState(directive: string, workspace: { name: string; hint?: string | null }) {
  return { directive: clip(directive, STATE_CHARS.message), workspace: { name: clip(workspace.name, 120), about: clip(workspace.hint, 240) } };
}

// ── Pure gates ───────────────────────────────────────────────────────────────

const noulConfidence = (p: number) => Math.max(p, 1 - p);

export interface KeepGate { durable: boolean | null; probability: number | null; confidence: number | null; flag: boolean }

/** Flag (tag) only on a confident "not durable". Never drops. */
export function gateKeep(answer: NoulAnswer | null | undefined): KeepGate {
  if (!answer || !Number.isFinite(answer.noul)) return { durable: null, probability: null, confidence: null, flag: false };
  const p = answer.noul;
  const confidence = noulConfidence(p);
  return { durable: p >= 0.5, probability: p, confidence, flag: p < 0.5 && confidence >= KEEP_MIN_CONFIDENCE };
}

export interface TypeGate { type: MemoryDecisionType; jev: MemoryDecisionType | null; confidence: number | null; overridden: boolean }

export function gateType(callerType: MemoryDecisionType, answer: ChoiceAnswer<MemoryDecisionType> | null | undefined): TypeGate {
  if (!answer) return { type: callerType, jev: null, confidence: null, overridden: false };
  const overridden = answer.choice !== callerType && answer.confidence >= TYPE_OVERRIDE_MIN_CONFIDENCE;
  return { type: overridden ? answer.choice : callerType, jev: answer.choice, confidence: answer.confidence, overridden };
}

/** The action to take, or null for today's conflict reply. */
export function gateUpdate(answer: ChoiceAnswer<MemoryUpdateAction> | null | undefined): MemoryUpdateAction | null {
  if (!answer) return null;
  const min = answer.choice === 'UPDATE' ? UPDATE_MERGE_MIN_CONFIDENCE : UPDATE_MIN_CONFIDENCE;
  return answer.confidence >= min ? answer.choice : null;
}

export function gateUse(answer: NoulAnswer | null | undefined): 'used' | 'ignored' | null {
  if (!answer || !Number.isFinite(answer.noul)) return null;
  if (noulConfidence(answer.noul) < USE_MIN_CONFIDENCE) return null;
  return answer.noul >= 0.5 ? 'used' : 'ignored';
}

/** The tier to propose on a card, or null (propose nothing). */
export function gateChatMemoryTier(answer: ChoiceAnswer<ChatMemoryTier> | null | undefined): Exclude<ChatMemoryTier, 'neither'> | null {
  if (!answer || answer.confidence < CHAT_TIER_MIN_CONFIDENCE || answer.choice === 'neither') return null;
  return answer.choice;
}

/** The scope to preselect, or null (the user picks from scratch). */
export function gateDirectiveScope(answer: ChoiceAnswer<DirectiveScope> | null | undefined): DirectiveScope | null {
  if (!answer || answer.confidence < DIRECTIVE_SCOPE_MIN_CONFIDENCE) return null;
  return answer.choice;
}

// ── Log rows ─────────────────────────────────────────────────────────────────

export interface MemoryDecisionScope {
  teamId: string;
  workspaceId?: string | null;
  /** The acting account, for account-scoped keys and the ai_usage receipt. */
  accountId?: string | null;
  taskId?: string | null;
}

/** A `memory_decisions` row as the sink receives it. Content-free. */
export interface MemoryDecisionRow {
  teamId: string;
  workspaceId: string | null;
  taskId: string | null;
  memoryId: string | null;
  decision: MemoryDecisionName;
  version: string;
  mode: 'live' | 'shadow';
  verdict: string | null;
  confidence: number | null;
  probability: number | null;
  rule: string | null;
  applied: boolean;
  error: string | null;
  caller: string | null;
  latencyMs: number | null;
  costUsd: number | null;
}

export interface MemoryDecisionDeps {
  /** The team's OpenRouter key, or null (not configured: nothing runs, nothing is logged). */
  resolveKey: (scope: MemoryDecisionScope) => Promise<string | null>;
  /** Persist rows and receipts. Must not throw and must not block the caller. */
  record: (rows: MemoryDecisionRow[], receipts: DecisionReceipt[], scope: MemoryDecisionScope) => void;
  /** Transport seam (tests). */
  fetch?: DecideParams<DecisionQuestions>['fetch'];
  now?: () => number;
  /** Whole-call deadline, key lookup included. Default MEMORY_DECISION_TIMEOUT_MS. */
  timeoutMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

const ATTRIBUTION_HEADERS = { 'http-referer': 'https://buildd.dev', 'x-title': 'buildd' } as const;

function baseRow(scope: MemoryDecisionScope, run: DecisionRun<DecisionQuestions> | null, decision: Decision<DecisionQuestions>) {
  const ok = run?.result.ok ? run.result : null;
  return {
    teamId: scope.teamId,
    workspaceId: uuidOrNull(scope.workspaceId),
    taskId: uuidOrNull(scope.taskId),
    version: run?.version ?? decision.version,
    error: run && !run.result.ok ? run.result.error.kind : null,
    latencyMs: run ? Math.round(run.result.latencyMs) : null,
    costUsd: ok ? ok.usage.costUsd : null,
  };
}

function safeRecord(deps: MemoryDecisionDeps, rows: MemoryDecisionRow[], receipts: DecisionReceipt[], scope: MemoryDecisionScope) {
  if (rows.length === 0 && receipts.length === 0) return;
  try {
    deps.record(rows, receipts, scope);
  } catch {
    // Telemetry never affects the decision.
  }
}

async function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); });
  try {
    return await Promise.race([work.catch(() => fallback), out]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Judgements ───────────────────────────────────────────────────────────────

export interface LearnJudgement {
  keep: KeepGate;
  type: TypeGate;
  /** Tags to add to the saved row (the "not durable" flag). */
  addTags: string[];
  /** Log the verdicts against the memory that was written (null when none was). Idempotent. */
  record(memoryId: string | null): void;
}

export interface UpdateJudgement {
  /** null: fall back to the conflict reply. */
  action: MemoryUpdateAction | null;
  jev: MemoryUpdateAction | null;
  confidence: number | null;
  /** Log the verdict. `memoryId` is the row written or kept. Idempotent. */
  record(memoryId: string | null, applied: boolean): void;
}

export interface UseLabel { memoryId: string; outcome: 'used' | 'ignored' | null }

export interface RelevanceShadowHit {
  memoryId: string;
  title?: string | null;
  content: string;
  /** The current rule's verdict: null = shown, else the gate that held it back. */
  gatedBy: string | null;
}

/** One candidate the lifecycle pass judged, for the shadow promote verdict. */
export interface PromoteShadowItem {
  memoryId: string;
  title?: string | null;
  content: string;
  type?: string | null;
  /** Deterministic evidence, as the rule saw it. Ids and booleans only. */
  evidence: Record<string, unknown>;
  /** What the deterministic rule decided: 'promote' or 'hold:<reason>'. */
  rule: string;
}

export interface MemoryDecider {
  /**
   * Shadow: ask "promote?" over the evidence and log the verdict next to the
   * rule's. Never acts, never throws. Optional so older fakes still type.
   */
  shadowPromote?(input: { scope: MemoryDecisionScope; items: PromoteShadowItem[] }): Promise<void>;
  judgeLearn(input: { scope: MemoryDecisionScope; title: string; content: string; type: MemoryDecisionType }): Promise<LearnJudgement>;
  judgeUpdate(input: { scope: MemoryDecisionScope; incoming: MemoryText; existing: MemoryText & { id: string } }): Promise<UpdateJudgement>;
  labelUses(input: { scope: MemoryDecisionScope; summary: string; memories: Array<MemoryText & { memoryId: string }> }): Promise<UseLabel[]>;
  shadowRelevance(input: { scope: MemoryDecisionScope; task: string; caller: string; hits: RelevanceShadowHit[] }): Promise<void>;
}

/** What learn does with no decider (the runner, a team without a key). */
export function fallbackLearnJudgement(type: MemoryDecisionType): LearnJudgement {
  return { keep: gateKeep(null), type: gateType(type, null), addTags: [], record: () => {} };
}

export const FALLBACK_UPDATE_JUDGEMENT: UpdateJudgement = { action: null, jev: null, confidence: null, record: () => {} };

export function createMemoryDecider(deps: MemoryDecisionDeps): MemoryDecider {
  const timeoutMs = deps.timeoutMs ?? MEMORY_DECISION_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());

  const KEY_TIMEOUT = Symbol('key-timeout');

  /**
   * A failed run that never reached `decide`: the deadline fired first (a
   * hanging key lookup included) or the work threw. Logged like any other
   * failure, so a timeout is visible in the readout rather than silent.
   */
  function failedRun<Q extends DecisionQuestions>(decision: Decision<Q>, kind: 'timeout' | 'transport', started: number): DecisionRun<Q> {
    const error = kind === 'timeout' ? { kind: 'timeout' as const, timeoutMs } : { kind: 'transport' as const, message: 'decision failed before the call' };
    return {
      ok: false,
      decisionId: decision.id,
      version: decision.version,
      outcomes: {} as DecisionRun<Q>['outcomes'],
      result: { ok: false, error, latencyMs: now() - started, attempts: 0 },
      receipt: null,
    };
  }

  /** Key, then one call, inside one deadline. Null = not configured (nothing is logged). */
  async function runOne<Q extends DecisionQuestions>(
    decision: Decision<Q>,
    scope: MemoryDecisionScope,
    state: Record<string, unknown>,
  ): Promise<DecisionRun<Q> | null> {
    const started = now();
    const work = (async (): Promise<DecisionRun<Q> | null> => {
      const apiKey = await deps.resolveKey(scope);
      if (!apiKey) return null;
      const remaining = timeoutMs - (now() - started);
      if (remaining <= 0) return failedRun(decision, 'timeout', started);
      return decision.run({ apiKey, state, timeoutMs: remaining, headers: { ...ATTRIBUTION_HEADERS }, ...(deps.fetch ? { fetch: deps.fetch } : {}), now });
    })().catch(() => failedRun(decision, 'transport', started));
    const timedOut = Symbol('timeout');
    const res = await bounded<DecisionRun<Q> | null | typeof timedOut>(work, timeoutMs, timedOut);
    return res === timedOut ? failedRun(decision, 'timeout', started) : res;
  }

  /** Key once, then a bounded pool of calls. Null = not configured. */
  async function runMany<T, Q extends DecisionQuestions>(
    decision: Decision<Q>,
    scope: MemoryDecisionScope,
    items: readonly T[],
    stateOf: (item: T) => Record<string, unknown>,
  ): Promise<Array<{ item: T; run: DecisionRun<Q> }> | null> {
    const started = now();
    const apiKey = await bounded<string | null | typeof KEY_TIMEOUT>(deps.resolveKey(scope), timeoutMs, KEY_TIMEOUT);
    if (apiKey === KEY_TIMEOUT) return items.map(item => ({ item, run: failedRun(decision, 'timeout', started) }));
    if (!apiKey) return null;
    const res = await decision.runEach(items, {
      apiKey, stateOf, headers: { ...ATTRIBUTION_HEADERS }, ...(deps.fetch ? { fetch: deps.fetch } : {}), now,
      timeoutMs, budgetMs: MEMORY_DECISION_POOL_BUDGET_MS,
    });
    // Items the pool budget cut off are logged as timeouts, not dropped.
    return res.items.map(r => ({ item: r.item, run: r.run ?? failedRun(decision, 'timeout', started) }));
  }

  const receiptsOf = (runs: Array<DecisionRun<DecisionQuestions> | null>) =>
    runs.flatMap(r => (r?.receipt ? [r.receipt] : []));

  return {
    async judgeLearn({ scope, title, content, type }) {
      try {
        const run = await runOne(MEMORY_LEARN_DECISION, scope, learnState({ title, content, type }));
        if (!run) return fallbackLearnJudgement(type);
        const answers = run.result.ok ? run.result.answers : null;
        const keep = gateKeep(answers?.keep);
        const typed = gateType(type, answers?.type as ChoiceAnswer<MemoryDecisionType> | undefined);
        let done = false;
        const judgement: LearnJudgement = {
          keep,
          type: typed,
          addTags: keep.flag ? [KEEP_NOT_DURABLE_TAG] : [],
          record(memoryId) {
            if (done) return;
            done = true;
            const base = baseRow(scope, run as DecisionRun<DecisionQuestions>, MEMORY_LEARN_DECISION as Decision<DecisionQuestions>);
            const written = memoryId !== null;
            safeRecord(deps, [
              {
                ...base, memoryId, decision: 'keep', mode: 'live', caller: null,
                verdict: keep.durable === null ? null : String(keep.durable),
                confidence: keep.confidence, probability: keep.probability,
                rule: 'keep', applied: written && keep.flag,
              },
              {
                ...base, memoryId, decision: 'type', mode: 'live', caller: null,
                verdict: typed.jev, confidence: typed.confidence, probability: null,
                rule: type, applied: written && typed.overridden,
              },
            ], receiptsOf([run as DecisionRun<DecisionQuestions>]), scope);
          },
        };
        return judgement;
      } catch {
        return fallbackLearnJudgement(type);
      }
    },

    async judgeUpdate({ scope, incoming, existing }) {
      try {
        const run = await runOne(MEMORY_UPDATE_DECISION, scope, updateState(incoming, existing));
        if (!run) return FALLBACK_UPDATE_JUDGEMENT;
        const answer = run.result.ok ? (run.result.answers.action as ChoiceAnswer<MemoryUpdateAction>) : null;
        let done = false;
        return {
          action: gateUpdate(answer),
          jev: answer?.choice ?? null,
          confidence: answer?.confidence ?? null,
          record(memoryId, applied) {
            if (done) return;
            done = true;
            safeRecord(deps, [{
              ...baseRow(scope, run as DecisionRun<DecisionQuestions>, MEMORY_UPDATE_DECISION as Decision<DecisionQuestions>),
              memoryId: memoryId ?? existing.id, decision: 'update', mode: 'live', caller: null,
              verdict: answer?.choice ?? null, confidence: answer?.confidence ?? null, probability: null,
              rule: 'conflict', applied,
            }], receiptsOf([run as DecisionRun<DecisionQuestions>]), scope);
          },
        };
      } catch {
        return FALLBACK_UPDATE_JUDGEMENT;
      }
    },

    async labelUses({ scope, summary, memories }) {
      const seen = new Set<string>();
      const items = memories.filter(m => (seen.has(m.memoryId) ? false : (seen.add(m.memoryId), true))).slice(0, MAX_USE_LABELS_PER_TASK);
      if (items.length === 0 || !summary.trim()) return [];
      try {
        const runs = await runMany(MEMORY_USE_DECISION, scope, items, m => useLabelState(summary, m));
        if (!runs) return items.map(m => ({ memoryId: m.memoryId, outcome: null }));
        const rows: MemoryDecisionRow[] = [];
        const labels = runs.map(({ item, run }) => {
          const answer = run?.result.ok ? run.result.answers.used : null;
          const outcome = gateUse(answer);
          if (run) {
            rows.push({
              ...baseRow(scope, run as DecisionRun<DecisionQuestions>, MEMORY_USE_DECISION as Decision<DecisionQuestions>),
              memoryId: item.memoryId, decision: 'use', mode: 'live', caller: null,
              verdict: answer ? String(answer.noul >= 0.5) : null,
              confidence: answer ? noulConfidence(answer.noul) : null,
              probability: answer?.noul ?? null,
              rule: null, applied: outcome !== null,
            });
          }
          return { memoryId: item.memoryId, outcome };
        });
        safeRecord(deps, rows, receiptsOf(runs.map(r => r.run as DecisionRun<DecisionQuestions> | null)), scope);
        return labels;
      } catch {
        return items.map(m => ({ memoryId: m.memoryId, outcome: null }));
      }
    },

    async shadowPromote({ scope, items }) {
      const batch = items.slice(0, MAX_PROMOTE_SHADOW_ITEMS);
      if (batch.length === 0) return;
      try {
        const runs = await runMany(MEMORY_PROMOTE_DECISION, scope, batch, i => promoteState(i, i.evidence));
        if (!runs) return;
        const rows: MemoryDecisionRow[] = runs.filter(r => r.run).map(({ item, run }) => {
          const answer = run!.result.ok ? run!.result.answers.promote : null;
          return {
            ...baseRow(scope, run as DecisionRun<DecisionQuestions>, MEMORY_PROMOTE_DECISION as Decision<DecisionQuestions>),
            memoryId: item.memoryId, decision: 'promote' as const, mode: 'shadow' as const, caller: null,
            verdict: answer ? String(answer.noul >= 0.5) : null,
            confidence: answer ? noulConfidence(answer.noul) : null,
            probability: answer?.noul ?? null,
            rule: item.rule,
            applied: false,
          };
        });
        safeRecord(deps, rows, receiptsOf(runs.map(r => r.run as DecisionRun<DecisionQuestions> | null)), scope);
      } catch {
        // Shadow: nothing depends on it.
      }
    },

    async shadowRelevance({ scope, task, caller, hits }) {
      const items = hits.slice(0, MAX_RELEVANCE_SHADOW_HITS);
      if (items.length === 0 || !task.trim()) return;
      try {
        const runs = await runMany(MEMORY_RELEVANCE_DECISION, scope, items, h => relevanceState(task, h));
        if (!runs) return;
        const rows: MemoryDecisionRow[] = runs.filter(r => r.run).map(({ item, run }) => {
          const answer = run!.result.ok ? run!.result.answers.relevant : null;
          return {
            ...baseRow(scope, run as DecisionRun<DecisionQuestions>, MEMORY_RELEVANCE_DECISION as Decision<DecisionQuestions>),
            memoryId: item.memoryId, decision: 'relevance' as const, mode: 'shadow' as const, caller,
            verdict: answer ? String(answer.noul >= 0.5) : null,
            confidence: answer ? noulConfidence(answer.noul) : null,
            probability: answer?.noul ?? null,
            rule: item.gatedBy ?? 'shown',
            applied: false,
          };
        });
        safeRecord(deps, rows, receiptsOf(runs.map(r => r.run as DecisionRun<DecisionQuestions> | null)), scope);
      } catch {
        // Shadow: nothing depends on it.
      }
    },
  };
}

// ── Use labels on completion ─────────────────────────────────────────────────

export interface TaskMemoryUse { teamId: string; workspaceId: string | null; memoryId: string }

export interface UseLabelDeps {
  decider: MemoryDecider;
  /** memory_uses rows for the task that reached the agent (gatedBy null) and have no outcome yet. */
  loadUses: (taskId: string) => Promise<TaskMemoryUse[]>;
  loadMemories: (teamId: string, ids: string[]) => Promise<Array<MemoryText & { id: string }>>;
  /** Write outcome on the task's unlabelled rows for each memory. */
  writeOutcomes: (taskId: string, labels: Array<{ memoryId: string; outcome: 'used' | 'ignored' }>) => Promise<void>;
  /**
   * Has this task already been labelled (a `use` verdict logged)? A repeated
   * completion must not ask again, including for rows left unlabelled below
   * threshold. Omitted: always ask.
   */
  attempted?: (taskId: string) => Promise<boolean>;
}

/**
 * Label a completed task's memory uses: "does the final summary act on this
 * memory?" per memory, at most MAX_USE_LABELS_PER_TASK. Never throws. Runs
 * after the completion response, never on the claim path.
 */
export async function labelTaskMemoryUses(
  input: { taskId: string; accountId?: string | null; summary: string },
  deps: UseLabelDeps,
): Promise<{ labelled: number; considered: number }> {
  try {
    if (!uuidOrNull(input.taskId) || !input.summary?.trim()) return { labelled: 0, considered: 0 };
    if (deps.attempted && await deps.attempted(input.taskId)) return { labelled: 0, considered: 0 };
    const uses = await deps.loadUses(input.taskId);
    if (uses.length === 0) return { labelled: 0, considered: 0 };
    const { teamId, workspaceId } = uses[0];
    const ids = [...new Set(uses.filter(u => u.teamId === teamId).map(u => u.memoryId))].slice(0, MAX_USE_LABELS_PER_TASK);
    const rows = await deps.loadMemories(teamId, ids);
    const byId = new Map(rows.map(r => [r.id, r]));
    const memories = ids.flatMap(id => {
      const m = byId.get(id);
      return m ? [{ memoryId: id, title: m.title, content: m.content, type: m.type }] : [];
    });
    const labels = await deps.decider.labelUses({
      scope: { teamId, workspaceId, accountId: input.accountId ?? null, taskId: input.taskId },
      summary: input.summary,
      memories,
    });
    const decided = labels.filter((l): l is { memoryId: string; outcome: 'used' | 'ignored' } => l.outcome !== null);
    if (decided.length > 0) await deps.writeOutcomes(input.taskId, decided);
    return { labelled: decided.length, considered: memories.length };
  } catch {
    return { labelled: 0, considered: 0 };
  }
}
