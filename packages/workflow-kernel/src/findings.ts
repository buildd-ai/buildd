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
import { OPEN_FINDING_STATUSES, REMEDY_CLASSES, type EvidenceTarget, type FindingSnapshot, type KernelView, type RemedyClass, type RoundSnapshot, type Verdict } from './types';

/** The stable id of the `ordinal`-th finding raised by round `roundId`. */
export function findingId(roundId: string, ordinal: number): string {
  return `${roundId}:${ordinal}`;
}

/** The title of the one finding a request for changes with no structured findings stands for. */
export const ROUND_FINDING_TITLE = 'the review asked for changes';

export const isOpenFinding = (f: Pick<FindingSnapshot, 'status'>): boolean => OPEN_FINDING_STATUSES.has(f.status);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A task id a deferral may name: a full id the host resolved. A short id or free text is not one. */
export const isTaskId = (v: unknown): boolean => typeof v === 'string' && UUID.test(v);

/** The one finding a request for changes with no structured findings stands for. */
export const isRoundFinding = (f: Pick<FindingSnapshot, 'path' | 'title'>): boolean => f.path == null && f.title === ROUND_FINDING_TITLE;

/** Every finding still open (`open` or `addressed`), oldest first. */
export function openFindings(view: Pick<KernelView, 'findings'>): FindingSnapshot[] {
  return (view.findings ?? []).filter(isOpenFinding);
}

/** Living Spec fa62b865 §11.1: who can fix a finding. A finding recorded before classes were is a code fix. */
export function remedyOf(f: Pick<FindingSnapshot, 'remedyClass'>): RemedyClass {
  return f.remedyClass ?? 'code_fix';
}

/** The route a remedy class takes: the fix loop, buildd's capture, or a person. */
export type RemedyRoute = 'fix' | 'evidence' | 'person';
export function remedyRoute(c: RemedyClass): RemedyRoute {
  return c === 'code_fix' ? 'fix' : c === 'evidence' ? 'evidence' : 'person';
}

export const isRemedyClass = (v: unknown): v is RemedyClass => typeof v === 'string' && (REMEDY_CLASSES as readonly string[]).includes(v);

/** Findings split by the route their class takes (R-45): only `fix` is fix work and spends a round. */
export function byRemedyRoute<F extends Pick<FindingSnapshot, 'remedyClass'>>(findings: readonly F[]): Record<RemedyRoute, F[]> {
  const out: Record<RemedyRoute, F[]> = { fix: [], evidence: [], person: [] };
  for (const f of findings) out[remedyRoute(remedyOf(f))].push(f);
  return out;
}

/**
 * Whether a verdict may close `f` without naming it: a code finding, or an evidence finding
 * whose capture is attached and judged by a round scoped to that evidence (R-46). A person's
 * finding is never closed by a reviewer's blanket approval: the person decides it.
 */
function blanketClosable(f: FindingSnapshot, round: Pick<RoundSnapshot, 'scope'>): boolean {
  const route = remedyRoute(remedyOf(f));
  if (route === 'fix') return true;
  if (route === 'evidence') return !!f.evidence?.artifactId && isEvidenceRound(round);
  return false;
}

/** A round opened to judge buildd's captures for evidence findings (R-46). */
export function isEvidenceRound(r: Pick<RoundSnapshot, 'scope'> | null | undefined): boolean {
  const ev = r?.scope?.evidence as { findingIds?: unknown } | undefined;
  return ev != null && typeof ev === 'object' && Array.isArray(ev.findingIds);
}

/** The finding ids an evidence round captures. */
export function evidenceRoundFindingIds(r: Pick<RoundSnapshot, 'scope'> | null | undefined): string[] {
  return isEvidenceRound(r) ? ((r!.scope!.evidence as { findingIds: unknown[] }).findingIds.map(String)) : [];
}

const evidenceTargetOf = (fi: FindingInput): EvidenceTarget | null =>
  fi.evidence && typeof fi.evidence.screen === 'string' && fi.evidence.screen.trim()
    ? { criterionId: fi.evidence.criterionId ?? null, screen: fi.evidence.screen.trim(), route: fi.evidence.route ?? null }
    : null;

/** The open findings that block landing. */
export function openRequiredFindings(view: Pick<KernelView, 'findings'>): FindingSnapshot[] {
  return openFindings(view).filter((f) => f.required);
}

/**
 * Living Spec r7 AC-47: where every required finding stands, each counted exactly once.
 *  - `open`: nothing has answered it yet;
 *  - `addressedAwaitingVerification`: a push touched it, and no review has verified that push
 *    (a pushed fix is not verified, so this is never folded into `verifiedResolved`);
 *  - `verifiedResolved`: a later review round verified it;
 *  - `waived`: a person waived it: closed, not verified;
 *  - `deferred`: deferred to a named task: closed here, not verified.
 * `total` is their sum. `advisory` counts the optional findings, which block nothing and are
 * kept out of the partition. `open + addressedAwaitingVerification` is what still blocks
 * landing (`openRequiredFindings`).
 */
export interface FindingTotals {
  open: number;
  addressedAwaitingVerification: number;
  verifiedResolved: number;
  waived: number;
  deferred: number;
  total: number;
  advisory: number;
}

/** The one partition of a delivery's findings every surface counts from (AC-47). */
export function findingTotals(findings: ReadonlyArray<Pick<FindingSnapshot, 'status' | 'required'>> | null | undefined): FindingTotals {
  const t: FindingTotals = { open: 0, addressedAwaitingVerification: 0, verifiedResolved: 0, waived: 0, deferred: 0, total: 0, advisory: 0 };
  for (const f of findings ?? []) {
    if (!f.required) { t.advisory++; continue; }
    t.total++;
    if (f.status === 'open') t.open++;
    else if (f.status === 'addressed') t.addressedAwaitingVerification++;
    else if (f.status === 'resolved') t.verifiedResolved++;
    else if (f.status === 'waived') t.waived++;
    else t.deferred++;
  }
  return t;
}

/**
 * The partition in words, zeros left out: "1 open finding, 2 with a fix awaiting verification,
 * 3 verified resolved, 1 advisory". With nothing left blocking: "no open findings (3 verified resolved)".
 */
export function findingTotalsLine(t: FindingTotals): string {
  if (t.total === 0 && t.advisory === 0) return 'no open findings';
  const closed: string[] = [];
  if (t.verifiedResolved) closed.push(`${t.verifiedResolved} verified resolved`);
  if (t.waived) closed.push(`${t.waived} waived`);
  if (t.deferred) closed.push(`${t.deferred} deferred`);
  // Optional findings block nothing; they are named, apart, so the reader still sees them.
  if (t.advisory) closed.push(`${t.advisory} advisory`);
  if (t.open + t.addressedAwaitingVerification === 0) return `no open findings (${closed.join(', ')})`;
  const parts: string[] = [];
  if (t.open) parts.push(`${t.open} open ${t.open === 1 ? 'finding' : 'findings'}`);
  if (t.addressedAwaitingVerification) parts.push(`${t.addressedAwaitingVerification} with a fix awaiting verification`);
  return [...parts, ...closed].join(', ');
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
  /** Restated ids whose words or class this round changed (R-49: a changed finding is news; an unchanged restatement is not). */
  changed: string[];
  deferred: string[];
  /** Deferrals that named no resolvable task: refused, the finding stays open. */
  unresolvedDeferrals: Array<{ id: string; taskId: string | null }>;
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
  const out: VerdictFindingsOutcome = { ops, stillOpen: [], resolved: [], restated: [], raised: [], changed: [], deferred: [], unresolvedDeferrals: [] };
  const closed = new Map<string, FindingSnapshot['status']>();

  for (const d of v.deferredFindings ?? []) {
    const f = byId.get(d.id);
    if (!f || !isOpenFinding(f) || touched.has(f.id) || !d.reason?.trim()) continue;
    // "Deferred to a named task": with no task the host resolved to a full id, nothing closes.
    if (!isTaskId(d.taskId)) { out.unresolvedDeferrals.push({ id: f.id, taskId: d.taskId ?? null }); continue; }
    touched.add(f.id);
    closed.set(f.id, 'deferred');
    out.deferred.push(f.id);
    ops.push({ op: 'update', findingId: f.id, whenStatus: ['open', 'addressed'], set: { status: 'deferred', closedByRoundId: round.id, closedBy: actor, closedReason: d.reason.trim(), deferredToTaskId: d.taskId as string } });
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
    for (const f of all) if (isOpenFinding(f) && !restatedIds.has(f.id) && blanketClosable(f, round)) resolveIds.add(f.id);
  }
  for (const id of v.resolvedFindings ?? []) if (!restatedIds.has(id)) resolveIds.add(id);
  // The stand-in for a request for changes that named nothing has no id a reviewer is likely to
  // report. An unscoped approval verifies it when it reviewed a later head than the one asked to
  // change, or when it verified every structured finding still open.
  const scoped = !!round.scope && (round.scope.composition === true || round.scope.refresh === true);
  if (verdict === 'approve' && !scoped) {
    const structured = all.filter((f) => isOpenFinding(f) && !isRoundFinding(f) && !restatedIds.has(f.id) && blanketClosable(f, round));
    const coversStructured = structured.every((f) => resolveIds.has(f.id) || closed.has(f.id));
    for (const f of all) {
      if (!isOpenFinding(f) || !isRoundFinding(f) || restatedIds.has(f.id)) continue;
      if (f.originHeadSha !== round.headSha || coversStructured) resolveIds.add(f.id);
    }
  }
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
    // R-48: a restatement is the same finding, counted; its first words stand unless the reviewer changed them.
    const title = fi.title.trim().slice(0, 500);
    const cls = isRemedyClass(fi.remedyClass) ? fi.remedyClass : undefined;
    const changedWords = title !== f.title;
    const changedClass = cls !== undefined && cls !== remedyOf(f);
    if (changedWords || changedClass) out.changed.push(f.id);
    const ev = cls === 'evidence' || (cls === undefined && remedyOf(f) === 'evidence') ? evidenceTargetOf(fi) : null;
    // Restated: open again (an `addressed` one was not fixed after all), and its newest round is this one.
    // A closed one a reviewer restates comes back: the change it asked for is missing again.
    ops.push({
      op: 'update', findingId: f.id, whenStatus: ['open', 'addressed', 'resolved', 'deferred'],
      set: {
        status: 'open', lastRound: round.round, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null, deferredToTaskId: null,
        restatedCount: (f.restatedCount ?? 0) + 1,
        ...(changedWords ? { title } : {}),
        ...(changedClass ? { remedyClass: cls } : {}),
        ...(ev ? { evidence: { ...ev, artifactId: f.evidence?.artifactId ?? null, capturedAt: f.evidence?.capturedAt ?? null } } : {}),
        ...(fi.required === false ? { required: false } : {}),
      },
    });
  }

  const raise = (fi: FindingInput, ordinal: number) => {
    const id = findingId(round.id, ordinal);
    out.raised.push(id);
    const remedyClass: RemedyClass = isRemedyClass(fi.remedyClass) ? fi.remedyClass : 'code_fix';
    const evidence = remedyClass === 'evidence' ? evidenceTargetOf(fi) : null;
    ops.push({
      op: 'insert', id, originRoundId: round.id, originRound: round.round, originHeadSha: round.headSha, ordinal,
      path: fi.path?.trim() || null, line: typeof fi.line === 'number' && Number.isFinite(fi.line) ? Math.trunc(fi.line) : null,
      title: fi.title.trim().slice(0, 500), required: fi.required !== false,
      // An evidence finding with nothing to capture is not evidence buildd can collect: a code fix.
      remedyClass: remedyClass === 'evidence' && !evidence ? 'code_fix' : remedyClass,
      ...(evidence ? { evidence } : {}),
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
  // What stays open reads as this verdict leaves it: a restated finding with its new class and count.
  out.stillOpen = all.filter((f) => after(f) && required(f)).map((f) => {
    const op = ops.find((o): o is Extract<FindingOp, { op: 'update' }> => o.op === 'update' && o.findingId === f.id);
    return op ? { ...f, ...Object.fromEntries(Object.entries(op.set).filter(([, x]) => x !== undefined)) } as FindingSnapshot : f;
  });
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
          remedyClass: op.remedyClass ?? 'code_fix', restatedCount: 0, evidence: op.evidence ?? null,
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

/** The directory of a repo path ('' for the root). */
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** A file's stem without test or spec markers: `src/a.test.ts` and `tests/a.spec.tsx` are both `a`. */
const stemOf = (p: string): string => (p.split('/').pop() ?? p).replace(/\.[^.]*$/, '').replace(/\.(test|spec)$/, '').replace(/^test_|_test$/, '');
const within = (path: string, dir: string): boolean => dir === '' || path === dir || path.startsWith(`${dir}/`);

/**
 * §13.13 rule 4: could a repair's diff answer the findings it was filed for? The check only
 * refuses a diff that plainly cannot: every open required finding names a path, and the push
 * changes nothing near any of them. "Near" is deliberately wide, because a fix often lands
 * beside the line the reviewer pointed at:
 *  - the finding's own directory, or anywhere below it (a caller, a sibling module);
 *  - a file with the same stem anywhere (its test: `a.ts` and `tests/a.test.ts`);
 *  - a path the reviewer's feedback names (`extraPaths`), or its directory.
 * `changedPaths` should include a renamed file's previous name. With an open required finding
 * that has no path, there is nothing to compare: any change may be the fix, and the reviewer
 * decides. Unread paths are not evidence either way: null.
 */
export function diffTouchesFindings(
  view: Pick<KernelView, 'findings'>, changedPaths: string[] | null | undefined, extraPaths: string[] = [],
): boolean | null {
  if (changedPaths == null) return null;
  if (changedPaths.length === 0) return false;
  const open = openRequiredFindings(view);
  if (open.length === 0 || open.some((f) => !f.path)) return true;
  const anchors = [...open.map((f) => f.path!), ...extraPaths.filter((x) => x && x.trim())];
  const dirs = new Set(anchors.map(dirOf));
  const stems = new Set(anchors.map(stemOf));
  const exact = new Set(anchors);
  return changedPaths.some((c) => exact.has(c) || stems.has(stemOf(c)) || [...dirs].some((d) => within(c, d)));
}

/** Repo paths a reviewer's feedback names (`src/a.ts`, `apps/web/x.tsx:12`): what rule 4 lets a fix touch besides the findings' own. */
export function pathsNamedIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?::\d+)?/g)) out.add(m[1]!);
  return [...out].slice(0, 50);
}
