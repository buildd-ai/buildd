/**
 * CBM search injection — the shared vocabulary (docs/design/cbm-search-injection.md).
 *
 * When a Claude worker runs an identifier search through Bash or the Grep tool,
 * the runner asks the codebase graph about that symbol and appends the
 * locations the search did NOT show to the tool result. This module holds what
 * both sides of that agree on: the outcome set the runner records, the facts it
 * sends the decision route, and the per-session metrics block that lands in
 * `resultMeta.cbm.injection`.
 *
 * Pure: no DB, no env, no model. Imported by the runner, the decision route and
 * the metrics aggregate.
 *
 * Privacy, same rule as `apps/runner/src/bash-classify.ts`: nothing here carries
 * command text, pattern text, a symbol name, a path, or a hash of any of them.
 * Shapes, counts and labels only.
 */

/** Every way one trigger can end. One per trigger, recorded in order of evaluation. */
export const CBM_INJECTION_OUTCOMES = [
  /** The runner's graph client is not ready, or the session's project is not indexed yet. */
  'no_index',
  /** The graph has no definition by that name. */
  'not_in_graph',
  /** Every graph location was already in the search output. No model call. */
  'empty_diff',
  /** Jev chose `skip` above the confidence gate. */
  'jev_skip',
  'injected_callers',
  'injected_impact',
  /** Jev failed, refused, timed out or was below the gate: callers were injected anyway. */
  'jev_error_injected',
  /** The session already had its injections. Nothing was queried. */
  'cap_reached',
  /** This symbol was already evaluated this session. Nothing was queried. */
  'repeat_symbol',
  /** The hook's total budget ran out before anything could be injected. */
  'deadline_exceeded',
  /** The backend has no post-tool seam (Codex). Counted to size the gap; nothing was queried. */
  'unsupported_backend',
] as const;

export type CbmInjectionOutcome = (typeof CBM_INJECTION_OUTCOMES)[number];

/** Outcomes that put text in front of the agent. */
export const INJECTED_OUTCOMES: ReadonlySet<CbmInjectionOutcome> = new Set<CbmInjectionOutcome>([
  'injected_callers',
  'injected_impact',
  'jev_error_injected',
]);

/**
 * Outcomes excluded from the kill metric's denominator: the trigger never
 * reached the graph because of a session rule or the backend, not because of
 * anything the graph did.
 */
export const INELIGIBLE_OUTCOMES: ReadonlySet<CbmInjectionOutcome> = new Set<CbmInjectionOutcome>([
  'cap_reached',
  'repeat_symbol',
  'unsupported_backend',
]);

/** Outcomes reached only after a non-empty diff (the kill metric's numerator). */
export const NON_EMPTY_DIFF_OUTCOMES: ReadonlySet<CbmInjectionOutcome> = new Set<CbmInjectionOutcome>([
  'jev_skip',
  'injected_callers',
  'injected_impact',
  'jev_error_injected',
]);

export const CBM_INJECTION_TRIGGERS = ['bash', 'grep'] as const;
export type CbmInjectionTrigger = (typeof CBM_INJECTION_TRIGGERS)[number];

/** The decision's labels. */
export const CBM_INJECTION_ACTIONS = ['inject_callers', 'inject_impact', 'skip'] as const;
export type CbmInjectionAction = (typeof CBM_INJECTION_ACTIONS)[number];

/** How the decision's answer was (or was not) acted on. */
export type CbmInjectionJevStatus = 'applied' | 'below_threshold' | 'error';

/** One decision, as recorded on the trigger row. */
export interface CbmInjectionJevRecord {
  /** Jev's pick, kept even below the gate; null when the call failed. */
  label: CbmInjectionAction | null;
  confidence: number | null;
  status: CbmInjectionJevStatus;
  /** Round trip as the runner saw it. */
  latencyMs: number;
  /** The decision's version string, when the server reported one. */
  version: string | null;
  /** Error kind (`timeout`, `missing_key`, `capability_disabled`, `http_503`, …). Never a message. */
  error?: string;
}

/** One trigger. Counts and labels only. */
export interface CbmInjectionEvent {
  trigger: CbmInjectionTrigger;
  outcome: CbmInjectionOutcome;
  /** Hits parsed from the search output. */
  hitCount: number;
  /** Distinct files among them. */
  hitFiles: number;
  /** Graph locations considered (definitions + callers). */
  graphCount: number;
  /** Graph locations the search did not show. */
  diffSize: number;
  /** Locations written into the note (≤ the entry cap). */
  injectedCount: number;
  /** The definition's graph label (`Function`, `Method`, …), or null. */
  symbolKind: string | null;
  /** Hook start to return. */
  latencyMs: number;
  jev?: CbmInjectionJevRecord;
}

/**
 * `resultMeta.cbm.injection`. Present on every Claude worker with CBM
 * enforced (and on Codex workers with CBM active, as `unsupported_backend`).
 */
export interface CbmInjectionMetrics {
  enabled: boolean;
  disabledReason?: 'kill_switch' | 'unsupported_backend';
  /** Triggers seen. Exact; never truncated. */
  triggers: number;
  byOutcome: Partial<Record<CbmInjectionOutcome, number>>;
  /** Notes put in front of the agent. */
  injections: number;
  /** Triggers whose diff was non-empty (kill metric numerator). */
  nonEmptyDiff: number;
  /** Triggers where the graph knew the symbol. */
  graphAnswered: number;
  uptake: {
    /** Tool calls after an injection within which a Read/Edit counts. */
    window: number;
    /** Injections whose window has been tracked (open or closed). */
    tracked: number;
    /** Injections followed by a Read/Edit of an injected location in the window. */
    taken: number;
  };
  /** One row per trigger, first `CBM_INJECTION_MAX_EVENTS`. */
  events: CbmInjectionEvent[];
  /** Triggers beyond the event cap (counted in `byOutcome`, not listed). */
  eventsDropped: number;
}

/** Session limits. Changing any of these is a spec change (cbm-search-injection.md). */
export const CBM_INJECTION_MAX_PER_SESSION = 3;
export const CBM_INJECTION_MAX_EVENTS = 50;
export const CBM_INJECTION_UPTAKE_WINDOW = 10;
export const CBM_INJECTION_MIN_SYMBOL_LENGTH = 4;

/** Kill metric defaults (open question 1 in the spec). */
export const CBM_INJECTION_KILL_DEFAULTS = { sessions: 200, minInjectedRate: 0.1, minUptakeRate: 0.15 } as const;

/**
 * The facts the decision sees. Structured only: never a command, pattern,
 * symbol name, path or file content. Validated on both ends.
 */
export interface CbmInjectionFacts {
  trigger: CbmInjectionTrigger;
  /** Task kind (`engineering`, `research`, …) or null. */
  taskKind: string | null;
  /** Task category (`bug`, `feature`, …) or null. */
  taskCategory: string | null;
  /** A missed location falls inside the task's declared pathManifest. */
  missedInManifest: boolean;
  /** A missed location's file was already edited this session. */
  missedAlreadyEdited: boolean;
  hitCount: number;
  hitFiles: number;
  definitionCount: number;
  callerCount: number;
  diffSize: number;
  /** The definition itself was among the misses. */
  definitionMissed: boolean;
  /** Graph label of the definition (`Function`, `Method`, `Class`, …) or null. */
  symbolKind: string | null;
}

const LABEL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : null;
}

function label(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && LABEL_RE.test(v) ? v : undefined;
}

/**
 * Validate an untrusted facts object. Rejects anything that is not exactly the
 * documented shape, so free text cannot ride into the model's state through a
 * field meant for a label.
 */
export function parseCbmInjectionFacts(input: unknown): { ok: true; facts: CbmInjectionFacts } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'facts must be an object' };
  const o = input as Record<string, unknown>;
  const allowed = new Set(['trigger', 'taskKind', 'taskCategory', 'missedInManifest', 'missedAlreadyEdited', 'hitCount', 'hitFiles', 'definitionCount', 'callerCount', 'diffSize', 'definitionMissed', 'symbolKind']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) return { ok: false, error: `unknown field '${k}'` };
  if (!(CBM_INJECTION_TRIGGERS as readonly unknown[]).includes(o.trigger)) return { ok: false, error: 'trigger must be bash|grep' };
  for (const k of ['missedInManifest', 'missedAlreadyEdited', 'definitionMissed'] as const) {
    if (typeof o[k] !== 'boolean') return { ok: false, error: `${k} must be a boolean` };
  }
  const nums: Record<string, number> = {};
  for (const k of ['hitCount', 'hitFiles', 'definitionCount', 'callerCount', 'diffSize'] as const) {
    const n = count(o[k]);
    if (n === null) return { ok: false, error: `${k} must be a non-negative integer` };
    nums[k] = n;
  }
  const taskKind = label(o.taskKind);
  const taskCategory = label(o.taskCategory);
  const symbolKind = label(o.symbolKind);
  if (taskKind === undefined || taskCategory === undefined || symbolKind === undefined) {
    return { ok: false, error: 'taskKind, taskCategory and symbolKind must be short labels or null' };
  }
  return {
    ok: true,
    facts: {
      trigger: o.trigger as CbmInjectionTrigger,
      taskKind,
      taskCategory,
      missedInManifest: o.missedInManifest as boolean,
      missedAlreadyEdited: o.missedAlreadyEdited as boolean,
      hitCount: nums.hitCount,
      hitFiles: nums.hitFiles,
      definitionCount: nums.definitionCount,
      callerCount: nums.callerCount,
      diffSize: nums.diffSize,
      definitionMissed: o.definitionMissed as boolean,
      symbolKind,
    },
  };
}

/** The decision route's reply. */
export type CbmInjectionDecisionReply =
  | {
      ok: true;
      /** What the runner should do (the fallback already applied on low confidence). */
      action: CbmInjectionAction;
      status: Exclude<CbmInjectionJevStatus, 'error'>;
      label: CbmInjectionAction;
      confidence: number;
      latencyMs: number;
      version: string;
    }
  | { ok: false; error: string; latencyMs: number; version: string | null };

/** An empty block for a session where injection runs. */
export function emptyCbmInjectionMetrics(enabled = true, disabledReason?: CbmInjectionMetrics['disabledReason']): CbmInjectionMetrics {
  return {
    enabled,
    ...(disabledReason ? { disabledReason } : {}),
    triggers: 0,
    byOutcome: {},
    injections: 0,
    nonEmptyDiff: 0,
    graphAnswered: 0,
    uptake: { window: CBM_INJECTION_UPTAKE_WINDOW, tracked: 0, taken: 0 },
    events: [],
    eventsDropped: 0,
  };
}
