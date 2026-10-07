/**
 * The PR activity comment as a projection (docs/specs/workflow-state-kernel.md
 * §12.1). Pure: the whole body is computed from the delivery, its full
 * `workflow_transitions` history and the legacy notes diverted into
 * `workflow_facts` (kind `activity_note`), never appended to.
 *
 *  - Transitions own every state-shaped row (review, fix, push, merge, close).
 *    A diverted note of one of those kinds is dropped: the transition is the
 *    authority, the note was a second writer.
 *  - Notes keep the rows the kernel does not own yet (CI fixes until the CI
 *    family moves, the lede correction, human overrides).
 *  - The headline is a pure function of canonical state (`deriveDeliveryView`),
 *    so "Approved" can never head a REPAIRING delivery and "Merged" stays the
 *    headline whatever is recorded after it.
 *  - The body carries a `render_version` marker instead of a state block; a
 *    render older than the marker already on GitHub is skipped by the handler.
 */
import { renderPrActivityComment, taskActivityUrl, type PrActivityEntry, type PrActivityKind, type ActivityHeader } from '@/lib/pr-activity-comment';
import { deriveDeliveryView } from './projections';
import { signatureChecks } from './trunk-signature';
import type { AttemptSnapshot, DeliveryState, KernelView, RoundSnapshot } from './types';

export interface ActivityTransition {
  command: string;
  fromState: string | null;
  toState: string;
  toVersion: number;
  evidence: Record<string, unknown> | null;
  createdAt: string;
}

export const RENDER_VERSION_PREFIX = '<!-- buildd-render-version:';
const RENDER_VERSION_RE = /<!-- buildd-render-version:(\d+) -->/;

export function renderVersionMarker(version: number): string {
  return `${RENDER_VERSION_PREFIX}${version} -->`;
}

/** The delivery version a comment body was rendered from, or null for a legacy/foreign body. */
export function parseRenderVersion(body: string): number | null {
  const m = RENDER_VERSION_RE.exec(body);
  return m ? Number(m[1]) : null;
}

/** Kinds a transition owns; a diverted note of one of these is a duplicate writer. */
export const TRANSITION_OWNED_KINDS: ReadonlySet<PrActivityKind> = new Set<PrActivityKind>([
  'review_queued', 'reviewing', 'review_approved', 'review_changes_requested', 'review_escalated',
  'review_failed', 'fix_started', 'fix_ended', 'changes_pushed', 'merged', 'closed_unmerged',
  'work_superseded', 'review_superseded_by_merge', 'fix_superseded_by_approval',
  'push_pending', 'push_undeliverable', 'composition_verified', 'composition_delta_approved',
]);

/** Transitions that queue a review round (they all end in AWAITING_REVIEW via `startRound`). */
const ROUND_STARTERS = new Set(['ReviewRequested', 'HeadObserved', 'AttemptEnded', 'PrReopened', 'CompositionAttested', 'HumanResolve', 'PrBound', 'TrunkRecovered']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const shortSha = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 7) : null);

function liveHead(ev: Record<string, unknown>): string | null {
  const live = ev.live as { headSha?: unknown } | null | undefined;
  return typeof live?.headSha === 'string' ? live.headSha : null;
}

/** Map the transition log to timeline entries, oldest first. */
export function transitionsToActivityEntries(
  transitions: ActivityTransition[],
  rounds: RoundSnapshot[],
  attempts: AttemptSnapshot[],
): PrActivityEntry[] {
  const out: PrActivityEntry[] = [];
  const sorted = [...transitions].sort((a, b) => a.toVersion - b.toVersion);
  const roundsByNo = [...rounds].sort((a, b) => a.round - b.round);
  let roundIdx = 0;
  let fixAttempt: AttemptSnapshot | undefined;
  let lastHead: string | null = null;
  const reviewUrl = (r: RoundSnapshot | undefined): string | null => (r?.reviewerTaskId ? taskActivityUrl(r.reviewerTaskId) : null);
  const fixFields = (a: AttemptSnapshot | undefined) => (a
    ? { iteration: a.attemptNo, maxIterations: a.maxAttempts, ...(a.taskId ? { taskUrl: taskActivityUrl(a.taskId) } : {}) }
    : {});

  for (const t of sorted) {
    const ev = t.evidence ?? {};
    const at = t.createdAt;
    const push = (e: Omit<PrActivityEntry, 'at'>) => out.push({ ...e, at });

    // A head that moved is a push, whatever the transition then decided. The
    // first head the log sees (the PR binding) is the starting point, not a push.
    const head = liveHead(ev);
    if (!lastHead && t.command === 'HeadObserved') lastHead = str(ev.previousHead);
    if (head) {
      if (lastHead && head !== lastHead) push({ kind: 'changes_pushed', sha: shortSha(head) });
      lastHead = head;
    }

    switch (t.command) {
      case 'ReviewVerdictRecorded': {
        const verdict = str(ev.effectiveVerdict) ?? str(ev.verdict);
        const round = rounds.find((r) => r.id === ev.roundId);
        const url = reviewUrl(round);
        const delta = ev.compositionDelta as { paths?: unknown } | undefined;
        if (t.toState === 'APPROVED' && delta) {
          // §5.9 / S33: the delta round covers only the novel paths, never the whole release.
          const paths = Array.isArray(delta.paths) ? delta.paths.map(String) : [];
          push({ kind: 'composition_delta_approved', note: paths.length ? paths.join('\n') : null, ...(url ? { taskUrl: url } : {}) });
        } else if (t.toState === 'APPROVED') push({ kind: 'review_approved', ...(url ? { taskUrl: url } : {}) });
        else if (t.toState === 'CHANGES_REQUESTED') {
          const next = attempts.filter((a) => a.family === 'review_fix' && a.triggerReason === round?.id).sort((a, b) => b.attemptNo - a.attemptNo)[0];
          push({ kind: 'review_changes_requested', iteration: next?.attemptNo ?? (attempts.filter((a) => a.family === 'review_fix').length + 1), maxIterations: next?.maxAttempts ?? null, ...(url ? { taskUrl: url } : {}) });
        } else if (t.toState === 'ESCALATED') {
          push({ kind: 'review_escalated', detail: verdict === 'escalate' ? null : 'review budget spent', ...(url ? { taskUrl: url } : {}) });
        }
        break;
      }
      case 'FixDispatched':
        fixAttempt = attempts.find((a) => a.id === ev.attemptId);
        break;
      case 'FixClaimed': {
        fixAttempt = attempts.find((a) => a.id === ev.attemptId) ?? fixAttempt;
        push({ kind: 'fix_started', ...fixFields(fixAttempt) });
        break;
      }
      case 'AttemptEnded': {
        if (t.fromState === 'FIXING' || t.fromState === 'REPAIRING') {
          const outcome = str(ev.outcome);
          if (t.toState === 'AWAITING_PUSH') push({ kind: 'push_pending', ...fixFields(fixAttempt) });
          else push({ kind: 'fix_ended', detail: outcome && outcome !== 'success' ? outcome : null, ...fixFields(fixAttempt) });
        } else if (t.toState === 'AWAITING_PUSH') {
          push({ kind: 'push_pending' });
        }
        if (t.toState === 'ESCALATED') push({ kind: 'push_undeliverable' });
        break;
      }
      case 'PushRecoveryExhausted':
        push({ kind: 'push_undeliverable', sha: shortSha(ev.localHeadSha) });
        break;
      case 'ReviewBudgetExhausted':
        push({ kind: 'review_escalated', detail: 'review budget spent' });
        break;
      case 'ReviewRoundFailed':
        if (t.toState === 'ESCALATED') push({ kind: 'review_failed' });
        break;
      case 'CompositionAttested':
        if (t.toState === 'APPROVED') push({ kind: 'composition_verified' });
        break;
      case 'TrunkRedObserved': {
        const checks = signatureChecks(str(ev.signature) ?? '');
        push({ kind: 'blocked_on_trunk', detail: checks.length ? checks.join(', ') : null });
        break;
      }
      case 'TrunkRecovered':
        push({ kind: 'trunk_recovered' });
        break;
      case 'PrMerged':
        push({ kind: 'merged' });
        break;
      case 'PrClosedUnmerged':
        push({ kind: 'closed_unmerged' });
        break;
      case 'SupersessionRecorded': {
        const target = ev.target as { prNumber?: unknown } | undefined;
        push({ kind: 'work_superseded', detail: typeof target?.prNumber === 'number' ? `shipped in #${target.prNumber}` : null });
        break;
      }
      default:
        if (t.toState === 'ESCALATED' && t.fromState !== 'ESCALATED') push({ kind: 'review_escalated', detail: str(ev.reason) });
    }

    // A round was queued by this transition.
    // Rounds are numbered in the order these transitions queued them; the
    // round rows say which head each one was bound to.
    if (t.toState === 'AWAITING_REVIEW' && ROUND_STARTERS.has(t.command) && roundIdx < roundsByNo.length) {
      const r = roundsByNo[roundIdx++];
      const url = reviewUrl(r);
      push({ kind: 'review_queued', detail: `round ${r.round}`, ...(url ? { taskUrl: url } : {}) });
    }
  }
  return out;
}

type HeaderTone = ActivityHeader['tone'];

function toneFor(state: DeliveryState, reviewing: boolean): HeaderTone {
  switch (state) {
    case 'WORKING':
    case 'FIXING': return 'working';
    case 'AWAITING_REVIEW': return reviewing ? 'working' : 'waiting';
    case 'ESCALATED': return 'human';
    case 'APPROVED':
    case 'MERGED':
    case 'SUPERSEDED': return 'done';
    case 'CLOSED_UNMERGED':
    case 'ABANDONED':
    case 'FAILED': return 'ended';
    default: return 'waiting';
  }
}

export interface DivertedNote {
  entry: PrActivityEntry;
  observedAt: string;
}

/** The whole comment body for one delivery at its current version. */
export function renderDeliveryActivity(p: {
  view: KernelView;
  transitions: ActivityTransition[];
  notes?: DivertedNote[];
  timezone?: string;
}): string {
  const d = p.view.delivery;
  if (!d) throw new Error('renderDeliveryActivity: no delivery');
  const fromTransitions = transitionsToActivityEntries(p.transitions, p.view.rounds, p.view.attempts);
  const fromNotes = (p.notes ?? [])
    .filter((n) => !TRANSITION_OWNED_KINDS.has(n.entry.kind))
    .map((n) => ({ ...n.entry, at: n.entry.at ?? n.observedAt }));
  const entries = [...fromTransitions, ...fromNotes]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.at ?? '').localeCompare(b.e.at ?? '') || a.i - b.i)
    .map((x) => x.e);

  const last = [...p.transitions].sort((a, b) => b.toVersion - a.toVersion)[0];
  const dv = deriveDeliveryView({
    view: p.view,
    lastTransition: last ? { command: last.command, fromState: last.fromState, toState: last.toState, evidence: last.evidence, createdAt: last.createdAt } : null,
  });
  const currentRound = p.view.rounds.find((r) => r.round === d.currentRound);
  const header: ActivityHeader = {
    headline: dv?.headline ?? d.state,
    tone: toneFor(d.state, currentRound?.status === 'reviewing'),
    status: dv?.detail && dv.detail.length <= 80 ? dv.detail : undefined,
  };
  const body = renderPrActivityComment(entries, p.timezone, { header, stateBlock: false });
  return `${body}\n${renderVersionMarker(d.version)}`;
}
