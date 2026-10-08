/**
 * The browser half of the visible-answer turn signal (lib/chat/turn-signal.ts).
 * One tracker per open conversation follows its current user turn: submitted,
 * streaming, first content, answer visibly on screen, ended. It also notes
 * anything that means the person may not have been looking (background,
 * pagehide, offline, leaving, stop, hidden pane), so a missing render is
 * never blamed on the app when the page was away.
 *
 * The environment (clock, DOM probe, network) is injected, so the tracker is
 * tested without a browser; use-turn-signal.ts wires the real one. It holds
 * ids, offsets and flags only: no message text ever enters it.
 */
import type { TurnSignal, TurnSignalOutcome, TurnSignalSuppressor } from '@/lib/chat/turn-signal';

/** After the turn ends, wait this long for the answer to paint before the last check. */
export const RENDER_GRACE_MS = 1500;

/** What the DOM shows of the answer right now. */
export type ProbeResult = 'visible' | 'not_visible' | 'pane_hidden';

export interface TrackerEnv {
  now(): number;
  /** Is non-empty assistant content of `assistantId` in the DOM and visible, next to user message `ref`? */
  probe(ref: string, assistantId: string): ProbeResult;
  /** Send `signal` for turn `ref`. `beacon`: the page is going away. */
  post(ref: string, signal: TurnSignal, beacon: boolean): void;
  docHidden(): boolean;
  online(): boolean;
}

interface Turn {
  ref: string;
  at: number;
  signal: TurnSignal;
  /** The final record went out: the turn is done. */
  done: boolean;
}

export class TurnSignalTracker {
  private turn: Turn | null = null;
  constructor(private env: TrackerEnv) {}

  /** The ref of the turn being followed, if any. */
  get current(): string | null { return this.turn && !this.turn.done ? this.turn.ref : null; }

  /** A new user message `ref` went out. A previous turn still open is sent as it stands. */
  submit(ref: string): void {
    if (this.turn?.ref === ref) return;
    if (this.turn && !this.turn.done) this.finalize();
    const at = this.env.now();
    this.turn = { ref, at, signal: { at }, done: false };
    if (this.env.docHidden()) this.flag('hidden');
    if (!this.env.online()) this.flag('offline');
  }

  streaming(): void { this.offset('startMs'); }

  /** Non-empty assistant content arrived in the client's state. */
  content(assistantId: string): void {
    const t = this.open();
    if (!t) return;
    t.signal.assistantId ??= assistantId;
    this.offset('contentMs');
  }

  /** Check the DOM for the answer; called after each commit while the turn is open. */
  check(): void {
    const t = this.open();
    if (!t?.signal.assistantId || t.signal.renderMs !== undefined) return;
    const r = this.env.probe(t.ref, t.signal.assistantId);
    if (r === 'visible' && !this.env.docHidden()) this.offset('renderMs');
    else if (r === 'pane_hidden') this.flag('paneHidden');
  }

  /** The client saw the turn end. The caller finalizes after RENDER_GRACE_MS. */
  end(outcome: TurnSignalOutcome): void {
    const t = this.open();
    if (!t || t.signal.endMs !== undefined) return;
    this.offset('endMs');
    t.signal.outcome = outcome;
  }

  /** Last check, then send the record once. */
  finalize(): void {
    const t = this.open();
    if (!t) return;
    this.check();
    t.done = true;
    this.env.post(t.ref, { ...t.signal }, false);
  }

  /** Something that means the person may not have been looking. */
  flag(k: TurnSignalSuppressor): void {
    const t = this.open();
    if (t) t.signal[k] = true;
  }

  /** The page's visibility changed: hidden at any point in the turn is flagged. */
  visibilityChanged(): void { if (this.env.docHidden()) this.flag('hidden'); }

  /** The page is going away: flag it and send what there is now. */
  pagehide(): void { this.away('pagehide'); }
  /** The conversation view closed or changed mid-turn. */
  left(): void { this.away('left'); }

  private away(k: 'pagehide' | 'left'): void {
    const t = this.open();
    if (!t) return;
    t.signal[k] = true;
    t.done = true;
    this.env.post(t.ref, { ...t.signal }, k === 'pagehide');
  }

  private open(): Turn | null { return this.turn && !this.turn.done ? this.turn : null; }

  private offset(k: 'startMs' | 'contentMs' | 'renderMs' | 'endMs'): void {
    const t = this.open();
    if (t && t.signal[k] === undefined) t.signal[k] = Math.max(0, this.env.now() - t.at);
  }
}

/** Non-empty assistant text, or an approval card, in a message's parts. */
export function hasAnswerContent(parts: ReadonlyArray<{ type: string }>): boolean {
  return (parts as ReadonlyArray<{ type: string; [k: string]: unknown }>).some(p =>
    (p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0)
    || ((p.type.startsWith('tool-') || p.type === 'dynamic-tool') && p.state === 'approval-requested'));
}
