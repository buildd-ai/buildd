/**
 * `@builddai/ai-kit/chat/contract`: the chat wire contract.
 *
 * Isomorphic and dependency-free. Message `parts` are AI SDK v7 `UIMessage`
 * parts on the wire, but nothing here imports the SDK, so a server, a React
 * client, a script or a native client can all read these types. The shapes
 * below are the structural subset of `UIMessage` a feed reads, so a
 * `UIMessage` from `useChat` is assignable to `ChatMessage` without importing
 * the SDK.
 *
 * Breaking changes to anything exported here are major version bumps. New
 * optional data parts are minor: an older client ignores a part type it does
 * not know.
 */

// ── Message parts ─────────────────────────────────────────────────────────────

/**
 * A `UIMessage` part, loosely typed. Known shapes: `{ type: 'text', text }`,
 * `{ type: 'step-start' }`, `{ type: 'reasoning', text }`,
 * `{ type: 'tool-{name}', toolCallId, state, input, output?, approval? }` and
 * `{ type: 'data-{name}', data }`.
 */
export type ChatMessagePart = { type: string; [key: string]: unknown };

/**
 * Tool part states, as AI SDK v7 names them. A tool that needs approval moves
 * `input-available → approval-requested → approval-responded →
 * output-available | output-denied`; a read tool goes
 * `input-streaming → input-available → output-available | output-error`.
 */
export type ToolPartState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

export interface ToolApproval {
  id: string;
  approved?: boolean;
  reason?: string;
  /** Why the server asked: for writes, the encoded before → after preview (APPROVAL_PREVIEW_PREFIX). */
  requestReason?: string;
  /**
   * The server decided, not the person (AI SDK: the `toolApproval` hook
   * returned `denied` or `approved`). A denial with this set was never shown
   * to anyone, so it must not read as "discarded".
   */
  isAutomatic?: boolean;
}

/**
 * What `denied` tells the model when a write can't join the turn's card: a
 * card that must stand alone (an admin write's typed confirmation, an app's
 * own full card) is already up, or this one must stand alone and rows are
 * already up. The call was never shown to the person: the model must not
 * report it as done or discarded, and must not fire a twin of the card shown.
 */
export const ONE_CARD_PER_TURN_REASON =
  'Not shown to the person: only one approval card per turn, and one is already up. Nothing ran and nothing was discarded; do not say either. '
  + 'If this call was another way of doing what that card does, drop it. If it is a separate change, ask about it after the person answers the card.';

/** Most rows one approval card holds (0.13.0). A write past it is `ROW_CAP_REASON`. */
export const APPROVAL_ROW_CAP = 8;

/**
 * What `denied` tells the model when the turn's card already holds
 * `APPROVAL_ROW_CAP` rows (0.13.0). Never shown, so "not proposed yet".
 */
export const ROW_CAP_REASON =
  `Not shown to the person: the card is full (${APPROVAL_ROW_CAP} changes). Nothing ran and nothing was discarded; do not say either. `
  + 'Propose the rest after the person answers this card.';

/**
 * What a write approved on a card answers when its target moved after the
 * card was shown (0.13.0). Its row reads "changed since shown".
 */
export const CHANGED_SINCE_SHOWN = 'changed since the card was shown';

/**
 * A write the server refused before any card was shown (the card is full,
 * a card that must stand alone, an unknown tool): never a person's Discard.
 */
export function isSystemDenied(part: Pick<ChatToolPart, 'state' | 'approval'>): boolean {
  return part.state === 'output-denied' && part.approval?.isAutomatic === true && part.approval.approved !== true;
}

/**
 * A system-denied write the model may propose once the card is answered
 * (0.13.0): it reads "not proposed yet", not a refusal.
 */
export function isHeldBack(part: Pick<ChatToolPart, 'state' | 'approval'>): boolean {
  const r = part.approval?.reason;
  return isSystemDenied(part) && (r === ROW_CAP_REASON || r === ONE_CARD_PER_TURN_REASON);
}

/** "the card is full": why a system-denied write never got its card. */
export function systemDeniedNote(part: Pick<ChatToolPart, 'approval'>): string {
  const r = part.approval?.reason;
  return r === ROW_CAP_REASON ? 'the card is full' : r === ONE_CARD_PER_TURN_REASON ? 'another card is up' : 'not allowed here';
}

/** "not proposed yet · the card is full" (0.13.0): a system-denied write, in one line. */
export function systemDeniedLine(part: Pick<ChatToolPart, 'state' | 'approval'>): string {
  return `${isHeldBack(part) ? 'not proposed yet' : 'not proposed'} · ${systemDeniedNote(part)}`;
}

/**
 * Where one row of an approval card stands (0.13.0).
 * - `awaiting`: the person hasn't answered; `deciding`: answered, not run yet.
 * - `ran`: it ran. `changed`: approved, but the target moved since the card
 *   was shown, so nothing ran. `failed`: approved and it failed.
 * - `discarded`: the person's Discard or an unchecked row.
 * - `held`: never shown (`isSystemDenied`).
 */
export type ApprovalRowOutcome = 'awaiting' | 'deciding' | 'ran' | 'changed' | 'failed' | 'discarded' | 'held';

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  const data = (output as { data?: unknown } | null | undefined)?.data;
  return typeof data === 'string' ? data : '';
}

export function approvalRowOutcome(part: Pick<ChatToolPart, 'state' | 'approval' | 'output'>): ApprovalRowOutcome {
  if (isSystemDenied(part)) return 'held';
  switch (part.state) {
    case 'output-denied': return 'discarded';
    case 'output-error': return 'failed';
    case 'approval-responded': return part.approval?.approved === false ? 'discarded' : 'deciding';
    case 'output-available': {
      const text = outputText(part.output);
      if (text.includes(CHANGED_SINCE_SHOWN)) return 'changed';
      return text.startsWith('Error:') ? 'failed' : 'ran';
    }
    default: return 'awaiting';
  }
}

export interface ChatToolPart {
  /** `tool-<name>` for static tools, `dynamic-tool` with `toolName` otherwise. */
  type: string;
  toolName?: string;
  toolCallId: string;
  state: ToolPartState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: ToolApproval;
}

export interface ChatTextPart { type: 'text'; text: string; state?: 'streaming' | 'done' }

/** A part a feed doesn't render specially (reasoning, step-start, files, data parts). */
export interface ChatOtherPart { type: string; [key: string]: unknown }

export type ChatPart = ChatTextPart | ChatToolPart | ChatOtherPart;

export interface ChatMessage {
  id: string;
  /** `event` is not a model turn: an update appended by the app (a hand-off finishing, a plan being ready). */
  role: 'system' | 'user' | 'assistant' | 'event';
  metadata?: unknown;
  parts: ChatPart[];
}

export function isToolPart(part: ChatPart): part is ChatToolPart {
  return typeof part.type === 'string'
    && (part.type.startsWith('tool-') || part.type === 'dynamic-tool')
    && typeof (part as ChatToolPart).toolCallId === 'string';
}

export function isTextPart(part: ChatPart): part is ChatTextPart {
  return part.type === 'text' && typeof (part as ChatTextPart).text === 'string';
}

/**
 * How long a new text part must grow, while it still streams, before it
 * replaces the turn's earlier prose as the answer (0.18.0), unless it has
 * already finished a sentence. Below it the earlier prose stays, so the
 * answer never drops to a word or two.
 */
export const ANSWER_SWAP_MIN_CHARS = 48;

const SENTENCE_END = /[.!?…](\s|$)/;

/** Prose still streaming that is too little to replace what was there: a word or two, no sentence yet. */
function isStub(p: ChatTextPart): boolean {
  const t = p.text.trim();
  return p.state === 'streaming' && t.length < ANSWER_SWAP_MIN_CHARS && !SENTENCE_END.test(t);
}

/**
 * Which text part is a turn's answer (0.18.0): its latest prose, or -1 with
 * none. Earlier prose in the same assistant message (written before tools
 * ran) is superseded by it. Empty parts are skipped, and a part still
 * streaming that is shorter than `ANSWER_SWAP_MIN_CHARS` with no finished
 * sentence yields to the prose before it, so an answer never goes blank and a turn cut off mid-word keeps
 * the most useful text it had. The parts are not changed: what was superseded
 * stays for history and audit.
 */
export function answerPartIndex(parts: readonly ChatPart[]): number {
  let latest = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!isTextPart(p) || !p.text.trim()) continue;
    if (latest === -1) {
      latest = i;
      if (!isStub(p)) return i;
      continue;
    }
    return i;
  }
  return latest;
}

/** The turn's answer as plain text (0.18.0): the canonical text of an assistant message. '' with none. */
export function answerText(parts: readonly ChatPart[]): string {
  const i = answerPartIndex(parts);
  return i === -1 ? '' : (parts[i] as ChatTextPart).text.trim();
}

export function toolNameOf(part: ChatToolPart): string {
  if (part.type === 'dynamic-tool') return part.toolName ?? 'tool';
  return part.type.slice('tool-'.length);
}

// ── Objects in the feed ───────────────────────────────────────────────────────

/**
 * What a chat answer can point at. Each app declares its own kinds
 * (`ObjectRef<'shipment' | 'order'>`) and a renderer for each. A ref is a
 * pointer, never a snapshot: the renderer fetches live state and prefers it.
 */
export interface ObjectRef<K extends string = string> {
  kind: K;
  /** Primary key of the object, as the app defines it for the kind. */
  id: string;
  workspaceId: string | null;
  /**
   * Plain text for surfaces that can't render the live object (email, a
   * deleted object, an unknown kind). Always present, always human-readable.
   */
  fallbackText: string;
  /** Display hint captured when the ref was made. */
  title?: string;
}

/** Structural check: a kind from `kinds`, a string id and a fallback text. */
export function isObjectRefOf<K extends string>(kinds: readonly K[], value: unknown): value is ObjectRef<K> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === 'string'
    && (kinds as readonly string[]).includes(v.kind)
    && typeof v.id === 'string'
    && typeof v.fallbackText === 'string';
}

/** One string per object (`kind:id`): the key a live copy is shared under. */
export function refKey(ref: Pick<ObjectRef, 'kind' | 'id'>): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * What every chat tool returns as its `output`. `data` is what the model
 * reads; `objects` is what the client renders.
 */
export interface ToolResult<T = unknown, R extends ObjectRef = ObjectRef> {
  data: T;
  objects: R[];
  /** One-line result for the collapsed tool row. Optional; a UI falls back to the object count. */
  summary?: string;
  /** A write that ran without a card under the person's "Allow" for its tool group. */
  allowed?: boolean;
  /**
   * The tool filed a long-running job (a runner task). `/chat/server` turns
   * this into a `data-handoff` part and a "Filed as a task" step. A tool that
   * hands off must be declared `spends: true`, so it always asks first.
   */
  handoff?: { taskId: string; url: string; title?: string };
}

// ── Data parts ────────────────────────────────────────────────────────────────

/** One row of the thinking checklist. Emitted by the server, never invented by the model. */
export interface StepData {
  id: string;
  label: string;
  state: 'done' | 'active' | 'pending';
  /**
   * How much the step matters to the person (0.17.0), decided by the server:
   * `key` (a write that returned something, a failure, a change waiting on
   * them, a refusal) or `routine` (reads, counted runs, thinking). The panel
   * pins the latest key step and folds runs of routine ones. Absent: a
   * `pending` step is key, anything else routine (`stepWeight`).
   */
  weight?: 'key' | 'routine';
}

/** A long job was filed to a runner; the part becomes a live object. */
export interface HandoffData {
  taskId: string;
  url: string;
  state: 'filed' | 'running' | 'completed' | 'failed';
  /** Display title ("Draft the Q3 plan"). Optional; a UI falls back to "Task". */
  title?: string;
  /** The tool call that filed it, when it was filed from a turn. */
  toolCallId?: string;
  /** One line from the runner once it finishes ("PR #12 opened"). */
  summary?: string;
}

/**
 * A mid-turn steer: text the person typed while a turn was running.
 * `queued` = waiting for the next step boundary; `applied` = injected into the
 * running turn; `deferred` = the turn ended first, so the client sends it as
 * the next user message.
 */
export interface SteerData {
  id: string;
  text: string;
  state: 'queued' | 'applied' | 'deferred';
}

/** An update appended to the conversation by the app, outside a model turn. */
export interface EventData<R extends ObjectRef = ObjectRef> {
  event: string;
  objects: R[];
  /** One line of plain text, e.g. "Plan ready: 12 tasks". */
  text: string;
}

export const STEP_PART_TYPE = 'data-step' as const;
export const HANDOFF_PART_TYPE = 'data-handoff' as const;
export const EVENT_PART_TYPE = 'data-event' as const;
export const STEER_PART_TYPE = 'data-steer' as const;
export const TURN_ERROR_PART_TYPE = 'data-turn-error' as const;

/**
 * Why a turn that had started streaming failed. `insufficient_credit`: the
 * provider refused the call for credit or a key's spending limit (OpenRouter's
 * "requires more credits, or fewer max_tokens"); `rate_limited`: the provider
 * throttled the key; `invalid_key`: the provider rejected the key; `failed`:
 * anything else.
 */
export type ChatTurnErrorCode = 'insufficient_credit' | 'rate_limited' | 'invalid_key' | 'failed';

/**
 * A turn failed mid-stream. The server writes it as a `data-turn-error` part
 * (saved with the message) and uses `message` as the stream's `errorText`, so
 * `useChat().error.message` reads the same words.
 */
export interface TurnErrorData {
  code: ChatTurnErrorCode;
  /** One or two plain sentences for the person: what happened and what fixes it. */
  message: string;
  /** The provider's HTTP status, when there was one. */
  status?: number;
}

export function isTurnErrorPart(part: ChatPart): part is { type: typeof TURN_ERROR_PART_TYPE; data: TurnErrorData } {
  if (part.type !== TURN_ERROR_PART_TYPE) return false;
  const d = (part as { data?: Partial<TurnErrorData> }).data;
  return !!d && typeof d.code === 'string' && typeof d.message === 'string';
}

export function isStepPart(part: ChatPart): part is { type: typeof STEP_PART_TYPE; data: StepData } {
  if (part.type !== STEP_PART_TYPE) return false;
  const d = (part as { data?: Partial<StepData> }).data;
  return !!d && typeof d.id === 'string' && typeof d.label === 'string'
    && (d.state === 'done' || d.state === 'active' || d.state === 'pending');
}

export function isHandoffPart(part: ChatPart): part is { type: typeof HANDOFF_PART_TYPE; data: HandoffData } {
  if (part.type !== HANDOFF_PART_TYPE) return false;
  const d = (part as { data?: Partial<HandoffData> }).data;
  return !!d && typeof d.taskId === 'string' && typeof d.url === 'string' && typeof d.state === 'string';
}

export function isSteerPart(part: ChatPart): part is { type: typeof STEER_PART_TYPE; data: SteerData } {
  if (part.type !== STEER_PART_TYPE) return false;
  const d = (part as { data?: Partial<SteerData> }).data;
  return !!d && typeof d.id === 'string' && typeof d.text === 'string'
    && (d.state === 'queued' || d.state === 'applied' || d.state === 'deferred');
}

export function isEventPart(part: ChatPart): part is { type: typeof EVENT_PART_TYPE; data: EventData } {
  if (part.type !== EVENT_PART_TYPE) return false;
  const d = (part as { data?: Partial<EventData> }).data;
  return !!d && typeof d.event === 'string' && typeof d.text === 'string' && Array.isArray(d.objects);
}

/**
 * The latest state of every hand-off in a conversation, keyed by task id.
 * A hand-off is filed in a turn (`filed`) and updated later by event messages
 * the app appends (`running`, `completed`, `failed`); the newest part wins.
 */
export function latestHandoffs(messages: readonly Pick<ChatMessage, 'parts'>[]): Map<string, HandoffData> {
  const out = new Map<string, HandoffData>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (isHandoffPart(p)) out.set(p.data.taskId, { ...out.get(p.data.taskId), ...p.data });
    }
  }
  return out;
}

// ── Turn wire ─────────────────────────────────────────────────────────────────

/**
 * The body of one chat turn request. The client sends only the newest message:
 * a `user` message for a new question, or the latest `assistant` message with
 * approval answers filled in. The server loads history from its own store and
 * treats the client's copy as an answer, never as history.
 */
export interface ChatTurnRequest {
  message: ChatMessage;
  /** App-defined extras (scope, entry point). The kit passes them through untouched. */
  [key: string]: unknown;
}

/** Metadata on every assistant message a turn streams (the `start` chunk). */
export interface ChatTurnMetadata {
  /** The tier the turn ran on (after any downgrade). */
  tier: string | null;
  /** The model id, as planned. */
  model: string | null;
  /** Where the plan came from (`registry`, `cached`, `fallback`, ...). */
  planSource: string | null;
  /** App-defined extras (e.g. the scope the turn was routed to). */
  [key: string]: unknown;
}

/** A turn refused before any model call: the JSON body of the 4xx response. */
export interface ChatUnavailableBody {
  error: ChatUnavailableReason;
  message: string;
  [key: string]: unknown;
}

// ── Approval previews ─────────────────────────────────────────────────────────

/**
 * What an approval card shows for a proposed write: exactly what changes, as
 * before → after. Built on the server from the target's current state (never
 * from the model's prose) and carried in the approval request's reason
 * (`approval.requestReason`, prefixed with APPROVAL_PREVIEW_PREFIX). The stored
 * copy is what the write is checked against: if the target's before-state no
 * longer matches `fingerprint` when the approval arrives, nothing runs.
 */
export interface ApprovalPreview {
  v: 1;
  /** "Hold task", "Reschedule", "Edit mission" */
  verb: string;
  target: {
    kind: string;
    id: string;
    label: string;
    /** "running", "waiting for input", "held" */
    detail?: string;
    workspaceId?: string | null;
  };
  /** `before: null` = added; `after: null` = removed. */
  changes: Array<{ label: string; before: string | null; after: string | null }>;
  /** One line on side effects. */
  note?: string;
  /** Admin writes: the user must type this (the target's name) to confirm. */
  confirmText?: string;
  fingerprint: string;
  /**
   * Fields the app's preview rewrote before running (its `input`), where what
   * runs differs from what the model proposed: the card shows each, so it
   * never reads narrower than the call that executes. Set by the kit server
   * (0.12.0); a rewrite to `target.id` is left out (the target already names it).
   */
  resolved?: Array<{ key: string; proposed: string | null; runs: string }>;
}

/** The card's change lines: the preview's changes, then each rewritten field as "key (runs as): proposed → runs". */
export function approvalChanges(p: ApprovalPreview): ApprovalPreview['changes'] {
  return [
    ...p.changes,
    ...(p.resolved ?? []).map(r => ({ label: `${r.key} (runs as)`, before: r.proposed, after: r.runs })),
  ];
}

const fieldText = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const t = typeof v === 'string' ? v.trim() : JSON.stringify(v);
  return t ? t : null;
};

/**
 * The preview with `resolved` filled in: every field of `runs` (what executes)
 * whose value differs from `proposed` (the model's input).
 */
export function withResolvedFields(p: ApprovalPreview, proposed: Record<string, unknown>, runs: Record<string, unknown> | undefined): ApprovalPreview {
  const { resolved: _drop, ...base } = p;
  if (!runs) return base;
  const resolved: NonNullable<ApprovalPreview['resolved']> = [];
  for (const [key, v] of Object.entries(runs)) {
    const r = fieldText(v);
    const was = fieldText(proposed[key]);
    if (r === null || r === was || r === p.target.id) continue;
    resolved.push({ key, proposed: was, runs: r });
  }
  return resolved.length ? { ...base, resolved } : base;
}

/** Wire prefix of an encoded preview. A stable wire value: changing it is a major bump. */
export const APPROVAL_PREVIEW_PREFIX = 'buildd-preview:';

export function encodeApprovalPreview(p: ApprovalPreview): string {
  return `${APPROVAL_PREVIEW_PREFIX}${JSON.stringify(p)}`;
}

export function parseApprovalPreview(reason: unknown): ApprovalPreview | null {
  if (typeof reason !== 'string' || !reason.startsWith(APPROVAL_PREVIEW_PREFIX)) return null;
  try {
    const p = JSON.parse(reason.slice(APPROVAL_PREVIEW_PREFIX.length)) as ApprovalPreview;
    return p && p.v === 1 && typeof p.verb === 'string' && p.target && Array.isArray(p.changes) ? p : null;
  } catch {
    return null;
  }
}

/** "Hold task: checkout (running)" */
export function approvalHeadline(p: ApprovalPreview): string {
  return `${p.verb}: ${p.target.label}${p.target.detail ? ` (${p.target.detail})` : ''}`;
}

/** "Criteria: + e2e passes", "Status: running → cancelled" */
export function approvalChangeLine(c: ApprovalPreview['changes'][number]): string {
  if (c.before === null && c.after !== null) return `${c.label}: + ${c.after}`;
  if (c.after === null && c.before !== null) return `${c.label}: − ${c.before}`;
  return `${c.label}: ${c.before ?? '—'} → ${c.after ?? '—'}`;
}

// ── Usage ─────────────────────────────────────────────────────────────────────

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** Null when the provider didn't report a cost and no price is known. */
  costUsd: number | null;
  /** Assistant turns: request start to stream end, in ms. */
  latencyMs?: number;
}

// ── Tool permissions ──────────────────────────────────────────────────────────

/**
 * How a tool group behaves in chat.
 * - `ask`: every write gets an approval card.
 * - `allow`: a write may skip its card (server-enforced, see `/chat/server`).
 * - `read`: the group has no write tool.
 * - `never`: the group is not a tool at all; shown locked so the person can see it is excluded.
 */
export type ToolPermissionMode = 'ask' | 'allow' | 'read' | 'never';

/**
 * One row of the composer's tools menu. `ask` / `allow` rows can be switched;
 * `locked` rows can't.
 */
export interface ToolPermissionRow {
  key: string;
  label: string;
  mode: ToolPermissionMode;
  locked: boolean;
}

/**
 * How many groups the person has set to Allow. Since 0.5.0 `<ToolsMenu>` no
 * longer shows this on its trigger; it stays for settings pages and tests.
 */
export function allowedBadgeCount(rows: readonly ToolPermissionRow[]): number {
  return rows.filter(r => r.mode === 'allow').length;
}

/** `GET` permissions response. */
export interface GetToolPermissionsResponse {
  rows: ToolPermissionRow[];
}

/** `PATCH` permissions request. */
export interface UpdateToolPermissionRequest {
  group: string;
  mode: 'ask' | 'allow';
}

// ── Turn refusals ─────────────────────────────────────────────────────────────

/**
 * Why a turn was refused before any model call, returned as JSON with a 4xx
 * status instead of a stream. `no_key` ⇒ show the setup card, keeping the draft.
 */
export type ChatUnavailableReason = 'no_key' | 'budget_exhausted' | 'rate_limited';

const UNAVAILABLE_REASONS: readonly ChatUnavailableReason[] = ['no_key', 'budget_exhausted', 'rate_limited'];

/**
 * Read a refusal back out of a client-side error. `useChat` surfaces a 4xx
 * JSON body as the error's message; this parses it into the body the server
 * sent, keeping any app-defined extras (`retryAfterSeconds`, who can fix it).
 * Null for anything that is not a refusal.
 */
export function parseChatUnavailable(err: unknown): ChatUnavailableBody | null {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : null;
  if (!raw || raw[0] !== '{') return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || typeof v.error !== 'string') return null;
    if (!(UNAVAILABLE_REASONS as readonly string[]).includes(v.error)) return null;
    return { ...v, error: v.error as ChatUnavailableReason, message: typeof v.message === 'string' ? v.message : '' };
  } catch {
    return null;
  }
}

/** The one-line wording `chatErrorLine` falls back to, per cause. */
export interface ChatErrorLines {
  no_key: string;
  budget_exhausted: string;
  rate_limited: string;
  /** Anything else: a dropped stream, a 500. */
  failed: string;
}

export const DEFAULT_CHAT_ERROR_LINES: ChatErrorLines = {
  no_key: 'Chat is unavailable.',
  budget_exhausted: 'Today’s chat budget is used up.',
  rate_limited: 'Too many turns in a short time. Try again in a moment.',
  failed: 'The turn didn’t finish. Your message is kept, so send it again.',
};

/**
 * One line for a turn that failed. A refusal reads its server message (or
 * the line for its reason); any other JSON body reads its `message` or
 * `error`; anything else reads `lines.failed`. Never echoes a stack.
 */
export function chatErrorLine(err: unknown, lines: Partial<ChatErrorLines> = {}): string {
  const l = { ...DEFAULT_CHAT_ERROR_LINES, ...lines };
  const u = parseChatUnavailable(err);
  if (u) return u.message || l[u.error];
  const raw = err instanceof Error ? err.message : '';
  if (raw.startsWith('{')) {
    try {
      const v = JSON.parse(raw) as { error?: unknown; message?: unknown } | null;
      if (typeof v?.message === 'string' && v.message) return v.message;
      if (typeof v?.error === 'string' && v.error) return v.error;
    } catch { /* fall through */ }
  }
  return l.failed;
}

// ── Turn feedback ─────────────────────────────────────────────────────────────

/** A thumb on one assistant turn. */
export type TurnSignal = 'up' | 'down';

/** A person's vote on one turn. `reason` is a label key, never free text. */
export interface TurnVote<R extends string = string> {
  signal: TurnSignal;
  reason: R | null;
}

/**
 * The next votes after one press. The same thumb with no new reason toggles
 * the vote off; anything else sets it. Pure, so a server mirroring the toggle
 * and the client agree.
 */
export function applyTurnVote<R extends string>(
  votes: Readonly<Record<string, TurnVote<R>>>,
  messageId: string,
  signal: TurnSignal,
  reason: R | null = null,
): Record<string, TurnVote<R>> {
  const prev = votes[messageId];
  const next = { ...votes };
  if (prev && prev.signal === signal && !reason) delete next[messageId];
  else next[messageId] = { signal, reason };
  return next;
}

// ── Tier policy (0.6.0) ───────────────────────────────────────────────────────

export {
  CHAT_TIERS, defineTierPolicy, defaultTierName, isChatTier,
  type ChatTier, type TierPolicy, type TierPolicyOptions,
} from './tiers';
