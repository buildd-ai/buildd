/**
 * In-session stuck detection — pure helpers, no I/O.
 *
 * Three scenarios over a worker's recent tool calls:
 *  1. repetition       — identical / near-identical calls (the original loop guard;
 *                        the only scenario that may abort).
 *  2. error streak     — 6 consecutive errored action calls with >= 3 distinct inputs.
 *  3. alternation      — A,B,A,B,... x4 with an unchanging result signature per call.
 *
 * Scenarios 2 and 3 never abort. They log (default) or nudge, once per streak.
 * The module reads call history; it never stores result text (only a hash).
 */

export const MAX_IDENTICAL_TOOL_CALLS = 5; // Nudge at 5 identical calls; abort at 2×
export const MAX_SIMILAR_TOOL_CALLS = 15; // Nudge at 15 similar non-benign Bash calls; abort at 2×
export const ERROR_STREAK_THRESHOLD = 6;
export const ERROR_STREAK_MIN_DISTINCT = 3;
export const ALTERNATION_REPEATS = 4; // A,B x4 = 8 calls
export const NUDGE_ERROR_LINE_MAX = 160;

// Bash command tokens that are safe exploration — never count toward the repetition check
export const BENIGN_BASH_FIRST_TOKENS = new Set([
  'cd', 'ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'echo',
]);
// git subcommands that are read-only — safe under "git <sub>" or "cd ... && git <sub>"
export const BENIGN_GIT_SUBCOMMANDS = new Set([
  'diff', 'log', 'show', 'status', 'branch', 'checkout', 'fetch', 'rev-parse', 'cat-file',
]);

// Strip a leading "cd <path> &&" or "cd <path>;" prefix so we can inspect the real command
export function stripCdPrefix(cmd: string): string {
  const m = cmd.match(/^cd\s+\S+\s*(?:&&|;)\s*([\s\S]*)/);
  return m ? m[1].trimStart() : cmd.trimStart();
}

export function isBenignBashCommand(cmd: string): boolean {
  const effective = stripCdPrefix(cmd);
  const tokens = effective.split(/\s+/);
  const first = tokens[0];
  if (!first) return false;
  if (BENIGN_BASH_FIRST_TOKENS.has(first)) return true;
  if (first === 'git') {
    const sub = tokens[1];
    return sub !== undefined && BENIGN_GIT_SUBCOMMANDS.has(sub);
  }
  return false;
}

// ── Repetition (behaviour-identical to the former workers.ts method) ─────────

export interface RepetitionResult {
  action: 'none' | 'nudge' | 'abort';
  reason?: string;
  nudgeMessage?: string;
}

export function normalizeCallKey(tc: { name: string; input?: Record<string, unknown> }): string {
  if (tc.name === 'Read') {
    // Different offset/limit = distinct reads, so include them in the key
    return JSON.stringify({
      name: tc.name,
      file_path: tc.input?.file_path,
      offset: tc.input?.offset,
      limit: tc.input?.limit,
    });
  }
  return JSON.stringify({ name: tc.name, input: tc.input });
}

export function detectRepetitiveToolCalls(toolCalls: ReadonlyArray<Pick<StuckCall, 'name' | 'input'>>): RepetitionResult {
  return detectRepetition(toolCalls);
}

export function detectRepetition(toolCalls: ReadonlyArray<{ name: string; input?: any }>): RepetitionResult {
  // Exclude benign Bash commands from all repetition counting.
  const calls = toolCalls.filter(tc => {
    if (tc.name === 'Bash') return !isBenignBashCommand((tc.input?.command as string) || '');
    return true;
  });

  if (calls.length < MAX_IDENTICAL_TOOL_CALLS) return { action: 'none' };

  // Abort at 2× (agent ignored the nudge and kept going)
  if (calls.length >= 2 * MAX_IDENTICAL_TOOL_CALLS) {
    const last2x = calls.slice(-2 * MAX_IDENTICAL_TOOL_CALLS);
    const key = normalizeCallKey(last2x[0]);
    if (last2x.every(tc => normalizeCallKey(tc) === key)) {
      return {
        action: 'abort',
        reason: `Agent stuck: made ${2 * MAX_IDENTICAL_TOOL_CALLS} identical ${last2x[0].name} calls`,
      };
    }
  }

  // Nudge at 1× threshold
  {
    const last1x = calls.slice(-MAX_IDENTICAL_TOOL_CALLS);
    const key = normalizeCallKey(last1x[0]);
    if (last1x.every(tc => normalizeCallKey(tc) === key)) {
      return {
        action: 'nudge',
        nudgeMessage: `You've repeated the same ${last1x[0].name} call ${MAX_IDENTICAL_TOOL_CALLS} times — vary your approach or signal completion.`,
      };
    }
  }

  // Similar Bash check (non-benign Bash only, full command comparison)
  // Only a CONSECUTIVE run of Bash calls counts: a build/edit loop that alternates
  // `make` with Edit is progress, not repetition (alternation has its own scenario).
  let tailStart = calls.length;
  while (tailStart > 0 && calls[tailStart - 1].name === 'Bash') tailStart--;
  const nonBenignBash = calls.slice(tailStart);

  if (nonBenignBash.length >= MAX_SIMILAR_TOOL_CALLS) {
    const normalizeCmd = (cmd: string) =>
      cmd.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");

    if (nonBenignBash.length >= 2 * MAX_SIMILAR_TOOL_CALLS) {
      const last2x = nonBenignBash.slice(-2 * MAX_SIMILAR_TOOL_CALLS);
      const firstPattern = normalizeCmd((last2x[0].input?.command as string) || '');
      if (last2x.every(tc => normalizeCmd((tc.input?.command as string) || '') === firstPattern)) {
        return {
          action: 'abort',
          reason: `Agent stuck: made ${2 * MAX_SIMILAR_TOOL_CALLS} similar Bash commands starting with "${firstPattern.slice(0, 30)}..."`,
        };
      }
    }

    const last1x = nonBenignBash.slice(-MAX_SIMILAR_TOOL_CALLS);
    const firstPattern = normalizeCmd((last1x[0].input?.command as string) || '');
    if (last1x.every(tc => normalizeCmd((tc.input?.command as string) || '') === firstPattern)) {
      return {
        action: 'nudge',
        nudgeMessage: `You've repeated a near-identical Bash command ${MAX_SIMILAR_TOOL_CALLS} times — vary your approach or signal completion.`,
      };
    }
  }

  return { action: 'none' };
}

// ── Result signature ─────────────────────────────────────────────────────────

/**
 * A short hash of a tool result with digits and whitespace removed, so a result
 * that only differs by a timestamp, count or spacing compares equal. The text
 * itself is not kept.
 */
export function resultSignature(text: string): string {
  const norm = (text ?? '').replace(/\d+/g, '').replace(/\s+/g, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}:${Math.min(norm.length, 9999)}`;
}

// ── Result signature ─────────────────────────────────────────────────────────

/**
 * A short hash of a tool result with digits and whitespace removed, so a result
 * that only differs by a timestamp, count or spacing compares equal. The text
 * itself is not kept.
 */
export function resultSignature(text: string): string {
  const norm = (text ?? '').replace(/\d+/g, '').replace(/\s+/g, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}:${Math.min(norm.length, 9999)}`;
}

// ── Call shape ───────────────────────────────────────────────────────────────

/**
 * A tool call joined with what its result said. `resultSignature` is a hash;
 * `errorLine` is the last line of an errored result, held only for the call
 * being evaluated (the worker never persists it). `nonExecutionKind` marks a
 * denied/cancelled/unresolved call: it is skipped, never counted as success.
 */
export interface StuckCall {
  id: string;
  name: string;
  timestamp: number;
  input?: Record<string, unknown>;
  isError?: boolean;
  resultSignature?: string;
  errorLine?: string;
  nonExecutionKind?: string;
}

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/** Read-only exploration: failing here is normal and says nothing about being stuck. */
function isReadOnlyCall(tc: Pick<StuckCall, 'name' | 'input'>): boolean {
  if (READ_ONLY_TOOLS.has(tc.name)) return true;
  if (tc.name === 'Bash') return isBenignBashCommand((tc.input?.command as string) || '');
  return false;
}

/** Waiting on something external: repeating it is expected, not a loop. */
function isPollingCall(tc: Pick<StuckCall, 'name' | 'input'>): boolean {
  if (tc.name !== 'Bash') return false;
  return /^sleep(\s|$)/.test(stripCdPrefix((tc.input?.command as string) || ''));
}

// ── Error streak ─────────────────────────────────────────────────────────────

export interface ErrorStreakResult {
  detected: boolean;
  count: number;
  distinct: number;
  tools: string[];
  lastErrorLine?: string;
}

/**
 * Trailing run of errored action calls. Read-only and denied calls are ignored
 * (neither extend nor reset). A successful action call ends the run.
 */
export function detectErrorStreak(calls: ReadonlyArray<StuckCall>): ErrorStreakResult {
  const keys = new Set<string>();
  const tools: string[] = [];
  let count = 0;
  let lastErrorLine: string | undefined;
  for (let i = calls.length - 1; i >= 0; i--) {
    const tc = calls[i];
    if (tc.nonExecutionKind) continue;
    if (isReadOnlyCall(tc)) continue;
    if (!tc.isError) break;
    count++;
    keys.add(normalizeCallKey(tc));
    if (!tools.includes(tc.name)) tools.push(tc.name);
    if (lastErrorLine === undefined) lastErrorLine = tc.errorLine;
  }
  return {
    detected: count >= ERROR_STREAK_THRESHOLD && keys.size >= ERROR_STREAK_MIN_DISTINCT,
    count,
    distinct: keys.size,
    tools,
    lastErrorLine,
  };
}

// ── Alternation ──────────────────────────────────────────────────────────────

export interface AlternationResult {
  detected: boolean;
  tools: string[];
}

export function detectAlternation(calls: ReadonlyArray<StuckCall>): AlternationResult {
  const need = ALTERNATION_REPEATS * 2;
  const window: StuckCall[] = [];
  for (let i = calls.length - 1; i >= 0 && window.length < need; i--) {
    const tc = calls[i];
    if (tc.nonExecutionKind || isPollingCall(tc)) continue;
    window.push(tc);
  }
  if (window.length < need) return { detected: false, tools: [] };
  window.reverse();
  const a = normalizeCallKey(window[0]);
  const b = normalizeCallKey(window[1]);
  if (a === b) return { detected: false, tools: [] };
  const sigs = new Map<string, string | undefined>();
  for (let i = 0; i < window.length; i++) {
    const k = normalizeCallKey(window[i]);
    if (k !== (i % 2 === 0 ? a : b)) return { detected: false, tools: [] };
    if (sigs.has(k) && sigs.get(k) !== window[i].resultSignature) return { detected: false, tools: [] };
    sigs.set(k, window[i].resultSignature);
  }
  return { detected: true, tools: [window[0].name, window[1].name] };
}

// ── Mode ─────────────────────────────────────────────────────────────────────

export type StuckMode = 'off' | 'log' | 'nudge';

/** BUILDD_STUCK_DETECTION: off | log | nudge. Unset or unknown is `log`. */
export function parseStuckMode(raw: string | undefined | null): StuckMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'off' || v === 'nudge' || v === 'log' ? v : 'log';
}

export function stuckMode(env: Record<string, string | undefined> = process.env): StuckMode {
  return parseStuckMode(env.BUILDD_STUCK_DETECTION);
}

// ── Nudge text ───────────────────────────────────────────────────────────────

/** Redact, then cap at 160 chars (an ellipsis counts toward the cap). */
export function clipErrorLine(line: string, redact: (s: string) => string = s => s): string {
  const red = redact((line ?? '').trim());
  return red.length > NUDGE_ERROR_LINE_MAX ? red.slice(0, NUDGE_ERROR_LINE_MAX - 1) + '…' : red;
}

/** Last non-empty line of a result text. */
export function lastLine(text: string): string {
  const lines = (text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

export function buildErrorStreakNudge(s: { tool: string; count: number; lastError?: string }): string {
  const latest = s.lastError ? ` Latest error: ${s.lastError}.` : '';
  return `Your last ${s.count} ${s.tool} calls in a row failed, each with different input.${latest} Stop repeating and find the common cause, change approach, or signal that you are blocked.`;
}

export function buildAlternationNudge(a: { tools: string[] }): string {
  return `You have alternated between ${a.tools[0]} and ${a.tools[1]} ${ALTERNATION_REPEATS} times with the same results each time. Neither is changing anything — try a different approach or signal that you are blocked.`;
}

// ── Latched evaluation ───────────────────────────────────────────────────────

export interface StuckState {
  errorStreakLatched: boolean;
  alternationLatched: boolean;
}

export function createStuckState(): StuckState {
  return { errorStreakLatched: false, alternationLatched: false };
}

/** What a log-mode signal records: scenario, size, tools, position. No inputs, no result text. */
export interface StuckSignal {
  scenario: 'error_streak' | 'alternation';
  length: number;
  tools: string[];
  callIndex: number;
}

export interface StuckEvaluation {
  action: 'none' | 'signal' | 'nudge';
  scenario?: StuckSignal['scenario'];
  message?: string;
  signal?: StuckSignal;
}

/**
 * Evaluate the outcome-based scenarios (error streak, then alternation) and
 * return at most one result. Each scenario latches independently: it fires once
 * per streak and re-arms when its condition stops holding. `off` evaluates
 * nothing; `log` returns a signal with no message; `nudge` adds the message.
 * Never aborts.
 */
export function evaluateStuck(args: {
  calls: ReadonlyArray<StuckCall>;
  state: StuckState;
  mode: StuckMode;
  redact?: (s: string) => string;
}): StuckEvaluation {
  const { calls, state, mode, redact } = args;
  if (mode === 'off') return { action: 'none' };

  const streak = detectErrorStreak(calls);
  const alt = detectAlternation(calls);
  if (!streak.detected) state.errorStreakLatched = false;
  if (!alt.detected) state.alternationLatched = false;

  let signal: StuckSignal | undefined;
  let message: string | undefined;
  if (streak.detected && !state.errorStreakLatched) {
    state.errorStreakLatched = true;
    signal = { scenario: 'error_streak', length: streak.count, tools: streak.tools, callIndex: calls.length - 1 };
    const line = streak.lastErrorLine ? clipErrorLine(streak.lastErrorLine, redact) : '';
    message = buildErrorStreakNudge({ tool: streak.tools[0], count: streak.count, lastError: line || undefined });
  }
  if (alt.detected && !state.alternationLatched) {
    // Latch even when the streak won this evaluation so it does not fire on the next call.
    state.alternationLatched = true;
    if (!signal) {
      signal = { scenario: 'alternation', length: ALTERNATION_REPEATS * 2, tools: alt.tools, callIndex: calls.length - 1 };
      message = buildAlternationNudge({ tools: alt.tools });
    }
  }
  if (!signal) return { action: 'none' };
  return mode === 'nudge'
    ? { action: 'nudge', scenario: signal.scenario, message, signal }
    : { action: 'signal', scenario: signal.scenario, signal };
}
