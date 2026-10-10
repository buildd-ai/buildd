/**
 * `createChatTurn`: one chat turn, generalised from buildd's
 * `apps/web/src/lib/chat/turn.ts`.
 *
 * Order matters and is the point of this module:
 *  1. refuse before any model call (bad request, the app's own admission
 *     check, no key, a denied plan), so nothing is spent;
 *  2. a user message is saved; an assistant message is an approval answer and
 *     is reconciled against storage: a replay, an edit or a lost race decides
 *     nothing and runs nothing;
 *  3. stream (AI SDK v7 `streamText`), with every write gated server-side:
 *     an approval card, or the person's "Allow" under `canSkipCard`; a
 *     turn's writes are the rows of one card (at most `APPROVAL_ROW_CAP`),
 *     and an admin write's card stands alone;
 *  4. on end, persist the assistant message and its approval requests, send
 *     the content-free receipt (`/models` `recordUsage`) and the app's own
 *     usage record (`onUsage`, awaited).
 *
 * The `ai` package is loaded lazily on the first turn, so this entry imports
 * cleanly without it (for apps that only use `defineToolGroups`).
 */

import type { LanguageModel, ModelMessage, ToolSet, UIMessage, UIMessageChunk } from 'ai';
import {
  encodeApprovalPreview,
  EVENT_PART_TYPE,
  HANDOFF_PART_TYPE,
  isToolPart,
  STEER_PART_TYPE,
  STEP_PART_TYPE,
  APPROVAL_ROW_CAP,
  CHANGED_SINCE_SHOWN,
  ONE_CARD_PER_TURN_REASON,
  ROW_CAP_REASON,
  TURN_ERROR_PART_TYPE,
  toolNameOf,
  withResolvedFields,
  type ApprovalPreview,
  type ChatMessage,
  type ChatPart,
  type ChatTurnMetadata,
  type ChatTurnRequest,
  type ChatUnavailableReason,
  type ChatUsage,
  type HandoffData,
  type StepData,
  type SteerData,
  type TurnErrorData,
} from '@builddai/ai-kit/chat/contract';
import { classifyTurnError } from './errors';
import { contentInContext, toolOutputInHistory, ToolGroupsError, type ToolGroups } from './permissions';
import { approvalRequestsIn, previewMatches, reconcileApprovals, type ApprovalRequestRow } from './approvals';
import type { ChatStore, StoredMessage } from './store';
import { DEFAULT_MAX_STEERS_PER_TURN, MAX_STEER_TEXT, steerInstruction, type SteerQueue } from './steering';
import { handoffOf } from './handoff';
import { DEFAULT_HISTORY_TOKENS, estimateTokens, fitHistoryToBudget, messageFitsModel } from './history-budget';
import type { ReadyTurnModel, TurnModel } from './model';
import { titleConversation, type TitleLimits, type TitleResult, type TitleRuleContext } from './title';

// ── Limits ────────────────────────────────────────────────────────────────────

export const DEFAULT_TURN_LIMITS = {
  /** Model steps (tool round-trips) per turn. */
  maxSteps: 8,
  /** One deadline for the whole turn, model and tools. Leave headroom under the function limit. */
  turnMs: 45_000,
  /** Stored messages sent to the model. */
  historyLimit: 40,
  /** Stored messages loaded for the Allow taint check; hitting it counts as tainted. */
  storedLimit: 500,
  /**
   * Longest user message accepted, in characters. 8,000 is not a limit: an app
   * may present a long paste as an attachment, but the server accepts it, and
   * `historyTokens` keeps the model's view of the conversation bounded.
   */
  maxUserText: 200_000,
  /**
   * Estimated tokens of history sent to the model per turn (history-budget.ts).
   * Stored history is never trimmed; a single message over it is refused.
   */
  historyTokens: DEFAULT_HISTORY_TOKENS,
  /**
   * Output tokens per model step (`maxOutputTokens`). Without a cap OpenRouter
   * reserves the model's whole output window (often 100k+ tokens) against the
   * key, and a key with a daily or credit limit refuses every call. A chat
   * answer plus a tool call fits in a few thousand. `0` sends no cap.
   */
  maxOutputTokens: 4_096,
} as const;

export type TurnLimits = { [K in keyof typeof DEFAULT_TURN_LIMITS]: number };

/**
 * What `denied` tells the model when a write can't join the turn's card: one
 * that must stand alone, or a full card (defined in the contract, so a card
 * can tell them from a Discard).
 */
export { APPROVAL_ROW_CAP, ONE_CARD_PER_TURN_REASON, ROW_CAP_REASON };
/** Appended to a turn the deadline or a Stop cut short. */
export const STOPPED_NOTE = '_Stopped before the answer was finished._';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Everything the app's hooks see about the turn. `X` is the app's own per-request context. */
export interface TurnContext<X = unknown> {
  userId: string;
  conversationId: string;
  /** The person's text for a new question; null for an approval continuation. */
  text: string | null;
  /** The stored assistant message an approval answer continues, else null. */
  continuing: StoredMessage | null;
  /** The stored messages loaded for this turn, oldest first. */
  stored: readonly StoredMessage[];
  /** The request body as sent (the kit reads only `message`). */
  body: ChatTurnRequest;
  /** The app's context, passed to `run` / `handle`. */
  extra: X;
}

/** The context the app's tool factory gets. */
export interface TurnToolsContext<X = unknown> extends TurnContext<X> {
  model: ReadyTurnModel;
  /** The turn's abort signal (deadline + Stop). Pass it to slow reads. */
  signal: AbortSignal;
  /**
   * Add or update one row of the thinking checklist. Returns the step id.
   * Use plain words ("Checking your calendar"), never a tool name.
   */
  step(label: string, state?: StepData['state'], id?: string): string;
}

/**
 * The app's dry run of a write. The same result drives the approval card
 * (before → after) and Allow (a skip needs a resolving preview). `input`, when
 * given, is what actually runs (e.g. a name resolved to an id).
 */
export type PreviewOutcome =
  | { ok: true; preview: ApprovalPreview; input?: Record<string, unknown> }
  | { ok: false; question: string };

/** What `onUsage` receives: the app's own ledger record. Contains identity; never sent to buildd. */
export interface TurnUsageRecord<X = unknown> {
  conversationId: string;
  /** The assistant message the turn saved. */
  messageId: string;
  userId: string;
  extra: X;
  /** App metadata from the model resolver (e.g. `keyScope`). */
  meta?: Record<string, unknown>;
  planId: string | null;
  planSource: string;
  provider: string;
  model: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost, else estimated from the plan's list price, else null. */
  costUsd: number | null;
  latencyMs: number;
  outcome: 'ok' | 'error' | 'aborted';
  /** This request continued an earlier turn (an approval answer). */
  continuation: boolean;
}

/**
 * Conversation titles (`./title`), off unless set: after a new question's turn
 * is saved, the app's rules, the built-in rule, then `model`.
 */
export interface ChatTitleOptions<X = unknown> {
  /** Whether this conversation still needs an automatic title (none yet, and the person never named it). */
  needed: (ctx: TurnContext<X>) => boolean | Promise<boolean>;
  /** Store the title. The app's write must not replace a title the person set meanwhile. */
  save: (args: TitleResult & { conversationId: string; ctx: TurnContext<X> }) => void | Promise<void>;
  /** App rules, before the built-in one (e.g. the name of the object the chat is about). */
  rules?: (ctx: TitleRuleContext<X>) => string | null | Promise<string | null>;
  /** Skip the built-in first-message rule. */
  skipBuiltInRule?: boolean;
  /**
   * The model step: `modelFromPlan({ models, key, create, tier: 'budget', kind: 'chat_title' })`.
   * Omit for rules only. A refusal (no key, denied plan) skips the step and goes to `onError`.
   */
  model?: (ctx: TurnContext<X>) => TurnModel | Promise<TurnModel>;
  limits?: Partial<TitleLimits>;
  instructions?: string;
  /**
   * Schedule the work after the response, e.g. Next's `after`. Default: started
   * without awaiting, which a serverless platform may cut off when the response ends.
   */
  later?: (fn: () => Promise<void>) => void;
}

export interface ChatTurnOptions<G extends string = string, X = unknown> {
  /** `defineToolGroups(...)`. Every tool the turn registers must be declared here. */
  toolGroups: ToolGroups<G>;
  /** The app's AI SDK tools (`tool({ ... })`), keyed by the name the model calls. */
  tools: ToolSet | ((ctx: TurnToolsContext<X>) => ToolSet | Promise<ToolSet>);
  /** The turn's model, from a `/models` plan: `modelFromPlan({ models, key, create })`. */
  model: (ctx: TurnContext<X>) => TurnModel | Promise<TurnModel>;
  /** Instructions for the model. */
  system: string | ((ctx: TurnContext<X> & { model: ReadyTurnModel }) => string | Promise<string>);
  /** Persistence: messages, approvals, hand-off links. */
  store: ChatStore;
  /** Groups this person set to Allow (their stored preference). Default: none, so every write asks. */
  permissions?: (ctx: TurnContext<X>) => Iterable<string> | Promise<Iterable<string>>;
  /**
   * The app's dry run for a write: what the card shows and what Allow needs.
   * Without it every write asks with a card built from the raw input, and
   * Allow never skips.
   */
  preview?: (tool: string, input: Record<string, unknown>, ctx: TurnContext<X>) => PreviewOutcome | Promise<PreviewOutcome>;
  /** An object's data is in the instructions (a docked pane). Blocks Allow. Default false. */
  docked?: (ctx: TurnContext<X>) => boolean | Promise<boolean>;
  /**
   * Groups whose tools are offered to the model this turn (every tool stays
   * defined, so an approved call from an earlier turn still runs). Default: all.
   */
  activeGroups?: (ctx: TurnContext<X>) => Iterable<string> | Promise<Iterable<string>>;
  /**
   * The app's admission check (rate limit, per-person cap), run before any
   * model call. A refusal returns 429 (or `status`) with the reason.
   */
  admit?: (ctx: TurnContext<X>) => Promise<{ ok: true } | { ok: false; reason: ChatUnavailableReason; message?: string; status?: number; extra?: Record<string, unknown> }>;
  limits?: Partial<TurnLimits>;
  /** Mid-turn steering, off unless set. See `./steering`. */
  steering?: { queue: SteerQueue; maxPerTurn?: number };
  /** The app's own usage record, awaited after the turn is saved (Cue's `ai_usage` ledger). */
  onUsage?: (record: TurnUsageRecord<X>) => void | Promise<void>;
  /** Automatic conversation titles. Off unless set. */
  title?: ChatTitleOptions<X>;
  /** Every `data-step` the turn emits, for logs and telemetry. */
  onStep?: (step: StepData, ctx: TurnContext<X>) => void;
  /** Every absorbed failure (persistence, receipts, hooks). The turn itself never throws from these. */
  onError?: (error: unknown, where: 'persist' | 'usage' | 'receipt' | 'stream' | 'steer' | 'title') => void;
  /** Extra fields for the assistant message's metadata (e.g. the routed scope). */
  metadata?: (ctx: TurnContext<X> & { model: ReadyTurnModel }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /** Message ids. Default `crypto.randomUUID()`. */
  generateId?: () => string;
  /** Test seam. */
  now?: () => number;
}

export interface RunTurnArgs<X = unknown> {
  body: unknown;
  userId: string;
  conversationId: string;
  /** Aborts the turn (a Stop; pass the request's signal). The turn deadline applies regardless. */
  signal?: AbortSignal;
  extra?: X;
}

export interface ChatTurn<X = unknown> {
  /** Run one turn from a parsed body. Returns the SSE stream, or a JSON refusal. */
  run(args: RunTurnArgs<X>): Promise<Response>;
  /**
   * `POST` handler: parses JSON and runs the turn. The request's own signal
   * aborts the turn when the client disconnects or stops (default).
   */
  handle(req: Request, ctx: { userId: string; conversationId: string; extra?: X; abortOnDisconnect?: boolean }): Promise<Response>;
  /**
   * Queue a steer for a running turn (only with `steering`). 202 when queued,
   * 400 for bad text, 404 when steering is off.
   */
  steer(args: { conversationId: string; userId: string; text: unknown; id?: string }): Promise<Response>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const UNAVAILABLE_MESSAGES: Record<ChatUnavailableReason, string> = {
  no_key: 'No provider key is connected for chat.',
  budget_exhausted: 'The chat budget is used up for now.',
  rate_limited: 'Too many chat turns in the last few minutes. Try again shortly.',
};

/** A JSON refusal with the contract's `ChatUnavailableBody`. */
export function unavailable(reason: ChatUnavailableReason, status: number, message?: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: reason, message: message ?? UNAVAILABLE_MESSAGES[reason], ...extra }, { status });
}

function badRequest(error: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status });
}

/** Why a message within `maxUserText` is still refused: estimated too large for the model in one turn. */
export function modelTooBig(text: string, maxTokens: number): { error: string; extra: Record<string, unknown> } {
  const tokens = estimateTokens(text);
  return {
    error: `this message is about ${tokens.toLocaleString('en-US')} tokens, more than the model can read in one turn (about ${maxTokens.toLocaleString('en-US')}); attach it as a document instead`,
    extra: { code: 'message_too_long_for_model', tokens, limitTokens: maxTokens },
  };
}

/** The user message's text, or why it is refused: empty, or over `max` characters. */
export function userTextOf(message: ChatMessage, max: number): { ok: true; text: string } | { ok: false; code: 'message_empty' | 'message_too_long'; error: string; chars: number } {
  const text = message.parts.filter(p => p.type === 'text').map(p => String((p as { text?: unknown }).text ?? '')).join('\n').trim();
  if (!text) return { ok: false, code: 'message_empty', error: 'a message needs some text', chars: 0 };
  if (text.length > max) {
    return {
      ok: false, code: 'message_too_long', chars: text.length,
      error: `this message is ${text.length.toLocaleString('en-US')} characters; the limit is ${max.toLocaleString('en-US')}`,
    };
  }
  return { ok: true, text };
}

/** Stored rows → the UI messages the model reads. Event rows become short assistant notes. */
export function toModelHistory(rows: readonly StoredMessage[], limit: number): UIMessage[] {
  const out: UIMessage[] = [];
  for (const m of rows.slice(-limit)) {
    if (m.role === 'event') {
      const data = (m.parts.find(p => p.type === EVENT_PART_TYPE) as { data?: { text?: string } } | undefined)?.data;
      if (data?.text) out.push({ id: m.id, role: 'assistant', parts: [{ type: 'text', text: `[update] ${data.text}` }] });
      continue;
    }
    const parts = m.parts.filter(p => p.type === 'text' || p.type === 'step-start' || p.type === 'reasoning' || isToolPart(p));
    if (parts.length > 0) out.push({ id: m.id, role: m.role, parts } as UIMessage);
  }
  return out;
}

function refusal(text: string) {
  return { data: `Error: ${text}`, objects: [], summary: text.slice(0, 120) };
}

function clarification(question: string) {
  return { data: `Needs clarification: ${question}`, objects: [], summary: 'needs clarification' };
}

function reportedCost(meta: unknown): number | null {
  const c = (meta as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/**
 * A turn's cost from its steps. `result.providerMetadata` is the last step's
 * alone, so a tool round-trip would otherwise be dropped. A step with no
 * reported cost is priced from its own usage. Null when no step reports one, so
 * the caller falls back to the whole-turn estimate.
 */
function reportedStepsCost(
  steps: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number }; providerMetadata?: unknown }>,
  price: Price,
): number | null {
  const reported = steps.map(s => reportedCost(s.providerMetadata));
  if (!reported.some(c => c !== null)) return null;
  return steps.reduce((sum, s, i) => sum + (reported[i] ?? estimatedCost(price, s.usage?.inputTokens ?? 0, s.usage?.outputTokens ?? 0) ?? 0), 0);
}

type Price = { inputPerMTok: number; outputPerMTok: number } | null | undefined;

function estimatedCost(price: Price, input: number, output: number): number | null {
  if (!price) return null;
  return (input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000;
}

let aiModule: Promise<typeof import('ai')> | null = null;
function loadAi(): Promise<typeof import('ai')> {
  // Not cached on failure, so installing the peer fixes a warm process.
  aiModule ??= import('ai').catch((e) => { aiModule = null; throw e; });
  return aiModule;
}

// ── The runner ────────────────────────────────────────────────────────────────

/**
 * Create the turn runner once per app (module scope), then call `run` or
 * `handle` per request:
 *
 * ```ts
 * const turn = createChatTurn({ toolGroups, tools, model: modelFromPlan({ ... }), system, store, permissions, preview });
 * export const POST = (req: Request) => turn.handle(req, { userId, conversationId });
 * ```
 */
export function createChatTurn<G extends string = string, X = unknown>(opts: ChatTurnOptions<G, X>): ChatTurn<X> {
  const limits: TurnLimits = { ...DEFAULT_TURN_LIMITS, ...opts.limits };
  const groups = opts.toolGroups;
  const registered = new Set(groups.registeredToolNames());
  const genId = opts.generateId ?? (() => crypto.randomUUID());
  const clock = opts.now ?? (() => Date.now());
  const report = (where: Parameters<NonNullable<ChatTurnOptions['onError']>>[1]) => (e: unknown) => {
    try { opts.onError?.(e, where); } catch { /* never let a logger break a turn */ }
  };

  const makeTitle = async (t: ChatTitleOptions<X>, ctx: TurnContext<X>, messages: readonly { role: string; parts: readonly unknown[] }[]) => {
    const onError = report('title');
    if (!(await t.needed(ctx))) return;
    const result = await titleConversation({
      messages: messages as never,
      extra: ctx.extra,
      rules: t.rules,
      skipBuiltInRule: t.skipBuiltInRule,
      limits: t.limits,
      instructions: t.instructions,
      onError,
      model: t.model ? async () => {
        const m = await t.model!(ctx);
        if (m.ok) return { model: m.model, plan: m.plan, recordUsage: m.recordUsage };
        onError(new Error(`title model refused: ${m.reason}`));
        return null;
      } : null,
    });
    if (result) await t.save({ ...result, conversationId: ctx.conversationId, ctx });
  };

  const callClass = (tool: string, input: unknown): string | undefined => {
    const t = groups.tool(tool);
    return t ? (t.deferred ? 'deferred' : t.effectiveClass ? t.effectiveClass(input) : t.class) : undefined;
  };

  const run = async (args: RunTurnArgs<X>): Promise<Response> => {
    const body = (args.body ?? {}) as ChatTurnRequest;
    const message = body.message;
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || !Array.isArray(message.parts) || typeof message.id !== 'string') {
      return badRequest('message with id, role and parts is required');
    }
    const checked = message.role === 'user' ? userTextOf(message, limits.maxUserText) : null;
    if (checked && !checked.ok) return badRequest(checked.error, 400, { code: checked.code, limit: limits.maxUserText, chars: checked.chars });
    const text = checked?.ok ? checked.text : null;
    if (text && !messageFitsModel(text, limits.historyTokens)) {
      const tooBig = modelTooBig(text, limits.historyTokens);
      return badRequest(tooBig.error, 400, tooBig.extra);
    }

    const { userId, conversationId } = args;
    const stored = await opts.store.loadMessages(conversationId, { limit: limits.storedLimit });
    let continuing: StoredMessage | null = null;
    if (message.role === 'assistant') {
      const last = stored.filter(m => m.role === 'assistant').at(-1);
      if (!last || last.id !== message.id) return badRequest('approval_not_pending', 409);
      continuing = last;
    }
    const ctx: TurnContext<X> = { userId, conversationId, text, continuing, stored, body, extra: args.extra as X };
    const scheduleTitle = (t: ChatTitleOptions<X>, messages: readonly { role: string; parts: readonly unknown[] }[]) => {
      const work = () => makeTitle(t, ctx, messages).catch(report('title'));
      try {
        if (t.later) t.later(work);
        else void work();
      } catch (e) { report('title')(e); }
    };

    // 1. Refuse before any spend.
    if (opts.admit) {
      const v = await opts.admit(ctx);
      if (!v.ok) return unavailable(v.reason, v.status ?? 429, v.message, v.extra);
    }
    const resolved = await opts.model(ctx);
    if (!resolved.ok) return unavailable(resolved.reason, resolved.reason === 'no_key' ? 409 : 429, resolved.message, resolved.extra);

    const ai = await loadAi();
    const deadline = AbortSignal.timeout(limits.turnMs);
    const signal = args.signal ? AbortSignal.any([deadline, args.signal]) : deadline;

    // ── Thinking steps ──
    let writeChunk: ((c: UIMessageChunk) => void) | null = null;
    const pendingChunks: UIMessageChunk[] = [];
    const emit = (c: UIMessageChunk) => (writeChunk ? writeChunk(c) : pendingChunks.push(c));
    const steps = new Map<string, StepData>();
    const setStep = (s: StepData) => {
      steps.set(s.id, s);
      emit({ type: `data-${STEP_PART_TYPE.slice('data-'.length)}`, id: s.id, data: s } as UIMessageChunk);
      try { opts.onStep?.(s, ctx); } catch (e) { report('stream')(e); }
    };
    const toolStepLabel = (tool: string, phase: 'active' | 'done' | 'failed'): string => {
      const t = groups.tool(tool);
      if (t?.steps) return phase === 'failed' ? (t.steps.failed ?? t.steps.done) : t.steps[phase];
      const g = groups.groupOf(tool);
      const label = (g && groups.labelOf(g)) || 'something';
      const thing = label.toLowerCase();
      return phase === 'active' ? `Working on ${thing}` : phase === 'done' ? `Worked on ${thing}` : `Couldn't finish with ${thing}`;
    };

    // The same object as ctx, so the tool factory sees ctx.continuing after reconcile.
    const toolsCtx: TurnToolsContext<X> = Object.assign(ctx, {
      model: resolved,
      signal,
      step(label: string, state: StepData['state'] = 'active', id?: string) {
        const sid = id ?? `step-${genId()}`;
        setStep({ id: sid, label, state });
        return sid;
      },
    });

    // Tools are built and checked before anything is written, so a bad
    // declaration refuses the turn instead of leaving a half-saved one.
    const appTools = typeof opts.tools === 'function' ? await opts.tools(toolsCtx) : opts.tools;
    for (const name of Object.keys(appTools)) {
      if (!registered.has(name)) {
        throw new ToolGroupsError(`tool '${name}' is not declared in any tool group; declare it (with its class) in defineToolGroups`);
      }
    }

    // 2. Approval answers: the stored parts are the truth.
    let authorized = new Set<string>();
    let approvedPreviews = new Map<string, ApprovalPreview>();
    if (continuing) {
      const r = await reconcileApprovals(continuing.parts, message.parts, a => opts.store.decideApproval({ conversationId, userId, ...a }));
      if (r.decided === 0) return badRequest('approval_not_pending', 409);
      authorized = r.authorizedToolCallIds;
      approvedPreviews = r.approvedPreviews;
      continuing = { ...continuing, parts: r.parts };
      ctx.continuing = continuing;
      await opts.store.saveMessage(conversationId, continuing);
    }

    const history = toModelHistory(stored, limits.historyLimit);
    // The taint covers the whole stored conversation, not only the model's window.
    const historyTainted = toolOutputInHistory(stored, stored.length >= limits.storedLimit);
    let uiMessages: UIMessage[];
    if (message.role === 'user') {
      const saved: StoredMessage = { id: genId(), role: 'user', parts: [{ type: 'text', text: text! }], authorUserId: userId };
      await opts.store.saveMessage(conversationId, saved);
      uiMessages = [...history, { id: saved.id, role: 'user', parts: [{ type: 'text', text: text! }] }];
    } else {
      uiMessages = history.map(m => (m.id === continuing!.id ? { ...m, parts: continuing!.parts } as UIMessage : m));
    }

    // ── Gating ──
    const allowedGroups = new Set<string>(opts.permissions ? await opts.permissions(ctx) : []);
    const docked = opts.docked ? await opts.docked(ctx) : false;
    const allowedSkips = new Map<string, Extract<PreviewOutcome, { ok: true }>>();
    // The turn's one card: up to APPROVAL_ROW_CAP rows, or one write that
    // must stand alone (an admin write's typed confirmation).
    let rowsThisTurn = 0;
    let aloneThisTurn = false;
    let skippedThisTurn = 0;

    const safePreview = async (tool: string, input: unknown): Promise<PreviewOutcome | null> => {
      if (!opts.preview) return null;
      try {
        const proposed = (input ?? {}) as Record<string, unknown>;
        const p = await opts.preview(tool, proposed, ctx);
        // The card must show what runs: a field the app rewrote is listed on it.
        return p.ok ? { ...p, preview: withResolvedFields(p.preview, proposed, p.input) } : p;
      } catch (e) {
        return { ok: false, question: e instanceof Error ? e.message : String(e) };
      }
    };

    const tools: ToolSet = {};
    for (const [name, t] of Object.entries(appTools)) {
      const execute = (t as { execute?: (input: unknown, options: { toolCallId: string }) => unknown }).execute;
      if (!execute) { tools[name] = t; continue; }
      tools[name] = {
        ...t,
        execute: async (input: unknown, options: { toolCallId: string }) => {
          const id = options.toolCallId;
          if (callClass(name, input) === 'read') return execute(input, options);
          let callInput = input;
          const approved = authorized.has(id);
          const skip = allowedSkips.get(id);
          if (approved) {
            // You approve what you saw: rebuild the card from current state
            // and require the same target and before-state.
            const was = approvedPreviews.get(id);
            if (was) {
              const now = await safePreview(name, input);
              if (!now || !now.ok) return refusal(`nothing changed: ${now && !now.ok ? now.question : 'the change could not be checked'}`);
              if (!previewMatches(was, now.preview)) {
                return refusal(`nothing changed: ${now.preview.target.label} ${CHANGED_SINCE_SHOWN}. Show the person the current state and ask again.`);
              }
              callInput = now.input ?? input;
            }
          } else if (skip) {
            callInput = skip.input ?? input;
          } else {
            // Never a write here. The SDK only executes an approved call, so an
            // unapproved one reaching execute had no card: the target was
            // unclear (a question for the person) or it was refused.
            const p = await safePreview(name, input);
            if (p && !p.ok) return clarification(p.question);
            return refusal('this write was not approved');
          }
          const out = await execute(callInput, options);
          const result = skip && out && typeof out === 'object' && !Array.isArray(out) ? { ...(out as object), allowed: true } : out;
          if (approved) await opts.store.storeApprovalResult?.({ conversationId, toolCallId: id, result }).catch(report('persist'));
          return result;
        },
      } as ToolSet[string];
    }

    const activeTools = opts.activeGroups
      ? await (async () => {
        const active = new Set<string>(await opts.activeGroups!(ctx));
        // A continuation keeps the groups of the calls it answers.
        for (const p of continuing?.parts ?? []) {
          if (isToolPart(p)) { const g = groups.groupOf(toolNameOf(p)); if (g) active.add(g); }
        }
        return Object.keys(tools).filter(n => { const g = groups.groupOf(n); return !!g && active.has(g); });
      })()
      : undefined;

    const toolApproval = async ({ toolCall, messages }: { toolCall: { toolName: string; toolCallId: string; input: unknown }; messages: ModelMessage[] }) => {
      const name = toolCall.toolName;
      const input = toolCall.input;
      const cls = callClass(name, input);
      if (cls === undefined) return { type: 'denied' as const, reason: 'Unknown tool.' };
      if (cls === 'read') return 'not-applicable' as const;
      const tainted = historyTainted || contentInContext(messages);
      if (skippedThisTurn === 0 && opts.preview && groups.canSkipCard({ tool: name, input, allowedGroups, tainted, docked, skippedThisTurn })) {
        // The person's Allow: one write per turn, only while nothing a tool
        // returned is in context, and only with a preview that resolves.
        const p = await safePreview(name, input);
        if (p?.ok) {
          skippedThisTurn += 1;
          allowedSkips.set(toolCall.toolCallId, p);
          return 'not-applicable' as const;
        }
      }
      const p = await safePreview(name, input);
      // A target that isn't exactly one thing gets no card: execute answers with the question.
      if (p && !p.ok) return 'not-applicable' as const;
      // One card per turn, each write its own row with its own approval id,
      // input hash and compare-and-set. Checked and counted with no await in
      // between, so parallel calls can't both take the last row.
      const alone = !!(p?.ok && p.preview.confirmText);
      if (aloneThisTurn || (alone && rowsThisTurn > 0)) return { type: 'denied' as const, reason: ONE_CARD_PER_TURN_REASON };
      if (rowsThisTurn >= APPROVAL_ROW_CAP) return { type: 'denied' as const, reason: ROW_CAP_REASON };
      rowsThisTurn += 1;
      if (alone) aloneThisTurn = true;
      return p?.ok ? { type: 'user-approval' as const, reason: encodeApprovalPreview(p.preview) } : 'user-approval' as const;
    };

    // ── Steering ──
    const steering = opts.steering;
    const maxSteers = steering?.maxPerTurn ?? DEFAULT_MAX_STEERS_PER_TURN;
    let appliedSteers = 0;
    const deferred: SteerData[] = [];
    const takeSteers = async (): Promise<SteerData[]> => {
      if (!steering) return [];
      let queued;
      try { queued = await steering.queue.drain(conversationId); } catch (e) { report('steer')(e); return []; }
      const apply: SteerData[] = [];
      for (const s of queued) {
        if (s.userId !== userId) continue;
        if (appliedSteers < maxSteers) { appliedSteers++; apply.push({ id: s.id, text: s.text, state: 'applied' }); }
        else deferred.push({ id: s.id, text: s.text, state: 'deferred' });
      }
      return apply;
    };
    const prepareStep = steering
      ? async ({ messages }: { messages: ModelMessage[] }) => {
        const apply = await takeSteers();
        if (apply.length === 0) return {};
        for (const s of apply) emit({ type: 'data-steer', id: s.id, data: s } as UIMessageChunk);
        return { messages: [...messages, ...apply.map(s => ({ role: 'user' as const, content: [{ type: 'text' as const, text: steerInstruction(s.text) }] }))] };
      }
      : undefined;

    const instructions = typeof opts.system === 'function' ? await opts.system({ ...ctx, model: resolved }) : opts.system;
    const extraMeta = opts.metadata ? await opts.metadata({ ...ctx, model: resolved }) : {};
    const turnMetadata: ChatTurnMetadata = {
      ...extraMeta,
      tier: resolved.plan.tier ?? null,
      model: resolved.plan.model ?? null,
      planSource: resolved.plan.planSource ?? null,
    };

    const startedAt = clock();
    // Only the model's view is trimmed; uiMessages (and the stored history) stay whole.
    const modelMessages = await ai.convertToModelMessages(fitHistoryToBudget(uiMessages, limits.historyTokens), { tools, ignoreIncompleteToolCalls: true });
    let streamError = false;
    const result = ai.streamText({
      model: resolved.model as LanguageModel,
      instructions,
      messages: modelMessages,
      tools,
      ...(activeTools ? { activeTools } : {}),
      ...(limits.maxOutputTokens > 0 ? { maxOutputTokens: limits.maxOutputTokens } : {}),
      stopWhen: ai.isStepCount(limits.maxSteps),
      abortSignal: signal,
      toolApproval: toolApproval as never,
      ...(prepareStep ? { prepareStep: prepareStep as never } : {}),
      onError: ({ error }: { error: unknown }) => { streamError = true; report('stream')(error); },
    });

    const toolNames = new Map<string, string>();
    const handoffs: HandoffData[] = [];
    // A provider failure, in words: the stream's errorText and a saved data-turn-error part.
    let turnError: TurnErrorData | null = null;
    let turnErrorWritten = false;
    const streamFailure = (e: unknown): string => {
      report('stream')(e);
      turnError ??= classifyTurnError(e);
      return turnError.message;
    };
    const persist = async ({ responseMessage, isContinuation, isAborted }: { responseMessage: UIMessage; isContinuation: boolean; isAborted: boolean }) => {
      const parts = [...(responseMessage.parts as ChatPart[])];
      if (isAborted) parts.push({ type: 'text', text: STOPPED_NOTE });
      let usage: ChatUsage | null = null;
      let tokens = { input: 0, output: 0 };
      let providerCost: number | null = null;
      try {
        const u = await result.totalUsage;
        tokens = { input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0 };
        providerCost = reportedStepsCost(await result.steps, resolved.plan.price);
      } catch { /* an aborted stream may have no usage */ }
      const latencyMs = clock() - startedAt;
      const costUsd = providerCost ?? estimatedCost(resolved.plan.price, tokens.input, tokens.output);
      usage = { inputTokens: tokens.input, outputTokens: tokens.output, costUsd, latencyMs };
      const messageId = isContinuation && continuing ? continuing.id : responseMessage.id;
      try {
        if (isContinuation && continuing) {
          const prior = continuing.usage;
          await opts.store.saveMessage(conversationId, {
            ...continuing,
            parts,
            model: resolved.plan.model,
            usage: prior ? {
              inputTokens: prior.inputTokens + usage.inputTokens,
              outputTokens: prior.outputTokens + usage.outputTokens,
              costUsd: prior.costUsd === null && usage.costUsd === null ? null : (prior.costUsd ?? 0) + (usage.costUsd ?? 0),
              // Time to the reply the person first saw, not the approval resume.
              ...(prior.latencyMs != null ? { latencyMs: prior.latencyMs } : {}),
            } : usage,
          });
        } else {
          await opts.store.saveMessage(conversationId, {
            id: messageId, role: 'assistant', parts, metadata: turnMetadata,
            tier: resolved.plan.tier, model: resolved.plan.model, usage,
          });
        }
        const rows: ApprovalRequestRow[] = await approvalRequestsIn(parts);
        if (rows.length) await opts.store.recordApprovals({ conversationId, messageId, userId, rows });
        for (const h of handoffs) {
          if (h.toolCallId) await opts.store.linkHandoff?.({ conversationId, messageId, toolCallId: h.toolCallId, taskId: h.taskId, url: h.url });
        }
      } catch (e) {
        report('persist')(e);
      }
      const outcome: TurnUsageRecord['outcome'] = isAborted ? 'aborted' : streamError ? 'error' : 'ok';
      try {
        resolved.recordUsage?.({
          plan: { planId: resolved.plan.planId, planSource: resolved.plan.planSource, model: resolved.plan.model, provider: resolved.plan.provider, tier: resolved.plan.tier },
          kind: 'chat',
          tokens,
          ...(providerCost !== null ? { costUsd: providerCost } : {}),
          latencyMs,
          outcome,
        });
      } catch (e) { report('receipt')(e); }
      if (opts.onUsage) {
        try {
          await opts.onUsage({
            conversationId, messageId, userId, extra: args.extra as X,
            ...(resolved.meta ? { meta: resolved.meta } : {}),
            planId: resolved.plan.planId, planSource: resolved.plan.planSource, provider: resolved.plan.provider,
            model: resolved.plan.model, tier: resolved.plan.tier,
            inputTokens: tokens.input, outputTokens: tokens.output, costUsd, latencyMs, outcome,
            continuation: isContinuation,
          });
        } catch (e) { report('usage')(e); }
      }
      if (opts.title && !isContinuation && text) scheduleTitle(opts.title, [...stored, message, { role: 'assistant', parts }]);
    };

    const stream = ai.createUIMessageStream({
      originalMessages: uiMessages,
      generateId: genId,
      onError: streamFailure,
      execute: async ({ writer }) => {
        const writeTurnError = () => {
          if (!turnError || turnErrorWritten) return;
          turnErrorWritten = true;
          writer.write({ type: TURN_ERROR_PART_TYPE, id: 'turn-error', data: turnError } as never);
        };
        const ui = ai.toUIMessageStream({
          stream: result.stream,
          tools,
          sendFinish: false,
          messageMetadata: ({ part }: { part: { type: string } }) => (part.type === 'start' ? turnMetadata : undefined),
          onError: streamFailure,
        } as never) as ReadableStream<UIMessageChunk>;
        const reader = ui.getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          // The typed part goes before the error chunk, so it is in the saved message.
          if (chunk.type === 'error') writeTurnError();
          writer.write(chunk as never);
          if (chunk.type === 'start' && !writeChunk) {
            // Steps emitted before the message started (a tool factory's step()) go right after it.
            writeChunk = c => writer.write(c as never);
            for (const c of pendingChunks.splice(0)) writer.write(c as never);
          }
          // The thinking checklist, from the tool lifecycle (never invented by the model).
          switch (chunk.type) {
            case 'tool-input-available': {
              toolNames.set(chunk.toolCallId, chunk.toolName);
              setStep({ id: chunk.toolCallId, label: toolStepLabel(chunk.toolName, 'active'), state: 'active' });
              break;
            }
            case 'tool-approval-request':
              setStep({ id: chunk.toolCallId, label: 'Check it with you', state: 'pending' });
              break;
            case 'tool-output-available': {
              const name = toolNames.get(chunk.toolCallId) ?? continuingToolName(continuing, chunk.toolCallId);
              const h = handoffOf(chunk.output);
              if (h) {
                const data: HandoffData = { taskId: h.taskId, url: h.url, state: 'filed', toolCallId: chunk.toolCallId, ...(h.title ? { title: h.title } : {}) };
                handoffs.push(data);
                writer.write({ type: HANDOFF_PART_TYPE, id: h.taskId, data } as never);
                setStep({ id: chunk.toolCallId, label: 'Filed as a task', state: 'done' });
              } else if (name) {
                setStep({ id: chunk.toolCallId, label: toolStepLabel(name, 'done'), state: 'done' });
              }
              break;
            }
            case 'tool-output-error': {
              const name = toolNames.get(chunk.toolCallId) ?? continuingToolName(continuing, chunk.toolCallId);
              if (name) setStep({ id: chunk.toolCallId, label: toolStepLabel(name, 'failed'), state: 'done' });
              break;
            }
            case 'tool-output-denied':
              if (steps.has(chunk.toolCallId)) setStep({ id: chunk.toolCallId, label: 'Not done', state: 'done' });
              break;
          }
        }
        // Steers that arrived after the last step boundary go back to the client.
        if (steering) {
          let late: Awaited<ReturnType<SteerQueue['drain']>> = [];
          try { late = await steering.queue.drain(conversationId); } catch (e) { report('steer')(e); }
          for (const q of late) if (q.userId === userId) deferred.push({ id: q.id, text: q.text, state: 'deferred' });
          for (const d of deferred) writer.write({ type: STEER_PART_TYPE, id: d.id, data: d } as never);
          if (!writeChunk) for (const c of pendingChunks.splice(0)) writer.write(c as never);
        }
        writer.write({ type: 'finish' } as never);
      },
      onEnd: persist as never,
    });

    return ai.createUIMessageStreamResponse({
      stream,
      // Keep consuming if the client disconnects, so onEnd still saves the turn.
      consumeSseStream: ({ stream: s }) => ai.consumeStream({ stream: s }),
      headers: { 'x-kit-chat-tier': String(resolved.plan.tier ?? ''), ...opts.headers },
    });
  };

  return {
    run,
    async handle(req, ctx) {
      let body: unknown;
      try { body = await req.json(); } catch { return badRequest('invalid JSON body'); }
      return run({
        body, userId: ctx.userId, conversationId: ctx.conversationId, extra: ctx.extra,
        ...(ctx.abortOnDisconnect === false ? {} : { signal: req.signal }),
      });
    },
    async steer({ conversationId, userId, text, id }) {
      if (!opts.steering) return badRequest('steering_disabled', 404);
      const t = typeof text === 'string' ? text.trim() : '';
      if (!t || t.length > MAX_STEER_TEXT) return badRequest(`a steer of 1–${MAX_STEER_TEXT} characters is required`);
      const steerId = typeof id === 'string' && id ? id.slice(0, 100) : genId();
      try {
        await opts.steering.queue.push(conversationId, { id: steerId, text: t, userId, at: new Date(clock()).toISOString() });
      } catch (e) {
        report('steer')(e);
        return badRequest('steer_not_queued', 503);
      }
      const data: SteerData = { id: steerId, text: t, state: 'queued' };
      return Response.json({ steer: data }, { status: 202 });
    },
  };
}

function continuingToolName(continuing: StoredMessage | null, toolCallId: string): string | undefined {
  const p = continuing?.parts.find(x => isToolPart(x) && x.toolCallId === toolCallId);
  return p && isToolPart(p) ? toolNameOf(p) : undefined;
}
