'use client';

/**
 * Mission · Overview: what the mission is doing and what sets its finish.
 *
 * ```
 * 2 done · 1 in progress · 2 waiting on tasks · 1 next in line
 * [■][■] ┌[▶]┐ [┊][┊][▢]  [◐]   TaskStrip (lg): Done, In progress (outlined),
 *  01 02    03   04 05 06   07    Waiting, then checks (spec f7f67f1a R-1)
 * ┌ 03 of 07 · level 1 of 3 ───┐   FocusCard: the selected task
 * │ Shared delivery projection  │
 * │ Build › Audit › Land        │   (once: no second stage grid)
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
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import Criteria, { type Criterion } from '@/components/ui/Criteria';
import FocusCard from '@/components/ui/FocusCard';
import TaskStrip from '@/components/ui/TaskStrip';
import { MissionStripContext, createMissionStripStore, type MissionStripValue } from '@/components/missions/mission-strip-context';
import { boardNeedsYouCount, type MissionBoardModel } from '@/lib/mission-board';
import { overviewCellState, overviewCells, overviewDefaultSelection, overviewLayout, overviewLegend, overviewSelection, overviewWaitLine, railLines, type OverviewLegendEntry } from '@/lib/mission-overview';
import { stepIndex, stripOrder, stripState } from '@/lib/mission-task-strip';
import { STATES, type StateKey } from '@/components/ui/states';
import type { MissionExecutor } from '@/lib/task-actions';
import { AskBanner, CompletionRecord, PlanningPlaceholder } from './MissionBoard';
import { useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';
import { DrawerDelivery, StripTaskActions, stripReason, type StripFocus } from './MissionTaskStrip';
import CriteriaCheckNow from './CriteriaCheckNow';
import { MissionVisualAsk, WithMissionVisualReview, type MissionVisualReviewValue } from './MissionVisualReview';
import type { TaskDeliveryDetail } from '@/lib/activity-delivery';

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
}

export default function MissionOverview(props: MissionOverviewProps) {
  return (
    <WithMissionVisualReview missionId={props.missionId} visual={props.visual}>
      {review => <OverviewView {...props} review={review} />}
    </WithMissionVisualReview>
  );
}

function OverviewView({
  model: serverModel, completionText = null, notice, visual: _visual, review,
  workspaceId = null, executor = null, stripFocus = null, deliveries = null, ...link
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
  // A tap or the situation block chooses through the store; else the task a hold names, else the first in flight.
  const selectedId = overviewDefaultSelection(model, order, chosen, stripFocus?.taskId ?? null);
  const select = useCallback((id: string) => store.select(id), [store]);
  const vm = review?.model ?? null;
  const needs = boardNeedsYouCount(model, vm);
  const rail = railLines(model.live, needs);
  const unevaluated = model.complete && !model.criteriaEvaluated && model.criteria.length > 0;

  return (
    <MissionStripContext.Provider value={stripValue}>
      <div data-testid="mission-overview" className="mt-4 grid gap-x-10 gap-y-6 min-[900px]:grid-cols-[minmax(0,720px)_minmax(240px,300px)]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Build counts only: criteria are the header's Verified pill and the rail's list. */}
          <Legend entries={legend} />
          {notice}
          {model.needsYou.filter(id => !model.tasks[id].delivery).map(id => (
            <AskBanner key={id} task={model.tasks[id]} now={now} />
          ))}
          {review && <MissionVisualAsk review={review} board={model} />}
          {model.complete && <CompletionRecord model={model} text={completionText} visual={vm} />}
          {model.phases.length === 0 && model.planning && <PlanningPlaceholder planning={model.planning} now={now} link={link} />}
          {selectedId && (
            <>
              <TaskStrip cells={cells} groups={groups} selectedId={selectedId} onSelect={select} marks={overviewSelection(model, order, selectedId).marks} label="Mission tasks, done first" />
              <Focus model={model} order={order} id={selectedId} onSelect={select} link={link} workspaceId={workspaceId} executor={executor} focusReason={stripFocus?.taskId === selectedId ? stripFocus.reason : null} delivery={deliveries?.[selectedId] ?? null} />
            </>
          )}
        </div>
        <aside data-testid="overview-rail" aria-label="Goal and agents" className="flex min-w-0 flex-col gap-6">
          <div>
            {model.criteria.length === 0 ? (
              <p className="text-body text-text-muted">No goal criteria set.</p>
            ) : (
              <Criteria
                items={model.criteria.map<Criterion>(c => ({ ok: c.state === 'pass', unchecked: c.state === 'unchecked', text: c.label, value: unevaluated && c.state === 'pending' ? undefined : c.value }))}
                action={unevaluated ? <CriteriaCheckNow missionId={link.missionId} /> : undefined}
                evaluated={unevaluated ? 'Criteria not evaluated' : undefined}
              />
            )}
          </div>
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

const STEP_BTN = 'inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] border border-border-default text-heading text-text-primary hover:bg-surface-3 md:h-9 md:w-9';

function Focus({ model, order, id, onSelect, link, workspaceId, executor, focusReason, delivery }: {
  model: MissionBoardModel;
  order: readonly string[];
  id: string;
  onSelect: (id: string) => void;
  link: BoardLinkContext;
  workspaceId: string | null;
  executor: MissionExecutor | null;
  focusReason: string | null;
  delivery: TaskDeliveryDetail | null;
}) {
  const t = model.tasks[id];
  const i = order.indexOf(id);
  const state = overviewCellState(model, id);
  const actionState = stripState(model, id);
  const { reason } = overviewSelection(model, order, id);
  const why = state === 'landed' ? null : focusReason ?? overviewWaitLine(model, id) ?? stripReason(t, executor);
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
        next={why ?? undefined}
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
