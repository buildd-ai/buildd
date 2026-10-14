import { db } from '@buildd/core/db';
import { missions, specOutcomeVerdicts, specs, tasks, users } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { getDeliveryViewsForTasks } from '@/lib/workflow/delivery-view';
import { readGovernedOutcome, type OutcomeView } from './outcome';
import { reach, type SpecCaller } from './store';
import { livingSpecCriteriaOf, selectedScope } from './mission-outcome';
import type { GoalCriteriaState, LivingSpecCriterionStanding } from '@buildd/shared';
import {
  deliveredSentence, markOf, standingSentence,
  type CriterionMark, type DeliveryOutcome, type DeliveryTone,
} from './delivery-words';

/**
 * Delivery and verification, read back from the spec (Living Specs Slice 13,
 * R-61..R-65): the work that answered to one spec, derived from links that
 * already exist, never from a hand-kept ledger (R-62).
 *
 *  - A task pinned to the spec (`tasks.context.specSource.specId`, set when it
 *    was filed and at its first claim). Only the work itself: retry attempts,
 *    review rounds and fixes carry their parent's pin and are part of its
 *    delivery, so they never add an entry. A task in a mission that selected
 *    this spec as its outcome spec is that mission's work and is listed under
 *    the mission, not again on its own (AC-45).
 *  - A mission that selected the spec as its outcome spec (a `living_spec`
 *    goal criterion, Slice 12). Its standing is the evaluator's stored
 *    reading of the integrated result (`goalCriteriaState`), with waived
 *    criteria said as waived and by whom; nothing here calls GitHub.
 *  - A text mention of the spec (a description, a comment, repoRefs) is not a
 *    link and creates no entry (AC-47).
 *
 * Per entry, kept apart (R-63): the revision it was built to and whether it
 * was delivered (the kernel's delivery reading: a merged PR, or a completed
 * task with no PR delivery), and where the revision in force stands for it,
 * read through the governed-outcome reader (./outcome.ts). Work built to an
 * older revision reads "not verified" against the one approved now.
 *
 * Read-only (R-65): no lifecycle state, count or spec body is written, no
 * GitHub call is made, and an entry whose outcome cannot be read still lists,
 * as not verified. Scoped to the spec's own workspace and to a reader who
 * reaches it; paged newest first.
 */

export const DELIVERY_PAGE = 10;

export interface DeliveryEvidence { label: string; href: string }

export interface DeliveryCriterion {
  criterionId: string;
  text: string;
  mark: CriterionMark;
  evidence: DeliveryEvidence[];
}

export interface DeliveryEntry {
  kind: 'task' | 'mission';
  id: string;
  title: string;
  href: string;
  builtTo: number;
  provisional: boolean;
  delivered: boolean;
  deliveredText: string;
  standing: { tone: DeliveryTone; text: string };
  /** The criteria the work answered for on the revision it was built to (R-64). */
  criteria: DeliveryCriterion[];
  /** Where its delivery is, e.g. the PR. */
  links: DeliveryEvidence[];
  at: string;
}

export interface SpecDelivery {
  entries: DeliveryEntry[];
  /** Cursor for the next (older) page, or null on the last one. */
  next: string | null;
}

type Cursor = { at: string; id: string };

export function encodeCursor(c: Cursor): string {
  return `${c.at}_${c.id}`;
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string') return null;
  const i = raw.lastIndexOf('_');
  if (i < 1) return null;
  const at = raw.slice(0, i); const id = raw.slice(i + 1);
  return isUuid(id) && !Number.isNaN(Date.parse(at)) ? { at: new Date(at).toISOString(), id } : null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A mission whose goal criteria select this spec as its outcome spec (Slice 12). */
const selectsSpec = (specId: string) => sql`exists (
  select 1 from missions m
  where m.id = ${tasks.missionId}
    and m.goal_criteria @> ${JSON.stringify([{ type: 'living_spec', specId }])}::jsonb
)`;

/**
 * The tasks pinned directly to `specId` in `workspaceId`, newest first, one
 * page past `cursor`. Exported for the real-Postgres test of the derivation.
 */
export async function pinnedTaskRows(workspaceId: string, specId: string, opts: { limit: number; cursor?: Cursor | null }) {
  return db.select({
    id: tasks.id, title: tasks.title, status: tasks.status, context: tasks.context, createdAt: tasks.createdAt,
  })
    .from(tasks)
    .where(and(
      eq(tasks.workspaceId, workspaceId),
      sql`${tasks.context}->'specSource'->>'specId' = ${specId}`,
      eq(tasks.taskClass, 'work'),
      sql`(${tasks.deliveryRole} is null or ${tasks.deliveryRole} = 'owner')`,
      sql`not ${selectsSpec(specId)}`,
      opts.cursor ? sql`(${tasks.createdAt}, ${tasks.id}) < (${opts.cursor.at}::timestamptz, ${opts.cursor.id}::uuid)` : undefined,
    ))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(opts.limit);
}

/** Evidence a verdict cites, as links the reader can open. Anything without a safe link is left out. */
export function evidenceLinks(evidence: unknown): DeliveryEvidence[] {
  const e = asRecord(evidence);
  if (!e) return [];
  const out: DeliveryEvidence[] = [];
  const refs = Array.isArray(e.refs) ? e.refs : [];
  for (const r of refs) {
    const ref = asRecord(r);
    if (!ref || typeof ref.ref !== 'string' || typeof ref.kind !== 'string') continue;
    if (/^https:\/\//.test(ref.ref)) out.push({ label: ref.kind, href: ref.ref });
    else if (isUuid(ref.ref) && /artifact|screenshot|report/.test(ref.kind)) out.push({ label: ref.kind, href: `/app/artifacts/${ref.ref}` });
  }
  if (typeof e.verificationTaskId === 'string' && isUuid(e.verificationTaskId)) out.push({ label: 'Check run', href: `/app/tasks/${e.verificationTaskId}` });
  if (typeof e.auditTaskId === 'string' && isUuid(e.auditTaskId)) out.push({ label: 'Visual audit', href: `/app/tasks/${e.auditTaskId}` });
  return out.slice(0, 4);
}

/** The newest verdict's evidence per criterion, for these tasks on their pinned revisions. */
async function newestEvidence(pins: Array<{ taskId: string; specRevisionId: string }>): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (!pins.length) return out;
  const rows = await db.select({
    taskId: specOutcomeVerdicts.taskId, specRevisionId: specOutcomeVerdicts.specRevisionId,
    criterionId: specOutcomeVerdicts.criterionId, evidence: specOutcomeVerdicts.evidence,
  })
    .from(specOutcomeVerdicts)
    .where(inArray(specOutcomeVerdicts.taskId, pins.map((p) => p.taskId)))
    .orderBy(desc(specOutcomeVerdicts.createdAt));
  const want = new Map(pins.map((p) => [p.taskId, p.specRevisionId]));
  for (const r of rows) {
    // A mission-subject verdict has no task; it is not a task's delivery evidence.
    if (!r.taskId || want.get(r.taskId) !== r.specRevisionId) continue;
    const k = `${r.taskId}:${r.criterionId}`;
    if (!out.has(k)) out.set(k, r.evidence);
  }
  return out;
}

async function taskEntries(rows: Awaited<ReturnType<typeof pinnedTaskRows>>, approved: number | null): Promise<DeliveryEntry[]> {
  const ids = rows.map((r) => r.id);
  const views = await getDeliveryViewsForTasks(ids).catch(() => new Map());
  const pins = rows.map((r) => ({ taskId: r.id, pin: asRecord(asRecord(r.context)?.specSource) ?? {} }));
  const evidence = await newestEvidence(pins
    .filter((p) => typeof p.pin.specRevisionId === 'string')
    .map((p) => ({ taskId: p.taskId, specRevisionId: p.pin.specRevisionId as string }))).catch(() => new Map<string, unknown>());

  return Promise.all(rows.map(async (r, i): Promise<DeliveryEntry> => {
    const pin = pins[i].pin;
    const view = views.get(r.id);
    // The kernel's reading when the task has a PR delivery; a task without one delivered by completing.
    const delivered = view ? view.state === 'MERGED' || !!view.supersededBy : r.status === 'completed';
    const read = await readGovernedOutcome(null, r.id).catch(() => null);
    const outcome = read && read.ok ? read.outcome : null;
    const builtTo = outcome?.revision ?? (typeof pin.revision === 'number' ? pin.revision : 0);
    const provisional = pin.provisional === true;
    const criteria: DeliveryCriterion[] = ((outcome?.criteria ?? []) as ReadonlyArray<OutcomeView['criteria'][number]>).map((c) => ({
      criterionId: c.criterionId, text: c.text, mark: markOf(c),
      evidence: evidenceLinks(evidence.get(`${r.id}:${c.criterionId}`)),
    }));
    const state: DeliveryOutcome = outcome?.outcome ?? 'unverified';
    const links: DeliveryEvidence[] = view?.prNumber && view.repoFullName
      ? [{ label: `PR #${view.prNumber}`, href: `https://github.com/${view.repoFullName}/pull/${view.prNumber}` }]
      : [];
    return {
      kind: 'task', id: r.id, title: r.title, href: `/app/tasks/${r.id}`,
      builtTo, provisional, delivered,
      deliveredText: deliveredSentence({ builtTo, provisional, delivered }),
      standing: standingSentence({ builtTo, approved, outcome: state, criteria }),
      criteria, links, at: new Date(r.createdAt).toISOString(),
    };
  }));
}

/** The missions in `workspaceId` that selected `specId` as their outcome spec, newest first. */
export async function selectingMissionRows(workspaceId: string, specId: string, opts: { limit: number; cursor?: Cursor | null }) {
  return db.select({
    id: missions.id, title: missions.title, status: missions.status, goalCriteria: missions.goalCriteria,
    goalCriteriaState: missions.goalCriteriaState, createdAt: missions.createdAt,
  })
    .from(missions)
    .where(and(
      eq(missions.workspaceId, workspaceId),
      sql`${missions.goalCriteria} @> ${JSON.stringify([{ type: 'living_spec', specId }])}::jsonb`,
      opts.cursor ? sql`(${missions.createdAt}, ${missions.id}) < (${opts.cursor.at}::timestamptz, ${opts.cursor.id}::uuid)` : undefined,
    ))
    .orderBy(desc(missions.createdAt), desc(missions.id))
    .limit(opts.limit);
}

const personId = (by: string) => (by.startsWith('user:') ? by.slice(5) : null);

async function personNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ids.filter(isUuid))];
  if (!want.length) return out;
  for (const u of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, want))) if (u.name) out.set(u.id, u.name);
  return out;
}

/** A mission standing as a mark. A stale verdict keeps what it was: a stale inconclusive is not a stale pass. */
function missionMark(s: LivingSpecCriterionStanding | undefined, verdict: string | undefined): CriterionMark {
  if (!s || s.standing === 'missing') return 'none';
  if (s.standing === 'stale') return verdict && verdict !== 'pass' ? (verdict as CriterionMark) : 'stale';
  return s.standing;
}

async function missionEntries(rows: Awaited<ReturnType<typeof selectingMissionRows>>, specId: string, approved: number | null): Promise<DeliveryEntry[]> {
  const picked = rows.map((r) => {
    const criterion = livingSpecCriteriaOf(r.goalCriteria).find((c) => c.specId === specId)!;
    const state = (r.goalCriteriaState as GoalCriteriaState | null)?.criteria
      ?.find((e) => e.type === 'living_spec' && e.spec?.specId === specId && e.spec.revision === criterion.revision) ?? null;
    return { r, criterion, state };
  });
  const verdictIds = picked.flatMap((p) => (p.state?.spec?.standings ?? []).map((s) => s.verdictId).filter((v): v is string => !!v && isUuid(v)));
  const verdicts = new Map<string, { verdict: string; evidence: unknown }>();
  if (verdictIds.length) {
    for (const v of await db.select({ id: specOutcomeVerdicts.id, verdict: specOutcomeVerdicts.verdict, evidence: specOutcomeVerdicts.evidence })
      .from(specOutcomeVerdicts).where(inArray(specOutcomeVerdicts.id, verdictIds)).catch(() => [])) verdicts.set(v.id, v);
  }
  const names = await personNames(picked.flatMap((p) => (p.criterion.waived ?? []).map((w) => personId(w.by) ?? ''))).catch(() => new Map<string, string>());

  return Promise.all(picked.map(async ({ r, criterion, state }): Promise<DeliveryEntry> => {
    const scope = await selectedScope(criterion).catch(() => null);
    const refs = scope && scope.ok ? scope.criteria : (state?.spec?.standings ?? []).map((s) => ({ id: s.criterionId, text: '' }));
    const standings = new Map((state?.spec?.standings ?? []).map((s) => [s.criterionId, s]));
    const waived = new Set((criterion.waived ?? []).map((w) => w.criterionId));
    const criteria: DeliveryCriterion[] = refs.map((ref) => {
      const s = standings.get(ref.id);
      const v = s?.verdictId ? verdicts.get(s.verdictId) : undefined;
      return {
        criterionId: ref.id, text: ref.text,
        mark: waived.has(ref.id) ? 'waived' : missionMark(s, v?.verdict),
        evidence: evidenceLinks(v?.evidence),
      };
    });
    const outcome: DeliveryOutcome = state?.verdict === 'pass' ? 'verified' : state?.verdict === 'fail' ? 'fail' : 'unverified';
    const waivedBy = (criterion.waived ?? []).map((w) => ({ criterionId: w.criterionId, by: names.get(personId(w.by) ?? '') ?? 'a person' }));
    const delivered = r.status === 'completed';
    const links: DeliveryEvidence[] = state?.workerTaskId && isUuid(state.workerTaskId)
      ? [{ label: 'Final verification', href: `/app/tasks/${state.workerTaskId}` }]
      : [];
    return {
      kind: 'mission', id: r.id, title: r.title, href: `/app/missions/${r.id}`,
      builtTo: criterion.revision, provisional: !!criterion.provisional, delivered,
      deliveredText: deliveredSentence({ builtTo: criterion.revision, provisional: !!criterion.provisional, delivered }),
      standing: standingSentence({ builtTo: criterion.revision, approved, outcome, criteria, waivedBy }),
      criteria, links, at: new Date(r.createdAt).toISOString(),
    };
  }));
}

/**
 * The Delivery and verification entries of one spec, one page. Null when the
 * spec is not there or the reader does not reach its workspace (the page then
 * shows no section, never an error).
 */
export async function readSpecDelivery(caller: SpecCaller, specId: string, opts: { limit?: number; cursor?: string | null } = {}): Promise<SpecDelivery | null> {
  if (!isUuid(specId)) return null;
  const [spec] = await db.select({ id: specs.id, workspaceId: specs.workspaceId, approvedRevision: specs.approvedRevision })
    .from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return null;
  const limit = Math.min(Math.max(opts.limit ?? DELIVERY_PAGE, 1), 50);
  const cursor = decodeCursor(opts.cursor);

  const [taskRows, missionRows] = await Promise.all([
    pinnedTaskRows(spec.workspaceId, spec.id, { limit: limit + 1, cursor }),
    selectingMissionRows(spec.workspaceId, spec.id, { limit: limit + 1, cursor }),
  ]);
  // One newest-first order over both, by the same (created, id) key the cursor uses.
  const merged = [
    ...taskRows.map((r) => ({ kind: 'task' as const, at: new Date(r.createdAt).toISOString(), id: r.id })),
    ...missionRows.map((r) => ({ kind: 'mission' as const, at: new Date(r.createdAt).toISOString(), id: r.id })),
  ].sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1));
  const page = merged.slice(0, limit);
  const keep = new Set(page.map((p) => `${p.kind}:${p.id}`));
  const [t, m] = await Promise.all([
    taskEntries(taskRows.filter((r) => keep.has(`task:${r.id}`)), spec.approvedRevision),
    missionEntries(missionRows.filter((r) => keep.has(`mission:${r.id}`)), spec.id, spec.approvedRevision),
  ]);
  const byKey = new Map([...t, ...m].map((e) => [`${e.kind}:${e.id}`, e]));
  const entries = page.map((p) => byKey.get(`${p.kind}:${p.id}`)!).filter(Boolean);
  const last = page[page.length - 1];
  return { entries, next: merged.length > limit && last ? encodeCursor(last) : null };
}
