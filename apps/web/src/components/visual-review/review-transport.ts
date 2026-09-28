'use client';

/**
 * How a human judgement leaves the review surfaces
 * (docs/design/visual-qa-human-review.md, part 1).
 *
 * - The transport: `POST /api/missions/[id]/visual-review/decisions` and
 *   `DELETE …/decisions/[reviewId]` (the undo), with the shared request and
 *   response types. The client sends artifact ids, the decision, a note and
 *   the agent verdicts it saw; the server derives the relation and builds any
 *   fix title. A fixture or the in-process chat API can stand in through the
 *   same `VisualReviewTransport` interface.
 * - `useVisualReviewDecisions`: optimistic apply with rollback. The view is
 *   always the last server model with the in-flight decisions laid over it,
 *   so a slow response never erases a later tap. A 409 stale adopts the
 *   model the server returned (the cell re-renders fresh) and is not retried.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  VISUAL_REVIEW_MAX_ARTIFACTS,
  visualReviewRelation,
  type HumanShotReview,
  type VisualReviewCell,
  type VisualReviewDecision,
  type VisualReviewDecisionError,
  type VisualReviewDecisionRequest,
  type VisualReviewDecisionResponse,
  type VisualReviewMarker,
  type VisualReviewModel,
  type VisualReviewUndoResponse,
} from '@buildd/shared';

// ── Requests ────────────────────────────────────────────────────────────────

export interface DecideInput {
  /** The cells decided together (both viewports of a route: one fix). */
  cells: readonly VisualReviewCell[];
  decision: VisualReviewDecision;
  note?: string;
}

const enc = encodeURIComponent;

export function visualReviewDecisionsUrl(missionId: string): string {
  return `/api/missions/${enc(missionId)}/visual-review/decisions`;
}

export function visualReviewUndoUrl(missionId: string, reviewId: string): string {
  return `${visualReviewDecisionsUrl(missionId)}/${enc(reviewId)}`;
}

/** The shared `VisualReviewDecisionRequest` for a decision. Throws on 0 or more than the limit. */
export function buildDecisionRequest(input: DecideInput): VisualReviewDecisionRequest {
  const artifactIds: string[] = [];
  const expected: Record<string, VisualReviewCell['current']['agentVerdict']> = {};
  for (const c of input.cells) {
    const id = c.current.shot.id;
    if (id in expected) continue;
    artifactIds.push(id);
    expected[id] = c.current.agentVerdict;
  }
  if (artifactIds.length === 0) throw new Error('A decision needs at least one screen.');
  if (artifactIds.length > VISUAL_REVIEW_MAX_ARTIFACTS) {
    throw new Error(`A decision covers at most ${VISUAL_REVIEW_MAX_ARTIFACTS} screens.`);
  }
  const note = input.note?.trim();
  return { artifactIds, decision: input.decision, ...(note ? { note } : {}), expected };
}

/** Split a batch (accept all) into requests the route accepts. */
export function chunkCells<T>(cells: readonly T[], size = VISUAL_REVIEW_MAX_ARTIFACTS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < cells.length; i += size) out.push(cells.slice(i, i + size));
  return out;
}

export type VisualReviewStaleBody = Extract<VisualReviewDecisionError, { error: 'stale' }>;

/** A failed decision or undo, with the server's body kept. */
export class VisualReviewRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? errorMessage(status, body));
    this.name = 'VisualReviewRequestError';
    this.status = status;
    this.body = body;
  }
  /** `stale`, `fix_started`, `round_ceiling`, `not_in_mission`, or another server code. */
  get code(): string | null {
    const b = this.body as { error?: unknown } | null;
    return b && typeof b.error === 'string' ? b.error : null;
  }
  /** The 409 stale body, with the fresh model. */
  get stale(): VisualReviewStaleBody | null {
    const b = this.body as Partial<VisualReviewStaleBody> | null;
    return this.status === 409 && b && b.error === 'stale' && b.model ? (b as VisualReviewStaleBody) : null;
  }
}

function errorMessage(status: number, body: unknown): string {
  const b = body as { error?: unknown; message?: unknown } | null;
  if (b && typeof b.message === 'string' && b.message) return b.message;
  switch (b?.error) {
    case 'stale': return 'This screen changed while you looked. It is shown fresh now.';
    case 'fix_started': return 'The fix has already started, so this cannot be undone here.';
    case 'round_ceiling': return 'This mission has had its last audit round. Open a task by hand.';
    case 'not_in_mission': return 'These screens are not part of this mission.';
  }
  if (b && typeof b.error === 'string' && b.error) return b.error;
  return status >= 500 ? 'The server could not save that. Try again.' : `Request failed (${status}).`;
}

/** Where decisions go. `createHttpVisualReviewTransport` in the app; a fixture in dev. */
export interface VisualReviewTransport {
  decide(req: VisualReviewDecisionRequest): Promise<VisualReviewDecisionResponse>;
  undo(reviewId: string): Promise<VisualReviewUndoResponse>;
}

export function createHttpVisualReviewTransport(missionId: string, fetchImpl: typeof fetch = fetch): VisualReviewTransport {
  async function call<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetchImpl(url, init);
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) throw new VisualReviewRequestError(res.status, body);
    return body as T;
  }
  return {
    decide: req => call<VisualReviewDecisionResponse>(visualReviewDecisionsUrl(missionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }),
    undo: reviewId => call<VisualReviewUndoResponse>(visualReviewUndoUrl(missionId, reviewId), { method: 'DELETE' }),
  };
}

// ── Optimistic model edits (pure) ───────────────────────────────────────────

function markerOf(review: HumanShotReview | null): VisualReviewMarker {
  if (!review) return 'awaiting';
  return review.relation === 'agree' ? 'confirmed' : review.relation === 'dispute' ? 'disputed' : 'waived';
}

function withReview(cell: VisualReviewCell, review: HumanShotReview | null): VisualReviewCell {
  const current = { ...cell.current, review };
  const history = cell.history.map(h => (h.shot.id === current.shot.id ? current : h));
  return {
    ...cell,
    current,
    history,
    marker: markerOf(review),
    effectiveVerdict: review ? (review.decision === 'looks_right' ? 'ok' : 'issue') : current.agentVerdict,
    needsHuman: current.agentVerdict === 'unsure' && !review,
  };
}

/** Recount the summary's review fields from the cells. */
function recount(model: VisualReviewModel, cells: VisualReviewCell[]): VisualReviewModel {
  const reviewed = cells.filter(c => c.current.review).length;
  const rel = (r: HumanShotReview['relation']) => cells.filter(c => c.current.review?.relation === r).length;
  return {
    ...model,
    cells,
    summary: {
      ...model.summary,
      effectiveOk: cells.filter(c => c.effectiveVerdict === 'ok').length,
      effectiveIssues: cells.filter(c => c.effectiveVerdict === 'issue').length,
      reviewed,
      unreviewed: cells.length - reviewed,
      awaitingHuman: cells.filter(c => c.needsHuman).length,
      confirmed: rel('agree'),
      disputed: rel('dispute'),
      waived: rel('waive'),
    },
  };
}

/** The model as it will be once `input` lands. `opId` makes the placeholder review ids. */
export function applyOptimisticDecision(
  model: VisualReviewModel,
  input: DecideInput,
  opId: number | string,
  now = Date.now(),
): { model: VisualReviewModel; reviewIds: string[] } {
  const ids = new Set(input.cells.map(c => c.current.shot.id));
  const reviewIds: string[] = [];
  const note = input.note?.trim() || null;
  const cells = model.cells.map((c) => {
    if (!ids.has(c.current.shot.id)) return c;
    const id = `optimistic-${opId}-${c.current.shot.id}`;
    reviewIds.push(id);
    return withReview(c, {
      id,
      artifactId: c.current.shot.id,
      auditTaskId: c.current.shot.auditTaskId,
      round: c.current.round,
      cellKey: c.key,
      route: c.route,
      viewport: c.viewport,
      agentVerdict: c.current.agentVerdict,
      decision: input.decision,
      relation: visualReviewRelation(c.current.agentVerdict, input.decision),
      note,
      fixTaskId: null,
      cancelledFixTaskId: null,
      reviewerUserId: null,
      reviewerLabel: 'You',
      createdAt: new Date(now).toISOString(),
      supersededAt: null,
    });
  });
  return { model: recount(model, cells), reviewIds };
}

/** The model once the reviews `reviewIds` are undone. */
export function applyOptimisticUndo(model: VisualReviewModel, reviewIds: readonly string[]): VisualReviewModel {
  const ids = new Set(reviewIds);
  const cells = model.cells.map(c => (c.current.review && ids.has(c.current.review.id) ? withReview(c, null) : c));
  return recount(model, cells);
}

// ── The hook ────────────────────────────────────────────────────────────────

/** True when `m` was built no earlier than `cur` (by `generatedAt`). An unparseable time is adopted. */
export function isNewerOrSame(m: VisualReviewModel, cur: VisualReviewModel): boolean {
  const a = Date.parse(m.generatedAt);
  const b = Date.parse(cur.generatedAt);
  return Number.isNaN(a) || Number.isNaN(b) || a >= b;
}

export type DecideResult =
  | { ok: true; reviewIds: string[]; fixTaskId: string | null; cancelledFixTaskId: string | null; guidanceTaskId: string | null }
  | { ok: false; reason: 'stale' | 'round_ceiling' | 'not_in_mission' | 'error'; message: string };

export type UndoResult = { ok: true } | { ok: false; reason: 'fix_started' | 'error'; message: string };

type Op =
  | { id: number; kind: 'decide'; input: DecideInput; at: number }
  | { id: number; kind: 'undo'; reviewIds: readonly string[] };

function applyOp(model: VisualReviewModel, op: Op): VisualReviewModel {
  return op.kind === 'decide'
    ? applyOptimisticDecision(model, op.input, op.id, op.at).model
    : applyOptimisticUndo(model, op.reviewIds);
}

function failureOf(e: unknown): { reason: string; message: string; stale: VisualReviewStaleBody | null } {
  if (e instanceof VisualReviewRequestError) return { reason: e.code ?? 'error', message: e.message, stale: e.stale };
  return { reason: 'error', message: e instanceof Error && e.message ? e.message : 'Could not reach the server. Try again.', stale: null };
}

export interface UseVisualReviewDecisions {
  /** The server model with in-flight decisions applied. Render this. */
  model: VisualReviewModel;
  decide(input: DecideInput): Promise<DecideResult>;
  undo(reviewIds: readonly string[]): Promise<UndoResult>;
  /** Decisions or undos in flight. */
  pending: number;
}

/**
 * Optimistic decisions over a model. A new `model` prop (a refresh) replaces
 * the server model. `onModel` sees every model the server returns, so a page
 * can refresh what it derives from it.
 */
export function useVisualReviewDecisions(
  model: VisualReviewModel,
  transport: VisualReviewTransport,
  opts: { onModel?: (model: VisualReviewModel) => void } = {},
): UseVisualReviewDecisions {
  const [server, setServer] = useState(model);
  const [prop, setProp] = useState(model);
  if (prop !== model) {
    setProp(model);
    setServer(model);
  }
  const [ops, setOps] = useState<Op[]>([]);
  const nextId = useRef(1);
  const onModel = useRef(opts.onModel);
  onModel.current = opts.onModel;

  const view = useMemo(() => ops.reduce(applyOp, server), [server, ops]);

  // Responses can land out of order (two quick taps, or a stale body after a
  // newer success). Keep whichever model the server built last, not whichever
  // arrived last, so a decision that already landed never drops out again.
  const serverRef = useRef(server);
  serverRef.current = server;
  const adopt = useCallback((m: VisualReviewModel) => {
    if (!isNewerOrSame(m, serverRef.current)) return;
    serverRef.current = m;
    setServer(m);
    onModel.current?.(m);
  }, []);
  const drop = useCallback((id: number) => setOps(prev => prev.filter(o => o.id !== id)), []);

  const decide = useCallback(async (input: DecideInput): Promise<DecideResult> => {
    let req: VisualReviewDecisionRequest;
    try { req = buildDecisionRequest(input); } catch (e) { return { ok: false, reason: 'error', message: (e as Error).message }; }
    const id = nextId.current++;
    setOps(prev => [...prev, { id, kind: 'decide', input, at: Date.now() }]);
    try {
      const res = await transport.decide(req);
      adopt(res.model);
      return {
        ok: true,
        reviewIds: res.reviews.map(r => r.id),
        fixTaskId: res.fixTaskId,
        cancelledFixTaskId: res.cancelledFixTaskId,
        guidanceTaskId: res.guidanceTaskId,
      };
    } catch (e) {
      const f = failureOf(e);
      // Stale: re-render from the fresh model the server sent. Never retried.
      if (f.stale) adopt(f.stale.model);
      const reason = f.stale ? 'stale' : f.reason === 'round_ceiling' || f.reason === 'not_in_mission' ? f.reason : 'error';
      return { ok: false, reason, message: f.message };
    } finally {
      drop(id);
    }
  }, [transport, adopt, drop]);

  const undo = useCallback(async (reviewIds: readonly string[]): Promise<UndoResult> => {
    if (reviewIds.length === 0) return { ok: true };
    const id = nextId.current++;
    setOps(prev => [...prev, { id, kind: 'undo', reviewIds }]);
    try {
      let last: VisualReviewModel | null = null;
      try {
        for (const r of reviewIds) last = (await transport.undo(r)).model;
      } finally {
        if (last) adopt(last);
      }
      return { ok: true };
    } catch (e) {
      const f = failureOf(e);
      return { ok: false, reason: f.reason === 'fix_started' ? 'fix_started' : 'error', message: f.message };
    } finally {
      drop(id);
    }
  }, [transport, adopt, drop]);

  return { model: view, decide, undo, pending: ops.length };
}
