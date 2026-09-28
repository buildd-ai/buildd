'use client';

/**
 * The visual review on the mission page (docs/design/visual-qa-human-review.md,
 * "Where it shows"): one live model, one deck, shared by every surface that
 * shows the audit — the Board, Lanes and Feed layouts, the footer's Screens
 * row and the Settings sheet's toggle.
 *
 * - `MissionVisualReviewProvider` holds the model with in-flight decisions
 *   laid over it (`useVisualReviewDecisions`) and the deck. The page wraps its
 *   layouts in one, so the footer row and the board open the same deck. A new
 *   `visual` prop (a server refresh after `mission:visual_review` or an audit
 *   shot's `worker:artifact`) replaces the model.
 * - `WithMissionVisualReview` is what MissionBoard, MissionLanes and
 *   MissionFeedLayout render through: inside a provider for the same mission
 *   it reads that one; alone (the chat's mission pane) it makes its own from
 *   the `visual` prop, so a host only passes `visual` (and, to force the
 *   inline deck, `reviewLayout="sheet"`).
 * - The deck is a dialog at md+ and inline below md (`layout="sheet"`: the
 *   deck takes the place of the page until it closes), never a dialog stacked
 *   inside another sheet.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { VisualReviewModel } from '@buildd/shared';
import VisualReviewDeck from '@/components/visual-review/VisualReviewDeck';
import VisualReviewAsk, { type OnAnswer } from '@/components/visual-review/VisualReviewAsk';
import VisualReviewTray from '@/components/visual-review/VisualReviewTray';
import type { MissionBoardModel } from '@/lib/mission-board';
import {
  createHttpVisualReviewTransport,
  useVisualReviewDecisions,
  type DecideInput,
  type DecideResult,
  type UndoResult,
  type VisualReviewTransport,
} from '@/components/visual-review/review-transport';

export type VisualReviewLayout = 'dialog' | 'sheet';

// ── Phase actions ───────────────────────────────────────────────────────────

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, fallback: string): Promise<void> {
  const res = await fetchImpl(url, init);
  if (res.ok) return;
  let message = fallback;
  try {
    const body = await res.json() as { error?: unknown; message?: unknown };
    if (typeof body?.message === 'string' && body.message) message = body.message;
    else if (typeof body?.error === 'string' && body.error) message = body.error;
  } catch { /* keep the fallback */ }
  throw new Error(message);
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export interface VisualReviewPhaseActionHandlers {
  onTurnOff: () => Promise<void>;
  onSkip: () => Promise<void>;
  onRetry: () => Promise<void>;
  onAnswer: OnAnswer;
}

/**
 * The Tray's inline actions, over the existing routes:
 * - Turn off for this mission: `autoSurfaceAudit: false` on the mission, then
 *   cancel the pending audit (only once the setting saved).
 * - Skip this audit: cancel the audit task only.
 * - Retry: re-queue the audit task (as the task row's retry does).
 * - Answer: reply to the parked worker (the boot-failure question).
 * Each throws with the server's message on a refusal, for the button to show.
 */
export function visualReviewPhaseActions({
  missionId,
  auditTaskId,
  fetchImpl = fetch,
  refresh,
}: {
  missionId: string;
  auditTaskId: string | null | undefined;
  fetchImpl?: typeof fetch;
  refresh: () => void;
}): VisualReviewPhaseActionHandlers {
  const enc = encodeURIComponent;
  const needAudit = () => {
    if (!auditTaskId) throw new Error('There is no audit task to act on.');
    return auditTaskId;
  };
  const cancelAudit = (id: string) =>
    send(fetchImpl, `/api/tasks/${enc(id)}`, json('PATCH', { status: 'cancelled' }), 'Could not cancel the audit. Try again.');
  return {
    async onTurnOff() {
      await send(fetchImpl, `/api/missions/${enc(missionId)}`, json('PATCH', { autoSurfaceAudit: false }), 'Could not turn the audit off. Try again.');
      if (auditTaskId) await cancelAudit(auditTaskId);
      refresh();
    },
    async onSkip() {
      await cancelAudit(needAudit());
      refresh();
    },
    async onRetry() {
      const id = needAudit();
      await send(fetchImpl, `/api/tasks/${enc(id)}/reassign?force=true`, { method: 'POST' }, 'Could not retry the audit. Try again.');
      refresh();
    },
    async onAnswer(answer, target) {
      await send(fetchImpl, `/api/workers/${enc(target.workerId)}/respond`, json('POST', { message: answer }), 'The answer did not send. Try again.');
      refresh();
    },
  };
}

// ── Context ─────────────────────────────────────────────────────────────────

export interface MissionVisualReviewValue {
  missionId: string;
  /** The live model (server model plus in-flight decisions). */
  model: VisualReviewModel;
  /** Open the deck at a cell (`null`: the head of the queue). */
  openDeck: (startKey: string | null, opts?: { compare?: boolean }) => void;
  decide: (input: DecideInput) => Promise<DecideResult>;
  undo: (reviewIds: readonly string[]) => Promise<UndoResult>;
  actions: VisualReviewPhaseActionHandlers;
  layout: VisualReviewLayout;
}

const Ctx = createContext<MissionVisualReviewValue | null>(null);

/** The mission's live visual review, when a provider for it is mounted. */
export function useMissionVisualReview(missionId?: string): MissionVisualReviewValue | null {
  const v = useContext(Ctx);
  if (!v) return null;
  return missionId && v.missionId !== missionId ? null : v;
}

/** md: at and above it the deck is a dialog; below, it replaces the page. */
export const VISUAL_REVIEW_DIALOG_QUERY = '(min-width: 768px)';

function subscribeWide(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(VISUAL_REVIEW_DIALOG_QUERY);
  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}
const readWide = () => typeof window !== 'undefined' && !!window.matchMedia?.(VISUAL_REVIEW_DIALOG_QUERY).matches;

/** A stand-in the hook can hold while there is no audit; never rendered. */
function emptyModel(missionId: string): VisualReviewModel {
  return {
    missionId,
    phase: 'off',
    progress: null,
    audit: null,
    bootFailure: null,
    roundCapOpen: false,
    needsYou: null,
    cells: [],
    queue: [],
    summary: {
      shots: 0, ok: 0, issues: 0, unsure: 0, effectiveOk: 0, effectiveIssues: 0, reviewed: 0, unreviewed: 0,
      awaitingHuman: 0, confirmed: 0, disputed: 0, waived: 0, rounds: 0, openFixes: 0,
    },
    fixTasks: [],
    generatedAt: new Date(0).toISOString(),
  };
}

const scroller = () => (typeof document === 'undefined' ? null : (document.querySelector('main') as HTMLElement | null));

export interface MissionVisualReviewProviderProps {
  missionId: string;
  /** The server's model. Null: no audit on this mission (nothing is provided). */
  visual: VisualReviewModel | null | undefined;
  /** Force the deck's layout; default dialog at md+, inline below. */
  reviewLayout?: VisualReviewLayout;
  /** Where decisions go. Default: the decisions route. A fixture passes its own. */
  transport?: VisualReviewTransport;
  children?: ReactNode;
}

export function MissionVisualReviewProvider({ missionId, visual, reviewLayout, transport, children }: MissionVisualReviewProviderProps) {
  const router = useRouter();
  const t = useMemo(() => transport ?? createHttpVisualReviewTransport(missionId), [transport, missionId]);
  const [fallback] = useState(() => emptyModel(missionId));
  const review = useVisualReviewDecisions(visual ?? fallback, t);
  const wide = useSyncExternalStore(subscribeWide, readWide, () => false);
  const layout: VisualReviewLayout = reviewLayout ?? (wide ? 'dialog' : 'sheet');
  const [deck, setDeck] = useState<{ startKey: string | null; compare: boolean } | null>(null);
  const savedScroll = useRef<number | null>(null);

  const openDeck = useCallback((startKey: string | null, opts: { compare?: boolean } = {}) => {
    if (layout === 'sheet') {
      // The inline deck takes the page's place: start it at the top, and
      // come back to where the reader was.
      const el = scroller();
      savedScroll.current = el?.scrollTop ?? (typeof window !== 'undefined' ? window.scrollY : 0);
      requestAnimationFrame(() => { el?.scrollTo?.(0, 0); if (typeof window !== 'undefined') window.scrollTo?.(0, 0); });
    }
    setDeck({ startKey, compare: opts.compare === true });
  }, [layout]);
  const closeDeck = useCallback(() => {
    setDeck(null);
    const y = savedScroll.current;
    savedScroll.current = null;
    if (y != null) requestAnimationFrame(() => { const el = scroller(); if (el) el.scrollTop = y; else window.scrollTo?.(0, y); });
  }, []);

  const refresh = useCallback(() => router.refresh(), [router]);
  const auditTaskId = visual?.audit?.id ?? null;
  const actions = useMemo(() => visualReviewPhaseActions({ missionId, auditTaskId, refresh }), [missionId, auditTaskId, refresh]);

  const value = useMemo<MissionVisualReviewValue | null>(() => (visual ? {
    missionId,
    model: review.model,
    openDeck,
    decide: review.decide,
    undo: review.undo,
    actions,
    layout,
  } : null), [visual, missionId, review.model, openDeck, review.decide, review.undo, actions, layout]);

  const deckEl = value && deck ? (
    <VisualReviewDeck
      key={`${deck.startKey ?? ''}:${deck.compare}`}
      model={value.model}
      layout={layout}
      open
      startKey={deck.startKey}
      initialCompare={deck.compare}
      onClose={closeDeck}
      onDecide={value.decide}
      onUndo={value.undo}
    />
  ) : null;

  if (deckEl && layout === 'sheet') {
    return (
      <Ctx.Provider value={value}>
        {/* Kept mounted (its state and scroll survive), out of sight. */}
        <div hidden>{children}</div>
        <div data-testid="mission-visual-review-inline">{deckEl}</div>
      </Ctx.Provider>
    );
  }
  return (
    <Ctx.Provider value={value}>
      {children}
      {deckEl}
    </Ctx.Provider>
  );
}

/**
 * Render with the mission's live visual review: the one from the page's
 * provider, else one made here from `visual`. `children` gets null when the
 * mission has no audit.
 */
export function WithMissionVisualReview({
  missionId,
  visual,
  reviewLayout,
  children,
}: {
  missionId: string;
  visual: VisualReviewModel | null | undefined;
  reviewLayout?: VisualReviewLayout;
  children: (review: MissionVisualReviewValue | null) => ReactNode;
}) {
  const ctx = useContext(Ctx);
  if (ctx && ctx.missionId === missionId) return <>{children(ctx)}</>;
  if (!visual) return <>{children(null)}</>;
  return (
    <MissionVisualReviewProvider missionId={missionId} visual={visual} reviewLayout={reviewLayout}>
      <Ctx.Consumer>{v => children(v)}</Ctx.Consumer>
    </MissionVisualReviewProvider>
  );
}

// ── The surfaces' blocks ────────────────────────────────────────────────────

/**
 * The parked auditor worker is already a Needs-you ask on the board (its task
 * is waiting), with its own answer buttons: the visual blocks then leave the
 * answering to that ask instead of offering it twice.
 */
function answeredElsewhere(model: VisualReviewModel, board: Pick<MissionBoardModel, 'needsYou'> | null): boolean {
  const taskId = model.bootFailure?.taskId ?? model.needsYou?.taskId ?? null;
  return !!taskId && !!board?.needsYou.includes(taskId);
}

/** The Tray with this page's actions. */
export function MissionVisualTray({
  review,
  board = null,
  columns = 'auto',
  hideLine = false,
  className = '',
}: {
  review: MissionVisualReviewValue;
  board?: Pick<MissionBoardModel, 'needsYou' | 'tasks'> | null;
  columns?: 'auto' | 'one' | 'fit';
  hideLine?: boolean;
  className?: string;
}) {
  const m = review.model;
  const boot = m.bootFailure;
  const answerOptions = boot ? board?.tasks[boot.taskId]?.waitingFor?.options : undefined;
  return (
    <VisualReviewTray
      model={m}
      onReview={k => review.openDeck(k)}
      actions={{
        onTurnOff: review.actions.onTurnOff,
        onSkip: review.actions.onSkip,
        onRetry: review.actions.onRetry,
        onAnswer: answeredElsewhere(m, board) ? undefined : review.actions.onAnswer,
        answerOptions: answerOptions && answerOptions.length > 0 ? answerOptions : undefined,
      }}
      columns={columns}
      hideLine={hideLine}
      className={className}
    />
  );
}

/**
 * The Ask beside the board's other asks. A worker question already has its
 * own ask (the waiting task), so this shows the unsure and round-cap asks,
 * and a question only where no board ask carries it.
 */
export function MissionVisualAsk({
  review,
  board = null,
  className = '',
}: {
  review: MissionVisualReviewValue;
  board?: Pick<MissionBoardModel, 'needsYou'> | null;
  className?: string;
}) {
  const m = review.model;
  if (m.phase !== 'needs_you') return null;
  if (m.needsYou?.reason === 'question' && answeredElsewhere(m, board)) return null;
  return (
    <VisualReviewAsk
      model={m}
      onReview={k => review.openDeck(k)}
      onAnswer={review.actions.onAnswer}
      className={className}
    />
  );
}
