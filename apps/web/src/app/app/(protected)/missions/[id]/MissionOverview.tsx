'use client';

/**
 * Mission · Overview: what the mission is doing and what sets its finish.
 *
 * ```
 * 2 of 7 merged · 1 of 4 criteria
 * [■][■][▶][▦][▦][░][░]        TaskStrip (lg): one cell per task, marks on the ticks
 *  01 02 03 04 05 06 07
 * ┌ 03 · level 1 of 3 · builder ┐   FocusCard: the selected task
 * │ Shared delivery projection  │
 * │ Build › Audit › Land …      │
 * └─────────────────────────────┘
 * ‹  Next open · 03  ›                           Goal · 1 of 4 criteria
 * ```
 *
 * On arrival the task setting the finish is selected (`finishSettingTaskId`),
 * never just the first. From 900px the main column stops at 720px and the
 * goal criteria and the agent counts sit in a right rail beside it.
 */
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import Criteria, { type Criterion } from '@/components/ui/Criteria';
import FocusCard from '@/components/ui/FocusCard';
import TaskStrip from '@/components/ui/TaskStrip';
import { MissionStripContext, createMissionStripStore, type MissionStripValue } from '@/components/missions/mission-strip-context';
import { boardNeedsYouCount, type MissionBoardModel } from '@/lib/mission-board';
import { finishSettingTaskId, overviewCells, overviewCounts, overviewSelection } from '@/lib/mission-overview';
import { stepIndex, stripOrder, stripState } from '@/lib/mission-task-strip';
import type { MissionExecutor } from '@/lib/task-actions';
import { AskBanner, CompletionRecord, PlanningPlaceholder } from './MissionBoard';
import { useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';
import { DrawerDelivery, StripTaskActions, stripDrawerPill, stripReason, type StripFocus } from './MissionTaskStrip';
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
  const order = useMemo(() => stripOrder(model), [model]);
  const cells = useMemo(() => overviewCells(model, order), [model, order]);
  const [store] = useState(createMissionStripStore);
  const stripValue = useMemo<MissionStripValue | null>(() => (order.length > 0 ? { store, taskIds: order } : null), [store, order]);
  const chosen = useSyncExternalStore(store.subscribe, store.getSelected, () => null);
  // On arrival the task setting the finish; the situation block or a tap overrides it through the store.
  const selectedId = chosen && order.includes(chosen) ? chosen : finishSettingTaskId(model, order);
  const select = useCallback((id: string) => store.select(id), [store]);
  const vm = review?.model ?? null;
  const needs = boardNeedsYouCount(model, vm);
  const unevaluated = model.complete && !model.criteriaEvaluated && model.criteria.length > 0;

  return (
    <MissionStripContext.Provider value={stripValue}>
      <div data-testid="mission-overview" className="mt-4 grid gap-x-10 gap-y-6 min-[900px]:grid-cols-[minmax(0,720px)_minmax(240px,300px)]">
        <div className="flex min-w-0 flex-col gap-4">
          <p data-testid="overview-counts" className="font-mono text-meta text-text-muted">{overviewCounts(model)}</p>
          {notice}
          {model.needsYou.filter(id => !model.tasks[id].delivery).map(id => (
            <AskBanner key={id} task={model.tasks[id]} now={now} />
          ))}
          {review && <MissionVisualAsk review={review} board={model} />}
          {model.complete && <CompletionRecord model={model} text={completionText} visual={vm} />}
          {model.phases.length === 0 && model.planning && <PlanningPlaceholder planning={model.planning} now={now} link={link} />}
          {selectedId && (
            <>
              <TaskStrip cells={cells} selectedId={selectedId} onSelect={select} marks={overviewSelection(model, order, selectedId).marks} label="Mission tasks" />
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
                items={model.criteria.map<Criterion>(c => ({ ok: c.state === 'pass', text: c.label, value: unevaluated && c.state === 'pending' ? undefined : c.value }))}
                action={unevaluated ? <CriteriaCheckNow missionId={link.missionId} /> : undefined}
                evaluated={unevaluated ? 'Criteria not evaluated' : undefined}
              />
            )}
          </div>
          <dl data-testid="overview-counts-rail" className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 border-t border-[var(--line-soft)] pt-3 text-title">
            <dt className="text-text-muted">Agents live</dt>
            <dd className="font-mono tabular-nums" data-testid="rail-agents">{model.live}</dd>
            <dt className={needs ? 'text-accent-text' : 'text-text-muted'}>Needs you</dt>
            <dd className={`font-mono tabular-nums ${needs ? 'font-semibold text-accent-text' : ''}`} data-testid="rail-needs">{needs}</dd>
          </dl>
        </aside>
      </div>
    </MissionStripContext.Provider>
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
  const state = stripState(model, id);
  const { reason } = overviewSelection(model, order, id);
  const why = state === 'landed' ? null : focusReason ?? stripReason(t, executor);
  const tick = String(i + 1).padStart(2, '0');
  const meta = [tick, t.levels > 1 ? `level ${t.level} of ${t.levels}` : null, t.roleName?.toLowerCase() ?? null, t.pr ? `PR #${t.pr.number}` : null].filter(Boolean).join(' · ');
  const needsYou = t.status === 'waiting' ? (t.waitingFor?.prompt ?? 'An answer') : t.delivery?.action?.label ?? null;
  const prev = () => onSelect(order[stepIndex(i, -1, order.length)]);
  const next = () => onSelect(order[stepIndex(i, 1, order.length)]);

  return (
    <div className="flex flex-col gap-3">
      <FocusCard
        meta={meta}
        title={t.title}
        state={state}
        next={why ?? undefined}
        reason={reason}
        needs={needsYou ?? undefined}
        footer={
          <div className="flex min-w-0 flex-col gap-2">
            {delivery && <DrawerDelivery key={t.id} delivery={delivery} />}
            {workspaceId && <StripTaskActions task={t} state={state} link={link} workspaceId={workspaceId} executor={executor} why={why} />}
          </div>
        }
      />
      <div className="flex items-center gap-2" data-testid="overview-stepper">
        <button type="button" aria-label="Previous task" data-testid="overview-prev" onClick={prev} className={STEP_BTN}>‹</button>
        <button type="button" aria-label="Next task" data-testid="overview-next" onClick={next} className={STEP_BTN}>›</button>
        <span className="font-mono text-meta text-text-muted">{`${tick} of ${String(order.length).padStart(2, '0')} · ${stripDrawerPill(t, state, executor)}`}</span>
        <span className="ml-auto hidden font-mono text-meta text-text-muted md:inline">← → to move between tasks</span>
      </div>
    </div>
  );
}
