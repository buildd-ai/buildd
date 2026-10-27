// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * The mission page's Delivery and Checks section as data (spec 072de598 I-20
 * to I-24): three checks (Visual review, Merge into dev, Release) as CheckRow
 * views and one Delivery count line with a row per PR. Labels, never
 * sentences: nothing here explains itself, and a block with nothing to show
 * is null. A projection over `missionChecks` rows and the task PRs; it
 * stores and decides nothing.
 */
import { CHECK_STATE_WORD, type CheckRowStatus } from '@/components/ui/CheckRow';
import type { CheckRepair, CheckRow, CheckStatus, MergeTier } from './mission-checks';

export interface DeliveryCheckView {
  key: 'visual' | 'merge' | 'release';
  name: string;
  status: CheckRowStatus;
  /** The state word: the status's own, or `In review` on a merge a reviewer decides. */
  stateWord: string;
  detail: string;
  href: string | null;
  /** The visual review may be skipped by a person here (I-7). */
  skippable: boolean;
  /** The step the mission waits on (I-24). */
  current: boolean;
  /** Repair tasks stay inside their check (I-6). */
  repairs: CheckRepair[];
}

export interface DeliveryChecksContext {
  prNumber: number | null;
  tier: MergeTier;
  target: string | null;
  releaseHref: string | null;
  screensHref: string | null;
}

const STATUS: Record<CheckStatus, CheckRowStatus | null> = {
  passed: 'passed', running: 'running', queued: 'queued', stale: 'queued', waived: 'skipped',
  finding: 'failed', unable: 'failed', owner: 'review', not_applicable: null,
};

const settled = (s: CheckRowStatus) => s === 'passed' || s === 'skipped';

export function deliveryChecks(rows: readonly CheckRow[], ctx: DeliveryChecksContext): DeliveryCheckView[] {
  const out: Omit<DeliveryCheckView, 'current' | 'repairs'>[] = [];
  const repairsOf = new Map<string, CheckRepair[]>();
  const pr = ctx.prNumber != null ? `#${ctx.prNumber}` : '';
  const mergeTarget = `Merge into ${ctx.target ?? 'dev'}`;
  for (const r of rows) {
    const status = STATUS[r.status];
    if (!status) continue;
    repairsOf.set(r.kind === 'visual' ? 'visual' : r.kind === 'mission_pr' ? 'merge' : 'release', r.repairs);
    if (r.kind === 'visual') {
      const screens = `${r.screens ?? 0} ${(r.screens ?? 0) === 1 ? 'screen' : 'screens'}`;
      out.push({ key: 'visual', name: 'Visual review', status, stateWord: CHECK_STATE_WORD[status], detail: [screens, r.commit].filter(Boolean).join(' · '), href: ctx.screensHref, skippable: !!r.waivable });
    } else if (r.kind === 'mission_pr') {
      // Reviewer merge reads In review; human merge with the review approved reads Needs review (I-20).
      const stateWord = status === 'running' && ctx.tier !== 'human' && r.state !== 'merging' ? 'In review' : CHECK_STATE_WORD[status];
      out.push({ key: 'merge', name: mergeTarget, status, stateWord, detail: pr, href: r.evidence[0]?.href ?? null, skippable: false });
    } else if (r.kind === 'release') {
      const detail = status === 'queued' && pr ? `after ${pr}` : status === 'failed' ? [r.target, 'deploy'].filter(Boolean).join(' · ') : r.target ?? '';
      out.push({ key: 'release', name: 'Release', status, stateWord: CHECK_STATE_WORD[status], detail, href: ctx.releaseHref ?? r.evidence[0]?.href ?? null, skippable: false });
    }
  }
  const currentIdx = out.findIndex(c => !settled(c.status));
  return out.map((c, i) => ({ ...c, current: i === currentIdx, repairs: repairsOf.get(c.key) ?? [] }));
}

// ── Delivery (I-23) ──────────────────────────────────────────────────────────

export interface DeliveryTask {
  id: string;
  title: string;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  prMerged: boolean;
  prClosed: boolean;
}

export interface DeliveryPr { key: string; title: string; number: number | null; href: string | null; status: CheckRowStatus; taskId: string }
export interface DeliveryView { line: string; prs: DeliveryPr[] }

/**
 * One row per PR, keyed by `prUrl`. A CI-retry task pushes to its parent's PR,
 * so two task rows can name one PR: the first keeps the title, and the PR
 * reads merged when any row saw the merge.
 */
function distinctByPr(rows: DeliveryTask[]): DeliveryTask[] {
  const byUrl = new Map<string, DeliveryTask>();
  for (const r of rows) {
    const prev = byUrl.get(r.prUrl!);
    if (!prev) { byUrl.set(r.prUrl!, r); continue; }
    const prMerged = prev.prMerged || r.prMerged;
    byUrl.set(r.prUrl!, { ...prev, prNumber: prev.prNumber ?? r.prNumber, prMerged, prClosed: !prMerged && (prev.prClosed || r.prClosed) });
  }
  return [...byUrl.values()];
}

/** `5 merged · 1 open · 7 no PR` and a row per PR, or null when there is nothing to show. */
export function deliveryBlock(tasks: readonly DeliveryTask[]): DeliveryView | null {
  const live = tasks.filter(t => t.status !== 'cancelled');
  const withPr = distinctByPr(live.filter(t => t.status === 'completed' && t.prUrl));
  const noPr = live.filter(t => t.status === 'completed' && !t.prUrl).length;
  const merged = withPr.filter(t => t.prMerged).length;
  const open = withPr.filter(t => !t.prMerged && !t.prClosed).length;
  const parts = [merged && `${merged} merged`, open && `${open} open`, noPr && `${noPr} no PR`].filter(Boolean) as string[];
  if (withPr.length === 0 && parts.length === 0) return null;
  return {
    line: parts.join(' · '),
    prs: withPr.map(t => ({
      key: t.id, title: t.title, number: t.prNumber, href: t.prUrl, taskId: t.id,
      status: t.prMerged ? 'passed' : t.prClosed ? 'skipped' : 'queued',
    })),
  };
}
