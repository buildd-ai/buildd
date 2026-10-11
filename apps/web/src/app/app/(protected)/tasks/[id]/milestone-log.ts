/**
 * Pure derivations for the running view's log: outcome milestones only, each
 * carrying how long it took and the tool calls that happened under it.
 *
 * The log used to list every milestone newest-first with a relative "just now"
 * on each row — narration ("Now I'll run the tests") sat beside outcomes and
 * every row read the same age. Now:
 *  - a tool-call preamble (a phase whose text was only a lead-in to its calls,
 *    see tool-preamble.ts) is named by what it called — "Checked decision",
 *    not "Now let me check the decision…" — with the raw text kept for the
 *    expanded row; adjacent phases that did the same thing merge;
 *  - other narration milestones are dropped (their tool calls fold into the
 *    milestone before them) unless they carry a finding or decision;
 *  - tool-call milestones (`type: 'action'`, e.g. "Ran: bun test") never get a
 *    row of their own — they hang under the milestone they happened in, behind
 *    its "N tools" chip;
 *  - each entry's time is its duration: until the next milestone, or
 *    "running 3m" for the newest one while the worker is live.
 */
import type { WorkerMilestone } from '@buildd/core/db/schema';
import { classifyAction } from './task-activity';
import { isSubstantive, isToolPreamble, preambleActionLabel } from './tool-preamble';

type Milestone = WorkerMilestone;

const NARRATION = /^(now\s+i'll|now\s+i\s+will|now\s+let\s+me|now\s+let's|let\s+me|let's|i'll|i\s+will|i'm\s+going\s+to|i\s+am\s+going\s+to|next,?\s+i|next,?\s+let\s+me)\b/i;

/**
 * Whether a milestone label is the agent narrating its next step rather than
 * reporting an outcome. Case-insensitive, after trimming; curly apostrophes
 * count as straight ones.
 */
export function isNarrationMilestone(text: string): boolean {
  if (!text) return false;
  return NARRATION.test(text.trim().replace(/[‘’]/g, "'"));
}

/** Compact duration: `42s`, `3m`, `1h 5m` (`2h` on the hour). */
export function formatDurationShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * How long a log entry took. A finished entry (`endMs` known) shows its
 * duration; the still-open newest entry (`endMs` null) shows how long it has
 * been running.
 */
export function milestoneDurationLabel(startMs: number, endMs: number | null, nowMs: number): string {
  if (endMs == null) return `running ${formatDurationShort(nowMs - startMs)}`;
  return formatDurationShort(endMs - startMs);
}

export interface LogEntry {
  milestone: Milestone & { label?: string };
  /**
   * What the feed shows instead of the milestone's own label: set when the
   * milestone was a tool-call preamble, named by the operations it called.
   */
  actionLabel?: string;
  /** The raw preamble text(s) `actionLabel` stands for, oldest first — for the expanded row. */
  preambles?: string[];
  /** Tool-call milestones that happened while this entry was the latest, oldest first. */
  tools: Array<Extract<Milestone, { type: 'action' }>>;
  /** Tool calls under this entry: the phase's own count, or the sampled actions, whichever is larger. */
  toolCount: number;
  startMs: number;
  /** Next entry's start; null for the newest entry while the worker is live. */
  endMs: number | null;
  /** Null when there is nothing honest to show (a finished run's last entry with no later activity). */
  durationLabel: string | null;
}

export function isToolMilestone(m: Milestone): m is Extract<Milestone, { type: 'action' }> {
  return m.type === 'action';
}

/**
 * Builds the log, newest entry first. Tool calls that happened before the
 * first outcome milestone attach to that first entry so none are lost.
 */
export function buildMilestoneLog(milestones: Milestone[], opts: { nowMs: number; live: boolean }): LogEntry[] {
  const sorted = [...milestones].sort((a, b) => a.ts - b.ts);
  const entries: Array<Omit<LogEntry, 'endMs' | 'durationLabel' | 'toolCount'> & { phaseTools: number }> = [];
  const leading: LogEntry['tools'] = [];
  let leadingPhaseTools = 0;

  for (const m of sorted) {
    const current = entries[entries.length - 1];
    if (isToolMilestone(m)) {
      (current ? current.tools : leading).push(m);
      continue;
    }
    const phaseTools = m.type === 'phase' ? m.toolCount || 0 : 0;
    const label = m.label ?? '';
    if (isToolPreamble(m)) {
      const actionLabel = preambleActionLabel(m);
      if (actionLabel) {
        // The same thing again ("Saved knowledge" twice running) is one row.
        if (current?.actionLabel === actionLabel) {
          current.phaseTools += phaseTools;
          current.preambles!.push(label.trim());
          continue;
        }
        entries.push({ milestone: m, actionLabel, preambles: [label.trim()], tools: [], startMs: m.ts, phaseTools });
        continue;
      }
      // An older runner recorded no ops to name it by: fall through to the
      // lexical narration check below.
    }
    if (isNarrationMilestone(label) && !isSubstantive(label)) {
      if (current) current.phaseTools += phaseTools;
      else leadingPhaseTools += phaseTools;
      continue;
    }
    entries.push({ milestone: m, tools: [], startMs: m.ts, phaseTools });
  }

  if (entries.length > 0) {
    entries[0].tools.unshift(...leading);
    entries[0].phaseTools += leadingPhaseTools;
  }

  const out: LogEntry[] = entries.map((e, i) => {
    const next = entries[i + 1];
    const lastTool = e.tools.length ? e.tools[e.tools.length - 1].ts : e.startMs;
    const endMs = next ? next.startMs : opts.live ? null : lastTool;
    const durationLabel = endMs == null || endMs > e.startMs ? milestoneDurationLabel(e.startMs, endMs, opts.nowMs) : null;
    const actionCount = e.tools.reduce((s, t) => s + (classifyAction(t)?.count ?? 1), 0);
    return {
      milestone: e.milestone,
      ...(e.actionLabel && { actionLabel: e.actionLabel, preambles: e.preambles }),
      tools: e.tools,
      toolCount: Math.max(e.phaseTools, actionCount),
      startMs: e.startMs,
      endMs,
      durationLabel,
    };
  });
  return out.reverse();
}

/**
 * Whether a tokens figure is real. Zero tokens after the agent has taken turns
 * is a reporting gap (seat/OAuth auth often reports none), not a measurement —
 * hide it rather than print a confident 0.
 */
export function showTokenCount(tokens: number | null | undefined, turns: number | null | undefined): boolean {
  const t = tokens ?? 0;
  if (t > 0) return true;
  return !((turns ?? 0) > 0);
}
