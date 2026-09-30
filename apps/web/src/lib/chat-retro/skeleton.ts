/**
 * The per-window skeleton: turns, waste candidates, eligibility, and the
 * bounded state the decision model reads. Pure functions over messages.
 *
 * Privacy: the rendered state carries each user turn's text cut to
 * USER_TEXT_CHARS, and never assistant prose, tool arguments' values or tool
 * results. It is built at run time, sent once, and never stored: the lesson
 * row keeps only the numbers and labels this module and ./lesson.ts derive.
 */
import { createHash } from 'node:crypto';
import { TURN_STOPPED_NOTE } from '@/lib/chat/turn-deadline';
import type { CandidateKind } from './vocab';
import { TOOL_NAME_PATTERN } from './vocab';

/** A conversation goes into a window only once it has been quiet this long. */
export const RETRO_IDLE_MIN = 30;
/** Below this many input tokens, a single-turn window with no signal is trivial. */
export const RETRO_MIN_TOKENS = 20_000;
/** A tool result above this many tokens is a `large_result` candidate. */
export const RETRO_LARGE_RESULT_TOKENS = 4_000;
/** At most this many candidates are shown to the model, largest first. */
export const RETRO_MAX_CANDIDATES = 8;
/** Rendered state budget, in estimated tokens. */
export const RETRO_STATE_TOKENS = 4_000;
/** Each user turn's text is cut to this many characters. */
export const USER_TEXT_CHARS = 300;
/** At most this many messages form one window; the rest wait for the next pass. */
export const RETRO_MAX_WINDOW_MESSAGES = 200;

const CHARS_PER_TOKEN = 3;
export const estimateTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);

export interface RetroMessage {
  id: string;
  role: 'user' | 'assistant' | 'event';
  parts: Array<{ type: string; [key: string]: unknown }>;
  tier: string | null;
  createdAt: Date;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number | null; routing?: { outcome?: string } } | null;
}

export interface RetroWindowInput {
  messages: RetroMessage[];
  /** messageId → thumbs-down reason label (null: a down with no reason). */
  thumbsDown: Map<string, string | null>;
  /** Message ids carrying a denied approval. */
  deniedApprovalMessageIds: Set<string>;
}

export interface ToolCallSummary {
  name: string;
  argKeys: string[];
  argHash: string;
  resultTokens: number;
  error: boolean;
}

export interface Turn {
  index: number;
  messageId: string;
  role: 'user' | 'assistant';
  tier: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  routingOutcome: string | null;
  stopped: boolean;
  thumbsDown: boolean;
  thumbsReason: string | null;
  deniedApproval: boolean;
  tools: ToolCallSummary[];
  /** User turns only; never persisted. */
  userText: string;
}

export interface Candidate {
  /** Position in the candidate list; questions are named turn_<id>. */
  id: number;
  kind: CandidateKind;
  turn: number;
  messageId: string;
  tokens: number;
  toolName: string | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toolNameOf(part: { type: string; [key: string]: unknown }): string | null {
  const raw = part.type === 'dynamic-tool' ? part.toolName : part.type.startsWith('tool-') ? part.type.slice(5) : null;
  return typeof raw === 'string' && TOOL_NAME_PATTERN.test(raw) ? raw : null;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** Hash of a tool call's arguments, key order ignored. Only the hash is kept. */
function stableHash(v: unknown): string {
  let json: string;
  try { json = JSON.stringify(canonical(v)) ?? ''; } catch { json = ''; }
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
}

function sizeTokens(v: unknown): number {
  if (v === undefined || v === null) return 0;
  try { return estimateTokens(typeof v === 'string' ? v : JSON.stringify(v)); } catch { return 0; }
}

function textOf(parts: RetroMessage['parts']): string {
  return parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join(' ');
}

/** One turn per user or assistant message, in order. Event messages are dropped. */
export function buildTurns(input: RetroWindowInput): Turn[] {
  const turns: Turn[] = [];
  for (const m of input.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const tools: ToolCallSummary[] = [];
    for (const p of m.parts ?? []) {
      const name = toolNameOf(p);
      if (!name) continue;
      const args = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input as Record<string, unknown> : {};
      tools.push({
        name,
        argKeys: Object.keys(args).sort(),
        argHash: stableHash(args),
        resultTokens: sizeTokens(p.output),
        error: p.state === 'output-error' || typeof p.errorText === 'string',
      });
    }
    const text = textOf(m.parts ?? []);
    const routingOutcome = m.role === 'user' && typeof m.usage?.routing?.outcome === 'string' ? m.usage.routing.outcome : null;
    turns.push({
      index: turns.length,
      messageId: m.id,
      role: m.role,
      tier: m.tier,
      inputTokens: num(m.usage?.inputTokens),
      outputTokens: num(m.usage?.outputTokens),
      costUsd: num(m.usage?.costUsd),
      routingOutcome,
      stopped: m.role === 'assistant' && text.includes(TURN_STOPPED_NOTE),
      thumbsDown: input.thumbsDown.has(m.id),
      thumbsReason: input.thumbsDown.get(m.id) ?? null,
      deniedApproval: input.deniedApprovalMessageIds.has(m.id),
      tools,
      userText: m.role === 'user' ? text.replace(/\s+/g, ' ').trim().slice(0, USER_TEXT_CHARS) : '',
    });
  }
  return turns;
}

/** Code-detected waste candidates, at most RETRO_MAX_CANDIDATES, largest first. */
export function detectCandidates(turns: Turn[]): Candidate[] {
  const found: Omit<Candidate, 'id'>[] = [];
  const seenCalls = new Set<string>();
  for (const t of turns) {
    const turnTokens = t.inputTokens + t.outputTokens;
    const base = { turn: t.index, messageId: t.messageId };
    const mainTool = t.tools[0]?.name ?? null;
    if (t.stopped) found.push({ ...base, kind: 'stopped', tokens: turnTokens, toolName: mainTool });
    if (t.routingOutcome?.startsWith('error:')) found.push({ ...base, kind: 'routing_error', tokens: turnTokens, toolName: null });
    if (t.thumbsDown) found.push({ ...base, kind: 'thumbs_down', tokens: turnTokens, toolName: mainTool });
    if (t.deniedApproval) found.push({ ...base, kind: 'denied_approval', tokens: turnTokens, toolName: mainTool });
    for (const c of t.tools) {
      const key = `${c.name}:${c.argHash}`;
      if (seenCalls.has(key)) found.push({ ...base, kind: 'repeat_call', tokens: Math.max(c.resultTokens, 1), toolName: c.name });
      seenCalls.add(key);
      if (c.resultTokens > RETRO_LARGE_RESULT_TOKENS) found.push({ ...base, kind: 'large_result', tokens: c.resultTokens, toolName: c.name });
    }
  }
  return found
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.tokens - a.c.tokens || a.i - b.i)
    .slice(0, RETRO_MAX_CANDIDATES)
    .sort((a, b) => a.c.turn - b.c.turn || a.i - b.i)
    .map(({ c }, id) => ({ ...c, id }));
}

export interface WindowTotals {
  userTurns: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function windowTotals(turns: Turn[]): WindowTotals {
  return {
    userTurns: turns.filter(t => t.role === 'user').length,
    turns: turns.length,
    inputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    costUsd: turns.reduce((s, t) => s + t.costUsd, 0),
  };
}

/**
 * The deterministic pre-filter. A window is trivial (skipped, no model call)
 * when ALL hold: fewer than 2 user turns; no stopped turn, routing error,
 * thumbs-down or denied approval; input under RETRO_MIN_TOKENS.
 */
export function isTrivialWindow(turns: Turn[]): boolean {
  const totals = windowTotals(turns);
  const signal = turns.some(t => t.stopped || t.thumbsDown || t.deniedApproval || t.routingOutcome?.startsWith('error:'));
  return totals.userTurns < 2 && !signal && totals.inputTokens < RETRO_MIN_TOKENS;
}

function renderTurn(t: Turn, flags: Map<number, Candidate[]>): string {
  const head = `#${t.index} ${t.role}${t.tier ? ` tier=${t.tier}` : ''} in=${t.inputTokens} out=${t.outputTokens}`;
  const extra: string[] = [];
  if (t.routingOutcome) extra.push(`routing=${t.routingOutcome}`);
  if (t.stopped) extra.push('stopped=time_limit');
  if (t.thumbsDown) extra.push(`thumbs_down=${t.thumbsReason ?? 'no_reason'}`);
  if (t.deniedApproval) extra.push('approval=denied');
  const cands = flags.get(t.index);
  if (cands) extra.push(`flagged=${cands.map(c => `turn_${c.id}:${c.kind}`).join(',')}`);
  const body = t.role === 'user'
    ? ` text="${t.userText}"`
    : t.tools.length > 0
      ? ` tools=[${t.tools.map(c => `${c.name}(${c.argKeys.join(',')}) result=${c.resultTokens}t${c.error ? ' error' : ''}`).join('; ')}]`
      : '';
  return `${head}${extra.length ? ` ${extra.join(' ')}` : ''}${body}`;
}

/**
 * The bounded state: one line per turn, then the flagged candidates. Over
 * budget, the oldest unflagged turns collapse into a count. Returns null when
 * even that does not fit (the window is skipped as `state_budget`).
 */
export function renderState(turns: Turn[], candidates: Candidate[], budgetTokens = RETRO_STATE_TOKENS): { state: string; tokens: number } | null {
  const flags = new Map<number, Candidate[]>();
  for (const c of candidates) flags.set(c.turn, [...(flags.get(c.turn) ?? []), c]);
  const lines = turns.map(t => ({ t, line: renderTurn(t, flags), flagged: flags.has(t.index) }));
  const footer = candidates.length === 0
    ? 'Flagged candidates: none'
    : `Flagged candidates:\n${candidates.map(c => `turn_${c.id}: ${c.kind} at #${c.turn}${c.toolName ? ` tool=${c.toolName}` : ''} tokens=${c.tokens}`).join('\n')}`;
  const header = `Chat session with ${turns.filter(t => t.role === 'user').length} user turns and ${turns.length} turns.`;

  const compose = (collapsed: number, collapsedTokens: number, kept: typeof lines) => [
    header,
    ...(collapsed > 0 ? [`…${collapsed} earlier turns, ${collapsedTokens} tokens…`] : []),
    ...kept.map(l => l.line),
    footer,
  ].join('\n');

  let kept = lines;
  let collapsed = 0;
  let collapsedTokens = 0;
  let state = compose(0, 0, kept);
  while (estimateTokens(state) > budgetTokens) {
    const i = kept.findIndex(l => !l.flagged);
    if (i < 0) return null;
    collapsed++;
    collapsedTokens += kept[i].t.inputTokens + kept[i].t.outputTokens;
    kept = [...kept.slice(0, i), ...kept.slice(i + 1)];
    state = compose(collapsed, collapsedTokens, kept);
  }
  return { state, tokens: estimateTokens(state) };
}
