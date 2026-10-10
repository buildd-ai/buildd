import type { UIMessage } from 'ai';

/**
 * The model's view of a long conversation. A user message may carry up to
 * `maxUserText` characters, so forty of them can exceed any model's context.
 * This trims what the model is SENT, never what is stored: earlier long user
 * text is replaced by a short note saying it is still in the conversation,
 * oldest first, until the history fits. The newest message is always sent
 * whole; it was accepted under `maxUserText`, so it alone fits.
 */

/** Characters of text sent to the model across the whole history (~100k tokens). */
export const DEFAULT_HISTORY_CHARS = 400_000;
/** User text at or below this length is never replaced. */
export const HISTORY_STUB_OVER_CHARS = 8_000;

export function historyStubText(chars: number): string {
  return `[Earlier pasted text, ${chars.toLocaleString('en-US')} characters. It is kept in the conversation but not repeated here; ask the person to paste or point to the part that matters.]`;
}

const textOf = (m: UIMessage): number =>
  m.parts.reduce((n, p) => n + (p.type === 'text' || p.type === 'reasoning' ? String((p as { text?: unknown }).text ?? '').length : 0), 0);

export function fitHistoryToBudget(messages: readonly UIMessage[], maxChars: number = DEFAULT_HISTORY_CHARS): UIMessage[] {
  const out = [...messages];
  let total = out.reduce((n, m) => n + textOf(m), 0);
  if (total <= maxChars) return out;

  // 1. Earlier long user text becomes a note, oldest first.
  for (let i = 0; i < out.length - 1 && total > maxChars; i++) {
    const m = out[i];
    if (m.role !== 'user') continue;
    const chars = textOf(m);
    if (chars <= HISTORY_STUB_OVER_CHARS) continue;
    const stub = historyStubText(chars);
    out[i] = { ...m, parts: [...m.parts.filter(p => p.type !== 'text'), { type: 'text', text: stub }] } as UIMessage;
    total += stub.length - chars;
  }
  // 2. Still over (long assistant text, many mid-sized messages): drop the
  //    oldest messages, never the newest.
  while (total > maxChars && out.length > 1) {
    total -= textOf(out.shift()!);
  }
  return out;
}
