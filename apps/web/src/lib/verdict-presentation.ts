import type { EffortDay } from './initiative-pulse';

/**
 * Presentation half of the winning verdict (spec §6.5, §4.3).
 *
 * Split from `initiative-pulse.ts` on purpose: that module imports the database,
 * and these values are needed by client components. A `'use client'` component
 * importing `VERDICT_LABEL` from the loader would drag Drizzle and the pg client
 * into the browser bundle. Type-only imports are erased, so `EffortDay` above
 * costs nothing.
 *
 * The verdict vocabulary is defined here and re-exported by the loader, so there
 * is one spelling of each label.
 */

export type Verdict =
  | 'losing'
  | 'grinding'
  | 'stuck'
  | 'won_unclaimed'
  | 'winning'
  | 'dormant'
  | 'empty';

export type Confidence = 'verified' | 'unverified';

/** Display copy. §6.5 fixes these strings; surfaces MUST NOT re-word them. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  losing: 'Losing',
  grinding: 'Grinding',
  stuck: 'Stuck',
  won_unclaimed: 'Ready to close',
  winning: 'Winning',
  dormant: 'Dormant',
  empty: 'Empty',
};

/**
 * The Not-winning zone's row order (§4.3), which is the ladder's own order.
 * A `losing` arc is therefore always the first row on the page.
 */
export const NOT_WINNING_ORDER: Verdict[] = ['losing', 'grinding', 'stuck', 'won_unclaimed'];

/** One initiative's daily signal, as every surface receives it (§6.1). */
export interface InitiativePulse {
  /** Initiative uuid. The unassigned bucket is a Missions concern, not a row here. */
  id: string;
  title: string;
  /** 0–100, canonical (§6.3) — the scope meter, never the headline. */
  progress: number;
  /** Exactly 14 entries, oldest first, anchored on today. */
  effortDays: EffortDay[];
  awaitingVerification: number;
  blocked: number;
  held: number;
  shippedThisWeek: number;
  verdict: Verdict;
  confidence: Confidence;
  merges7d: number;
  attempts7d: number;
  tokens7d: number;
  criteriaFail: number;
  /** Rollup counts for the row's third line. */
  completedMissions: number;
  totalMissions: number;
  completedTasks: number;
  totalTasks: number;
}

export interface VerdictChipStyle {
  label: string;
  /** Token-only classes; no off-palette hex, matching `initiativeStatusChip`. */
  className: string;
}

/**
 * Chip style per verdict. Only `losing` gets the error palette — if three
 * verdicts shouted, none would.
 */
export function verdictChip(verdict: Verdict): VerdictChipStyle {
  const label = VERDICT_LABEL[verdict];
  switch (verdict) {
    case 'losing':
      return { label, className: 'bg-status-error text-white border-status-error' };
    case 'grinding':
      return { label, className: 'bg-card text-status-warning border-status-warning' };
    case 'stuck':
      return { label, className: 'bg-card text-status-warning border-status-warning/40' };
    case 'won_unclaimed':
      return { label, className: 'bg-card text-status-success border-status-success/50' };
    case 'winning':
      return { label, className: 'bg-accent-soft text-accent-text border-accent-border' };
    default:
      // dormant + empty — present but deliberately quiet.
      return { label, className: 'bg-card text-text-muted border-border-default' };
  }
}

/** Pending actions waiting on a person, the Not-winning tiebreak. */
function pendingCount(p: InitiativePulse): number {
  return p.awaitingVerification + p.blocked + p.held;
}

/** 14-day token total, the Winning zone's second sort key. */
function windowTokens(p: InitiativePulse): number {
  return p.effortDays.reduce((n, d) => n + d.tokens, 0);
}

export interface InitiativeZones {
  /** `losing` → `grinding` → `stuck` → `won_unclaimed`, ladder order. */
  notWinning: InitiativePulse[];
  winning: InitiativePulse[];
  /** `dormant` + `empty`, collapsed behind a disclosure. */
  dormant: InitiativePulse[];
}

/**
 * Partition rows into the three zones of §4.3 — by verdict, not by pending count,
 * so the page reads top-down as an answer to "are we winning".
 *
 * Pure and non-mutating. The Not-winning zone is sorted by ladder position first,
 * which is what guarantees AC-14a: whenever a `losing` arc exists it is the first
 * row of the first zone, reachable without scrolling.
 */
export function partitionInitiativeZones(items: InitiativePulse[]): InitiativeZones {
  const notWinning: InitiativePulse[] = [];
  const winning: InitiativePulse[] = [];
  const dormant: InitiativePulse[] = [];

  for (const item of items) {
    if (item.verdict === 'winning') winning.push(item);
    else if (item.verdict === 'dormant' || item.verdict === 'empty') dormant.push(item);
    else notWinning.push(item);
  }

  notWinning.sort((a, b) => {
    const rank = NOT_WINNING_ORDER.indexOf(a.verdict) - NOT_WINNING_ORDER.indexOf(b.verdict);
    if (rank !== 0) return rank;
    const pending = pendingCount(b) - pendingCount(a);
    if (pending !== 0) return pending;
    return b.progress - a.progress;
  });

  winning.sort((a, b) => {
    if (b.merges7d !== a.merges7d) return b.merges7d - a.merges7d;
    return windowTokens(b) - windowTokens(a);
  });

  return { notWinning, winning, dormant };
}
