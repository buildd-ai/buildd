/**
 * Pure view helpers for the `/chat/react` components (no React, no DOM), so
 * an app can reuse them in its own components and test them without a DOM.
 */

import {
  isStepPart,
  isTextPart,
  isToolPart,
  toolNameOf,
  type ChatPart,
  type ChatToolPart,
  type StepData,
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
      ? 'Reading your question'
      : textAfterSteps ? 'Writing the answer' : 'Thinking it through';
    steps.push({ id: 'kit-tail', label, state: 'active' });
  }
  return steps;
}

/** A tool part that is, or was, an approval card. */
export function isApprovalPart(part: ChatToolPart): boolean {
  return !!part.approval || part.state === 'approval-requested' || part.state === 'approval-responded' || part.state === 'output-denied';
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
export function tierLabel(pinned: string | null, last: string | null | undefined, labels: Record<string, string> = {}): string {
  const name = (t: string) => labels[t] ?? (t === 'premium-plus' ? 'Premium+' : t[0].toUpperCase() + t.slice(1));
  if (pinned) return name(pinned);
  return last ? `Auto · ${name(last)}` : 'Auto';
}

/** "Hi Sam, what are we working on?" */
export function greeting(name?: string | null): string {
  const n = name?.trim();
  return n ? `Hi ${n}, what are we working on?` : 'What are we working on?';
}
