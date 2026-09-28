'use client';

/**
 * The mission Board: the default mission layout.
 *
 * ```
 * ┌ LANDED 2 of 12 ─┬ GOAL · 0/4 ───────┬ FLEET 6 live ─┬ NEEDS YOU 0 ┐
 * │ ■■▨■■ ■■■■░ ░░  │ ▣ PRs merged 2/11 │ A ■□ B ■■ …   │ nothing     │
 * └─────────────────┴───────────────────┴───────────────┴─────────────┘
 * [ asks: Round per line or on the total?  (Per line) (On the total) ]
 * 1 FOUNDATIONS ■■□□□ 2/5 │ 2 THROUGH THE PRODUCT │ 3 PROVE IT
 * ┃◇ research FX providers B │ ┃◆ api currency on API B │ ░ e2e pay a EUR
 * ┃━━┃━━━┃━━●      9m      │ …                      │ after invoices
 * ✓ db currency columns #411
 * JUST NOW ▶ checkout → D <1m · ✓ #412 money merged 1m …
 * ```
 *
 * Tiles are compact: scope chip, short label, runner, and an elapsed bar with
 * one notch per milestone (no progress is stored, so none is invented).
 * Landed work collapses to one line with its PR; queued work is hatched with
 * "after <scope>" chips. Hover (or focus) shows the task's detail; a click
 * opens the task sheet.
 */
import type { ReactNode } from 'react';
import type { VisualReviewModel } from '@buildd/shared';
import SteerButton from '@/components/chat/SteerButton';
import VisualReviewLine from '@/components/visual-review/VisualReviewLine';
import { BOARD_LANDED, boardNeedsYouCount, concurrencyBins, formatAge, formatClock, type BoardStatus, type BoardTask, type MissionBoardModel } from '@/lib/mission-board';
import {
  AnswerButtons, CriterionBox, LandedMeter, RoleGlyph, RunnerAvatar, ScopeChip, SectionLabel,
  taskSheetHref, useLiveBoard, useNow, type BoardLinkContext,
} from './MissionBoardParts';
import { MISSION_CRITERIA_ANCHOR } from '@/components/missions/MissionSituationBlock';
import { useMissionLiveSnapshot } from './MissionLiveStore';
import { verdictLine } from '@/lib/mission-visual-review';
import {
  MissionVisualAsk, MissionVisualTray, WithMissionVisualReview,
  type MissionVisualReviewValue, type VisualReviewLayout,
} from './MissionVisualReview';
import CriteriaCheckNow from './CriteriaCheckNow';
import { describeMissionDuration } from '@/lib/mission-duration';
import { axisTicks, formatAxisMinutes } from '@/components/fleet/slot-lanes-layout';

export interface MissionBoardProps extends BoardLinkContext {
  model: MissionBoardModel;
  /** The completion record's prose, for a completed mission. */
  completionText?: string | null;
  /** Anything the mission needs said that the band cannot (a decision gate). */
  notice?: ReactNode;
  /**
   * The narrow layout (the chat's docked pane and phone sheet): criteria are
   * pips named on hover, phase headers wrap, tile titles wrap to two lines and
   * the landed strip's captions drop the ordinal, instead of truncating.
   */
  compact?: boolean;
  /**
   * The mission's visual review (`loadVisualReview`), whenever an audit task
   * exists, pending and failed ones included. The Band gets a Screens row,
   * Needs you counts the screens awaiting a human, the Ask sits with the
   * other asks, the auditor's tile carries the Tray (else a section under
   * the columns) and the completion record counts the human calls. Decisions
   * go to the decisions route; the page's provider is used when mounted.
   */
  visual?: VisualReviewModel | null;
  /** Force the review deck's layout (`sheet`: inline, for a host that is a sheet). */
  reviewLayout?: VisualReviewLayout;
}

/** Tile order inside a column: what needs you, then red, then live, then review, then queued. */
const ORDER: Record<BoardStatus, number> = {
  waiting: 0, ci_failed: 1, fixing: 1, failed: 1, running: 2, review: 3, ready: 4, blocked: 5, merged: 6, done: 6,
};

/** The elapsed bar's full width: the longest live run, at least this. */
const MIN_STRIP_SPAN_MS = 15 * 60_000;

export default function MissionBoard(props: MissionBoardProps) {
  return (
    <WithMissionVisualReview missionId={props.missionId} visual={props.visual} reviewLayout={props.reviewLayout}>
      {review => <BoardView {...props} review={review} />}
    </WithMissionVisualReview>
  );
}

function BoardView({
  model: serverModel, completionText, notice, compact = false, visual: _visual, reviewLayout: _layout, review, ...link
}: MissionBoardProps & { review: MissionVisualReviewValue | null }) {
  const model = useLiveBoard(serverModel);
  const now = useNow(model.now, 15_000, !model.complete);
  const liveSpans = Object.values(model.tasks)
    .filter(t => t.status === 'running' || t.status === 'fixing')
    .map(t => (t.startedAt != null ? now - t.startedAt : 0));
  const stripSpan = Math.max(MIN_STRIP_SPAN_MS, ...liveSpans);
  const lastCol = model.phases.length - 1;
  const vm = review?.model ?? null;
  // The Tray sits under the latest audit's tile; an audit the board does not
  // draw (none, or folded away) gets a section under the columns.
  const auditId = vm?.audit?.id ?? null;
  const auditOnBoard = !!auditId && model.phases.some(p => p.taskIds.includes(auditId));
  const shotsFor = (taskId: string) =>
    review && auditOnBoard && taskId === auditId ? (
      <div key={`${taskId}:shots`} data-testid="board-visual-tray" className="-mt-1 border-[1.5px] border-t-0 border-border-strong bg-card px-3 pb-3 pt-2.5">
        <MissionVisualTray review={review} board={model} columns="fit" hideLine />
      </div>
    ) : null;

  return (
    <div data-testid="mission-board" data-compact={compact ? 'true' : undefined} className="flex flex-col">
      <Band model={model} compact={compact} missionId={link.missionId} visual={vm} onReview={review ? () => review.openDeck(null) : undefined} />
      {notice && <div className="mt-4">{notice}</div>}
      {model.needsYou.map(id => (
        <AskBanner key={id} task={model.tasks[id]} now={now} />
      ))}
      {review && <MissionVisualAsk review={review} board={model} className="mt-4" />}
      {model.complete && <CompletionRecord model={model} text={completionText ?? null} visual={vm} />}

      {model.phases.length === 0 && model.planning && (
        <PlanningPlaceholder planning={model.planning} now={now} link={link} />
      )}

      {model.phases.length > 0 && <section
        data-testid="mission-board-columns"
        className="mt-[22px] grid grid-cols-1 items-start gap-[22px] md:[grid-template-columns:var(--cols)]"
        style={{ ['--cols' as string]: model.phases.map(p => `minmax(0,${p.total <= 2 ? 0.78 : 1}fr)`).join(' ') }}
      >
        {model.phases.map((p, i) => {
          const tasks = p.taskIds.map(id => model.tasks[id]);
          const active = tasks.filter(t => !BOARD_LANDED.has(t.status)).sort((a, b) => ORDER[a.status] - ORDER[b.status]);
          const landed = tasks.filter(t => BOARD_LANDED.has(t.status));
          return (
            <div key={p.key} data-testid="board-column" data-phase={p.key} className="flex min-w-0 flex-col gap-2.5">
              <div className="flex items-center gap-2.5 border-b-2 border-border-strong pb-2">
                <span className="font-mono text-[11px] font-bold text-text-primary">{p.ordinal}</span>
                {/* One line: a wrapped header pushes its underline below its neighbours'. */}
                <SectionLabel
                  data-testid="board-phase-label"
                  title={p.label ?? (model.phases.length === 1 ? 'Tasks' : 'Unphased')}
                  className={`min-w-0 truncate !text-text-primary ${compact ? 'flex-1' : ''}`}
                >
                  {p.label ?? (model.phases.length === 1 ? 'Tasks' : 'Unphased')}
                </SectionLabel>
                <span aria-hidden="true" className="ml-auto flex shrink-0 gap-0.5">
                  {p.taskIds.map((id, k) => (
                    <i key={id} className={`block h-2 w-2 border ${k < p.done ? 'border-status-success bg-status-success' : 'border-[var(--fleet-border-mid)]'}`} />
                  ))}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">{`${p.done}/${p.total}`}</span>
              </div>
              {active.map(t => [
                <Tile key={t.id} task={t} model={model} now={now} span={stripSpan} link={link} popLeft={i === lastCol && lastCol > 0} compact={compact} />,
                shotsFor(t.id),
              ])}
              {landed.length > 0 && (
                <div className="mt-0.5 border-t border-border-default">
                  {landed.map(t => [<LandedRow key={t.id} task={t} link={link} complete={model.complete} />, shotsFor(t.id)])}
                </div>
              )}
            </div>
          );
        })}
      </section>}

      {review && !auditOnBoard && (
        <section data-testid="board-visual-section" className="mt-[22px] border-t-2 border-border-strong pt-3">
          <MissionVisualTray review={review} board={model} columns="fit" />
        </section>
      )}

      {model.complete ? <Concurrency model={model} /> : <Ticker model={model} now={now} link={link} />}
    </div>
  );
}

// ── Band ─────────────────────────────────────────────────────────────────────

export function Band({ model, compact, missionId, visual = null, onReview }: {
  model: MissionBoardModel;
  compact: boolean;
  missionId: string;
  /** The live visual review: a Screens row, and its screens in Needs you. */
  visual?: VisualReviewModel | null;
  onReview?: () => void;
}) {
  const needs = boardNeedsYouCount(model, visual);
  const first = model.needsYou.length ? model.tasks[model.needsYou[0]] : null;
  const awaiting = visual?.summary.awaitingHuman ?? 0;
  const needsCaption = first
    ? `${first.scope ?? first.label} has a question`
    : awaiting > 0
      ? `${awaiting} ${awaiting === 1 ? 'screen' : 'screens'} to review`
      : visual?.needsYou?.reason === 'round_cap'
        ? 'visual issues: your call'
        : model.complete ? 'all answered' : 'nothing waiting';
  const cell = 'flex min-w-0 flex-col gap-2.5 border-border-default px-[18px] pb-4 pt-3.5';
  return (
    <section
      data-testid="mission-band"
      className="mt-[18px] grid grid-cols-2 border-2 border-border-strong bg-card shadow-[var(--card-shadow)] md:grid-cols-[1.35fr_1.25fr_1.1fr_0.8fr]"
    >
      {/* Phone: Landed and Goal take a full row each (half width truncates the
          phase captions and every criterion); Fleet and Needs you pair up. */}
      <div data-testid="landed-band" className={`${cell} col-span-2 border-b md:col-span-1 md:border-b-0 md:border-r`}>
        <SectionLabel>Landed</SectionLabel>
        {model.landed.total > 0 ? (
          <>
            <Big n={model.landed.done} small={`of ${model.landed.total}`} />
            <LandedMeter model={model} variant="band" compact={compact} />
          </>
        ) : (
          <span data-testid="landed-empty" className="font-mono text-[12px] md:text-[11.5px] text-text-muted">
            No tasks yet
          </span>
        )}
      </div>
      <GoalCell model={model} compact={compact} missionId={missionId} className={`${cell} col-span-2 border-b md:col-span-1 md:border-b-0 md:border-r`} />
      <div data-testid="fleet-band" className={`${cell} md:border-r`}>
        <SectionLabel>Fleet</SectionLabel>
        <Big n={model.live} small={model.complete || model.live === 0 ? 'agents · idle' : model.live === 1 ? 'agent live' : 'agents live'} />
        <div className="flex flex-wrap gap-3">
          {model.runners.map(r => (
            <span key={r.id} className="flex items-center gap-1" title={r.machine ? `${r.name} · ${r.machine}` : r.name}>
              <RunnerAvatar runner={r.name} />
              {r.slots.map((s, i) => (
                <span
                  key={i}
                  className={`block h-3.5 w-3.5 ${s ? (s.waiting ? 'border-2 border-accent' : 'border-[1.5px] border-accent bg-accent') : 'border-[1.5px] border-[var(--fleet-border-mid)]'}`}
                />
              ))}
            </span>
          ))}
          {model.runners.length === 0 && <span className="font-mono text-[12px] text-text-muted">No runner has picked up work yet.</span>}
        </div>
      </div>
      <div data-testid="needs-you-cell" className={`${cell} border-l md:border-l-0 ${needs ? 'bg-accent-soft' : ''}`}>
        <SectionLabel className={needs ? '!text-accent-text' : ''}>Needs you</SectionLabel>
        <span className={`font-mono text-[34px] font-semibold leading-none tracking-[-1px] tabular-nums ${needs ? 'text-accent-text' : 'text-[var(--fleet-faint)]'}`}>{needs}</span>
        <span className="font-mono text-[12px] md:text-[11.5px] text-text-muted">
          {needsCaption}
        </span>
      </div>
      {visual && visual.phase !== 'off' && (
        // The Visual cell: one full-width row under the four, at every width,
        // so the band keeps its columns (a fifth would crowd a docked pane).
        <div data-testid="visual-band" data-phase={visual.phase} className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-default px-[18px] py-3 md:col-span-4">
          <VisualReviewLine model={visual} variant="full" className="min-w-0 flex-1" />
          {onReview && visual.cells.length > 0 && visual.phase !== 'needs_you' && (
            <button
              type="button"
              data-testid="visual-band-open"
              onClick={onReview}
              className="inline-flex min-h-10 shrink-0 items-center gap-1 font-mono text-[12px] font-semibold text-text-secondary hover:text-text-primary md:min-h-8"
            >
              Open screens
              <span aria-hidden="true">›</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The band's goal cell. A mission that completed without anything evaluating
 * its criteria says so once, with Check now — not a "not checked" on every row.
 */
export function GoalCell({ model, compact, missionId, className }: { model: MissionBoardModel; compact: boolean; missionId: string; className: string }) {
  const unevaluated = model.complete && !model.criteriaEvaluated && model.criteria.length > 0;
  const heading = unevaluated ? 'Goal' : `Goal · ${model.criteriaPassed}/${model.criteria.length} criteria`;
  return (
    <div data-testid="goal-band" data-evaluated={unevaluated ? 'false' : undefined} className={className}>
      {/* flex, not inline: an inline link's line box sat the label lower than the other cells'. */}
      <a href={`#${MISSION_CRITERIA_ANCHOR}`} className="flex self-start hover:underline">
        <SectionLabel>{heading}</SectionLabel>
      </a>
      {unevaluated && (
        <div data-testid="criteria-not-evaluated" className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 font-mono text-[12px] text-text-secondary">
          <span>Criteria not evaluated</span>
          <CriteriaCheckNow missionId={missionId} />
        </div>
      )}
      {compact ? (
        <div className="flex flex-wrap gap-1.5" role="list" aria-label="Goal criteria">
          {model.criteria.length === 0 && <span className="font-mono text-[12px] text-text-muted">No criteria set.</span>}
          {model.criteria.map((c, i) => (
            <span
              key={i}
              role="listitem"
              data-testid="goal-criterion-pip"
              data-state={c.state}
              title={unevaluated ? c.label : `${c.label} · ${c.value}`}
              aria-label={unevaluated ? c.label : `${c.label} · ${c.value}`}
            >
              <CriterionBox c={c} size={16} />
            </span>
          ))}
        </div>
      ) : <div className="grid gap-[5px]">
        {model.criteria.length === 0 && <span className="font-mono text-[12px] text-text-muted">No criteria set.</span>}
        {model.criteria.map((c, i) => (
          <a key={i} href={`#${MISSION_CRITERIA_ANCHOR}`} data-testid="goal-criterion" data-state={c.state} className="flex min-w-0 items-center gap-2 font-mono text-[12px] text-text-secondary hover:text-text-primary">
            <CriterionBox c={c} />
            <span className="min-w-0 truncate">{c.label}</span>
            {/* Unevaluated: the one line above says it; a per-row "not checked" is noise. */}
            {!(unevaluated && c.state === 'pending') && (
              <span className={`ml-auto shrink-0 tabular-nums ${c.state === 'pending' ? 'font-medium text-text-muted' : 'font-semibold text-text-primary'}`}>{c.value}</span>
            )}
          </a>
        ))}
      </div>}
    </div>
  );
}

function Big({ n, small }: { n: number; small: string }) {
  return (
    <span className="font-mono text-[34px] font-semibold leading-none tracking-[-1px] text-text-primary tabular-nums">
      {n}
      <small className="ml-1.5 text-[14px] font-medium tracking-normal text-text-muted">{small}</small>
    </span>
  );
}

// ── Needs you ────────────────────────────────────────────────────────────────

export function AskBanner({ task, now }: { task: BoardTask; now: number }) {
  const prompt = task.waitingFor?.prompt ?? 'Waiting on you.';
  return (
    <section
      data-testid="needs-you-band"
      data-task-id-ref={task.id}
      className="mt-4 flex flex-col gap-3 border-2 border-accent bg-card px-4 py-3 shadow-[var(--card-shadow)] md:flex-row md:items-center md:gap-4"
    >
      <RunnerAvatar runner={task.runner} className="hidden md:grid" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[12px] md:text-[11.5px] text-text-muted">
          <RoleGlyph task={task} />
          <ScopeChip scope={task.scope} />
          <span className="truncate">
            {`asked ${formatAge(task.waitStartedAt != null ? now - task.waitStartedAt : 0)} ago`}
            {task.runner ? ` · agent paused on ${task.runner}` : ''}
          </span>
        </div>
        <p className="font-mono text-[14px] font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]">{prompt}</p>
      </div>
      <div className="shrink-0">
        <AnswerButtons workerId={task.workerId} options={task.waitingFor?.options ?? []} />
      </div>
    </section>
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────

const ACCENT_BAR: Partial<Record<BoardStatus, string>> = {
  running: 'bg-accent', waiting: 'bg-accent', review: 'bg-status-success', ci_failed: 'bg-status-error', fixing: 'bg-status-error', failed: 'bg-status-error',
};

function Tile({ task: t, model, now, span, link, popLeft, compact = false }: { task: BoardTask; model: MissionBoardModel; now: number; span: number; link: BoardLinkContext; popLeft: boolean; compact?: boolean }) {
  const href = taskSheetHref(link, t.id);
  const queued = t.status === 'ready' || t.status === 'blocked';
  const live = t.status === 'running' || t.status === 'fixing';
  const head = (
    <div className={`flex min-w-0 gap-2 ${compact ? 'items-start' : 'items-center'}`}>
      <RoleGlyph task={t} />
      <ScopeChip scope={t.scope} />
      <span
        data-testid="board-tile-label"
        title={compact ? t.title : undefined}
        className={`min-w-0 font-mono text-[14px] ${compact ? 'line-clamp-2 leading-snug [overflow-wrap:anywhere]' : 'truncate'} ${queued ? 'font-medium text-text-secondary' : 'font-semibold text-text-primary'}`}
      >
        {t.label}
      </span>
      <span className="flex-1" />
      {t.attempt > 1 && (
        <span className={`inline-flex h-5 shrink-0 items-center border px-1.5 font-mono text-[11px] ${t.status === 'fixing' || t.status === 'ci_failed' ? 'border-status-error text-status-error' : 'border-[var(--fleet-border-mid)] text-text-secondary'}`}>{`↻${t.attempt}`}</span>
      )}
      {live && <SteerButton taskId={t.id} />}
      {!queued && <RunnerAvatar runner={t.runner} />}
    </div>
  );

  let body: ReactNode;
  if (queued) {
    body = (
      <div className="flex min-h-[18px] items-center gap-[5px] font-mono text-[12px] md:text-[11.5px] text-text-muted">
        {t.status === 'ready' ? 'ready · next free slot' : (
          <>
            after
            {t.deps.filter(d => !d.ok).concat(t.deps.filter(d => d.ok)).map(d => (
              <ScopeChip key={d.id} scope={d.scope ?? d.label} tone={d.ok ? 'ok' : 'ghost'} />
            ))}
          </>
        )}
      </div>
    );
  } else if (t.status === 'waiting') {
    body = (
      <div className="flex min-h-[18px] items-center gap-2.5 font-mono text-[12px] md:text-[11.5px] text-text-muted">
        <span className="flex items-center gap-1.5 text-[11px] md:text-[10.5px] font-bold uppercase tracking-[1px] text-accent-text">
          <span className="h-2 w-2 animate-status-pulse bg-accent" />Needs you
        </span>
        <span className="flex-1" />
        <span className="font-medium tabular-nums text-text-secondary">{formatAge(t.waitStartedAt != null ? now - t.waitStartedAt : 0)}</span>
      </div>
    );
  } else if (t.status === 'review') {
    body = (
      <div className="flex min-h-[18px] items-center gap-2.5 font-mono text-[12px] md:text-[11.5px] text-text-muted">
        <span>in review</span>
        <span className="flex-1" />
        <PrChip task={t} />
      </div>
    );
  } else {
    const chip = t.pr && t.status !== 'running' ? <PrChip task={t} /> : t.pr && t.pr.state !== 'open' ? <PrChip task={t} /> : null;
    // A live tile says what it is doing (the current action, else the elapsed
    // strip) and for how long — or nothing: no empty second line under the title.
    const lead = live && t.currentAction
      ? <span data-testid="board-tile-action" className="min-w-0 flex-1 truncate text-text-secondary">{t.currentAction}</span>
      : live && t.startedAt != null
        ? <ElapsedStrip task={t} now={now} span={span} />
        : null;
    const elapsed = live && t.startedAt != null
      ? <span className="font-medium tabular-nums text-text-secondary">{formatAge(now - t.startedAt)}</span>
      : null;
    body = lead || chip || elapsed || !live ? (
      <div data-testid="board-tile-body" className="flex min-h-[18px] items-center gap-2.5 font-mono text-[12px] md:text-[11.5px] text-text-muted">
        {lead ?? <span className="flex-1" />}
        {chip}
        {elapsed}
      </div>
    ) : null;
  }

  return (
    <div className="group relative">
      <a
        href={href}
        data-task-id={t.id}
        data-testid="board-tile"
        data-status={t.status}
        className={`relative flex flex-col gap-[9px] px-3 py-2.5 pl-3.5 transition-transform ${
          queued
            ? `border-[1.5px] border-dashed border-[var(--fleet-border-mid)] py-[9px] ${t.status === 'blocked' ? 'fleet-hatch' : ''}`
            : `border-[1.5px] border-border-strong bg-card group-hover:-translate-x-px group-hover:-translate-y-px group-hover:shadow-[3px_3px_0_0_var(--border-strong)] ${t.status === 'waiting' ? 'border-2 !border-accent shadow-[3px_3px_0_0_var(--border-strong)]' : ''}`
        }`}
      >
        {!queued && ACCENT_BAR[t.status] && <span aria-hidden="true" className={`absolute -bottom-[1.5px] -left-[1.5px] -top-[1.5px] w-1 ${ACCENT_BAR[t.status]}`} />}
        {head}
        {body}
      </a>
      {!queued && <TilePopover task={t} model={model} now={now} left={popLeft} href={href} />}
    </div>
  );
}

function PrChip({ task: t }: { task: BoardTask }) {
  if (!t.pr) return null;
  const n = `#${t.pr.number}`;
  switch (t.pr.state) {
    case 'merged': return <span className="shrink-0 font-mono text-[11px] font-semibold text-status-success">{`${n} ✓`}</span>;
    case 'ci_failed':
    case 'conflict': return <span className="shrink-0 font-mono text-[11px] font-semibold text-status-error">{`${n} ✕ ${t.pr.state === 'conflict' ? 'conflict' : 'CI'}`}</span>;
    case 'checks_running': return <span className="shrink-0 font-mono text-[11px] font-semibold text-accent-text">{n} <span className="animate-status-pulse">◌</span> CI</span>;
    case 'open': return <span className="shrink-0 font-mono text-[11px] font-semibold text-status-success">{`${n} ● ready`}</span>;
    default: return <span className="shrink-0 font-mono text-[11px] font-semibold text-status-error">{`${n} ${t.pr.state}`}</span>;
  }
}

/** Elapsed time as a filled strip, with a notch at every milestone. No stored progress. */
function ElapsedStrip({ task: t, now, span }: { task: BoardTask; now: number; span: number }) {
  if (t.startedAt == null) return <span className="flex-1" />;
  const frac = (ms: number) => `${Math.min(1, Math.max(0, (ms - t.startedAt!) / span)) * 100}%`;
  return (
    <span data-testid="board-tile-strip" className="relative h-1.5 flex-1 border border-border-default bg-surface-1">
      <span className="absolute -bottom-px -top-px left-0 border-r-[3px] border-accent bg-accent-soft" style={{ width: frac(now) }} />
      {t.milestones.filter(m => m.ts >= t.startedAt!).map((m, i) => (
        <i key={i} data-testid="board-tile-notch" title={m.label} className="absolute -top-[3px] block h-2.5 w-0.5 bg-text-secondary" style={{ left: `calc(${frac(m.ts)} - 1px)` }} />
      ))}
    </span>
  );
}

function TilePopover({ task: t, model, now, left, href }: { task: BoardTask; model: MissionBoardModel; now: number; left: boolean; href: string }) {
  const recent = t.milestones.slice(-4);
  const deps = t.deps.map(d => `${d.scope ?? d.label}${d.ok ? ' ✓' : ''}`).join('  ');
  const running = t.startedAt != null ? formatAge((t.endedAt ?? now) - t.startedAt) : null;
  return (
    <div
      data-testid="board-tile-detail"
      role="tooltip"
      className={`pointer-events-none invisible absolute top-[-6px] z-30 hidden w-[380px] flex-col gap-2.5 border-2 border-border-strong bg-card px-4 py-3.5 opacity-0 shadow-[var(--card-shadow)] transition-opacity delay-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 md:flex ${left ? 'right-[calc(100%+14px)]' : 'left-[calc(100%+14px)]'}`}
    >
      <div className="flex items-center gap-2">
        <RoleGlyph task={t} />
        <ScopeChip scope={t.scope} />
        {t.roleName && <SectionLabel className="ml-auto">{t.roleName}</SectionLabel>}
      </div>
      <p className="font-mono text-[13px] font-semibold leading-[1.45] text-text-primary">{t.title}</p>
      <div className="grid grid-cols-[70px_1fr] gap-x-2.5 gap-y-1 font-mono text-[12px] md:text-[11.5px]">
        {t.runner && <><span className="text-text-muted">runner</span><span className="text-text-secondary">{`${t.runner}${t.slot != null ? ` · slot ${t.slot + 1}` : ''}`}</span></>}
        {running && <><span className="text-text-muted">{t.endedAt ? 'ran' : 'running'}</span><span className="tabular-nums text-text-secondary">{`${running} · ${t.milestones.length} milestone${t.milestones.length === 1 ? '' : 's'}`}</span></>}
        {deps && <><span className="text-text-muted">after</span><span className="text-text-secondary">{deps}</span></>}
        {t.unblocks.length > 0 && <><span className="text-text-muted">unblocks</span><span className="text-text-secondary">{t.unblocks.map(u => u.scope ?? u.label).join('  ')}</span></>}
      </div>
      {(recent.length > 0 || t.currentAction) && (
        <div className="flex flex-col gap-[5px] border-t border-border-default pt-2.5">
          {recent.map((m, i) => (
            <div key={i} className={`grid grid-cols-[44px_12px_1fr] gap-1.5 font-mono text-[12px] md:text-[11.5px] leading-[1.4] ${i === recent.length - 1 ? 'text-text-primary' : 'text-text-secondary'}`}>
              <span className="tabular-nums text-text-muted">{t.startedAt != null ? formatClock(m.ts - t.startedAt) : ''}</span>
              <i className={`mt-1 block h-2 w-2 ${i === recent.length - 1 ? 'bg-accent' : 'bg-[var(--fleet-faint)]'}`} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{m.label}</span>
            </div>
          ))}
          {recent.length === 0 && t.currentAction && <span className="font-mono text-[12px] text-text-secondary">{t.currentAction}</span>}
        </div>
      )}
      <span className="font-mono text-[12px] font-semibold text-accent-text" data-href={href}>Open task →</span>
    </div>
  );
}

function LandedRow({ task: t, link, complete }: { task: BoardTask; link: BoardLinkContext; complete: boolean }) {
  return (
    <a
      href={taskSheetHref(link, t.id)}
      data-task-id={t.id}
      data-testid="board-tile"
      data-status={t.status}
      className="flex h-8 min-w-0 items-center gap-2 border-b border-border-default font-mono text-[12.5px] text-text-secondary hover:bg-card-hover"
    >
      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center bg-status-success text-[11px] md:text-[10px] font-bold text-card">✓</span>
      <ScopeChip scope={t.scope} />
      <span className="min-w-0 truncate font-medium">{t.label}</span>
      {t.attempt > 1 && <span className="inline-flex h-[18px] shrink-0 items-center border border-[var(--fleet-border-mid)] px-1.5 text-[11px]">{`↻${t.attempt}`}</span>}
      <span className="flex-1" />
      {complete && (t.lines ? (
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--fleet-faint)]">
          <b className="font-medium text-status-success">{`+${t.lines.added.toLocaleString()}`}</b>
          {t.lines.removed > 0 && <em className="not-italic text-status-error">{` −${t.lines.removed.toLocaleString()}`}</em>}
        </span>
      ) : !t.pr ? <span className="shrink-0 text-[11px] text-[var(--fleet-faint)]">report</span> : null)}
      {t.pr ? <span className="shrink-0 text-[11px] font-semibold text-status-success">{`#${t.pr.number}`}</span> : <span className="shrink-0 text-[11px] text-text-muted">◇</span>}
    </a>
  );
}

// ── Just now ─────────────────────────────────────────────────────────────────

const TICK: Record<string, { glyph: string; cls: string }> = {
  merged: { glyph: '✓', cls: 'text-status-success' },
  pr: { glyph: '↑', cls: 'text-text-primary' },
  claimed: { glyph: '▶', cls: 'text-accent-text' },
  ci_failed: { glyph: '✕', cls: 'text-status-error' },
  asked: { glyph: '?', cls: 'text-accent-text' },
  done: { glyph: '■', cls: 'text-text-secondary' },
};

function Ticker({ model, now, link }: { model: MissionBoardModel; now: number; link: BoardLinkContext }) {
  if (model.ticker.length === 0) return null;
  return (
    <section data-testid="mission-ticker" className="mt-8 flex flex-wrap items-center gap-2 border-t border-border-default py-2.5 font-mono text-[12px] md:text-[11.5px] text-text-muted">
      <SectionLabel className="mr-1.5">Just now</SectionLabel>
      {model.ticker.map((e, i) => (
        <a
          key={`${e.kind}:${e.taskId}:${e.at}:${i}`}
          href={taskSheetHref(link, e.taskId)}
          data-task-id={e.taskId}
          data-testid="mission-ticker-event"
          className="inline-flex h-6 items-center gap-1.5 border border-border-default px-2 text-text-secondary hover:bg-card-hover"
        >
          <span className={`font-bold ${TICK[e.kind].cls}`}>{TICK[e.kind].glyph}</span>
          {e.text}
          <span className="tabular-nums text-[var(--fleet-faint)]">{formatAge(now - e.at)}</span>
        </a>
      ))}
    </section>
  );
}

// ── Planning ─────────────────────────────────────────────────────────────────

/**
 * Before the plan lands there are no deliverables, so no columns: say who is
 * planning and what they are doing, live (milestones stream in over the same
 * store the tiles read), instead of an empty "Tasks 0/0" column.
 */
function PlanningPlaceholder({ planning: p, now, link }: { planning: NonNullable<MissionBoardModel['planning']>; now: number; link: BoardLinkContext }) {
  const live = useMissionLiveSnapshot()[p.taskId];
  const milestone = live?.milestones?.length ? live.milestones[live.milestones.length - 1].label : p.lastMilestone;
  const action = live?.currentAction ?? p.currentAction;
  const detail = action ?? milestone;
  return (
    <a
      href={taskSheetHref(link, p.taskId)}
      data-testid="board-planning"
      data-task-id={p.taskId}
      data-live={String(p.live)}
      className="mt-[22px] flex min-w-0 flex-col gap-1.5 border-2 border-dashed border-border-strong bg-card px-[18px] py-3.5 hover:bg-card-hover"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`block h-2 w-2 shrink-0 ${p.live ? 'animate-pulse bg-accent' : 'border border-border-strong'}`}
          style={p.roleColor && p.live ? { background: p.roleColor } : undefined}
        />
        <span className="min-w-0 truncate font-mono text-[13px] font-semibold text-text-primary">
          {p.live ? `${p.roleName} is planning…` : `${p.roleName} will plan this mission`}
        </span>
        {p.runner && <RunnerAvatar runner={p.runner} className="ml-auto" />}
        {p.runner && <span className="shrink-0 font-mono text-[11px] text-text-muted">{p.runner}</span>}
        {p.live && p.startedAt != null && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">{formatAge(now - p.startedAt)}</span>
        )}
      </span>
      <span data-testid="board-planning-detail" className="min-w-0 truncate font-mono text-[12px] text-text-secondary">
        {detail ?? (p.live ? 'Breaking the goal into tasks and phases.' : 'Waiting for a runner to pick up the plan.')}
      </span>
    </a>
  );
}

// ── Completion ───────────────────────────────────────────────────────────────

function CompletionRecord({ model, text, visual }: { model: MissionBoardModel; text: string | null; visual: VisualReviewModel | null }) {
  const r = model.record;
  const review = visual && visual.summary.shots > 0 ? visual.summary : null;
  const d = describeMissionDuration({ activeMs: model.activeMs, openMs: (model.endedAt ?? model.now) - model.startedAt });
  // Only what happened: a CI auto-fix count of 0 is not an outcome, and a
  // visual review is. One compact card, like the Lanes side card: the summary
  // across the top, the numbers in one row under it.
  const stats: Array<{ label: string; value: string; testId: string; sub?: string; subCls?: string }> = [
    { label: 'PRs merged', value: String(r.prsMerged), testId: 'record-prs' },
    { label: 'Lines', value: `+${r.linesAdded.toLocaleString()}`, testId: 'record-lines' },
    ...(r.ciFixes > 0 ? [{ label: 'CI auto-fix', value: String(r.ciFixes), testId: 'record-ci-fixes' }] : []),
    ...(review
      ? [{ label: 'Screens reviewed', value: String(review.shots), testId: 'record-screens', sub: review.ok === review.shots ? 'all ok' : verdictLine(review), subCls: review.ok === review.shots ? 'text-status-success' : 'text-text-secondary' }]
      : []),
    ...(review && review.reviewed > 0
      ? [{ label: 'Screens you judged', value: String(review.reviewed), testId: 'record-screen-calls', sub: humanCallsLine(review) }]
      : []),
    { label: 'Your decisions', value: String(r.decisions), testId: 'record-decisions' },
    { label: 'Work', value: d.work ?? '0m', testId: 'record-time', sub: d.showOpen ? `open ${d.open}` : undefined },
  ];
  return (
    <section data-testid="mission-completion-record" className="mt-[18px] flex flex-col gap-3 border-2 border-border-strong bg-card px-[18px] py-3.5 shadow-[var(--card-shadow)]">
      <SectionLabel className="!text-status-success">Completion record</SectionLabel>
      {text && <p data-testid="record-text" className="max-w-[100ch] font-mono text-[12.5px] leading-[1.55] text-text-secondary whitespace-pre-line">{text}</p>}
      <div data-testid="record-stats" className="flex flex-wrap gap-x-8 gap-y-3 border-t border-border-default pt-3">
        {stats.map(st => (
          <div key={st.testId} data-testid={st.testId} className="flex min-w-0 flex-col gap-1.5">
            <span className="font-mono text-[11px] md:text-[10px] uppercase tracking-[1.2px] text-text-muted">{st.label}</span>
            <div className="flex items-baseline gap-2">
              <b className="font-mono text-[22px] font-semibold leading-none tabular-nums text-text-primary">{st.value}</b>
              {st.sub && <span className={`font-mono text-[12px] ${st.subCls ?? 'text-text-secondary'}`}>{st.sub}</span>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** `2 agreed · 1 disputed · 1 waived`, zeros left out. */
export function humanCallsLine(s: Pick<VisualReviewModel['summary'], 'confirmed' | 'disputed' | 'waived'>): string {
  return [
    s.confirmed > 0 ? `${s.confirmed} agreed` : null,
    s.disputed > 0 ? `${s.disputed} disputed` : null,
    s.waived > 0 ? `${s.waived} waived` : null,
  ].filter(Boolean).join(' · ');
}

function Concurrency({ model }: { model: MissionBoardModel }) {
  const from = model.startedAt;
  const to = Math.max(from + 60_000, ...model.bars.map(b => b.end ?? model.now), ...model.merges.map(m => m.at));
  // Side runs (a friction report's) are not agents working the mission.
  const bins = concurrencyBins(model.bars.filter(b => b.tone !== 'side'), from, to, 72);
  const peak = Math.max(1, ...bins);
  const x = (t: number) => `${((t - from) / (to - from)) * 100}%`;
  // The shared axis ladder (minutes up to days), so a mission open for weeks
  // gets a handful of day ticks, not a solid bar of overlapping "30m" labels.
  const { ticks } = axisTicks(to - from, 10);
  return (
    <section data-testid="mission-concurrency" className="mt-[26px] hidden md:block">
      <div className="mb-2.5 flex items-baseline gap-3.5">
        <SectionLabel>Agents over time</SectionLabel>
        <span className="font-mono text-[12px] md:text-[11.5px] text-text-muted">
          peak <b className="text-text-primary">{model.record.peakAgents}</b> in parallel · {model.merges.length} merges <span className="text-status-success">■</span>
        </span>
      </div>
      <div className="relative flex h-[120px] items-end gap-0.5 border-b-2 border-border-strong">
        <span className="absolute inset-x-0 border-t border-dashed border-border-default font-mono text-[11px] md:text-[10px] text-[var(--fleet-faint)]" style={{ bottom: `${(model.record.peakAgents / (peak + 1)) * 100}%` }}>{model.record.peakAgents}</span>
        {bins.map((n, i) => (
          <i key={i} className="block flex-1 bg-surface-4" style={{ height: `${(n / (peak + 1)) * 100}%` }} />
        ))}
        {model.humanTouches.filter(t => t >= from && t <= to).map(t => (
          <Marker key={`h${t}`} left={x(t)} cls="text-accent-text" label="? you" />
        ))}
        {model.ciFails.map(f => (
          <Marker key={`c${f.at}`} left={x(f.at)} cls="text-status-error" label="✕ CI" />
        ))}
      </div>
      <div className="relative h-[26px] font-mono text-[11px] md:text-[10.5px] text-[var(--fleet-faint)]">
        {ticks.map(m => <span key={m} data-testid="concurrency-tick" className="absolute top-1.5 -translate-x-1/2" style={{ left: x(from + m * 60_000) }}>{formatAxisMinutes(m)}</span>)}
        {model.merges.map(m => <i key={m.pr} title={`#${m.pr}`} className="absolute -top-0.5 block h-2 w-2 -translate-x-1/2 bg-status-success" style={{ left: x(m.at) }} />)}
      </div>
    </section>
  );
}

function Marker({ left, cls, label }: { left: string; cls: string; label: string }) {
  return (
    <span className={`absolute -top-1.5 flex -translate-x-1/2 flex-col items-center gap-0.5 font-mono text-[11px] font-bold ${cls}`} style={{ left }}>
      {label}
      <span className="block h-[110px] w-[1.5px] bg-current opacity-50" />
    </span>
  );
}
