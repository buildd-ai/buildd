/**
 * Conversation titles, cheapest step first:
 *
 *  1. the app's own rules (`rules`): a chat opened about an object can take
 *     that object's name, with no model call;
 *  2. the built-in rule (`ruleTitle`): a short first message that already
 *     reads like a title ("Why is the release stuck?") is used as is;
 *  3. a model call, on whatever model the app hands over (a `budget` plan).
 *
 * The model step leaves room for reasoning. Budget models on OpenRouter often
 * think before they answer, and a cap sized for the title alone (~30 tokens)
 * is spent on the thinking: the call finishes on `length` with empty text.
 * An empty or unusable answer is an error the app hears about (`onError`),
 * never a silent skip.
 *
 * Off unless the app passes `title` to `createChatTurn`. `titleConversation`
 * is the same pipeline for apps that run their own turn loop.
 */

import type { LanguageModel, UIMessage } from 'ai';
import type { ChatPart } from '@builddai/ai-kit/chat/contract';
import type { UsageReceipt } from '@builddai/ai-kit/models';
import type { TurnPlan } from './model';

/** Longest title the kit returns. Matches `schema.sql`'s `varchar(80)`. */
export const TITLE_MAX_CHARS = 80;
/** The built-in rule's word range: shorter is too vague, longer is a message, not a title. */
export const RULE_TITLE_WORDS = { min: 2, max: 7 } as const;
export const TITLE_INSTRUCTIONS = 'Write a title for this conversation: 3 to 7 words, sentence case, no quotes, no trailing period. Reply with the title only.';

export const DEFAULT_TITLE_LIMITS = {
  /** Room for a reasoning model to think and still answer. */
  maxOutputTokens: 512,
  timeoutMs: 10_000,
  /** Trailing messages the model reads. */
  messages: 4,
  /** Transcript characters the model reads. */
  transcriptChars: 3_000,
} as const;

export type TitleLimits = { [K in keyof typeof DEFAULT_TITLE_LIMITS]: number };

/** A plain view of the conversation: role and text only. */
export interface TitleMessage {
  role: string;
  text: string;
}

export interface TitleRuleContext<X = unknown> {
  messages: readonly TitleMessage[];
  /** The first user message's text, trimmed. */
  firstUserText: string;
  extra: X;
}

/** The model for the model step: the `ai` model, and where its receipt goes. */
export interface TitleModel {
  model: LanguageModel;
  plan?: TurnPlan;
  recordUsage?: (receipt: UsageReceipt) => void;
}

export interface TitleResult {
  title: string;
  /** Which step produced it. */
  source: 'app_rule' | 'rule' | 'model';
}

export interface TitleConversationArgs<X = unknown> {
  messages: readonly TitleMessage[] | readonly UIMessage[];
  extra?: X;
  /** App rules, run first. Return a title, or null to fall through. */
  rules?: (ctx: TitleRuleContext<X>) => string | null | Promise<string | null>;
  /** Skip the built-in first-message rule. Default false. */
  skipBuiltInRule?: boolean;
  /** The model step. Omit (or resolve null) for rules only. */
  model?: TitleModel | null | (() => TitleModel | null | Promise<TitleModel | null>);
  limits?: Partial<TitleLimits>;
  instructions?: string;
  onError?: (error: unknown) => void;
  /** Test seam: replace `generateText`. */
  generate?: typeof import('ai').generateText;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Clean a model's or a person's title: one line, no quotes/markdown/label/trailing period, ≤ 80 chars. Null when nothing is left. */
export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const line = raw.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
  let t = line.replace(/\s+/g, ' ');
  t = t.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').replace(/^title\s*:\s*/i, '');
  const QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/g;
  t = t.replace(QUOTES, '').replace(/[.。]+$/, '').replace(QUOTES, '').trim();
  if (!t) return null;
  return t.length > TITLE_MAX_CHARS ? `${t.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : t;
}

const FILLER = /^(?:(?:hey|hi|hello|ok|okay|so|um|please)\b[\s,!.]*|(?:can|could|would|will) you\s+(?:please\s+)?)/i;

/**
 * The built-in rule: a first message of 2–7 words on one line, with no code
 * or link, is already a title. Leading filler ("hey", "can you") is dropped
 * and the first letter capitalised. Null ⇒ ask the model.
 */
export function ruleTitle(text: string): string | null {
  const raw = text.trim();
  if (!raw || /[\r\n]/.test(raw) || /`|https?:\/\/|[{}<>]/.test(raw)) return null;
  let t = raw.replace(/\s+/g, ' ');
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(FILLER, ''); }
  t = t.replace(/[.!]+$/, '').trim();
  const words = t.split(' ').filter(Boolean).length;
  if (words < RULE_TITLE_WORDS.min || words > RULE_TITLE_WORDS.max) return null;
  return normalizeTitle(t.charAt(0).toUpperCase() + t.slice(1));
}

function textOf(parts: readonly unknown[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => (p as ChatPart)?.type === 'text' && typeof (p as { text?: unknown }).text === 'string')
    .map(p => p.text)
    .join(' ')
    .trim();
}

/** UI or stored messages → role + text, user and assistant only. */
export function titleMessages(messages: readonly TitleMessage[] | readonly UIMessage[] | readonly { role: string; parts: readonly unknown[] }[]): TitleMessage[] {
  return (messages as readonly (TitleMessage | { role: string; parts: readonly unknown[] })[])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ('text' in m && typeof m.text === 'string' ? { role: m.role, text: m.text.trim() } : { role: m.role, text: textOf((m as { parts: readonly unknown[] }).parts ?? []) }))
    .filter(m => m.text);
}

function transcript(messages: readonly TitleMessage[], limits: TitleLimits): string {
  return messages.slice(-limits.messages).map(m => `${m.role}: ${m.text}`).join('\n').slice(0, limits.transcriptChars);
}

// ── The pipeline ──────────────────────────────────────────────────────────────

let aiModule: Promise<typeof import('ai')> | null = null;
function loadAi(): Promise<typeof import('ai')> {
  aiModule ??= import('ai').catch((e) => { aiModule = null; throw e; });
  return aiModule;
}

/**
 * Title a conversation: app rules, the built-in rule, then the model. Never
 * throws; null when no step produced a title (the failure goes to `onError`).
 */
export async function titleConversation<X = unknown>(args: TitleConversationArgs<X>): Promise<TitleResult | null> {
  const report = (e: unknown) => { try { args.onError?.(e); } catch { /* a logger never breaks titling */ } };
  const limits: TitleLimits = { ...DEFAULT_TITLE_LIMITS, ...args.limits };
  const messages = titleMessages(args.messages);
  const firstUserText = messages.find(m => m.role === 'user')?.text ?? '';
  if (!firstUserText) return null;

  try {
    if (args.rules) {
      const t = normalizeTitle(await args.rules({ messages, firstUserText, extra: args.extra as X }));
      if (t) return { title: t, source: 'app_rule' };
    }
  } catch (e) { report(e); }

  if (!args.skipBuiltInRule) {
    const t = ruleTitle(firstUserText);
    if (t) return { title: t, source: 'rule' };
  }

  let m: TitleModel | null | undefined;
  try {
    m = typeof args.model === 'function' ? await args.model() : args.model;
  } catch (e) { report(e); return null; }
  if (!m) return null;

  const startedAt = Date.now();
  let outcome: 'ok' | 'error' = 'error';
  let tokens = { input: 0, output: 0 };
  try {
    const generate = args.generate ?? (await loadAi()).generateText;
    const r = await generate({
      model: m.model,
      instructions: args.instructions ?? TITLE_INSTRUCTIONS,
      prompt: transcript(messages, limits),
      ...(limits.maxOutputTokens > 0 ? { maxOutputTokens: limits.maxOutputTokens } : {}),
      abortSignal: AbortSignal.timeout(limits.timeoutMs),
    });
    tokens = { input: r.usage?.inputTokens ?? 0, output: r.usage?.outputTokens ?? 0 };
    const title = normalizeTitle(r.text);
    if (!title) {
      report(new Error(`title model${m.plan ? ` ${m.plan.model}` : ''} returned no text (finish: ${r.finishReason}, output tokens: ${tokens.output})`));
      return null;
    }
    outcome = 'ok';
    return { title, source: 'model' };
  } catch (e) {
    report(e);
    return null;
  } finally {
    if (m.plan && m.recordUsage) {
      try {
        m.recordUsage({
          plan: { planId: m.plan.planId, planSource: m.plan.planSource, model: m.plan.model, provider: m.plan.provider, tier: m.plan.tier },
          kind: 'inference', tokens, latencyMs: Date.now() - startedAt, outcome,
        });
      } catch (e) { report(e); }
    }
  }
}
