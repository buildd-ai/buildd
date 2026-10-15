/**
 * Findings that survive (docs/specs/workflow-kernel-library.md §5,
 * workflow-state-kernel.md §13.13 rules 2 and 4). Pure: the reducer asks these
 * what a verdict, a push or a person's waiver does to the delivery's findings
 * and writes the answer as `FindingOp`s in the transition's own statement.
 *
 * A finding is raised by a request for changes, one per issue, pinned to the
 * round, head, path and line it was raised on. Its id is stable: derived from
 * the round that raised it and its position there, and kept when a later round
 * restates it. It stays open across pushes, CI, refreshes, composition, owner
 * changes and task completion. Only these close it:
 *  - a later round that verifies it (`resolved`),
 *  - a person's waiver (`waived`, with who and why),
 *  - a deferral to a named task, by a reviewer or a person (`deferred`).
 * A push that touches its path marks it `addressed`, which is not closed: the
 * next approval still has to verify it.
 */
import type { FindingInput, FindingOp, VerdictFindings } from './commands';
import { OPEN_FINDING_STATUSES, type FindingSnapshot, type KernelView, type RoundSnapshot, type Verdict } from './types';

/** The stable id of the `ordinal`-th finding raised by round `roundId`. */
export function findingId(roundId: string, ordinal: number): string {
  return `${roundId}:${ordinal}`;
}

/** The title of the one finding a request for changes with no structured findings stands for. */
export const ROUND_FINDING_TITLE = 'the review asked for changes';

export const isOpenFinding = (f: Pick<FindingSnapshot, 'status'>): boolean => OPEN_FINDING_STATUSES.has(f.status);

/** Every finding still open (`open` or `addressed`), oldest first. */
export function openFindings(view: Pick<KernelView, 'findings'>): FindingSnapshot[] {
  return (view.findings ?? []).filter(isOpenFinding);
}

/** The open findings that block landing. */
export function openRequiredFindings(view: Pick<KernelView, 'findings'>): FindingSnapshot[] {
  return openFindings(view).filter((f) => f.required);
}

/** How a finding reads in one line: where it is and what it asks. */
export function describeFinding(f: Pick<FindingSnapshot, 'path' | 'line' | 'title'>): string {
  const where = f.path ? `${f.path}${f.line != null ? `:${f.line}` : ''}` : null;
  return where ? `${where}: ${f.title}` : f.title;
}

/**
 * Is a round's approval a verification of every finding it did not name? Only
 * for an unscoped round whose reviewer did not report per-finding resolution:
 * its brief held every open finding (the prior verdict's feedback). A scoped
 * round (a composition's novel paths, a refresh's merge) read only its scope,
 * so it verifies only what it names.
 */
function blanketVerifies(round: Pick<RoundSnapshot, 'scope'>, v: VerdictFindings): boolean {
  if (v.resolvedFindings !== undefined) return false;
  const sc = round.scope;
  return !sc || (sc.composition !== true && sc.refresh !== true);
}

export interface VerdictFindingsOutcome {
  ops: FindingOp[];
  /** Required findings still open once the verdict is applied. */
  stillOpen: FindingSnapshot[];
  /** Ids the verdict resolved, restated, raised and deferred (for the transition's evidence). */
  resolved: string[];
  restated: string[];
  raised: string[];
  deferred: string[];
}

/**
 * What a decided round's verdict does to the findings. `request_changes`
 * raises its findings (or restates earlier ones; with none named, one finding
 * stands for the round), resolves what it names, defers what it defers.
 * `approve` resolves what it names, or every open finding when it is an
 * unscoped round with no per-finding report. `escalate` changes nothing but
 * what it names. Unknown ids are ignored: a reviewer cannot close a finding of
 * another delivery.
 */
export function applyVerdictToFindings(
  view: Pick<KernelView, 'findings'>,
  round: Pick<RoundSnapshot, 'id' | 'round' | 'headSha' | 'scope'>,
  verdict: Verdict,
  v: VerdictFindings,
  actor: string,
): VerdictFindingsOutcome {
  const all = view.findings ?? [];
  const byId = new Map(all.map((f) => [f.id, f]));
  const touched = new Set<string>();
  const ops: FindingOp[] = [];
  const out: VerdictFindingsOutcome = { ops, stillOpen: [], resolved: [], restated: [], raised: [], deferred: [] };
  const closed = new Map<string, FindingSnapshot['status']>();

  for (const d of v.deferredFindings ?? []) {
    const f = byId.get(d.id);
    if (!f || !isOpenFinding(f) || touched.has(f.id) || !d.reason?.trim()) continue;
    touched.add(f.id);
    closed.set(f.id, 'deferred');
    out.deferred.push(f.id);
    ops.push({ op: 'update', findingId: f.id, whenStatus: ['open', 'addressed'], set: { status: 'deferred', closedByRoundId: round.id, closedBy: actor, closedReason: d.reason.trim(), deferredToTaskId: d.taskId ?? null } });
  }

  const restatedInputs: FindingInput[] = [];
  const newInputs: FindingInput[] = [];
  for (const fi of v.findings ?? []) {
    if (!fi?.title?.trim()) continue;
    const prior = fi.id ? byId.get(fi.id) : undefined;
    if (prior) restatedInputs.push(fi);
    else newInputs.push(fi);
  }
  const restatedIds = new Set(restatedInputs.map((fi) => fi.id!));

  const resolveIds = new Set<string>();
  if (verdict === 'approve' && blanketVerifies(round, v)) {
    for (const f of all) if (isOpenFinding(f) && !restatedIds.has(f.id)) resolveIds.add(f.id);
  }
  for (const id of v.resolvedFindings ?? []) if (!restatedIds.has(id)) resolveIds.add(id);
  for (const id of resolveIds) {
    const f = byId.get(id);
    if (!f || !isOpenFinding(f) || touched.has(f.id)) continue;
    touched.add(f.id);
    closed.set(f.id, 'resolved');
    out.resolved.push(f.id);
    ops.push({ op: 'update', findingId: f.id, whenStatus: ['open', 'addressed'], set: { status: 'resolved', closedByRoundId: round.id } });
  }

  for (const fi of restatedInputs) {
    const f = byId.get(fi.id!)!;
    if (touched.has(f.id)) continue;
    touched.add(f.id);
    out.restated.push(f.id);
    // Restated: open again (an `addressed` one was not fixed after all), and its newest round is this one.
    // A closed one a reviewer restates comes back: the change it asked for is missing again.
    ops.push({
      op: 'update', findingId: f.id, whenStatus: ['open', 'addressed', 'resolved', 'deferred'],
      set: { status: 'open', lastRound: round.round, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null, ...(fi.required === false ? { required: false } : {}) },
    });
  }

  const raise = (fi: FindingInput, ordinal: number) => {
    const id = findingId(round.id, ordinal);
    out.raised.push(id);
    ops.push({
      op: 'insert', id, originRoundId: round.id, originRound: round.round, originHeadSha: round.headSha, ordinal,
      path: fi.path?.trim() || null, line: typeof fi.line === 'number' && Number.isFinite(fi.line) ? Math.trunc(fi.line) : null,
      title: fi.title.trim().slice(0, 500), required: fi.required !== false,
    });
  };
  if (verdict === 'request_changes') newInputs.forEach((fi, i) => raise(fi, i));

  // What stays open after this verdict.
  const after = (f: FindingSnapshot): boolean => {
    if (restatedIds.has(f.id)) return true;
    const c = closed.get(f.id);
    return c ? false : isOpenFinding(f);
  };
  const required = (f: FindingSnapshot): boolean => {
    const fi = restatedInputs.find((x) => x.id === f.id);
    return fi?.required === false ? false : f.required;
  };
  out.stillOpen = all.filter((f) => after(f) && required(f));
  if (verdict === 'request_changes') {
    const raisedRequired = newInputs.some((fi) => fi.required !== false);
    if (!raisedRequired && out.stillOpen.length === 0) {
      // A request for changes always leaves something open: with nothing structured, the round itself.
      const fi: FindingInput = { title: ROUND_FINDING_TITLE, required: true };
      raise(fi, newInputs.length);
    }
    for (const op of ops) {
      if (op.op === 'insert' && op.required) {
        out.stillOpen.push({
          id: op.id, originRoundId: op.originRoundId, originRound: op.originRound, originHeadSha: op.originHeadSha, ordinal: op.ordinal,
          path: op.path, line: op.line, title: op.title, required: true, status: 'open', lastRound: round.round,
          addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null,
        });
      }
    }
  }
  return out;
}

/**
 * §5: a push that changed `changedPaths` marks every open finding on one of
 * them `addressed` by `head`. Not a closure: the finding still blocks until a
 * round verifies it. A finding with no path is never addressed by a push.
 * Unread paths (null/undefined) address nothing.
 */
export function addressFindings(view: Pick<KernelView, 'findings'>, head: string, changedPaths: string[] | null | undefined): FindingOp[] {
  if (!changedPaths || changedPaths.length === 0) return [];
  const changed = new Set(changedPaths);
  return (view.findings ?? [])
    .filter((f) => f.status === 'open' && f.path && changed.has(f.path))
    .map((f) => ({ op: 'update', findingId: f.id, whenStatus: ['open'], set: { status: 'addressed', addressedBySha: head } }));
}

/**
 * §13.13 rule 4: does a repair's diff answer the findings it was filed for?
 * True when it changed a path an open required finding names, or when no open
 * required finding names a path (then any change is a candidate fix for the
 * reviewer to verify). Unread paths are not evidence either way: null.
 */
export function diffTouchesFindings(view: Pick<KernelView, 'findings'>, changedPaths: string[] | null | undefined): boolean | null {
  if (changedPaths == null) return null;
  if (changedPaths.length === 0) return false;
  const withPath = openRequiredFindings(view).filter((f) => f.path);
  if (withPath.length === 0) return true;
  const changed = new Set(changedPaths);
  return withPath.some((f) => changed.has(f.path!));
}
