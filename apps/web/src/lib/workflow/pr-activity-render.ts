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
import { closeCauseCopy, deriveDeliveryView } from './projections';
import { decisionCopy, DECISION_LABELS } from './escalation-copy';
import { signatureChecks } from './trunk-signature';
import type { AttemptSnapshot, DeliveryState, KernelView, RoundSnapshot } from './types';
import { ROUND_TRIGGER_COPY } from '@buildd/workflow-kernel/delta-approval';
import { attemptOrdinal, deltaApprovalOf } from '@buildd/workflow-kernel/reducer';

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
const ROUND_STARTERS = new Set(['ReviewRequested', 'HeadObserved', 'AttemptEnded', 'PrReopened', 'CompositionAttested', 'HumanResolve', 'PrBound', 'TrunkRecovered', 'BaseChanged']);

const queuesRound = (t: ActivityTransition): boolean => t.toState === 'AWAITING_REVIEW' && ROUND_STARTERS.has(t.command);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const shortSha = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 7) : null);

function liveHead(ev: Record<string, unknown>): string | null {
  const live = ev.live as { headSha?: unknown } | null | undefined;
  return typeof live?.headSha === 'string' ? live.headSha : null;
}

/**
 * 58c8961e: "round N", then why it started, whether it is a delta review that
 * carries an approval, and, for a round that ended without a verdict, what ended it.
 */
export function roundLabel(r: RoundSnapshot): string {
  const parts = [`round ${r.round}`];
  if (r.trigger && ROUND_TRIGGER_COPY[r.trigger]) parts.push(ROUND_TRIGGER_COPY[r.trigger]);
  if (deltaApprovalOf(r)) parts.push('delta review of the approval');
  if (r.status === 'superseded') parts.push(r.endReason === 'superseded_by_push' ? 'replaced by a newer push' : 'superseded');
  return parts.join(' · ');
}

/**
 * Why an ended attempt escalated, read from what the transition recorded: the review budget
 * flag, the attempt's family against its own cap in the ledger, and the live CI read.
 */
function attemptEscalation(ev: Record<string, unknown>, a: AttemptSnapshot | undefined, attempts: AttemptSnapshot[]): Omit<PrActivityEntry, 'at'> {
  if (ev.reviewBudgetSpent) return { kind: 'review_escalated', detail: 'review budget spent' };
  if (a) {
    const spent = attempts.filter((x) => x.family === a.family && x.mode === a.mode && x.status !== 'skipped').length >= a.maxAttempts;
    if (spent) return a.family === 'ci' ? { kind: 'ci_exhausted' } : { kind: 'review_escalated', detail: a.family === 'review_fix' ? 'fix budget spent' : `${a.family} fix budget spent` };
    if (ev.noChange) return { kind: 'review_escalated', detail: `the ${a.family === 'review_fix' ? 'review' : a.family} fix left the PR unchanged` };
    return { kind: 'review_escalated', detail: `the ${a.family === 'review_fix' ? 'review' : a.family} fix ended and the head is still not mergeable` };
  }
  const failing = (ev.liveChecks as { failing?: unknown } | undefined)?.failing;
  if (Array.isArray(failing) && failing.length > 0) return { kind: 'review_escalated', detail: 'CI is red' };
  return { kind: 'review_escalated', detail: 'the fix ended and a person has to decide' };
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
  // The newest queued row is the delivery's newest round, so the label agrees with explain
  // even when some rounds have no transition here (rounds imported with a legacy PR).
  let roundIdx = roundsByNo.length - sorted.filter(queuesRound).length;
  let fixAttempt: AttemptSnapshot | undefined;
  let lastHead: string | null = null;
  const reviewUrl = (r: RoundSnapshot | undefined): string | null => (r?.reviewerTaskId ? taskActivityUrl(r.reviewerTaskId) : null);
  // The N of "fix N of M" is the attempt's place among those dispatched (295486ba), as in the titles and checks.
  const fixFields = (a: AttemptSnapshot | undefined) => (a
    ? { iteration: attemptOrdinal(attempts, a) ?? a.attemptNo, maxIterations: a.maxAttempts, ...(a.taskId ? { taskUrl: taskActivityUrl(a.taskId) } : {}) }
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
          // §5.9 / S33: the delta round covers only the novel paths, never the whole PR.
          const paths = Array.isArray(delta.paths) ? delta.paths.map(String) : [];
          push({ kind: 'composition_delta_approved', note: paths.length ? paths.join('\n') : null, ...(url ? { taskUrl: url } : {}) });
        } else if (t.toState === 'APPROVED') {
          // 58c8961e: a delta round's approve carries the approval it followed to this head.
          const carried = ev.deltaApproval as { fromHeadSha?: unknown } | undefined;
          const from = shortSha(carried?.fromHeadSha);
          push({ kind: 'review_approved', ...(from ? { detail: `carries the approval at \`${from}\`` } : {}), ...(url ? { taskUrl: url } : {}) });
        }
        else if (t.toState === 'CHANGES_REQUESTED') {
          const next = attempts.filter((a) => a.family === 'review_fix' && a.triggerReason === round?.id && a.status !== 'skipped').sort((a, b) => b.attemptNo - a.attemptNo)[0];
          push({ kind: 'review_changes_requested', iteration: (next ? attemptOrdinal(attempts, next) : null) ?? (attempts.filter((a) => a.family === 'review_fix' && a.status !== 'skipped').length + 1), maxIterations: next?.maxAttempts ?? null, ...(url ? { taskUrl: url } : {}) });
        } else if (t.toState === 'ESCALATED') {
          push({ kind: 'review_escalated', detail: verdict === 'escalate' ? null : 'review budget spent', ...(url ? { taskUrl: url } : {}) });
        }
        break;
      }
      case 'FixDispatched':
        if (t.toState !== 'ESCALATED') fixAttempt = attempts.find((a) => a.id === ev.attemptId);
        else push({ kind: 'review_escalated', detail: 'fix budget spent' });
        break;
      case 'EffectDead':
        if (t.toState !== 'ESCALATED') break;
        if (ev.reason === 'push_undeliverable') push({ kind: 'push_undeliverable' });
        else push({ kind: 'review_escalated', detail: `${str(ev.effectKind) ?? 'an automatic step'} kept failing` });
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
        // 2ded4e88: a repair out of a spent review budget ends back at the person, not unpushed.
        // Name the real reason, from the ledger and the evidence; only PushRecoveryExhausted says
        // "never reached GitHub".
        if (t.toState === 'ESCALATED') push(attemptEscalation(ev, fixAttempt, attempts));
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
        if (t.toState === 'ESCALATED' && ev.reviewBudgetSpent) push({ kind: 'review_escalated', detail: 'review budget spent' });
        break;
      case 'PrMerged':
        push({ kind: 'merged' });
        break;
      case 'PrClosedUnmerged': {
        // A transition written before the cause was recorded on it reads as no detail, as it did.
        const detail = closeCauseCopy(str(ev.closeCause), ev);
        push({ kind: 'closed_unmerged', ...(detail && detail !== 'unknown' ? { detail } : {}) });
        break;
      }
        break;
      case 'SupersessionRecorded': {
        const target = ev.target as { prNumber?: unknown } | undefined;
        push({ kind: 'work_superseded', detail: typeof target?.prNumber === 'number' ? `shipped in #${target.prNumber}` : null });
        break;
      }
      default:
        if (t.toState === 'ESCALATED' && t.fromState !== 'ESCALATED') push({ kind: 'review_escalated', detail: ev.reviewBudgetSpent ? 'review budget spent' : str(ev.reason) });
    }

    // A round was queued by this transition.
    // Rounds are numbered in the order these transitions queued them; the
    // round rows say which head each one was bound to.
    if (queuesRound(t)) {
      // More queueing transitions than rounds: the oldest ones queued no round of their own.
      const r = roundIdx >= 0 ? roundsByNo[roundIdx] : undefined;
      roundIdx++;
      if (r) {
        const url = reviewUrl(r);
        push({ kind: 'review_queued', detail: roundLabel(r), ...(url ? { taskUrl: url } : {}) });
      }
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

/**
 * Whether the owner's latest attempt move in WORKING put its task back in the
 * queue (a requeue, a loop hold, a reopen to pending) rather than starting it.
 * The comment has no task row, so this reads the transitions.
 */
export function ownerParkedIn(transitions: ActivityTransition[]): boolean {
  const latest = [...transitions]
    .filter((t) => t.toState === 'WORKING')
    .sort((a, b) => b.toVersion - a.toVersion)
    .find((t) => t.command === 'AttemptStarted' || t.command === 'AttemptRequeued' || t.command === 'AttemptReopened'
      || (t.command === 'AttemptEnded' && t.evidence?.requeue === true));
  if (!latest) return false;
  if (latest.command === 'AttemptStarted') return false;
  if (latest.command === 'AttemptReopened') return latest.evidence?.to === 'pending';
  return true;
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
  const ownerParked = d.state === 'WORKING' && ownerParkedIn(p.transitions);
  const dv = deriveDeliveryView({
    view: p.view,
    lastTransition: last ? { command: last.command, fromState: last.fromState, toState: last.toState, evidence: last.evidence, createdAt: last.createdAt } : null,
    ownerParked,
  });
  const currentRound = p.view.rounds.find((r) => r.round === d.currentRound);
  const header: ActivityHeader = {
    headline: dv?.headline ?? d.state,
    tone: ownerParked ? 'waiting' : toneFor(d.state, currentRound?.status === 'reviewing'),
    status: dv?.detail && dv.detail.length <= 80 ? dv.detail : undefined,
  };
  // The delivery's start is its first transition (the PR binding), whatever the row cap keeps.
  const startedAt = [...p.transitions].sort((a, b) => a.toVersion - b.toVersion)[0]?.createdAt ?? null;
  const body = renderPrActivityComment(entries, p.timezone, {
    header,
    stateBlock: false,
    fold: { startedAt, url: d.ownerTaskId ? taskActivityUrl(d.ownerTaskId) : null },
  });
  // GitHub already carries actionable review findings. Keep review history,
  // provenance and finding dispositions on the linked Buildd task.
  const decision = dv?.escalation ? renderEscalationDecision(dv) : '';
  return `${body}\n${decision ? `\n${decision}\n` : ''}${renderVersionMarker(d.version)}`;
}

/**
 * Spec r7 §7 (AC-43 / AC-44 / AC-48): a review escalation in the comment reads as
 * the task page's decision card does (`decisionCopy`): the question, why automation
 * stopped, each unresolved finding by name, and the actions open on the task page.
 * Approving past findings is never offered here.
 */
function renderEscalationDecision(dv: NonNullable<ReturnType<typeof deriveDeliveryView>>): string {
  const c = decisionCopy(dv.escalation!, { rounds: dv.rounds, ledger: dv.ledger ?? [] });
  return [
    `**${c.question}**`,
    c.why,
    c.unresolved.open.length > 0 ? `${DECISION_LABELS.open}: ${c.unresolved.open.map(escapeFindingText).join('; ')}` : '',
    c.unresolved.awaitingVerification.length > 0 ? `${DECISION_LABELS.awaitingVerification}: ${c.unresolved.awaitingVerification.map(escapeFindingText).join('; ')}` : '',
    `${DECISION_LABELS.choicesOnTaskPage}: ${c.actions.map((a) => a.label).join(', ')}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * §5 (workflow-kernel-library.md): every finding with its disposition, the
 * commit that addressed it and the round that verified it, so a request for
 * changes that was fixed reads as fixed and one that was not stays visible.
 * Empty when the delivery has no findings.
 */
export function renderFindingsSummary(view: Pick<KernelView, 'findings' | 'rounds'>): string {
  const all = view.findings ?? [];
  if (all.length === 0) return '';
  const roundNo = (id: string | null) => view.rounds.find((r) => r.id === id)?.round ?? null;
  const open = all.filter((f) => f.status === 'open' || f.status === 'addressed').length;
  const line = (f: (typeof all)[number]): string => {
    const where = f.path ? `\`${f.path}${f.line != null ? `:${f.line}` : ''}\` ` : '';
    const raised = `round ${f.originRound}`;
    const state = f.status === 'open' ? 'open'
      : f.status === 'addressed' ? `addressed by \`${shortSha(f.addressedBySha)}\`, awaiting verification`
        : f.status === 'resolved' ? `resolved${f.addressedBySha ? ` by \`${shortSha(f.addressedBySha)}\`` : ''}, verified in round ${roundNo(f.closedByRoundId) ?? '?'}`
          : f.status === 'waived' ? `waived${f.closedBy ? ` by ${f.closedBy.replace(/^human:/, '')}` : ''}${f.closedReason ? `: ${f.closedReason}` : ''}`
            : `deferred${f.deferredToTaskId ? ` to task ${f.deferredToTaskId.slice(0, 8)}` : ''}${f.closedReason ? `: ${f.closedReason}` : ''}`;
    return `- ${where}${escapeFindingText(f.title)} (${raised}${f.required ? '' : ', optional'}) · ${state}`;
  };
  const summary = `Findings: ${open} open of ${all.length}`;
  return ['<details><summary>' + summary + '</summary>', '', ...all.map(line), '', '</details>'].join('\n');
}

/** A finding's title in one line, with nothing that could open a tag or a mention. */
function escapeFindingText(t: string): string {
  return t.replace(/\s+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/@/g, '@\u200b').slice(0, 200);
}
