/**
 * Visible-answer findings: did the person actually get to see an answer?
 *
 * Pure and deterministic, over the stored messages of one retro window and
 * the turn signal the client merged into each user message
 * (lib/chat/turn-signal.ts). Three kinds, all labelled by code, never asked
 * of the model:
 *
 * - `no_output` (on the user message): the turn ended with no usable
 *   assistant answer saved. Backend-side: nothing the client did matters,
 *   except that a client that confirmed rendering content means the person
 *   saw something, so it is not a visible-answer failure.
 * - `render_gap` (on the assistant message): a usable answer was saved, the
 *   client stayed in the foreground to the end of the turn (no background,
 *   pagehide, offline, leaving, stop or hidden pane), and still never
 *   confirmed the answer visible. A missing or suppressed signal is unknown,
 *   never a gap.
 * - `blank_retry` (on the next user message): the person asked again within
 *   BLANK_RETRY_WINDOW_MS of a blank outcome (confidence 1), or re-sent the
 *   same question that quickly after an answer nobody confirmed seeing
 *   (confidence RETRY_GUESS_CONF, at least RETRY_GUESS_MIN_CHARS long). The text comparison happens here, in
 *   memory; no text leaves this function.
 */
import { TURN_STOPPED_NOTE } from '@/lib/chat/turn-deadline';
import { readTurnSignal, turnSignalSuppressedBy } from '@/lib/chat/turn-signal';
import type { VisibleCandidateKind, VisibleCauseLabel } from './vocab';

/** A re-ask this soon after a blank outcome is a retry of it. */
export const BLANK_RETRY_WINDOW_MS = 3 * 60_000;
/** Confidence of a finding code is sure of. */
export const VISIBLE_HIGH_CONF = 1;
/** An identical re-ask after an answer whose display is unknown. */
export const RETRY_GUESS_CONF = 0.6;
/** Shorter re-sends ("yes", "continue") are ordinary replies, not re-asks. */
export const RETRY_GUESS_MIN_CHARS = 12;

export interface VisibleFinding {
  kind: VisibleCandidateKind;
  /** The message the finding attaches to (see the module comment). */
  messageId: string;
  conf: number;
}

/** The lesson's cause for each kind. */
export const VISIBLE_CAUSE_OF: Record<VisibleCandidateKind, VisibleCauseLabel> = {
  no_output: 'no_answer',
  render_gap: 'render_gap',
  blank_retry: 'blank_retry',
};

/** Primary-cause precedence when a window has several; a visible failure outranks any waste. */
export const VISIBLE_CAUSE_ORDER: readonly VisibleCauseLabel[] = ['render_gap', 'no_answer', 'blank_retry'];

/** The fix class code assigns: a render gap is the screen's, the rest the turn pipeline's. */
export const VISIBLE_FIX_CLASS: Record<VisibleCauseLabel, 'ui' | 'turn_pipeline'> = {
  render_gap: 'ui',
  no_answer: 'turn_pipeline',
  blank_retry: 'turn_pipeline',
};

/** Kinds, and their causes, that may file on first occurrence for a dogfood team, at high confidence. */
export const FIRST_OCCURRENCE_KINDS: readonly VisibleCandidateKind[] = ['no_output', 'render_gap'];
export const FIRST_OCCURRENCE_CAUSES: readonly VisibleCauseLabel[] = FIRST_OCCURRENCE_KINDS.map(k => VISIBLE_CAUSE_OF[k]);

interface Msg {
  id: string;
  role: 'user' | 'assistant' | 'event';
  parts: Array<{ type: string; [key: string]: unknown }>;
  createdAt: Date;
  usage: unknown;
}

const textParts = (parts: Msg['parts']) =>
  (parts ?? []).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text as string);

/**
 * A usable answer: non-empty text other than the stopped note, or an
 * approval card waiting on the person. Tool rows alone are not an answer.
 */
export function isUsableAnswer(parts: Msg['parts']): boolean {
  if (textParts(parts).some(t => t.replace(TURN_STOPPED_NOTE, '').trim().length > 0)) return true;
  return (parts ?? []).some(p => (p.type.startsWith('tool-') || p.type === 'dynamic-tool') && p.state === 'approval-requested');
}

const isStopped = (parts: Msg['parts']) => textParts(parts).some(t => t.includes(TURN_STOPPED_NOTE));
const normalize = (s: string) => s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

type Outcome = 'blank' | 'seen' | 'unknown' | 'other';

export function classifyVisibleAnswers(messages: Msg[], opts: { lastMayContinue?: boolean } = {}): VisibleFinding[] {
  const seq = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const findings: VisibleFinding[] = [];
  let prev: { outcome: Outcome; endAt: number; text: string } | null = null;

  for (let i = 0; i < seq.length; i++) {
    const user = seq[i];
    if (user.role !== 'user') continue;
    const text = normalize(textParts(user.parts).join(' '));

    if (prev) {
      const gap = new Date(user.createdAt).getTime() - prev.endAt;
      if (gap >= 0 && gap <= BLANK_RETRY_WINDOW_MS) {
        if (prev.outcome === 'blank') findings.push({ kind: 'blank_retry', messageId: user.id, conf: VISIBLE_HIGH_CONF });
        else if (prev.outcome === 'unknown' && text.length >= RETRY_GUESS_MIN_CHARS && text === prev.text) findings.push({ kind: 'blank_retry', messageId: user.id, conf: RETRY_GUESS_CONF });
      }
    }

    const next = seq[i + 1];
    const answer = next?.role === 'assistant' ? next : null;
    const signal = readTurnSignal(user.usage);
    const rendered = signal?.renderMs !== undefined;
    let outcome: Outcome;

    if (answer && isUsableAnswer(answer.parts)) {
      const sameAnswer = !signal?.assistantId || signal.assistantId === answer.id.toLowerCase();
      if (rendered) outcome = 'seen';
      else if (signal && sameAnswer && turnSignalSuppressedBy(signal) === null) {
        findings.push({ kind: 'render_gap', messageId: answer.id, conf: VISIBLE_HIGH_CONF });
        outcome = 'blank';
      } else outcome = 'unknown';
    } else if (answer && isStopped(answer.parts)) {
      outcome = 'other'; // the `stopped` family covers it, and the person saw the note
    } else if (rendered) {
      outcome = 'seen'; // the client showed content the server did not keep: not a visible failure
    } else if (!answer && i === seq.length - 1 && opts.lastMayContinue) {
      outcome = 'other'; // the answer may be in the next window
    } else {
      findings.push({ kind: 'no_output', messageId: user.id, conf: VISIBLE_HIGH_CONF });
      outcome = 'blank';
    }

    const endAt = new Date((answer ?? user).createdAt).getTime();
    prev = { outcome, endAt, text };
  }
  return findings;
}
