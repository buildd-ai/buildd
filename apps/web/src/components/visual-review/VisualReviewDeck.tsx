'use client';

/**
 * The review deck (docs/design/visual-qa-human-review.md, part 2): the
 * visual audit's screens as a queue a human works through, on a phone first.
 *
 * - Order: the model's triage queue (unsure, issue, ok, already reviewed),
 *   one route at a time, its phone and desktop shots together. The order is
 *   fixed when the deck opens, so a decision never reshuffles what is next.
 * - Two buttons whatever the agent said, **Looks right** and **Needs fix**.
 *   What each does follows the agent's verdict (`verdictEffects`); the server
 *   derives it again and builds any fix title. Agreeing with an issue is one
 *   tap (an optional note from the toast); filing a fix opens a one-line note,
 *   prefilled with the finding only when the agent was unsure. On an issue,
 *   Looks right names what happens to the fix by its status (`effectCopy`).
 * - Also apply to the other viewport (named, with the agent's verdict when
 *   it differs), on by default when their verdicts match: one request, so one fix.
 * - Every decision shows a five-second Undo. At the end of the queue, one
 *   batch action accepts every screen the agent marked fine.
 * - Keys: Y looks right, N needs fix, J/K next and previous, C compare,
 *   U undo, Escape closes the note, then compare, then the deck.
 * - Phone: the image is width-fit and scrolls with the page, with no height
 *   cap. The two half-width buttons sit in a sticky bar inside the safe area.
 *   A horizontal swipe (40px) moves between routes, off while zoomed or
 *   comparing.
 * - `layout="dialog"` wraps it in the shared Dialog (full screen on a phone);
 *   `layout="sheet"` renders inline, for a host that is already a sheet.
 *
 * Transport-agnostic: `onDecide` and `onUndo` are usually
 * `useVisualReviewDecisions` (review-transport.ts), which applies
 * optimistically and rolls back.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  visualReviewRelation,
  type VisualQaVerdict,
  type VisualQaViewport,
  type VisualReviewCell,
  type VisualReviewDecision,
  type VisualReviewModel,
  type VisualReviewRelation,
} from '@buildd/shared';
import { findingIsStillThere } from '@buildd/core/visual-fix-label';
import Dialog from '@/components/ui/Dialog';
import { Kbd } from '@/components/KeyHints';
import { taskPageHref } from '@/lib/mission-task-href';
import ShotImage, { VERDICT_DOT, VIEWPORT_LABEL } from './ShotImage';
import VisualShotCompare, { FixStatus, fixTitleText } from './VisualShotCompare';
import { ReviewMarker } from './VisualReviewTray';
import { BTN_BASE, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, CHIP, groupCells, groupCellsOf, groupsInQueueOrder, type RouteGroup } from './review-ui';
import { chunkCells, type DecideInput, type DecideResult, type UndoResult } from './review-transport';

// ── Pure helpers ────────────────────────────────────────────────────────────

/** What each button means for this verdict (the design doc's table). */
export function verdictEffects(verdict: VisualQaVerdict): Record<VisualReviewDecision, VisualReviewRelation> {
  return { looks_right: visualReviewRelation(verdict, 'looks_right'), needs_fix: visualReviewRelation(verdict, 'needs_fix') };
}

/** The line under each button: what pressing it does. */
export const EFFECT_COPY: Record<VisualQaVerdict, Record<VisualReviewDecision, string>> = {
  ok: { looks_right: 'Agree with the agent', needs_fix: 'File a fix' },
  issue: { looks_right: 'Not a bug, drop the fix', needs_fix: 'Agree, keep the fix' },
  unsure: { looks_right: 'Fine as it is', needs_fix: 'File a fix' },
};

const FIX_OVER = new Set(['completed', 'cancelled', 'failed']);

/** Where the cell's fix is, as far as a waive can act on it (the decisions route's rule). */
export function fixStage(cell: VisualReviewCell): 'none' | 'pending' | 'running' | 'over' {
  const fix = cell.current.fixTask;
  if (!fix) return 'none';
  if (fix.mergedAt || FIX_OVER.has(fix.status)) return 'over';
  return fix.status === 'pending' ? 'pending' : 'running';
}

/**
 * The line under each button for this cell. On an issue, Looks right only
 * cancels a fix that has not started; a running fix is told to stop (a
 * guidance note), and a finished one is left alone.
 */
export function effectCopy(cell: VisualReviewCell): Record<VisualReviewDecision, string> {
  const verdict = cell.current.agentVerdict;
  if (verdict !== 'issue') return EFFECT_COPY[verdict];
  const stage = fixStage(cell);
  return {
    looks_right: stage === 'pending' ? 'Not a bug, drop the fix' : stage === 'running' ? 'Not a bug, tell the fix to stop' : 'Not a bug',
    needs_fix: stage === 'none' ? 'Agree with the agent' : 'Agree, keep the fix',
  };
}

/** What the server did with a fix, for the undo toast. */
function outcomeSuffix(r: Extract<DecideResult, { ok: true }>): string {
  if (r.cancelledFixTaskId) return ', fix dropped';
  if (r.guidanceTaskId) return ', running fix told to stop';
  return '';
}

const DECISION_WORDS: Record<VisualReviewDecision, string> = { looks_right: 'looks right', needs_fix: 'needs fix' };
const RELATION_WORDS: Record<VisualReviewRelation, string> = { agree: 'agreed', dispute: 'disagreed', waive: 'waived' };

export const SWIPE_THRESHOLD_PX = 40;

/** +1 next, -1 previous, 0 nothing. Horizontal only: the move must be mostly sideways. */
export function swipeStep({ dx, dy, zoomed = false, comparing = false }: { dx: number; dy: number; zoomed?: boolean; comparing?: boolean }): -1 | 0 | 1 {
  if (zoomed || comparing) return 0;
  if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}

// ── Props ───────────────────────────────────────────────────────────────────

export interface VisualReviewDeckProps {
  model: VisualReviewModel;
  layout?: 'dialog' | 'sheet';
  /** Dialog layout only. The sheet is open while mounted. */
  open?: boolean;
  onClose?: () => void;
  /** The cell to open on. Default: the head of the queue. */
  startKey?: string | null;
  /** Open with compare showing (the cell must have more than one round). */
  initialCompare?: boolean;
  onDecide: (input: DecideInput) => Promise<DecideResult>;
  onUndo: (reviewIds: readonly string[]) => Promise<UndoResult>;
  fixTaskHref?: (taskId: string) => string;
  /** How long Undo stays. Default five seconds. */
  undoMs?: number;
}

export default function VisualReviewDeck(props: VisualReviewDeckProps) {
  const { layout = 'dialog', open = true } = props;
  if (layout === 'dialog' && !open) return null;
  return <DeckInner {...props} layout={layout} />;
}

// ── The deck ────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  label: string;
  keys: string[];
  cells: VisualReviewCell[];
  decision: VisualReviewDecision;
  result: Promise<DecideResult>;
  at: { index: number; viewport: VisualQaViewport };
}

/** An optional note for a fix the reviewer already agreed with (sent as a re-decision). */
interface Guidance {
  cells: VisualReviewCell[];
  label: string;
  at: { index: number; viewport: VisualQaViewport };
}

const DIALOG_PANEL =
  'relative flex h-[100dvh] w-full flex-col overflow-y-auto overscroll-contain bg-surface-1 outline-none md:mx-6 md:h-auto md:max-h-[calc(100dvh-3rem)] md:max-w-[min(1200px,calc(100vw-3rem))] md:border-2 md:border-border-strong md:shadow-[var(--card-shadow)]';

function DeckInner({
  model,
  layout = 'dialog',
  onClose,
  startKey,
  initialCompare = false,
  onDecide,
  onUndo,
  fixTaskHref,
  undoMs = 5000,
}: VisualReviewDeckProps) {
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const hrefOf = useMemo(() => fixTaskHref ?? ((id: string) => taskPageHref({ taskId: id, missionId: model.missionId })), [fixTaskHref, model.missionId]);

  // The order is fixed at open; a group that appears later joins the end.
  const [snapshot] = useState(() => groupsInQueueOrder(model).map(g => g.key));
  const groups: RouteGroup[] = useMemo(() => {
    const byKey = new Map(groupCells(model.cells).map(g => [g.key, g]));
    const keys = [...snapshot.filter(k => byKey.has(k)), ...[...byKey.keys()].filter(k => !snapshot.includes(k))];
    return keys.map(k => byKey.get(k)!);
  }, [model.cells, snapshot]);
  const queueRank = useMemo(() => new Map(model.queue.map((k, i) => [k, i])), [model.queue]);

  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  const isDone = useCallback((c: VisualReviewCell) => !!c.current.review || decided.has(c.key), [decided]);

  const focusIn = useCallback((g: RouteGroup | undefined, prefer?: string | null): VisualQaViewport => {
    if (!g) return 'mobile';
    const cells = groupCellsOf(g);
    const preferred = prefer ? cells.find(c => c.key === prefer) : undefined;
    if (preferred) return preferred.viewport;
    const open = cells.filter(c => !isDone(c)).sort((a, b) => (queueRank.get(a.key) ?? 0) - (queueRank.get(b.key) ?? 0));
    return (open[0] ?? cells[0]).viewport;
  }, [isDone, queueRank]);

  const [pos, setPos] = useState(() => {
    const key = startKey ?? model.queue[0] ?? null;
    const cell = model.cells.find(c => c.key === key);
    const index = cell ? Math.max(0, groups.findIndex(g => groupCellsOf(g).some(c => c.key === cell.key))) : 0;
    return { index, viewport: cell?.viewport ?? focusIn(groups[index]) };
  });
  const atEnd = pos.index >= groups.length;
  const group = atEnd ? undefined : groups[pos.index];
  const focused = group ? (group[pos.viewport] ?? groupCellsOf(group)[0]) : undefined;
  const sibling = group && focused ? groupCellsOf(group).find(c => c.key !== focused.key) : undefined;

  const [note, setNote] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [applyBoth, setApplyBoth] = useState<boolean | null>(null);
  const [comparing, setComparing] = useState(initialCompare && !!focused && focused.history.length > 1);
  const [zoomed, setZoomed] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const toastSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const bothDefault = !!sibling && !isDone(sibling) && sibling.current.agentVerdict === focused?.current.agentVerdict;
  // Offered only while neither viewport has a decision; re-deciding one screen never touches the other.
  const canApplyBoth = !!sibling && !!focused && !isDone(sibling) && !isDone(focused);
  const both = canApplyBoth && (applyBoth ?? bothDefault);

  const go = useCallback((index: number, prefer?: string | null) => {
    const i = Math.max(0, Math.min(groups.length, index));
    setPos({ index: i, viewport: focusIn(groups[i], prefer) });
    setNote(null); setGuidance(null);
    setApplyBoth(null);
    setComparing(false);
    setZoomed(false);
  }, [groups, focusIn]);
  const next = useCallback(() => go(pos.index + 1), [go, pos.index]);
  const prev = useCallback(() => go(pos.index - 1), [go, pos.index]);

  // Undo stays for `undoMs`.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(cur => (cur?.id === toast.id ? null : cur)), undoMs);
    return () => clearTimeout(t);
  }, [toast, undoMs]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  /** The next place after deciding `keys` at the current position. */
  const advanceAfter = useCallback((keys: ReadonlySet<string>) => {
    const done = (c: VisualReviewCell) => isDone(c) || keys.has(c.key);
    const here = groups[pos.index];
    const rest = here ? groupCellsOf(here).find(c => !done(c)) : undefined;
    if (rest) {
      setPos({ index: pos.index, viewport: rest.viewport });
      setNote(null); setGuidance(null);
      setApplyBoth(null);
      setComparing(false);
      setZoomed(false);
      return;
    }
    const open = (g: RouteGroup) => groupCellsOf(g).some(c => !done(c));
    let target = groups.findIndex((g, i) => i > pos.index && open(g));
    if (target < 0) target = groups.findIndex(open);
    go(target < 0 ? groups.length : target);
  }, [groups, pos.index, isDone, go]);

  const submit = useCallback((cells: VisualReviewCell[], decision: VisualReviewDecision, noteText: string | undefined, label: string, from: { index: number; viewport: VisualQaViewport }) => {
    const keys = cells.map(c => c.key);
    setDecided(prev => new Set([...prev, ...keys]));
    setNotice(null);
    setFlash(null);
    const chunks = chunkCells(cells);
    const result: Promise<DecideResult> = (async () => {
      const ids: string[] = [];
      let last: DecideResult | null = null;
      for (const chunk of chunks) {
        const r = await onDecide({ cells: chunk, decision, ...(noteText !== undefined ? { note: noteText } : {}) });
        if (!r.ok) return r;
        ids.push(...r.reviewIds);
        last = r;
      }
      return last && last.ok ? { ...last, reviewIds: ids } : { ok: false as const, reason: 'error' as const, message: 'Nothing was saved.' };
    })();
    const id = ++toastSeq.current;
    setToast({ id, label, keys, cells, decision, result, at: from });
    void result.then((r) => {
      if (!mounted.current) return;
      if (r.ok) {
        // Say what the server actually did with the fix.
        const suffix = outcomeSuffix(r);
        if (suffix) setToast(cur => (cur?.id === id ? { ...cur, label: `${cur.label}${suffix}` } : cur));
        return;
      }
      setDecided(prev => { const s = new Set(prev); keys.forEach(k => s.delete(k)); return s; });
      setToast(cur => (cur?.id === id ? null : cur));
      setNotice(r.message);
      setPos(from);
      setNote(null); setGuidance(null);
    });
    return new Set(keys);
  }, [onDecide]);

  const decide = useCallback((decision: VisualReviewDecision, noteText?: string) => {
    if (!focused) return;
    const cells = both && sibling ? [focused, sibling] : [focused];
    const where = `${focused.route} ${cells.length > 1 ? 'both' : VIEWPORT_LABEL[focused.viewport].toLowerCase()}`;
    const extra = decision === 'needs_fix' && focused.current.agentVerdict !== 'issue' ? ', fix filed' : '';
    const keys = submit(cells, decision, noteText, `${where}: ${DECISION_WORDS[decision]}${extra}`, { index: pos.index, viewport: focused.viewport });
    advanceAfter(keys);
  }, [focused, sibling, both, submit, advanceAfter, pos.index]);

  /**
   * Needs fix. Agreeing with an issue is one tap: the fix exists, a note is
   * optional (from the toast). Filing a fix opens the one-line note, prefilled
   * with the finding only when the agent was unsure (an ok finding says what
   * is right, not what to change).
   */
  const needsFix = useCallback(() => {
    if (!focused) return;
    if (focused.current.agentVerdict === 'issue') { decide('needs_fix'); return; }
    setGuidance(null);
    setNote(focused.current.agentVerdict === 'unsure' ? focused.current.finding : '');
  }, [focused, decide]);

  /** Add guidance to the fix just agreed with: back to that screen, an empty note. */
  const addNote = useCallback(() => {
    const t = toast;
    if (!t) return;
    setToast(null);
    setPos(t.at);
    setComparing(false);
    setZoomed(false);
    setGuidance({ cells: t.cells, label: t.label, at: t.at });
    setNote('');
  }, [toast]);

  const submitNote = useCallback((text: string) => {
    setNote(null);
    const g = guidance;
    setGuidance(null);
    if (g) {
      // A re-decision with the note: the server supersedes and appends it as guidance.
      submit(g.cells, 'needs_fix', text, `${g.label}, note added`, g.at);
      advanceAfter(new Set(g.cells.map(c => c.key)));
      return;
    }
    decide('needs_fix', text);
  }, [guidance, submit, advanceAfter, decide]);

  const closeNote = useCallback(() => { setNote(null); setGuidance(null); }, []);

  const okLeft = useMemo(() => model.cells.filter(c => !isDone(c) && c.current.agentVerdict === 'ok'), [model.cells, isDone]);
  const othersLeft = useMemo(() => model.cells.filter(c => !isDone(c) && c.current.agentVerdict !== 'ok'), [model.cells, isDone]);
  const acceptAll = useCallback(() => {
    if (okLeft.length === 0) return;
    submit(okLeft, 'looks_right', undefined, `Accepted ${okLeft.length} screen${okLeft.length === 1 ? '' : 's'}`, { index: pos.index, viewport: pos.viewport });
    go(groups.length);
  }, [okLeft, submit, pos, go, groups.length]);

  const undo = useCallback(async () => {
    const t = toast;
    if (!t) return;
    setToast(null);
    const r = await t.result;
    if (!r.ok || !mounted.current) return;
    const u = await onUndo(r.reviewIds);
    if (!mounted.current) return;
    if (u.ok) {
      setDecided(prev => { const s = new Set(prev); t.keys.forEach(k => s.delete(k)); return s; });
      setPos(t.at);
      setNote(null); setGuidance(null);
      setComparing(false);
      setFlash('Undone.');
    } else {
      setNotice(u.message);
    }
  }, [toast, onUndo]);

  const toggleCompare = useCallback(() => {
    if (!focused || focused.history.length < 2) return;
    setComparing(c => !c);
    setZoomed(false);
  }, [focused]);

  // Keys. Typing in the note is never a shortcut.
  const keyState = useRef({ decide, needsFix, next, prev, toggleCompare, undo, note, closeNote, comparing, atEnd, onClose, layout, focused });
  keyState.current = { decide, needsFix, next, prev, toggleCompare, undo, note, closeNote, comparing, atEnd, onClose, layout, focused };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = keyState.current;
      if (e.key === 'Escape') {
        if (s.note !== null) { e.preventDefault(); s.closeNote(); return; }
        if (s.comparing) { e.preventDefault(); setComparing(false); return; }
        if (s.layout === 'sheet' && s.onClose) { e.preventDefault(); s.onClose(); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (s.note !== null) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const act = (fn: () => void) => { e.preventDefault(); fn(); };
      if ((k === 'y') && s.focused && !s.atEnd) act(() => s.decide('looks_right'));
      else if (k === 'n' && s.focused && !s.atEnd) act(s.needsFix);
      else if (k === 'j' || k === 'ArrowRight') act(s.next);
      else if (k === 'k' || k === 'ArrowLeft') act(s.prev);
      else if (k === 'c') act(s.toggleCompare);
      else if (k === 'u') act(() => { void s.undo(); });
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Swipe between routes on the image.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const pinchZoomed = () => typeof window !== 'undefined' && (window.visualViewport?.scale ?? 1) > 1.01;
  const swipe = {
    onPointerDown: (e: React.PointerEvent) => {
      swiped.current = false;
      swipeStart.current = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: React.PointerEvent) => {
      const s = swipeStart.current;
      swipeStart.current = null;
      if (!s) return;
      const step = swipeStep({ dx: e.clientX - s.x, dy: e.clientY - s.y, zoomed: zoomed || pinchZoomed(), comparing });
      if (step !== 0) {
        swiped.current = true;
        if (step > 0) next(); else prev();
      }
    },
    onPointerCancel: () => { swipeStart.current = null; },
  };

  const reviewedCount = model.cells.filter(isDone).length;
  const total = model.cells.length;
  const s = model.summary;

  const header = (
    <header className="sticky top-0 z-20 border-b-2 border-border-strong bg-surface-1 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] md:px-6 md:pt-4">
      <div className="flex items-center gap-2">
        <p data-testid="deck-progress" className="font-mono text-[12px] font-semibold uppercase tracking-[1.5px] text-text-secondary">
          {`${reviewedCount} of ${total} reviewed`}
        </p>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" data-testid="deck-prev" aria-label="Previous route" disabled={pos.index === 0} onClick={prev} className={`${BTN_BASE} ${BTN_GHOST} h-10 w-10 text-[16px]`}>
            ‹<Kbd className="sr-only">K</Kbd>
          </button>
          <button type="button" data-testid="deck-next" aria-label="Next route" disabled={atEnd} onClick={next} className={`${BTN_BASE} ${BTN_GHOST} h-10 w-10 text-[16px]`}>
            ›
          </button>
          {onClose && (
            <button type="button" data-testid="deck-close" aria-label="Close review" onClick={onClose} className={`${BTN_BASE} ${BTN_SECONDARY} h-10 w-10 text-[18px] leading-none`}>
              ×
            </button>
          )}
        </span>
      </div>
      <div aria-hidden="true" className="mt-2 h-[3px] w-full bg-surface-3">
        <div className="h-full bg-text-primary transition-[width]" style={{ width: `${total ? (reviewedCount / total) * 100 : 0}%` }} />
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
        <h2 id={titleId} data-testid="deck-route" className="min-w-0 break-all font-mono text-[17px] font-semibold leading-tight text-text-primary md:text-[19px]">
          {group ? group.route : 'End of the queue'}
        </h2>
        {group?.variant && <span className={CHIP}>{group.variant}</span>}
        {focused && <span data-testid="deck-round" className={CHIP}>Round {focused.current.round}</span>}
        {focused && focused.history.length > 1 && (
          <button
            type="button"
            data-testid="deck-compare"
            aria-pressed={comparing}
            onClick={toggleCompare}
            className={`${BTN_BASE} min-h-9 px-2.5 text-[12px] ${comparing ? 'border-text-primary bg-text-primary text-surface-1' : BTN_SECONDARY}`}
          >
            {comparing ? 'Close compare' : `Compare rounds`}<Kbd>C</Kbd>
          </button>
        )}
      </div>
    </header>
  );

  const body = atEnd ? (
    <EndOfQueue
      okLeft={okLeft.length}
      othersLeft={othersLeft.length}
      summary={s}
      onAcceptAll={acceptAll}
      onBack={() => { const i = groups.findIndex(g => groupCellsOf(g).some(c => !isDone(c))); go(i < 0 ? 0 : i); }}
      onClose={onClose}
    />
  ) : comparing && focused ? (
    <div className="px-4 py-4 md:px-6">
      <VisualShotCompare cell={focused} fixTaskHref={hrefOf} />
    </div>
  ) : group && focused ? (
    <div className="flex flex-col gap-4 px-4 py-4 md:px-6">
      {sibling && (
        <div role="group" aria-label="Viewport" data-testid="deck-viewport-toggle" className="grid grid-cols-2 border-2 border-border-strong md:hidden">
          {groupCellsOf(group).map(c => (
            <button
              key={c.key}
              type="button"
              data-testid={`deck-viewport-${c.viewport}`}
              aria-pressed={c.key === focused.key}
              onClick={() => { setPos({ index: pos.index, viewport: c.viewport }); setZoomed(false); closeNote(); }}
              className={`flex min-h-11 items-center justify-center gap-2 font-mono text-[13px] font-semibold ${c.key === focused.key ? 'bg-text-primary text-surface-1' : 'bg-surface-2 text-text-secondary'}`}
            >
              <i aria-hidden="true" className={`inline-block h-2.5 w-2.5 ${VERDICT_DOT[c.effectiveVerdict]}`} />
              {VIEWPORT_LABEL[c.viewport]}
              {isDone(c) && <span className="font-normal">✓</span>}
            </button>
          ))}
        </div>
      )}
      <div className={sibling ? 'md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,5fr)] md:items-start md:gap-6' : 'md:mx-auto md:w-full md:max-w-[760px]'}>
        {groupCellsOf(group).map(c => (
          <ShotPanel
            key={c.key}
            cell={c}
            focused={c.key === focused.key}
            paired={!!sibling}
            done={isDone(c)}
            zoomed={zoomed && c.key === focused.key}
            onFocus={() => setPos({ index: pos.index, viewport: c.viewport })}
            onImageClick={() => { if (swiped.current) { swiped.current = false; return; } setZoomed(z => !z); }}
            swipe={swipe}
            fixTaskHref={hrefOf}
          />
        ))}
      </div>
    </div>
  ) : null;

  const effects = focused ? verdictEffects(focused.current.agentVerdict) : null;
  const copy = focused ? effectCopy(focused) : null;
  const primary: VisualReviewDecision | null = focused
    ? focused.current.agentVerdict === 'ok' ? 'looks_right' : focused.current.agentVerdict === 'issue' ? 'needs_fix' : null
    : null;
  // The note either files a fix (ok or unsure) or adds guidance to one you agreed with.
  const filesFix = !!focused && !guidance && focused.current.agentVerdict !== 'issue';
  const noteRequired = filesFix && focused!.current.agentVerdict === 'ok';

  const bar = (
    <div
      data-testid="deck-actions"
      className="sticky bottom-0 z-20 mt-auto border-t-2 border-border-strong bg-surface-1 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 md:px-6"
    >
      <div className="mx-auto flex max-w-[760px] flex-col gap-2.5">
        {notice && (
          <p role="alert" data-testid="deck-notice" className="border-l-[3px] border-status-error bg-surface-2 py-2 pl-3 pr-2 font-mono text-[12px] text-text-primary">
            {notice}
          </p>
        )}
        {(toast || flash) && (
          <div role="status" data-testid="deck-toast" className="flex min-h-11 items-center justify-between gap-3 border-2 border-border-strong bg-surface-3 py-1 pl-3 pr-1">
            <span data-testid="deck-toast-label" className="min-w-0 break-words py-1 font-mono text-[12px] leading-snug text-text-primary">{toast ? toast.label : flash}</span>
            {toast && (
              <span className="flex shrink-0 gap-1">
                {toast.decision === 'needs_fix' && toast.cells.every(c => c.current.agentVerdict === 'issue') && (
                  <button type="button" data-testid="deck-add-note" onClick={addNote} className={`${BTN_BASE} ${BTN_GHOST} min-h-9 shrink-0 px-2.5 text-[12px]`}>
                    Add a note
                  </button>
                )}
                <button type="button" data-testid="deck-undo" onClick={() => void undo()} className={`${BTN_BASE} ${BTN_SECONDARY} min-h-9 shrink-0 px-3 text-[12px]`}>
                  Undo<Kbd>U</Kbd>
                </button>
              </span>
            )}
          </div>
        )}
        {!atEnd && focused && othersLeft.length === 0 && okLeft.length > 1 && !isDone(focused) && note === null && (
          <div className="flex items-center justify-between gap-3 font-mono text-[12px] text-text-secondary">
            <span>Only screens the agent marked fine are left.</span>
            <button type="button" data-testid="deck-accept-rest" onClick={acceptAll} className={`${BTN_BASE} ${BTN_SECONDARY} min-h-9 shrink-0 px-3 text-[12px]`}>
              Accept all {okLeft.length}
            </button>
          </div>
        )}
        {!atEnd && focused && sibling && canApplyBoth && note === null && (
          <label className="flex min-h-9 cursor-pointer items-center gap-2.5 font-mono text-[12px] text-text-secondary">
            <input
              type="checkbox"
              data-testid="deck-apply-both"
              checked={both}
              onChange={e => setApplyBoth(e.target.checked)}
              style={{ accentColor: 'var(--text-primary)' }}
              className="h-5 w-5"
            />
            <span>
              {`Also apply to ${VIEWPORT_LABEL[sibling.viewport].toLowerCase()}`}
              {sibling.current.agentVerdict !== focused.current.agentVerdict && (
                <span className="text-text-muted">{` (agent: ${sibling.current.agentVerdict})`}</span>
              )}
            </span>
          </label>
        )}
        {!atEnd && focused && note !== null && (
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => { e.preventDefault(); if (noteRequired && !note.trim()) return; submitNote(note); }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="section-label">{filesFix ? 'What should the fix change?' : 'A note for the fix'}</span>
              <input
                autoFocus
                data-testid="deck-note"
                value={note}
                onChange={e => setNote(e.target.value)}
                onFocus={e => e.currentTarget.select()}
                placeholder={filesFix ? 'One line for the fix task' : 'Guidance for the fix task'}
                className="min-h-12 w-full border-2 border-border-strong bg-surface-2 px-3 font-mono text-base text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none md:text-[13px]"
              />
            </label>
            <div className="flex gap-2">
              <button type="button" data-testid="deck-note-cancel" onClick={closeNote} className={`${BTN_BASE} ${BTN_SECONDARY} min-h-12 basis-1/2 text-[14px]`}>
                Cancel
              </button>
              <button
                type="submit"
                data-testid="deck-note-submit"
                disabled={filesFix && !note.trim() && (noteRequired || !focused.current.finding.trim())}
                className={`${BTN_BASE} ${BTN_PRIMARY} min-h-12 basis-1/2 text-[14px]`}
              >
                {filesFix ? 'File the fix' : 'Send the note'}
              </button>
            </div>
          </form>
        )}
        {!atEnd && focused && effects && note === null && (
          <div className="flex gap-2">
            <DecisionButton
              testId="deck-needs-fix"
              label="Needs fix"
              hint="N"
              effect={effects.needs_fix}
              copy={copy!.needs_fix}
              primary={primary === 'needs_fix'}
              onClick={needsFix}
            />
            <DecisionButton
              testId="deck-looks-right"
              label="Looks right"
              hint="Y"
              effect={effects.looks_right}
              copy={copy!.looks_right}
              primary={primary === 'looks_right'}
              onClick={() => decide('looks_right')}
            />
          </div>
        )}
      </div>
    </div>
  );

  const deck = (
    <section
      data-testid="visual-review-deck"
      data-layout={layout}
      data-focused={focused?.key ?? ''}
      data-swipe={comparing || zoomed ? 'off' : 'on'}
      data-undo-ms={String(undoMs)}
      aria-labelledby={titleId}
      ref={sectionRef}
      tabIndex={-1}
      className={`flex flex-col bg-surface-1 outline-none text-text-primary ${layout === 'sheet' ? 'min-h-[100dvh]' : 'min-h-full'}`}
    >
      {header}
      <div className="flex-1">{body}</div>
      {bar}
    </section>
  );

  if (layout === 'sheet') return deck;
  return (
    <Dialog open onClose={onClose ?? (() => {})} labelledBy={titleId} initialFocusRef={sectionRef} dismissible={note === null && !comparing} className={DIALOG_PANEL}>
      {deck}
    </Dialog>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function DecisionButton({ testId, label, hint, effect, copy, primary, onClick }: {
  testId: string; label: string; hint: string; effect: VisualReviewRelation; copy: string; primary: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-effect={effect}
      onClick={onClick}
      className={`${BTN_BASE} ${primary ? BTN_PRIMARY : BTN_SECONDARY} min-h-12 basis-1/2 flex-col gap-0.5 px-2 py-2`}
    >
      <span className="flex items-center gap-2 text-[15px] leading-none">{label}<Kbd tone={primary ? 'accent' : 'default'}>{hint}</Kbd></span>
      <span className={`text-[11px] font-normal leading-tight ${primary ? 'text-white/90' : 'text-text-secondary'}`}>{copy}</span>
    </button>
  );
}

function ShotPanel({ cell, focused, paired, done, zoomed, onFocus, onImageClick, swipe, fixTaskHref }: {
  cell: VisualReviewCell;
  focused: boolean;
  paired: boolean;
  done: boolean;
  zoomed: boolean;
  onFocus: () => void;
  onImageClick: () => void;
  swipe: Record<string, (e: React.PointerEvent) => void>;
  fixTaskHref: (id: string) => string;
}) {
  const entry = cell.current;
  const review = entry.review;
  const fix = entry.fixTask;
  return (
    <article
      data-testid="deck-shot"
      data-viewport={cell.viewport}
      data-focused-shot={focused ? 'true' : 'false'}
      className={`${focused ? 'flex' : 'hidden'} min-w-0 flex-col gap-3 md:flex ${paired && focused ? 'md:outline md:outline-2 md:outline-offset-4 md:outline-text-primary' : ''}`}
    >
      <button
        type="button"
        onClick={onFocus}
        tabIndex={paired ? 0 : -1}
        className="order-1 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 text-left"
      >
        <span className={`${paired ? 'hidden md:inline' : ''} font-mono text-[12px] font-semibold uppercase tracking-[1.5px] text-text-primary`}>{VIEWPORT_LABEL[cell.viewport]}</span>
        <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-text-secondary">
          <i aria-hidden="true" className={`inline-block h-2.5 w-2.5 ${VERDICT_DOT[entry.agentVerdict]}`} />
          Agent: {entry.agentVerdict}
        </span>
        {(review || done) && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-text-secondary">
            <ReviewMarker marker={review ? cell.marker : 'confirmed'} />
            {review ? `You: ${DECISION_WORDS[review.decision]}, ${RELATION_WORDS[review.relation]}` : 'Saving'}
          </span>
        )}
      </button>

      <div
        {...swipe}
        onClick={onImageClick}
        style={{ touchAction: zoomed ? 'auto' : 'pan-y pinch-zoom' }}
        className={`order-4 border-2 ${entry.agentVerdict === 'issue' ? 'border-status-error' : 'border-border-strong'} bg-surface-3 ${zoomed ? 'overflow-auto cursor-zoom-out' : 'cursor-zoom-in'}`}
      >
        <ShotImage
          shot={entry.shot}
          alt={`${cell.route} on ${VIEWPORT_LABEL[cell.viewport].toLowerCase()}, round ${entry.round}`}
          large
          eager={focused}
          className={zoomed ? 'block h-auto w-[200%] max-w-none' : 'block h-auto w-full md:mx-auto md:max-h-[56vh] md:w-auto md:max-w-full'}
        />
      </div>

      <div className="order-2">
        <p className="section-label mb-1.5">Finding</p>
        <p data-testid="deck-finding" className={`border-l-[3px] ${entry.agentVerdict === 'issue' ? 'border-status-error' : entry.agentVerdict === 'unsure' ? 'border-status-info' : 'border-status-success'} py-0.5 pl-3 text-[15px] leading-[1.5] text-text-primary`}>
          {entry.finding}
        </p>
        {review?.note && <p className="mt-2 pl-3 text-[13px] text-text-secondary">Your note: {review.note}</p>}
      </div>

      {fix && (
        <div data-testid="deck-fix" className="order-3 flex flex-col gap-1 border-2 border-border-default bg-surface-2 px-3 py-2.5">
          <p className="flex items-center gap-2">
            <span className="section-label">{fix.origin === 'human' ? 'Your fix' : 'Fix task'}</span>
            <FixStatus fix={fix} stillPresent={entry.agentVerdict === 'issue' && findingIsStillThere(entry.finding)} />
          </p>
          <a href={fixTaskHref(fix.id)} className="text-[14px] leading-[1.4] text-text-primary underline decoration-border-strong underline-offset-2 hover:text-accent-text">
            {fixTitleText(fix.title, cell.route)}
          </a>
          {fix.prUrl && (
            <a href={fix.prUrl} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-accent-text underline underline-offset-2">
              PR #{fix.prNumber ?? ''}{fix.mergedAt ? ', merged' : ''}
            </a>
          )}
        </div>
      )}
    </article>
  );
}

function EndOfQueue({ okLeft, othersLeft, summary, onAcceptAll, onBack, onClose }: {
  okLeft: number;
  othersLeft: number;
  summary: VisualReviewModel['summary'];
  onAcceptAll: () => void;
  onBack: () => void;
  onClose?: () => void;
}) {
  const allDone = okLeft === 0 && othersLeft === 0;
  const heading = allDone
    ? 'Every screen has a decision'
    : othersLeft > 0
      ? `${othersLeft} screen${othersLeft === 1 ? '' : 's'} still need${othersLeft === 1 ? 's' : ''} a look`
      : `${okLeft} left, all marked fine by the agent`;
  const decidedParts = [
    summary.confirmed ? `agreed with ${summary.confirmed}` : null,
    summary.disputed ? `disagreed with ${summary.disputed}` : null,
    summary.waived ? `waived ${summary.waived}` : null,
  ].filter(Boolean);
  return (
    <div data-testid="deck-end" className="mx-auto flex max-w-[560px] flex-col gap-5 px-4 py-8 md:px-6 md:py-12">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[20px] font-semibold leading-tight text-text-primary">{heading}</p>
        {decidedParts.length > 0 && <p className="text-[14px] text-text-secondary">So far you {decidedParts.join(', ')}.</p>}
      </div>
      {okLeft > 0 && (
        <button
          type="button"
          data-testid="deck-accept-all"
          onClick={onAcceptAll}
          className={`${BTN_BASE} ${othersLeft === 0 ? BTN_PRIMARY : BTN_SECONDARY} min-h-12 w-full px-4 text-[15px]`}
        >
          {`Accept all ${okLeft} the agent marked fine`}
        </button>
      )}
      <div className="flex gap-2">
        {!allDone && (
          <button type="button" data-testid="deck-back" onClick={onBack} className={`${BTN_BASE} ${othersLeft > 0 ? BTN_PRIMARY : BTN_SECONDARY} min-h-12 basis-1/2 flex-1 text-[14px]`}>
            {othersLeft > 0 ? 'Go to the next one' : 'Look through them'}
          </button>
        )}
        {onClose && (
          <button type="button" data-testid="deck-done" onClick={onClose} className={`${BTN_BASE} ${allDone ? BTN_PRIMARY : BTN_SECONDARY} min-h-12 basis-1/2 flex-1 text-[14px]`}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
