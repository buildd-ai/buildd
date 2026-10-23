'use client';

/**
 * Mission · Overview: what the mission is doing and what sets its finish.
 *
 * ```
 * 2 done · 1 in progress · 2 waiting on tasks · 1 next in line
 * [■][■] ┌[▶]┐ [┊][┊][▢]  [◐]   TaskStrip (lg): Done, In progress (outlined),
 *  01 02    03   04 05 06   07    Waiting, then checks (spec f7f67f1a R-1)
 *                                               Goal · 1 of 4 criteria
 * ```
 *
 * Tapping a cell opens that task's page, the only task view (spec d25d923d
 * R-1). The selection (← → move it) only marks what holds a task or what it
 * holds: on arrival the task a hold names, else the first in flight
 * (`overviewDefaultSelection`), never just the first. From 900px the main
 * column stops at 720px and the goal criteria and the agent counts sit in a
 * right rail beside it.
 */
import { displayTaskTitle } from '@/lib/task-title';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import Criteria, { type Criterion } from '@/components/ui/Criteria';
import TaskStrip from '@/components/ui/TaskStrip';
import { useMissionFocusSnapshot } from '@/components/missions/mission-focus-context';
import { MissionStripContext, createMissionStripStore, type MissionStripValue } from '@/components/missions/mission-strip-context';
import { BOARD_LANDED, boardNeedsYouCount, type MissionBoardModel } from '@/lib/mission-board';
import { buildEstimate, missionChecks, outcomeSpecLines, type CheckStatus, type MissionChecksInput } from '@/lib/mission-checks';
import { isClosedUnshipped, overviewCells, overviewDefaultSelection, overviewLayout, overviewLegend, overviewSelection, railLines, type OverviewLegendEntry } from '@/lib/mission-overview';
import { stripOrder } from '@/lib/mission-task-strip';
import { STATES, type StateKey } from '@/components/ui/states';
import { useRouter } from 'next/navigation';
import { AskBanner, CompletionRecord, PlanningPlaceholder } from './MissionBoard';
import { boardTaskHref, useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';
import type { StripFocus } from './MissionTaskStrip';
import CriteriaCheckNow from './CriteriaCheckNow';
import { MissionVisualAsk, WithMissionVisualReview, type MissionVisualReviewValue } from './MissionVisualReview';
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
  /** The situation block's task, when its one affordance is a single task: the default selection. */
  stripFocus?: StripFocus | null;
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
  stripFocus = null,
  checks: checksSource = null, planTasks = null, held = false, outcomeSpecTitles = null, ...link
}: MissionOverviewProps & { review: MissionVisualReviewValue | null }) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 15_000, !model.complete);
  const layout = useMemo(() => overviewLayout(model, stripOrder(model)), [model]);
  const order = layout.order;
  const cells = useMemo(() => overviewCells(model, order), [model, order]);
  const groups = useMemo(() => layout.groups.map(g => ({ key: g.key, ids: g.ids, outline: g.key === 'active' })), [layout]);
  const legend = useMemo(() => overviewLegend(model, layout), [model, layout]);
  const [store] = useState(createMissionStripStore);
  const stripValue = useMemo<MissionStripValue | null>(() => (order.length > 0 ? { store, taskIds: order } : null), [store, order]);
  const chosen = useSyncExternalStore(store.subscribe, store.getSelected, () => null);
  // Arrow keys choose through the store; a `#t-<id>` arrival through the page's
  // focus store; else the task a hold names, else the first in flight.
  const hashed = useMissionFocusSnapshot()?.selectedTaskId ?? null;
  const selectedId = overviewDefaultSelection(model, order, chosen ?? (hashed && order.includes(hashed) ? hashed : null), stripFocus?.taskId ?? null);
  const select = useCallback((id: string) => store.select(id), [store]);
  const router = useRouter();
  const openTask = useCallback((id: string) => router.push(boardTaskHref(link, id)), [router, link]);
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
  // A `#t-<id>` arrival shows the build strip it points into, even once the build is done.
  useEffect(() => { if (hashed) setShowBuild(true); }, [hashed]);
  const activeCount = layout.groups.find(g => g.key === 'active')?.ids.length ?? 0;
  const waitingCount = layout.groups.find(g => g.key === 'waiting')?.ids.length ?? 0;
  // A decision, a hold or nothing running while work waits (capacity, outside) removes any time promise.
  const estimate = handoff && !handoff.buildComplete && planTasks
    ? buildEstimate(planTasks, now, held || needs > 0 || (activeCount === 0 && waitingCount > 0))?.line ?? null
    : null;
  const where = checksSource?.branch === 'mission-branch' ? 'the mission branch' : checksSource?.target ?? 'the target branch';

  const strip = selectedId && (
    <TaskStrip cells={cells} groups={groups} selectedId={selectedId} onSelect={select} onOpen={openTask} marks={overviewSelection(model, order, selectedId).marks} label="Mission tasks, done first" />
  );

  return (
    <MissionStripContext.Provider value={stripValue}>
      <div data-testid="mission-overview" className="mt-6 grid gap-x-10 gap-y-6 min-[900px]:grid-cols-[minmax(0,720px)_minmax(240px,300px)]">
        <div className="flex min-w-0 flex-col gap-4">
          {handoff && <CheckRail steps={handoff.rail} />}
          {handoff && checksSource && <OutcomeSpecLines lines={outcomeSpecLines(checksSource.criteria, handoff.rows, outcomeSpecTitles ?? {})} />}
          {/* Build counts only: criteria are the header's Verified pill and the rail's list. */}
          {!handoff?.buildComplete && <Legend entries={legend} />}
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
                {strip}
              </BuildCompleteBar>
              <ChecksCard rows={handoff.rows} onOpenTask={openTask} />
            </>
          ) : (
            <>
              {strip}
              {handoff && handoff.rows.some(r => STARTED.has(r.status)) && <ChecksCard rows={handoff.rows.filter(r => STARTED.has(r.status))} onOpenTask={openTask} />}
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

/** Each legend entry's swatch: the same cell fill the strip draws for it. */
const SWATCH: Record<OverviewLegendEntry['key'], { state: StateKey; wait?: string }> = {
  done: { state: 'landed' },
  active: { state: 'running' },
  tasks: { state: 'blocked', wait: 'tasks' },
  slot: { state: 'ready', wait: 'slot' },
  hold: { state: 'ready', wait: 'hold' },
  unknown: { state: 'ready', wait: 'unknown' },
  closed: { state: 'not_landed' },
  checks: { state: 'review' },
};

function Legend({ entries }: { entries: readonly OverviewLegendEntry[] }) {
  if (entries.length === 0) return <p data-testid="overview-counts" className="font-mono text-meta text-text-muted">No tasks</p>;
  return (
    <p data-testid="overview-counts" className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-meta text-text-muted">
      {entries.map(e => {
        const sw = SWATCH[e.key];
        const s = STATES[sw.state];
        return (
          <span key={e.key} data-legend={e.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="state-cell inline-block h-2.5 w-2.5 rounded-sm" data-tone={s.tone} data-pattern={s.pattern} data-frame={s.frame} data-wait={sw.wait} />
            {e.text}
          </span>
        );
      })}
    </p>
  );
}
