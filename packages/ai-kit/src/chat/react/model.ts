/**
 * Pure view helpers for the `/chat/react` components (no React, no DOM), so
 * an app can reuse them in its own components and test them without a DOM.
 */

import {
  answerPartIndex,
  isSteerPart,
  isStepPart,
  isSystemDenied,
  isTextPart,
  isToolPart,
  parseApprovalPreview,
  toolNameOf,
  type ChatPart,
  type ChatToolPart,
  type StepData,
  defaultTierName,
} from '@builddai/ai-kit/chat/contract';

/**
 * The checklist for one assistant message: its `data-step` parts, newest state
 * per id, in first-seen order. While the turn streams and nothing is active or
 * waiting, a tail row says what is happening ("Reading your question",
 * "Thinking it through", "Writing the answer").
 */
export function thinkingSteps(parts: readonly ChatPart[], streaming: boolean): StepData[] {
  const byId = new Map<string, StepData>();
  let textAfterSteps = false;
  for (const p of parts) {
    if (isStepPart(p)) {
      byId.set(p.data.id, { ...p.data });
      textAfterSteps = false;
    } else if (isTextPart(p) && p.text.trim()) {
      textAfterSteps = true;
    }
  }
  const steps = [...byId.values()];
  if (!streaming) return steps.map(s => (s.state === 'active' ? { ...s, state: 'done' } : s));
  // One active step at most: the latest wins.
  let seenActive = false;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].state !== 'active') continue;
    if (seenActive) steps[i] = { ...steps[i], state: 'done' };
    seenActive = true;
  }
  if (!seenActive && !steps.some(s => s.state === 'pending')) {
    const label = steps.length === 0 && !textAfterSteps
      ? THINKING_TAIL.reading
      : textAfterSteps ? THINKING_TAIL.writing : THINKING_TAIL.thinking;
    steps.push({ id: THINKING_TAIL_ID, label, state: 'active' });
  }
  return steps;
}

/** The tail row `thinkingSteps` adds while nothing is active (0.17.0). */
export const THINKING_TAIL_ID = 'kit-tail';
export const THINKING_TAIL = { reading: 'Reading your question', thinking: 'Thinking it through', writing: 'Writing the answer' } as const;

/**
 * A step's weight (0.17.0): the server's `weight`, else `key` for a step
 * waiting on the person and `routine` for anything else.
 */
export function stepWeight(s: StepData): 'key' | 'routine' {
  return s.weight ?? (s.state === 'pending' ? 'key' : 'routine');
}

/** The step the live line shows (0.17.0): the active one, else the latest waiting on the person. */
export function liveStep(steps: readonly StepData[]): StepData | null {
  return lastOf(steps, s => s.state === 'active') ?? lastOf(steps, s => s.state === 'pending');
}

function lastOf(steps: readonly StepData[], ok: (s: StepData) => boolean): StepData | null {
  for (let i = steps.length - 1; i >= 0; i--) if (ok(steps[i])) return steps[i];
  return null;
}

/**
 * The one step pinned under the live line (0.17.0): the latest key step that
 * is not the live one. Reads, counted runs and thinking never pin.
 */
export function pinnedStep(steps: readonly StepData[]): StepData | null {
  const live = liveStep(steps);
  return lastOf(steps, s => s !== live && s.state !== 'active' && stepWeight(s) === 'key');
}

/** One row of the unfolded list (0.17.0): a step, or two or more routine steps in a row folded together. */
export type StepGroup =
  | { kind: 'step'; step: StepData }
  | { kind: 'routine'; id: string; steps: StepData[] };

/**
 * The unfolded list (0.17.0): the turn's steps in order, each run of two or
 * more consecutive routine steps folded into one group, and the active step
 * (if any) last.
 */
export function stepGroups(steps: readonly StepData[]): StepGroup[] {
  const live = lastOf(steps, s => s.state === 'active');
  const out: StepGroup[] = [];
  let run: StepData[] = [];
  const flush = () => {
    if (run.length === 1) out.push({ kind: 'step', step: run[0] });
    else if (run.length > 1) out.push({ kind: 'routine', id: run[0].id, steps: run });
    run = [];
  };
  for (const s of steps) {
    if (s === live) continue;
    if (stepWeight(s) === 'routine' && s.state !== 'pending') { run.push(s); continue; }
    flush();
    out.push({ kind: 'step', step: s });
  }
  flush();
  if (live) out.push({ kind: 'step', step: live });
  return out;
}

/** A tool part that is, or was, an approval card. */
export function isApprovalPart(part: ChatToolPart): boolean {
  return !!part.approval || part.state === 'approval-requested' || part.state === 'approval-responded' || part.state === 'output-denied';
}

/**
 * One assistant message's writes as the rows of one card (0.13.0): `rows` are
 * the writes that were shown, `held` the ones the server held back (the card
 * was full). Null when fewer than two rows were shown: a single write keeps
 * its own card. A write that must stand alone (an admin write's typed
 * confirmation by default, or whatever `alone` says) is never a row.
 */
export interface ApprovalRowGroup {
  rows: ChatToolPart[];
  held: ChatToolPart[];
}

export function approvalRowGroup(
  parts: readonly ChatPart[],
  opts: { alone?(part: ChatToolPart): boolean } = {},
): ApprovalRowGroup | null {
  const alone = opts.alone ?? (p => !!parseApprovalPreview(p.approval?.requestReason)?.confirmText);
  const approvals = parts.filter(isToolPart).filter(isApprovalPart);
  const rows = approvals.filter(p => !isSystemDenied(p) && !alone(p));
  if (rows.length < 2) return null;
  return { rows, held: approvals.filter(isSystemDenied) };
}

/**
 * One phase of an assistant turn (0.22.0, `ChatThread compose="turn"`): the
 * parts `[from, to)`, answered by one text part (`answerAt`, -1 with none
 * yet). A turn starts in one phase; a run of approvals or a steer closes it,
 * and the next phase opens with the first visible part after it, so the reply
 * to a decision is a new answer below the card, not the earlier answer moved.
 */
export interface TurnPhase {
  /** Stable while parts stream: `answer`, then `answer@<index of the boundary that opened it>`. */
  key: string;
  from: number;
  to: number;
  answerAt: number;
  /** What opened it: the last part of an approval run, or a steer. Null for the first phase. */
  opener: { kind: 'approval' | 'steer'; at: number } | null;
  /** What closed it: the approval run (its part indices) or a steer. Null while it is the last phase. */
  closer: { kind: 'approval'; at: number[] } | { kind: 'steer'; at: number } | null;
  /** Nothing more will land in it: it is closed, or the turn is no longer streaming. */
  settled: boolean;
}

export interface TurnComposition {
  phases: TurnPhase[];
}

/** A steer the agent took into this turn (not one deferred to the next). */
function opensPhase(p: ChatPart): boolean {
  return isSteerPart(p) && p.data.state !== 'deferred';
}

/**
 * Where an assistant turn's parts go (0.22.0): its phases, in order. Pure and
 * append-stable: a part arriving never changes an earlier phase's range,
 * answer or key, so what a phase drew stays where it is.
 */
export function composeTurn(parts: readonly ChatPart[], opts: { streaming?: boolean } = {}): TurnComposition {
  const phases: TurnPhase[] = [];
  let from = 0;
  let opener: TurnPhase['opener'] = null;
  let run: number[] = [];
  const close = (to: number, closer: TurnPhase['closer']) => {
    phases.push({ key: opener ? `answer@${opener.at}` : 'answer', from, to, answerAt: -1, opener, closer, settled: true });
  };
  parts.forEach((p, i) => {
    if (isToolPart(p) && isApprovalPart(p)) {
      run.push(i);
      return;
    }
    if (opensPhase(p)) {
      close(i, run.length > 0 ? { kind: 'approval', at: run } : { kind: 'steer', at: i });
      // An approval run then a steer: the steer still opens the next phase.
      from = i;
      opener = { kind: 'steer', at: i };
      run = [];
      return;
    }
    const visible = isToolPart(p) || (isTextPart(p) && !!p.text.trim());
    if (run.length > 0 && visible) {
      const last = run[run.length - 1];
      close(last + 1, { kind: 'approval', at: run });
      from = last + 1;
      opener = { kind: 'approval', at: last };
      run = [];
    }
  });
  phases.push({
    key: opener ? `answer@${(opener as { at: number }).at}` : 'answer',
    from, to: parts.length, answerAt: -1, opener,
    closer: run.length > 0 ? { kind: 'approval', at: run } : null,
    settled: run.length > 0 || !opts.streaming,
  });
  for (const ph of phases) {
    const i = answerPartIndex(parts.slice(ph.from, ph.to));
    ph.answerAt = i === -1 ? -1 : ph.from + i;
  }
  return { phases };
}

export type ToolRowState = 'running' | 'done' | 'failed' | 'awaiting' | 'denied';

export function toolRowState(part: ChatToolPart): ToolRowState {
  switch (part.state) {
    case 'output-available': return 'done';
    case 'output-error': return 'failed';
    case 'output-denied': return 'denied';
    case 'approval-requested': return 'awaiting';
    default: return 'running';
  }
}

/** "search_notes" → "Search notes". Used only when no step label exists. */
export function humanizeToolName(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Tool';
}

/** The collapsed row for a tool call: its step label when the server sent one. */
export function toolRowLabel(part: ChatToolPart, parts: readonly ChatPart[]): string {
  for (const p of parts) if (isStepPart(p) && p.data.id === part.toolCallId) return p.data.label;
  return humanizeToolName(toolNameOf(part));
}

/** The one-line summary a `ToolResult` may carry. */
export function toolSummary(part: ChatToolPart): string | null {
  if (part.state === 'output-error') return part.errorText ?? 'failed';
  const o = part.output as { summary?: unknown; objects?: unknown[] } | undefined;
  if (typeof o?.summary === 'string' && o.summary) return o.summary;
  if (Array.isArray(o?.objects) && o.objects.length) return `${o.objects.length} item${o.objects.length === 1 ? '' : 's'}`;
  return null;
}

/** The composer's tier label: "Auto", "Auto · Standard" once a turn ran, or the pinned tier. */
export function tierLabel(pinned: string | null, last: string | null | undefined, labels: Record<string, string> = {}, autoLabel = 'Auto'): string {
  const name = (t: string) => labels[t] ?? defaultTierName(t);
  if (pinned) return name(pinned);
  return last ? `${autoLabel} · ${name(last)}` : autoLabel;
}

/** A running total: '' when nothing has been spent, `<$0.01` under a cent, else `$0.42`. */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return '';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** A per-1k-token price: two significant figures, trailing zeros dropped (`$0.0030` → `$0.003`). */
export function formatPer1k(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  return `$${Number(usd.toPrecision(2)).toString()}`;
}

/** "Hi Sam, what are we working on?" */
export function greeting(name?: string | null): string {
  const n = name?.trim();
  return n ? `Hi ${n}, what are we working on?` : 'What are we working on?';
}
