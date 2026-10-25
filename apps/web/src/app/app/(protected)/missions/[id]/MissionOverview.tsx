'use client';

/**
 * Mission · Overview: is this outcome getting done? (Navigation d25d923d R-3
 * to R-6, R-15, R-16.)
 *
 * ```
 * Spec Cloud runner: deploy from Settings
 * Build · 11 of 16        Verify        Deliver         the stage line
 * ● Mirror the runner image · asked 1m ago              a decision card
 * [■■■■■■■■■■■][▨][▨][!][┊][┊]                           the bar
 * 11 of 16 merged · 1 running · 1 fixing · 1 your decision · 2 waiting
 * Mirror the runner image to Docker Hub   Your decision   the task list
 * 11 merged ›
 * ```
 *
 * Only the current stage renders. Build: the leading decision card, the bar, the
 * summary line and the task list. Verify: the bar folded to `16 tasks
 * merged ›` and the checks. Deliver: `Delivered into <branch>` with the
 * requirements folded. One predicate (`isBuildComplete`) decides which. A
 * cell or a row opens its task page, the only task view (R-1).
 */
import { displayTaskTitle } from '@/lib/task-title';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { termWord, type VisualReviewModel } from '@buildd/shared';
import TaskStrip from '@/components/ui/TaskStrip';
import DecisionCard from '@/components/DecisionCard';
import { useVisualDecisionAct } from './visual-decision-act';
import { useMissionFocusSnapshot } from '@/components/missions/mission-focus-context';
import { BOARD_LANDED, boardNeedsYouCount, type MissionBoardModel } from '@/lib/mission-board';
import { buildEstimate, isBuildComplete, missionChecks, missionStandardsLine, outcomeSpecLines, requirementsCount, type CheckStatus, type MissionChecksInput } from '@/lib/mission-checks';
import { isClosedUnshipped, overviewCells, overviewLayout } from '@/lib/mission-overview';
import { stripOrder } from '@/lib/mission-task-strip';
import type { DecisionView } from '@/lib/needs-you-card';
import { historyOnScreen, type HistoryRaised } from '@/lib/mission-decisions';
import { useRouter } from 'next/navigation';
import { CompletionRecord, PlanningPlaceholder } from './MissionBoard';
import { boardTaskHref, useLiveBoard, useNow, type BoardLinkContext } from './MissionBoardParts';
import { useMissionLayout } from './MissionLayoutShell';
import { MissionVisualAsk, WithMissionVisualReview, type MissionVisualReviewValue } from './MissionVisualReview';
import type { PlanTask } from '@/lib/mission-plan';
import { BuildCompleteBar, CheckRail, ChecksCard, OutcomeSpecLines, StandardsLineView } from './MissionChecks';
import MissionBuildStage from './MissionBuildStage';
import { MissionStageProvider } from '@/components/design-stage';

/** What the page knows about the checks; the build counts and repairs come from the live board. */
export type MissionChecksSource = Omit<MissionChecksInput, 'build' | 'repairs'>;

export interface MissionOverviewProps extends BoardLinkContext {
  model: MissionBoardModel;
  completionText?: string | null;
  /** What the strip cannot say (a decision gate, the integration PR). */
  notice?: ReactNode;
  /**
   * The mission's situation, by stage. Build draws none of a failed task, an
   * unmet criterion or the visual audit (rows, a decision card and Verify
   * own those, R-14 to R-20); Verify and Deliver draw all of it.
   */
  situation?: { build: ReactNode; verify: ReactNode };
  visual?: VisualReviewModel | null;
  /** The checks that apply after the build (spec f7f67f1a R-11 to R-22). Absent: the build view only. */
  checks?: MissionChecksSource | null;
  /** The build tasks as the Plan page schedules them (frozen estimates), for the build-only estimate (R-23). */
  planTasks?: readonly PlanTask[] | null;
  /** A hold or empty budget: no time promise (R-24). */
  held?: boolean;
  /** The mission's title: a spec line repeating it is left out. */
  missionTitle?: string | null;
  /** Titles of the selected outcome specs and the standards, by spec id, for the spec line (Navigation R-3). */
  outcomeSpecTitles?: Readonly<Record<string, string>> | null;
  /** The decisions a person must give, one card each (Navigation R-16; `missionDecisions`). */
  decisions?: readonly DecisionView[];
  /** What raises History into the page (Navigation R-6; `historyRaised`). */
  history?: HistoryRaised | null;
  /** Task id → expected minutes (task estimates), for the summary's `finish depends on` (Navigation R-22). */
  expectedMinutes?: Readonly<Record<string, number | null | undefined>>;
  /** The mission's design, closed: one fixed place after the current stage, on every mission (Navigation R-3). */
  design?: ReactNode;
}

/** Checks already at work before the build ends (R-13) are shown under the list. */
const STARTED: ReadonlySet<CheckStatus> = new Set(['running', 'finding', 'owner', 'unable', 'stale']);

export default function MissionOverview(props: MissionOverviewProps) {
  return (
    <WithMissionVisualReview missionId={props.missionId} visual={props.visual}>
      {review => <OverviewView {...props} review={review} />}
    </WithMissionVisualReview>
  );
}

function OverviewView({
  model: serverModel, completionText = null, notice, situation, visual: _visual, review,
  checks: checksSource = null, planTasks = null, held = false, outcomeSpecTitles = null, missionTitle = null, design = null,
  decisions = [], history = null, expectedMinutes, ...link
}: MissionOverviewProps & { review: MissionVisualReviewValue | null }) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 15_000, !model.complete);
  const layout = useMemo(() => overviewLayout(model, stripOrder(model)), [model]);
  const order = layout.order;
  const cells = useMemo(() => overviewCells(model, order), [model, order]);
  const groups = useMemo(() => layout.groups.map(g => ({ key: g.key, ids: g.ids, outline: g.key === 'active' })), [layout]);
  // ← → move a selection for the keyboard; a tap opens the task page.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hashed = useMissionFocusSnapshot()?.selectedTaskId ?? null;
  const router = useRouter();
  const hrefFor = useCallback((id: string) => boardTaskHref(link, id), [link]);
  const openTask = useCallback((id: string) => router.push(hrefFor(id)), [router, hrefFor]);
  const vm = review?.model ?? null;

  // Build tasks only (P-2): fixes, audits and refreshes sit in the checks group and never count.
  const buildIds = useMemo(() => layout.groups.filter(g => g.key !== 'checks').flatMap(g => g.ids), [layout]);
  const doneCount = layout.groups.find(g => g.key === 'done')?.ids.length ?? 0;
  const repairs = useMemo(() => order.filter(id => model.tasks[id].deliverableRole === 'repair').map(id => ({
    id, title: displayTaskTitle(model.tasks[id].title), done: BOARD_LANDED.has(model.tasks[id].status) && !isClosedUnshipped(model, id),
  })), [model, order]);
  const build = { done: doneCount, total: buildIds.length };
  const handoff = useMemo(
    () => (checksSource ? missionChecks({ ...checksSource, build, repairs }) : null),
    [checksSource, build.done, build.total, repairs], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const standards = useMemo(
    () => (checksSource ? missionStandardsLine({ ...checksSource, build }, outcomeSpecTitles ?? {}) : null),
    [checksSource, build.done, build.total, outcomeSpecTitles], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // One predicate for every surface (R-15).
  const buildComplete = handoff ? handoff.buildComplete : isBuildComplete(build);
  const stage: 'build' | 'verify' | 'deliver' = !buildComplete ? 'build' : handoff?.delivered ? 'deliver' : 'verify';
  // A check the owner must act on (a final merge under the human tier) is a decision too.
  // Max, not sum: the visual review's own ask may already count the same decision.
  const needs = Math.max(boardNeedsYouCount(model, vm), handoff?.rows.filter(r => r.status === 'owner').length ?? 0, decisions.length);
  const [showBuild, setShowBuild] = useState(false);
  // A `#t-<id>` arrival shows the bar it points into, even once the build is done.
  useEffect(() => { if (hashed) setShowBuild(true); }, [hashed]);
  const activeCount = layout.groups.find(g => g.key === 'active')?.ids.length ?? 0;
  const waitingCount = layout.groups.find(g => g.key === 'waiting')?.ids.length ?? 0;
  // A decision, a hold or nothing running while work waits (capacity, outside) removes any time promise.
  const estimate = stage === 'build' && planTasks
    ? buildEstimate(planTasks, now, held || needs > 0 || (activeCount === 0 && waitingCount > 0))?.line ?? null
    : null;
  const where = checksSource?.branch === 'mission-branch' ? 'the mission branch' : checksSource?.target ?? 'the target branch';
  const specLines = checksSource ? outcomeSpecLines(checksSource.criteria, handoff?.rows ?? [], outcomeSpecTitles ?? {}, missionTitle) : [];

  const bar = order.length > 0 && (
    <TaskStrip cells={cells} groups={groups} ticks={false} selectedId={selectedId} onSelect={setSelectedId} onOpen={openTask} label="Mission tasks, merged first" />
  );
  // A review waiting on a person is one decision card (R-16); the screens and fixes are evidence behind
  // its Review screens, not a second ask or a Checks row (R-18).
  const visualCard = decisions.some(d => d.answer.kind === 'visual');
  const showAsk = review && !visualCard;
  const listed = (rows: NonNullable<typeof handoff>['rows']) => (visualCard ? rows.filter(r => r.kind !== 'visual') : rows);
  const cards = decisions.length > 0 && <LeadDecision decisions={decisions} now={model.now} missionId={link.missionId} />;
  // History only for what the screen does not already show (R-37): the build rows show in Build, or once unfolded.
  const raised = historyOnScreen(history, { buildRowsShown: stage === 'build' || showBuild, decisions });

  return (
    <div data-testid="mission-overview" data-stage={stage} className="flex min-w-0 flex-col gap-5">
      <OutcomeSpecLines lines={specLines} />
      {handoff && <CheckRail steps={handoff.rail} />}
      {stage === 'build' && (
        <>
          {cards}
          {raised && <HistoryRaisedLine item={raised} missionId={link.missionId} />}
          {situation?.build}
          {notice}
          {showAsk && <MissionVisualAsk review={review} board={model} />}
          {model.phases.length === 0 && model.planning && <PlanningPlaceholder planning={model.planning} now={now} link={link} />}
          {bar}
          {order.length > 0 && <MissionBuildStage model={model} now={now} hrefFor={hrefFor} revealTaskId={hashed} expectedMinutes={expectedMinutes} />}
          {handoff && listed(handoff.rows).some(r => STARTED.has(r.status)) && <ChecksCard rows={listed(handoff.rows).filter(r => STARTED.has(r.status))} onOpenTask={openTask} />}
          {estimate && <p data-testid="overview-estimate" className="font-mono text-meta text-text-muted">{estimate}</p>}
        </>
      )}
      {stage === 'verify' && (
        <>
          <BuildCompleteBar done={buildIds.length} where={where} open={showBuild} onToggle={() => setShowBuild(v => !v)}>
            {bar}
            {showBuild && <MissionBuildStage model={model} now={now} hrefFor={hrefFor} revealTaskId={hashed} expectedMinutes={expectedMinutes} />}
          </BuildCompleteBar>
          {cards}
          {raised && <HistoryRaisedLine item={raised} missionId={link.missionId} />}
          {situation?.verify}
          {notice}
          {showAsk && <MissionVisualAsk review={review} board={model} />}
          {handoff && <ChecksCard rows={listed(handoff.rows)} onOpenTask={openTask} />}
          {standards && <StandardsLineView line={standards} />}
          {model.complete && <CompletionRecord model={model} text={completionText} visual={vm} />}
        </>
      )}
      {stage === 'deliver' && handoff && (
        <>
          {/* The Deliver stage, done: the catalog's word for it (terms.ts `mission.done`), then the branch it merged into. */}
          <p data-testid="mission-delivered-line" className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-title font-semibold text-text-primary">
            <span aria-hidden="true" className="state-cell inline-block h-3.5 w-3.5 shrink-0 self-center rounded-[var(--radius-cell)]" data-tone="ok" data-pattern="solid" />
            {`${termWord('mission.done')} · merged into ${checksSource?.target ?? where}`}
          </p>
          {situation?.verify}
          {notice}
          <details data-testid="mission-requirements-fold" className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-baseline gap-x-2 text-body md:min-h-0">
              <span className="text-text-muted">Requirements</span>
              <span className="font-mono text-meta text-text-muted">{requirementsCount(handoff.rows)} ›</span>
            </summary>
            <div className="mt-2 flex flex-col gap-3">
              <BuildCompleteBar done={buildIds.length} where={where} open={showBuild} onToggle={() => setShowBuild(v => !v)}>{bar}</BuildCompleteBar>
              <ChecksCard rows={handoff.rows} onOpenTask={openTask} />
            </div>
          </details>
          {standards && <StandardsLineView line={standards} />}
          {model.complete && <CompletionRecord model={model} text={completionText} visual={vm} />}
        </>
      )}
      {design && <MissionStageProvider value={stage}>{design}</MissionStageProvider>}
    </div>
  );
}

/**
 * One decision card leads (AC-4): the bar, the summary line and the list stay
 * on the first phone screen. The rest are reached from it, one line that
 * opens them in place.
 */
function MissionDecisionCard({ view, now, missionId }: { view: DecisionView; now: number; missionId: string }) {
  const visualAct = useVisualDecisionAct(view);
  return <DecisionCard view={view} now={now} pageMissionId={missionId} visualAct={visualAct} />;
}

function LeadDecision({ decisions, now, missionId }: { decisions: readonly DecisionView[]; now: number; missionId: string }) {
  const [open, setOpen] = useState(false);
  const rest = decisions.length - 1;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <MissionDecisionCard view={decisions[0]} now={now} missionId={missionId} />
      {rest > 0 && !open && (
        <button
          type="button"
          data-testid="decision-more"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-11 items-center self-start text-body text-text-secondary underline-offset-4 hover:text-text-primary hover:underline md:min-h-0"
        >
          {`${rest} more ${rest === 1 ? 'decision' : 'decisions'} ›`}
        </button>
      )}
      {open && decisions.slice(1).map(d => <MissionDecisionCard key={d.key} view={d} now={now} missionId={missionId} />)}
    </div>
  );
}

/**
 * History raised into the page (R-6): one line above the list naming the
 * open decision, the failure or the reopened task, opening History.
 */
function HistoryRaisedLine({ item, missionId }: { item: HistoryRaised; missionId: string }) {
  const ctx = useMissionLayout();
  const body = (
    <>
      <span className="shrink-0 text-text-muted">History</span>
      <span className="min-w-0 truncate text-text-primary">{item.text}</span>
      <span aria-hidden="true" className="text-text-muted">›</span>
    </>
  );
  const cls = 'flex min-h-11 w-full min-w-0 items-center gap-2 border-t border-[var(--line-soft)] text-left text-body hover:bg-card-hover md:min-h-9';
  return (
    <div data-testid="mission-history-raised" data-kind={item.kind}>
      {ctx
        ? <button type="button" onClick={() => ctx.setLayout('feed')} className={cls}>{body}</button>
        : <Link href={`/app/missions/${encodeURIComponent(missionId)}?layout=feed`} className={cls}>{body}</Link>}
    </div>
  );
}
