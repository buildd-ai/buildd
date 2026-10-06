/**
 * The visible-answer turn signal: what the browser saw of one user turn.
 *
 * It answers one question the stored messages cannot: did an answer the
 * server saved actually show up on the person's screen? The client
 * (components/chat/use-turn-signal.ts) posts it to
 * `POST /api/chat/[id]/turn-signal`; the server merges it into the user
 * message's `usage.turn`, next to the routing record, keyed by the id the
 * client gave that message (`usage.turn.ref`, written when the turn is saved).
 * The chat retro reads it (lib/chat-retro/visible-answer.ts).
 *
 * Content-free by construction: refs, millisecond offsets, an outcome label
 * and `true` flags. `parseTurnSignalPost` rejects any other key or value, so
 * no message text can arrive this way.
 *
 * Idempotent: a merge keeps the first value of every key (`mergeTurnSignal`,
 * the same rule as the SQL in the route), and the flags are only ever `true`,
 * so a repeated, reordered or reconnect-duplicated post changes nothing.
 *
 * No imports: the client hook reads this module.
 */

/** The id the client gave its user message (AI SDK ids, or a UUID). */
export const TURN_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Offsets past this are clamped out: no turn runs an hour. */
const MAX_OFFSET_MS = 60 * 60 * 1000;

export const TURN_SIGNAL_OUTCOMES = ['ready', 'error'] as const;
export type TurnSignalOutcome = typeof TURN_SIGNAL_OUTCOMES[number];

/**
 * Flags that, once seen during the turn, mean the person may not have been
 * looking: a missing render is then not evidence of a defect.
 */
export const TURN_SIGNAL_SUPPRESSORS = ['hidden', 'pagehide', 'offline', 'left', 'stopped', 'paneHidden'] as const;
export type TurnSignalSuppressor = typeof TURN_SIGNAL_SUPPRESSORS[number];

export interface TurnSignal {
  /** Written by the server when the user message is saved; never posted. */
  ref?: string;
  /** Client clock, epoch ms, when the turn was submitted. */
  at?: number;
  /** Offsets from `at`, in ms. */
  startMs?: number;
  /** First non-empty assistant content reached the client. */
  contentMs?: number;
  /** Non-empty assistant content was in the DOM and visible. */
  renderMs?: number;
  /** The client saw the turn end. */
  endMs?: number;
  /** The assistant message id the client received (the server's id). */
  assistantId?: string;
  outcome?: TurnSignalOutcome;
  /** The page went to the background during the turn. */
  hidden?: true;
  /** The page was unloaded or frozen during the turn. */
  pagehide?: true;
  /** The browser went offline during the turn. */
  offline?: true;
  /** The conversation view was closed or left during the turn. */
  left?: true;
  /** The person pressed stop. */
  stopped?: true;
  /** The chat pane itself was not visible when the answer was checked. */
  paneHidden?: true;
}

const OFFSET_KEYS = ['startMs', 'contentMs', 'renderMs', 'endMs'] as const;
/** Every key a client may post. `ref` is not one: the server owns it. */
export const TURN_SIGNAL_POST_KEYS = ['at', ...OFFSET_KEYS, 'assistantId', 'outcome', ...TURN_SIGNAL_SUPPRESSORS] as const;

export type TurnSignalPostResult =
  | { ok: true; ref: string; signal: TurnSignal }
  | { ok: false; error: string };

/** Validate a posted `{ ref, signal }`. Anything outside the shape is refused, never dropped silently. */
export function parseTurnSignalPost(body: unknown): TurnSignalPostResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be { ref, signal }' };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter(k => k !== 'ref' && k !== 'signal');
  if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
  if (typeof b.ref !== 'string' || !TURN_REF_PATTERN.test(b.ref)) return { ok: false, error: 'ref must be a message id' };
  const raw = b.signal;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'signal must be an object' };
  const s = raw as Record<string, unknown>;
  const signal: TurnSignal = {};
  for (const [k, v] of Object.entries(s)) {
    if (!(TURN_SIGNAL_POST_KEYS as readonly string[]).includes(k)) return { ok: false, error: `signal.${k} is not a turn signal field` };
    if (k === 'at') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return { ok: false, error: 'signal.at must be epoch ms' };
      signal.at = v;
    } else if ((OFFSET_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_OFFSET_MS) return { ok: false, error: `signal.${k} must be an offset in ms` };
      signal[k as typeof OFFSET_KEYS[number]] = Math.round(v);
    } else if (k === 'assistantId') {
      if (typeof v !== 'string' || !UUID_RE.test(v)) return { ok: false, error: 'signal.assistantId must be a message id' };
      signal.assistantId = v.toLowerCase();
    } else if (k === 'outcome') {
      if (!(TURN_SIGNAL_OUTCOMES as readonly unknown[]).includes(v)) return { ok: false, error: 'signal.outcome must be ready or error' };
      signal.outcome = v as TurnSignalOutcome;
    } else {
      if (v !== true) return { ok: false, error: `signal.${k} must be true when sent` };
      signal[k as TurnSignalSuppressor] = true;
    }
  }
  if (Object.keys(signal).length === 0) return { ok: false, error: 'signal is empty' };
  return { ok: true, ref: b.ref, signal };
}

/**
 * First value wins, per key. The route runs the same rule in SQL
 * (`incoming || existing`, right side wins), so this is its executable spec.
 */
export function mergeTurnSignal(existing: TurnSignal | null | undefined, incoming: TurnSignal): TurnSignal {
  return { ...incoming, ...(existing ?? {}) };
}

/** Why a turn's missing render does not count, or null when the client stayed on screen to the end. */
export function turnSignalSuppressedBy(s: TurnSignal): TurnSignalSuppressor | 'no_end' | null {
  for (const k of TURN_SIGNAL_SUPPRESSORS) if (s[k]) return k;
  // No end record: the page may have died mid-turn. Unknown is not a defect.
  if (s.endMs === undefined) return 'no_end';
  return null;
}

/** Read `usage.turn` off a stored message, fail-closed to null. */
export function readTurnSignal(usage: unknown): TurnSignal | null {
  if (!usage || typeof usage !== 'object') return null;
  const t = (usage as { turn?: unknown }).turn;
  return t && typeof t === 'object' && !Array.isArray(t) ? t as TurnSignal : null;
}

/**
 * A user message's `usage` with the client's id for it under `turn.ref`, so a
 * later turn signal finds its row. A ref the pattern refuses is not stored.
 */
export function withTurnRef<U extends { inputTokens: number; outputTokens: number; costUsd: number | null }>(
  usage: U | null,
  ref: unknown,
): U | (U & { turn: { ref: string } }) | { inputTokens: number; outputTokens: number; costUsd: number | null; turn: { ref: string } } | null {
  if (typeof ref !== 'string' || !TURN_REF_PATTERN.test(ref)) return usage;
  return { ...(usage ?? { inputTokens: 0, outputTokens: 0, costUsd: null }), turn: { ref } };
}
