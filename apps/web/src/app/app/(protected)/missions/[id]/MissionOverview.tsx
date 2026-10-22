'use client';

/**
 * Mission · Overview: what the mission is doing and what sets its finish.
 *
 * ```
 * 2 of 6 merged
 * [■][■] ┌[▶]┐ [┊][┊][▢]  [◐]   TaskStrip (lg): Done, In progress (outlined),
 *  01 02    03   04 05 06   07    Waiting, then checks (spec f7f67f1a R-1)
 * ┌ 03 of 07 · level 1 of 3 ───┐   FocusCard: the selected task
 * │ Shared delivery projection  │
 * │ Build ✓  Verify  Deliver    │   one line at 320px (once: no second stage grid)
 * │ ● Running 12m 04s · Running unit tests   Updated 14s ago │   status line
 * └─────────────────────────────┘
 * ‹ ›                                           Goal · 1 of 4 criteria
 * ```
 *
 * On arrival the task a hold names is selected, else the first in flight
 * (`overviewDefaultSelection`), never just the first. The selection is a task
 * id, so a task keeps it when it moves to another group. From 900px the main column stops at 720px and the
 * goal criteria and the agent counts sit in a right rail beside it.
 */
import { displayTaskTitle } from '@/lib/task-title';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { VisualReviewModel } from '@buildd/shared';
import Criteria, { type Criterion } from '@/components/ui/Criteria';
import FocusCard from '@/components/ui/FocusCard';
import TaskStrip from '@/components/ui/TaskStrip';
import { MissionStripContext, createMissionStripStore, type MissionStripValue } from '@/components/missions/mission-strip-context';
import { BOARD_LANDED, boardNeedsYouCount, type MissionBoardModel } from '@/lib/mission-board';
import { buildEstimate, missionChecks, outcomeSpecLines, type CheckStatus, type MissionChecksInput } from '@/lib/mission-checks';
import { formatCountdown, formatElapsed, isClosedUnshipped, liveLine, overviewCellState, overviewCells, overviewDefaultSelection, overviewLayout, overviewMergedLine, overviewSelection, overviewStatus, railLines, taskEstimate, type OverviewStatus } from '@/lib/mission-overview';
import { stepIndex, stripOrder, stripState } from '@/lib/mission-task-strip';
import { TONE_TEXT } from '@/components/ui/states';
import type { MissionExecutor } from '@/lib/task-actions';
import { AskBanner, CompletionRecord, PlanningPlaceholder } from './MissionBoard';
import { useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';
import { DrawerDelivery, StripTaskActions, stripReason, type StripFocus } from './MissionTaskStrip';
import CriteriaCheckNow from './CriteriaCheckNow';
import { MissionVisualAsk, WithMissionVisualReview, type MissionVisualReviewValue } from './MissionVisualReview';
import type { TaskDeliveryDetail } from '@/lib/activity-delivery';
import type { PlanTask } from '@/lib/mission-plan';
import { BuildCompleteBar, CheckRail, ChecksCard, OutcomeSpecLines } from './MissionChecks';

/** What the page knows about the checks; the build counts and repairs come from the live board. */
export type MissionChecksSource = Omit<MissionChecksInput, 'build' | 'repairs'>;

export interface MissionOverviewProps extends BoardLinkContext {
  model: MissionBoardModel;
  completionText?: string | null;
  /** What the strip cannot say (a decision gate, the integration PR). */
  notice?: ReactNode;
  visual?: VisualReviewModel | null;
  workspaceId?: string | null;
  executor?: MissionExecutor | null;
  /** The situation block's task, when its one affordance is a single task. */
  stripFocus?: StripFocus | null;
  deliveries?: Readonly<Record<string, TaskDeliveryDetail>> | null;
  /** The checks that apply after the build (spec f7f67f1a R-11 to R-22). Absent: the build view only. */
  checks?: MissionChecksSource | null;
  /** The build tasks as the Plan page schedules them (frozen estimates), for the build-only estimate (R-23). */
  planTasks?: readonly PlanTask[] | null;
  /** A hold or empty budget: no time promise (R-24). */
  held?: boolean;
  /** Titles of the selected outcome specs, by spec id, for the line under the rail (R-40). */
  outcomeSpecTitles?: Readonly<Record<string, string>> | null;
}

/** Checks already at work before the build ends (R-13) are shown under the strip. */
const STARTED: ReadonlySet<CheckStatus> = new Set(['running', 'finding', 'owner', 'unable', 'stale']);

export default function MissionOverview(props: MissionOverviewProps) {
  return (
    <WithMissionVisualReview missionId={props.missionId} visual={props.visual}>
      {review => <OverviewView {...props} review={review} />}
    </WithMissionVisualReview>
  );
}

function OverviewView({
  model: serverModel, completionText = null, notice, visual: _visual, review,
  workspaceId = null, executor = null, stripFocus = null, deliveries = null,
  checks: checksSource = null, planTasks = null, held = false, outcomeSpecTitles = null, ...link
}: MissionOverviewProps & { review: MissionVisualReviewValue | null }) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 15_000, !model.complete);
  const layout = useMemo(() => overviewLayout(model, stripOrder(model)), [model]);
  const order = layout.order;
  const cells = useMemo(() => overviewCells(model, order), [model, order]);
  const groups = useMemo(() => layout.groups.map(g => ({ key: g.key, ids: g.ids, outline: g.key === 'active' })), [layout]);
  const mergedLine = overviewMergedLine(layout);
  const estimates = useMemo(() => new Map((planTasks ?? []).map(p => [p.id, p.p50Minutes])), [planTasks]);
  const [store] = useState(createMissionStripStore);
  const stripValue = useMemo<MissionStripValue | null>(() => (order.length > 0 ? { store, taskIds: order } : null), [store, order]);
  const chosen = useSyncExternalStore(store.subscribe, store.getSelected, () => null);
  // A tap or the situation block chooses through the store; else the task a hold names, else the first in flight.
  const selectedId = overviewDefaultSelection(model, order, chosen, stripFocus?.taskId ?? null);
  const select = useCallback((id: string) => store.select(id), [store]);
  const vm = review?.model ?? null;
  const unevaluated = model.complete && !model.criteriaEvaluated && model.criteria.length > 0;

  // Build tasks only (P-2): fixes, audits and refreshes sit in the checks group and never count.
  const buildIds = useMemo(() => layout.groups.filter(g => g.key !== 'checks').flatMap(g => g.ids), [layout]);
  const doneCount = layout.groups.find(g => g.key === 'done')?.ids.length ?? 0;
  const repairs = useMemo(() => order.filter(id => model.tasks[id].deliverableRole === 'repair').map(id => ({
    id, title: displayTaskTitle(model.tasks[id].title), done: BOARD_LANDED.has(model.tasks[id].status) && !isClosedUnshipped(model, id),
  })), [model, order]);
  const handoff = useMemo(
    () => (checksSource ? missionChecks({ ...checksSource, build: { done: doneCount, total: buildIds.length }, repairs }) : null),
    [checksSource, doneCount, buildIds.length, repairs],
  );
  // A check the owner must act on (a final merge under the human tier) is a decision too.
  // Max, not sum: the visual review's own ask may already count the same decision.
  const needs = Math.max(boardNeedsYouCount(model, vm), handoff?.rows.filter(r => r.status === 'owner').length ?? 0);
  const rail = railLines(model.live, needs);
  const [showBuild, setShowBuild] = useState(false);
  const activeCount = layout.groups.find(g => g.key === 'active')?.ids.length ?? 0;
  const waitingCount = layout.groups.find(g => g.key === 'waiting')?.ids.length ?? 0;
  // A decision, a hold or nothing running while work waits (capacity, outside) removes any time promise.
  const estimate = handoff && !handoff.buildComplete && planTasks
    ? buildEstimate(planTasks, now, held || needs > 0 || (activeCount === 0 && waitingCount > 0))?.line ?? null
    : null;
  const where = checksSource?.branch === 'mission-branch' ? 'the mission branch' : checksSource?.target ?? 'the target branch';
  const openTask = (id: string) => { setShowBuild(true); select(id); };

  const stripAndFocus = selectedId && (
    <>
      <TaskStrip cells={cells} groups={groups} selectedId={selectedId} onSelect={select} marks={overviewSelection(model, order, selectedId).marks} label="Mission tasks, done first" />
      <Focus model={model} order={order} id={selectedId} onSelect={select} link={link} workspaceId={workspaceId} executor={executor} focusReason={stripFocus?.taskId === selectedId ? stripFocus.reason : null} delivery={deliveries?.[selectedId] ?? null} estimateMinutes={estimates.get(selectedId) ?? null} />
    </>
  );

  return (
    <MissionStripContext.Provider value={stripValue}>
      <div data-testid="mission-overview" className="mt-6 grid gap-x-10 gap-y-6 min-[900px]:grid-cols-[minmax(0,720px)_minmax(240px,300px)]">
        <div className="flex min-w-0 flex-col gap-4">
          {handoff && <CheckRail steps={handoff.rail} />}
          {handoff && checksSource && <OutcomeSpecLines lines={outcomeSpecLines(checksSource.criteria, handoff.rows, outcomeSpecTitles ?? {})} />}
          {/* Build counts only: criteria are the header's Verified pill and the rail's list. */}
          {!handoff?.buildComplete && <p data-testid="overview-counts" className="font-mono text-meta text-text-muted">{mergedLine}</p>}
          {notice}
          {model.needsYou.filter(id => !model.tasks[id].delivery).map(id => (
            <AskBanner key={id} task={model.tasks[id]} now={now} />
          ))}
          {review && <MissionVisualAsk review={review} board={model} />}
          {model.complete && <CompletionRecord model={model} text={completionText} visual={vm} />}
          {model.phases.length === 0 && model.planning && <PlanningPlaceholder planning={model.planning} now={now} link={link} />}
          {handoff?.buildComplete ? (
            <>
              <BuildCompleteBar done={buildIds.length} where={where} open={showBuild} onToggle={() => setShowBuild(v => !v)}>
                {stripAndFocus}
              </BuildCompleteBar>
              <ChecksCard rows={handoff.rows} onOpenTask={openTask} />
            </>
          ) : (
            <>
              {stripAndFocus}
              {handoff && handoff.rows.some(r => STARTED.has(r.status)) && <ChecksCard rows={handoff.rows.filter(r => STARTED.has(r.status))} onOpenTask={select} />}
              {estimate && <p data-testid="overview-estimate" className="font-mono text-meta text-text-muted">{estimate}</p>}
            </>
          )}
        </div>
        <aside data-testid="overview-rail" aria-label="Goal and agents" className="flex min-w-0 flex-col gap-6">
          {/* Once the build is done each criterion is a row in the checks; the rail does not repeat them. */}
          {!handoff?.buildComplete && <div>
            {model.criteria.length === 0 ? (
              <p className="text-body text-text-muted">No goal criteria set.</p>
            ) : (
              <Criteria
                items={model.criteria.map<Criterion>(c => ({ ok: c.state === 'pass', unchecked: c.state === 'unchecked', text: c.label, value: unevaluated && c.state === 'pending' ? undefined : c.value }))}
                action={unevaluated ? <CriteriaCheckNow missionId={link.missionId} /> : undefined}
                evaluated={unevaluated ? 'Criteria not evaluated' : undefined}
              />
            )}
          </div>}
          <ul data-testid="overview-counts-rail" className="flex flex-col gap-1.5 border-t border-[var(--line-soft)] pt-3 text-title">
            <li className="text-text-secondary" data-testid="rail-agents" data-count={model.live}>{rail.agents}</li>
            <li className={needs ? 'font-semibold text-accent-text' : 'text-text-muted'} data-testid="rail-needs" data-count={needs}>{rail.needs}</li>
          </ul>
        </aside>
      </div>
    </MissionStripContext.Provider>
  );
}

const STEP_BTN = 'inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] border border-border-default text-heading text-text-primary hover:bg-surface-3 md:h-9 md:w-9';

function Focus({ model, order, id, onSelect, link, workspaceId, executor, focusReason, delivery, estimateMinutes }: {
  model: MissionBoardModel;
  order: readonly string[];
  id: string;
  onSelect: (id: string) => void;
  link: BoardLinkContext;
  workspaceId: string | null;
  executor: MissionExecutor | null;
  focusReason: string | null;
  delivery: TaskDeliveryDetail | null;
  /** The task's frozen p50 when task-estimates allows showing it (the gated rows the page loads). */
  estimateMinutes: number | null;
}) {
  const t = model.tasks[id];
  const status = overviewStatus(model, id);
  const i = order.indexOf(id);
  const state = overviewCellState(model, id);
  const actionState = stripState(model, id);
  const { reason } = overviewSelection(model, order, id);
  // Kept for the action zone (its queued note); the card itself says the status line, no Next sentence.
  const why = state === 'landed' ? null : focusReason ?? stripReason(t, executor);
  const tick = String(i + 1).padStart(2, '0');
  const of = `${tick} of ${String(order.length).padStart(2, '0')}`;
  const meta = [of, t.levels > 1 ? `level ${t.level} of ${t.levels}` : null, t.roleName?.toLowerCase() ?? null, t.pr ? `PR #${t.pr.number}` : null].filter(Boolean).join(' · ');
  const needsYou = t.status === 'waiting' ? (t.waitingFor?.prompt ?? 'An answer') : t.delivery?.action?.label ?? null;
  const prev = () => onSelect(order[stepIndex(i, -1, order.length)]);
  const next = () => onSelect(order[stepIndex(i, 1, order.length)]);

  return (
    // scroll-mb: a focused stepper or action never lands under the phone tab bar.
    <div className="flex scroll-mb-[calc(5rem+env(safe-area-inset-bottom))] flex-col gap-2.5 [&_button]:scroll-mb-[calc(5rem+env(safe-area-inset-bottom))]">
      <FocusCard
        meta={meta}
        title={displayTaskTitle(t.title)}
        state={state}
        repairs={delivery?.repairs || undefined}
        flow="line"
        status={<FocusStatus status={status} taskId={t.id} prWorkerId={t.prWorkerId ?? null} serverNow={model.now} estimateMinutes={estimateMinutes} />}
        reason={reason}
        needs={needsYou ?? undefined}
        footer={
          <div className="flex min-w-0 flex-col gap-2">
            {delivery && delivery.evidence.length > 0 && <DrawerDelivery key={t.id} delivery={delivery} stages={false} />}
            {workspaceId && <StripTaskActions task={t} state={actionState} link={link} workspaceId={workspaceId} executor={executor} why={why} />}
          </div>
        }
      />
      <div className="flex items-center gap-2" data-testid="overview-stepper">
        <button type="button" aria-label="Previous task" data-testid="overview-prev" onClick={prev} className={STEP_BTN}>‹</button>
        <button type="button" aria-label="Next task" data-testid="overview-next" onClick={next} className={STEP_BTN}>›</button>
        <span className="ml-auto hidden font-mono text-meta text-text-muted md:inline">← → to move between tasks</span>
      </div>
    </div>
  );
}

/** Ticks every `ms` while `on`; the server's clock until the first tick. */
function useTick(serverNow: number, ms: number, on: boolean): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return on ? Math.max(now, serverNow) : serverNow;
}

const DOT = 'inline-block h-2 w-2 shrink-0 rounded-full bg-current';

/**
 * The selected task's status line (mission-feed §Status vocabulary): one dot,
 * one word, one short cause. Running ticks from the worker's start and says
 * when it last did anything; a failed task in backoff says when it retries.
 */
export function FocusStatus({ status, taskId, prWorkerId, serverNow, estimateMinutes }: {
  status: OverviewStatus;
  taskId: string;
  prWorkerId: string | null;
  serverNow: number;
  estimateMinutes: number | null;
}) {
  const running = status.since != null;
  const now = useTick(serverNow, 1000, running || status.retryAt != null);
  const live = running ? liveLine(status.lastEventAt, now) : null;
  const est = running ? taskEstimate(estimateMinutes, status.since, now) : null;
  const word = running ? `${status.word} ${formatElapsed(now - status.since!)}` : status.word;
  const replacement = status.closed?.replacement ?? null;
  return (
    <div data-testid="focus-status" data-word={status.word} className="flex min-w-0 flex-col gap-1.5">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-title">
        <span aria-hidden="true" className={`${DOT} ${TONE_TEXT[status.tone]}`} />
        {replacement ? (
          <a data-testid="focus-status-replacement" href={replacement.url ?? undefined} className="font-medium text-text-primary underline-offset-4 hover:underline">
            Closed → #{replacement.number}
          </a>
        ) : (
          <span data-testid="focus-status-word" className="font-medium tabular-nums text-text-primary">{word}</span>
        )}
        {status.cause && <span data-testid="focus-status-cause" className="min-w-0 truncate text-text-secondary">· {status.cause}</span>}
        {live && (
          <span data-testid="focus-status-live" data-stale={live.stale || undefined} className={`ml-auto font-mono text-meta ${live.stale ? TONE_TEXT.dec : 'text-text-muted'}`}>
            {live.text}
          </span>
        )}
      </p>
      {est && (
        <div data-testid="focus-estimate" className="flex items-center gap-2 font-mono text-meta text-text-muted">
          <span>{est.text}</span>
          <span aria-hidden="true" className="h-1 min-w-0 max-w-40 flex-1 overflow-hidden rounded-full bg-[var(--line-soft)]">
            <span className="block h-full rounded-full bg-text-secondary" style={{ width: `${Math.round(est.frac * 100)}%` }} />
          </span>
        </div>
      )}
      {status.retryAt != null && status.retryAt > now && <RetryRow taskId={taskId} retryAt={status.retryAt} now={now} />}
      {status.closed && !replacement && prWorkerId && <LinkReplacement workerId={prWorkerId} />}
    </div>
  );
}

/** `Retry in 3h 52m` beside `Retry now`: the backoff's start time, lifted on request. */
function RetryRow({ taskId, retryAt, now }: { taskId: string; retryAt: number; now: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forceOverride: true }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Retry failed');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="focus-retry" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono text-meta text-text-muted">Retry in {formatCountdown(retryAt - now)}</span>
      <button type="button" data-testid="focus-retry-now" disabled={busy} onClick={retry} className="btn btn-sm min-h-11 md:min-h-0">Retry now</button>
      {error && <span role="alert" className="text-meta text-status-error">{error}</span>}
    </div>
  );
}

/** `Link replacement`: name the PR that replaces a closed one. It shows as `Closed → #N`; the supersession still records on merge. */
function LinkReplacement({ workerId }: { workerId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <div>
        <button type="button" data-testid="focus-link-replacement" onClick={() => setOpen(true)} className="btn btn-sm min-h-11 md:min-h-0">Link replacement</button>
      </div>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const prNumber = Number(value.replace(/^#/, '').trim());
    if (!Number.isInteger(prNumber) || prNumber <= 0) { setError('Enter a PR number'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workers/${workerId}/replacement`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prNumber }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Could not link');
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form data-testid="focus-link-replacement-form" onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`replacement-${workerId}`}>Replacement PR number</label>
      <input id={`replacement-${workerId}`} inputMode="numeric" autoFocus placeholder="PR number" value={value} onChange={e => setValue(e.target.value)} className="h-11 w-28 px-2 font-mono text-meta md:h-8" />
      <button type="submit" disabled={busy} className="btn btn-sm min-h-11 md:min-h-0">Link</button>
      <button type="button" onClick={() => setOpen(false)} className="btn btn-sm btn-quiet min-h-11 md:min-h-0">Cancel</button>
      {error && <span role="alert" className="text-meta text-status-error">{error}</span>}
    </form>
  );
}
