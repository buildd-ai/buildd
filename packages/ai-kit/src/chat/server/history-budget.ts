import type { UIMessage } from 'ai';

/**
 * The model's view of a long conversation. A user message may carry up to
 * `maxUserText` characters, so a few of them can exceed any model's context.
 * This trims what the model is SENT, never what is stored: earlier long user
 * text is replaced by a short note saying it is still in the conversation,
 * oldest first, then the oldest messages drop, until the history fits. The
 * newest user message is always sent whole; a turn refuses one that alone
 * exceeds the budget (`messageFitsModel`) before any spend.
 *
 * Sizes are estimated tokens, not characters: ASCII at 4 characters a token,
 * anything else at 1 (CJK, emoji and most scripts tokenize near one token a
 * character, so a character count let 200,000 of them through whole).
 */

/** Estimated tokens of history sent to the model per turn. */
export const DEFAULT_HISTORY_TOKENS = 100_000;
/** User text estimated at or below this many tokens is never replaced. */
export const HISTORY_STUB_OVER_TOKENS = 2_000;

export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

export function historyStubText(chars: number): string {
  return `[Earlier pasted text, ${chars.toLocaleString('en-US')} characters. It is kept in the conversation but not repeated here; ask the person to paste or point to the part that matters.]`;
}

const partText = (p: UIMessage['parts'][number]): string => {
  if (p.type === 'text' || p.type === 'reasoning') return String((p as { text?: unknown }).text ?? '');
  // Tool parts carry their input and output to the model too.
  if (p.type.startsWith('tool-') || p.type === 'dynamic-tool') {
    const t = p as { input?: unknown; output?: unknown };
    return JSON.stringify([t.input ?? null, t.output ?? null]);
  }
  return '';
};
const userChars = (m: UIMessage): number =>
  m.parts.reduce((n, p) => n + (p.type === 'text' ? String((p as { text?: unknown }).text ?? '').length : 0), 0);
export const messageTokens = (m: UIMessage): number => m.parts.reduce((n, p) => n + estimateTokens(partText(p)), 0);

/** Whether one message, sent whole, fits the model's history budget. */
export function messageFitsModel(text: string, maxTokens: number = DEFAULT_HISTORY_TOKENS): boolean {
  return estimateTokens(text) <= maxTokens;
}

export function fitHistoryToBudget(messages: readonly UIMessage[], maxTokens: number = DEFAULT_HISTORY_TOKENS): UIMessage[] {
  const out = [...messages];
  const sizes = out.map(messageTokens);
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return out;

  // The newest user message is the one this turn answers (on an approval
  // continuation the newest message is the assistant's, so look back for it).
  let keep = out.length - 1;
  for (let i = out.length - 1; i >= 0; i--) if (out[i].role === 'user') { keep = i; break; }

  // 1. Earlier long user text becomes a note, oldest first.
  for (let i = 0; i < out.length && total > maxTokens; i++) {
    const m = out[i];
    if (i === keep || m.role !== 'user' || sizes[i] <= HISTORY_STUB_OVER_TOKENS) continue;
    const stub = historyStubText(userChars(m));
    out[i] = { ...m, parts: [...m.parts.filter((p) => p.type !== 'text'), { type: 'text', text: stub }] } as UIMessage;
    const next = messageTokens(out[i]);
    total += next - sizes[i];
    sizes[i] = next;
  }
  // 2. Still over: drop the oldest messages, never the one this turn answers
  //    or anything after it, and start on a user message, as providers expect.
  const dropOldest = () => { total -= sizes.shift()!; out.shift(); keep--; };
  let dropped = false;
  while (out.length > 1 && keep > 0 && total > maxTokens) { dropOldest(); dropped = true; }
  if (dropped) while (out.length > 1 && keep > 0 && out[0].role !== 'user') dropOldest();
  return out;
}
