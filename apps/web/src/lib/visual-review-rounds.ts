/**
 * One audit round's view of a mission's `VisualReviewModel`
 * (docs/design/visual-qa-human-review.md, "Where it shows": the task page and
 * the task sheet show the Tray for the audit's round, not a mixed-attempt grid).
 *
 * Pure and client-safe. The model is mission-wide: a cell's `current` is the
 * newest round that shot it. A round view keeps the cells that round shot,
 * with that round's entry current, so a round-1 audit's page never shows a
 * round-2 re-shoot, and a round-2 page never shows round-1 screens it did not
 * re-shoot. Decisions still go through the whole model (the hook holds it);
 * the view is display only.
 */
import type { HumanShotReview, VisualQaVerdict, VisualReviewCell, VisualReviewCellEntry, VisualReviewModel } from '@buildd/shared';
import { awaitingCapture, fixCheckDue, fixCheckOf, markerOf, queueRankOf } from './visual-review-model';

/** Rounds that shot at least one screen, latest first. */
export function visualReviewRounds(model: Pick<VisualReviewModel, 'cells'>): number[] {
  const rounds = new Set<number>();
  for (const c of model.cells) for (const h of c.history) rounds.add(h.round);
  return [...rounds].sort((a, b) => b - a);
}

/**
 * The round an audit task ran: from the shots it wrote, else (the latest audit,
 * no shots yet) the model's audit round. Null for any other task.
 */
export function visualReviewRoundOf(model: Pick<VisualReviewModel, 'cells' | 'audit'>, auditTaskId: string): number | null {
  for (const c of model.cells) {
    for (const h of c.history) if (h.shot.auditTaskId === auditTaskId) return h.round;
  }
  return model.audit?.id === auditTaskId ? model.audit.round : null;
}

function cellAt(cell: VisualReviewCell, entry: VisualReviewCellEntry, round: number): VisualReviewCell {
  const review = entry.review;
  const history = cell.history.filter(h => h.round <= round);
  const fixCheck = fixCheckOf(history);
  return {
    ...cell,
    current: entry,
    history,
    effectiveVerdict: review ? (review.decision === 'looks_right' ? 'ok' : 'issue') : entry.agentVerdict,
    marker: markerOf(review, fixCheck),
    needsHuman: entry.agentVerdict === 'unsure' && !review && fixCheck?.state !== 'awaiting_capture',
    fixCheck,
  };
}

/** The model as round `round` saw it. The latest round keeps the live phase; an earlier one is history. */
export function visualReviewForRound(model: VisualReviewModel, round: number): VisualReviewModel {
  const cells: VisualReviewCell[] = [];
  for (const c of model.cells) {
    const entry = c.history.find(h => h.round === round);
    if (entry) cells.push(cellAt(c, entry, round));
  }
  const order = new Map(model.cells.map((c, i) => [c.key, i]));
  const queue = cells
    .filter(c => !awaitingCapture(c))
    .sort((a, b) => queueRankOf(a) - queueRankOf(b) || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
    .map(c => c.key);
  const latest = Math.max(0, ...visualReviewRounds(model), model.audit?.round ?? 0);
  const count = (v: VisualQaVerdict) => cells.filter(c => c.current.agentVerdict === v).length;
  const effective = (v: VisualQaVerdict) => cells.filter(c => c.effectiveVerdict === v).length;
  const rel = (r: HumanShotReview['relation']) => cells.filter(c => c.current.review?.relation === r).length;
  const reviewed = cells.filter(c => c.current.review).length;
  const isLatest = round >= latest;
  return {
    ...model,
    phase: isLatest ? model.phase : 'reviewed',
    progress: isLatest ? model.progress : null,
    needsYou: isLatest ? model.needsYou : null,
    cells,
    queue,
    summary: {
      ...model.summary,
      shots: cells.length,
      ok: count('ok'),
      issues: count('issue'),
      unsure: count('unsure'),
      effectiveOk: effective('ok'),
      effectiveIssues: effective('issue'),
      reviewed,
      unreviewed: cells.length - reviewed,
      awaitingHuman: cells.filter(c => c.needsHuman).length,
      fixChecks: cells.filter(c => fixCheckDue(c) && !c.needsHuman).length,
      awaitingCapture: cells.filter(awaitingCapture).length,
      confirmed: rel('agree'),
      disputed: rel('dispute'),
      waived: rel('waive'),
      required: undefined,
      covered: undefined,
    },
  };
}

export interface VisualReviewRoundGroup {
  round: number;
  /** What the round shot, as it saw it (`visualReviewForRound`). */
  model: VisualReviewModel;
  /**
   * The round's screens a later round did not re-shoot, as the mission holds
   * them now: the ones a decision can still land on. Null when none are left.
   */
  deckModel: VisualReviewModel | null;
}

/** One group per round up to `uptoRound`, latest first (the task page's audit rounds). */
export function visualReviewRoundGroups(model: VisualReviewModel, uptoRound: number): VisualReviewRoundGroup[] {
  return visualReviewRounds(model)
    .filter(r => r <= uptoRound)
    .map((round) => {
      const view = visualReviewForRound(model, round);
      const currentKeys = new Set(model.cells.filter(c => c.current.round === round).map(c => c.key));
      const deckCells = model.cells.filter(c => currentKeys.has(c.key));
      const deckModel = deckCells.length > 0
        ? { ...model, cells: deckCells, queue: model.queue.filter(k => currentKeys.has(k)) }
        : null;
      return { round, model: view, deckModel };
    });
}
