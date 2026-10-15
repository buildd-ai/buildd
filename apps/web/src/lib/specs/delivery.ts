import { db } from '@buildd/core/db';
import { specOutcomeVerdicts, specs, tasks } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { getDeliveryViewsForTasks } from '@/lib/workflow/delivery-view';
import { readGovernedOutcome, type OutcomeView } from './outcome';
import { reach, type SpecCaller } from './store';
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

  const taskRows = await pinnedTaskRows(spec.workspaceId, spec.id, { limit: limit + 1, cursor });
  const merged = taskRows.map((r) => ({ at: new Date(r.createdAt).toISOString(), id: r.id }));
  const page = merged.slice(0, limit);
  const keep = new Set(page.map((p) => p.id));
  const entries = await taskEntries(taskRows.filter((r) => keep.has(r.id)), spec.approvedRevision);
  const last = page[page.length - 1];
  return { entries, next: merged.length > limit && last ? encodeCursor(last) : null };
}
