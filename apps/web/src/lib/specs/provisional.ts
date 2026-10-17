import { db } from '@buildd/core/db';
import { missionNotes, specOutcomeVerdicts, specRevisions, specs, tasks, workers } from '@buildd/core/db/schema';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { requestingPerson } from '@/lib/request-person';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { criterionChecks } from '@buildd/spec-contract/check-lines';
import { inScope, scopeOf } from '@buildd/spec-contract/scope';
import type { WaitingOnYouRawItem } from '@/lib/action-queue';
import { readPinnedSpecRevision } from './pin';
import { diffSpecBodies } from './diff';
import { currentPrHeadSha } from './outcome';
import { dispatchCriterionChecks, type CheckDeps } from './criterion-checks';
import { criterionTexts, withSpecSourceBlock } from './provisional-text';
import { fail, reach, type SpecCaller, type SpecError } from './store';

/**
 * Building ahead of approval (living-specs.md §20, decision D-14).
 *
 * Work filed against a draft carries a provisional pin to the exact revision
 * it was built against (./pin.ts). When a person approves revision M, every
 * provisional pin on that spec re-pins to M and is re-graded there
 * (`regradeProvisionalPins`, run from approveSpecRevision's after-response
 * work): each checked criterion reruns at the task's PR head, a verdict on N
 * carries to M only when the criterion's text is unchanged, the N-to-M diff is
 * posted to the task as a note, and the PR text says what happened. One
 * statement moves each pin only while it still names N and is provisional, so
 * a second run writes nothing.
 *
 * `attachProvisional` pins finished work after the fact (a person or an admin
 * token, never an agent run), and `loadProvisionalNeedsYou` puts merged
 * provisional work nobody approved in front of the people who may approve it.
 */

/** Merged provisional work older than this, with no approval, needs a person (R-42). */
export const PROVISIONAL_UNAPPROVED_DAYS = 3;
export const MAX_ATTACH_TASKS = 50;

export interface ProvisionalDeps {
  /** Wakes a filed check run (criterion-checks.ts); dispatch's own when unset. */
  wake?: CheckDeps['wake'];
  /** Rewrites the task's PR body with `rewrite`; returns what happened, in a word or two. Never throws. */
  rewritePrBody: (taskId: string, rewrite: (body: string) => string) => Promise<string>;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const PR_URL = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

async function defaultRewritePrBody(taskId: string, rewrite: (body: string) => string): Promise<string> {
  try {
    const [w] = await db.select({ workspaceId: workers.workspaceId, prUrl: workers.prUrl, prNumber: workers.prNumber })
      .from(workers).where(and(eq(workers.taskId, taskId), isNotNull(workers.prNumber))).orderBy(desc(workers.createdAt)).limit(1);
    if (!w?.prNumber) return 'no PR';
    const [{ linkedRepo }, { githubApi }] = await Promise.all([import('./repo-source'), import('@/lib/github')]);
    const repo = await linkedRepo(w.workspaceId);
    if (!repo) return 'no linked repo';
    // The PR's own repo, from its URL; the workspace's link only when the URL has none.
    const fullName = (w.prUrl && PR_URL.exec(w.prUrl)?.[1]) || repo.fullName;
    const path = `/repos/${fullName}/pulls/${w.prNumber}`;
    const pr = await githubApi(repo.installationId, path);
    const body = typeof pr?.body === 'string' ? pr.body : '';
    const next = rewrite(body);
    if (next === body) return 'unchanged';
    await githubApi(repo.installationId, path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: next }) });
    return 'updated';
  } catch (err) {
    return `failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
  }
}

/** Overridable for tests. */
export const provisionalDeps: ProvisionalDeps = { rewritePrBody: defaultRewritePrBody };

export interface Regraded {
  taskId: string;
  from: number;
  to: number;
  carried: string[];
  rerun: number;
  noteId: string | null;
  pr: string;
  scopeDropped: boolean;
}

/**
 * Re-pin every provisional pin on `specId` to approved revision `approved`
 * and re-grade it there (R-39 to R-41). `taskIds` narrows it to those tasks
 * (attach_provisional). Never throws for one task's failure.
 */
export async function regradeProvisionalPins(
  specId: string,
  approved: number,
  opts: { taskIds?: readonly string[] } = {},
  deps: ProvisionalDeps = provisionalDeps,
): Promise<{ regraded: Regraded[]; reason?: string }> {
  if (!isUuid(specId)) return { regraded: [], reason: 'not a spec id' };
  const [spec] = await db.select({ workspaceId: specs.workspaceId, title: specs.title, approvedRevision: specs.approvedRevision }).from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || spec.approvedRevision !== approved) return { regraded: [], reason: `revision ${approved} is not the approved revision` };
  const [revM] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, approved), isNotNull(specRevisions.approvedAt))).limit(1);
  if (!revM) return { regraded: [], reason: `revision ${approved} is not approved` };
  const readM = await readPinnedSpecRevision({ specId, specRevisionId: revM.id, contentHash: revM.contentHash });
  if (!readM.ok) return { regraded: [], reason: readM.reason };
  if (opts.taskIds && opts.taskIds.length === 0) return { regraded: [] };

  const candidates = await db.select({ id: tasks.id, missionId: tasks.missionId, context: tasks.context }).from(tasks).where(and(
    eq(tasks.workspaceId, spec.workspaceId),
    sql`${tasks.context} @> ${JSON.stringify({ specSource: { specId, provisional: true } })}::jsonb`,
    ...(opts.taskIds ? [inArray(tasks.id, [...opts.taskIds])] : []),
  ));

  const idsM = specCriteria(readM.body).map((c) => c.id);
  const textsM = criterionTexts(readM.body);
  const checkedM = new Set(criterionChecks(readM.body).map((c) => c.criterionId));
  const out: Regraded[] = [];

  for (const task of candidates) {
    try {
      const r = await regradeOne(task, { specId, title: spec.title, revM, bodyM: readM.body, idsM, textsM, checkedM }, deps);
      if (r) out.push(r);
    } catch (err) {
      console.error(`[spec-provisional] re-grade of task ${task.id} failed:`, err);
    }
  }
  return { regraded: out };
}

type Target = {
  specId: string; title: string; revM: typeof specRevisions.$inferSelect; bodyM: string;
  idsM: string[]; textsM: Map<string, string>; checkedM: Set<string>;
};

async function regradeOne(task: { id: string; missionId: string | null; context: unknown }, m: Target, deps: ProvisionalDeps): Promise<Regraded | null> {
  const src = asRecord(asRecord(task.context)?.specSource);
  if (!src || typeof src.specRevisionId !== 'string' || typeof src.revision !== 'number') return null;
  if (src.revision > m.revM.revision) return null;
  const from = src.revision;
  const readN = await readPinnedSpecRevision(src);
  const bodyN = readN.ok ? readN.body : null;

  // A scope keeps only the ids M still has; none left, it is dropped (R-39).
  const scope = scopeOf(src);
  const kept = scope ? scope.filter((id) => m.idsM.includes(id)) : null;
  const scopeDropped = !!scope && kept!.length === 0;
  const { provisional: _p, criteria: _c, explicit: _e, ...rest } = src;
  const pin: Record<string, unknown> = {
    ...rest,
    specRevisionId: m.revM.id,
    revision: m.revM.revision,
    contentHash: m.revM.contentHash,
    ...(kept && kept.length > 0 ? { criteria: kept } : {}),
    regradedFrom: { specRevisionId: src.specRevisionId, revision: from, contentHash: src.contentHash },
    regradedAt: new Date().toISOString(),
  };

  // The one write that decides: only while the pin still names N and is provisional.
  const moved = await db.execute(sql`
    UPDATE ${tasks} SET context = jsonb_set(context, '{specSource}', ${JSON.stringify(pin)}::jsonb), updated_at = now()
    WHERE id = ${task.id}::uuid
      AND context->'specSource'->>'provisional' = 'true'
      AND context->'specSource'->>'specRevisionId' = ${src.specRevisionId}
    RETURNING id`);
  if (((moved as { rows?: unknown[] }).rows ?? []).length === 0) return null;

  // Verdicts on N carry to M only where the criterion's text is unchanged (R-40).
  const carried: string[] = [];
  const notCarried: string[] = [];
  const inM = inScope(pin, m.idsM.map((id) => ({ id })) ).map((c) => c.id);
  if (bodyN) {
    const textsN = criterionTexts(bodyN);
    const rows = await db.select().from(specOutcomeVerdicts)
      .where(and(eq(specOutcomeVerdicts.taskId, task.id), eq(specOutcomeVerdicts.specRevisionId, src.specRevisionId)))
      .orderBy(asc(specOutcomeVerdicts.createdAt));
    const newest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) newest.set(r.criterionId, r);
    for (const id of inM) {
      const v = newest.get(id);
      if (!v) continue;
      const evidence = asRecord(v.evidence) ?? {};
      const byCheck = typeof evidence.recordedBy === 'string' && evidence.recordedBy.startsWith('check:');
      if (textsN.get(id) !== m.textsM.get(id) || (byCheck && m.checkedM.has(id))) { notCarried.push(id); continue; }
      await db.insert(specOutcomeVerdicts).values({
        workspaceId: v.workspaceId, taskId: task.id, specRevisionId: m.revM.id, criterionId: id, verdict: v.verdict, headSha: v.headSha,
        evidence: { ...evidence, carriedFrom: { verdictId: v.id, specRevisionId: src.specRevisionId, revision: from } },
      });
      carried.push(id);
    }
  }

  // Checks rerun at the PR head through the existing check runs (§7).
  const head = await currentPrHeadSha(task.id);
  let rerun = 0;
  if (head) {
    const [w] = await db.select({ branch: workers.branch }).from(workers).where(eq(workers.taskId, task.id)).orderBy(desc(workers.createdAt)).limit(1);
    rerun = (await dispatchCriterionChecks({ taskId: task.id, headSha: head, headBranch: w?.branch ?? null }, deps.wake ? { wake: deps.wake } : {})).dispatched;
  }

  // The note: what changed from N to M, what carried and what reruns (R-41).
  const diff = bodyN ? diffSpecBodies(bodyN, m.bodyM) : null;
  const lines = [
    `This work was built ahead of approval, against revision ${from} of "${m.title}". A person approved revision ${m.revM.revision}, so it is now graded against revision ${m.revM.revision}.`,
    '',
    carried.length ? `Verdicts carried over (criterion text unchanged): ${carried.join(', ')}.` : 'No verdicts carried over.',
    ...(notCarried.length ? [`Not carried (the text changed, or a check reruns it): ${notCarried.join(', ')}.`] : []),
    head ? `Check runs filed at the PR head ${head.slice(0, 7)}: ${rerun}.` : 'No PR head is known, so no checks were rerun.',
    ...(scopeDropped ? [`None of the criteria this task answered for (${scope!.join(', ')}) are in revision ${m.revM.revision}, so it now answers for all of them.`] : []),
    '',
    `Changes from revision ${from} to revision ${m.revM.revision}:`,
    diff === null ? `(revision ${from} could not be read: ${readN.ok ? '' : readN.reason})`
      : diff.identical ? '(no change)'
      : ['```diff', diff.diff, '```', ...(diff.omittedLines ? [`(${diff.omittedLines} more diff lines not shown)`] : [])].join('\n'),
  ];
  const [note] = await db.insert(missionNotes).values({
    missionId: task.missionId,
    taskId: task.id,
    authorType: 'system',
    type: 'update',
    title: `Spec approved at revision ${m.revM.revision}: re-graded from revision ${from}`,
    body: lines.join('\n'),
    actorLabel: 'living specs: approval re-grade',
  }).returning({ id: missionNotes.id });

  const pr = await deps.rewritePrBody(task.id, (body) => withSpecSourceBlock(body, pin)).catch((e) => `failed: ${String(e)}`);

  // The record, on the pin itself.
  const regrade = { carried, notCarried, rerun, headSha: head, noteId: note?.id ?? null, pr };
  await db.execute(sql`
    UPDATE ${tasks} SET context = jsonb_set(context, '{specSource,regrade}', ${JSON.stringify(regrade)}::jsonb)
    WHERE id = ${task.id}::uuid AND context->'specSource'->>'specRevisionId' = ${m.revM.id}`);

  return { taskId: task.id, from, to: m.revM.revision, carried, rerun, noteId: note?.id ?? null, pr, scopeDropped };
}

export interface AttachResult { taskId: string; attached: boolean; reason?: string }

const NOT_A_PERSON = 'Attaching finished work to a spec revision is a person\'s act, or an admin token\'s: an agent run cannot attach work, its own or another\'s.';

/**
 * attach_provisional (R-43): pin finished tasks to the revision they were
 * built against. A person or an admin token; an agent run or a plain key is a 403.
 */
export async function attachProvisional(caller: SpecCaller, specId: unknown, input: { revision: unknown; taskIds: unknown }, deps: ProvisionalDeps = provisionalDeps): Promise<
  { ok: true; revision: number; provisional: boolean; results: AttachResult[]; regraded: Regraded[] } | SpecError
> {
  if (typeof specId !== 'string' || !isUuid(specId)) return fail(404, 'Spec not found');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, true))) return fail(404, 'Spec not found');
  let label: string;
  if (caller.kind === 'user') label = `user:${caller.userId}`;
  else {
    const account = caller.account as typeof caller.account & { level?: unknown };
    const person = requestingPerson(null, account);
    if (account.taskScope) return fail(403, NOT_A_PERSON);
    if (person) label = `user:${person}`;
    else if (account.level === 'admin') label = `account:${account.id}`;
    else return fail(403, NOT_A_PERSON);
  }

  if (!Number.isInteger(input.revision)) return fail(400, 'revision (the spec revision the work was built against) is required');
  const ids = input.taskIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ATTACH_TASKS || !ids.every((id) => typeof id === 'string' && isUuid(id))) {
    return fail(400, `taskIds must list 1 to ${MAX_ATTACH_TASKS} task ids`);
  }
  const taskIds = [...new Set(ids as string[])];
  const [rev] = await db.select().from(specRevisions).where(and(eq(specRevisions.specId, specId), eq(specRevisions.revision, input.revision as number))).limit(1);
  if (!rev) return fail(409, `This spec has no revision ${input.revision as number} (it has revisions 1 to ${spec.headRevision})`);

  const provisional = rev.approvedAt === null;
  const pin = {
    specId, specRevisionId: rev.id, revision: rev.revision, contentHash: rev.contentHash,
    ...(provisional ? { provisional: true } : { explicit: true }),
    attachedBy: label, attachedAt: new Date().toISOString(),
  };

  const rows = await db.select({ id: tasks.id, workspaceId: tasks.workspaceId, status: tasks.status, context: tasks.context }).from(tasks).where(inArray(tasks.id, taskIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const results: AttachResult[] = [];
  for (const id of taskIds) {
    const t = byId.get(id);
    if (!t || t.workspaceId !== spec.workspaceId) { results.push({ taskId: id, attached: false, reason: 'not a task in this spec\'s workspace' }); continue; }
    if (t.status !== 'completed') { results.push({ taskId: id, attached: false, reason: `the task is ${t.status}, not finished` }); continue; }
    const existing = asRecord(asRecord(t.context)?.specSource);
    if (existing && typeof existing.specId === 'string') { results.push({ taskId: id, attached: false, reason: 'the task is already pinned to a Living Spec' }); continue; }
    const r = await db.execute(sql`
      UPDATE ${tasks}
      SET context = coalesce(context, '{}'::jsonb) || jsonb_build_object('specSource', coalesce(context->'specSource', '{}'::jsonb) || ${JSON.stringify(pin)}::jsonb),
          updated_at = now()
      WHERE id = ${id}::uuid AND status = 'completed' AND (context->'specSource'->>'specId') IS NULL
      RETURNING id`);
    const ok = ((r as { rows?: unknown[] }).rows ?? []).length > 0;
    results.push(ok ? { taskId: id, attached: true } : { taskId: id, attached: false, reason: 'the task changed while attaching; read it again' });
  }

  // Already approved past the named revision: grade the attached work there now.
  const attached = results.filter((r) => r.attached).map((r) => r.taskId);
  const regraded = provisional && spec.approvedRevision !== null && spec.approvedRevision > rev.revision && attached.length > 0
    ? (await regradeProvisionalPins(specId, spec.approvedRevision, { taskIds: attached }, deps)).regraded
    : [];
  return { ok: true, revision: rev.revision, provisional, results, regraded };
}

/**
 * Needs You (R-42): a spec with provisional work merged more than
 * PROVISIONAL_UNAPPROVED_DAYS ago and still unapproved, for a viewer who may
 * approve it. Re-derived from the task and worker rows on every read. Never
 * throws (Home keeps every other card).
 */
export async function loadProvisionalNeedsYou(userId: string | null | undefined, workspaceIds: readonly string[], now = Date.now()): Promise<WaitingOnYouRawItem[]> {
  if (!userId || workspaceIds.length === 0) return [];
  try {
    const cutoff = new Date(now - PROVISIONAL_UNAPPROVED_DAYS * 86_400_000).toISOString();
    const specIdOf = sql<string>`${tasks.context}->'specSource'->>'specId'`;
    const groups = await db.select({
      specId: specIdOf,
      n: sql<number>`count(distinct ${tasks.id})::int`,
      revision: sql<number>`max((${tasks.context}->'specSource'->>'revision')::int)`,
    }).from(tasks)
      .innerJoin(workers, and(eq(workers.taskId, tasks.id), isNotNull(workers.mergedAt)))
      .where(and(inArray(tasks.workspaceId, [...workspaceIds]), sql`${tasks.context}->'specSource'->>'provisional' = 'true'`))
      .groupBy(specIdOf)
      .having(sql`min(${workers.mergedAt}) < ${cutoff}::timestamptz`)
      .limit(50);
    const specIds = groups.map((g) => g.specId).filter((id): id is string => typeof id === 'string' && isUuid(id));
    if (specIds.length === 0) return [];
    const rows = await db.select({ id: specs.id, title: specs.title, workspaceId: specs.workspaceId, status: specs.status }).from(specs).where(inArray(specs.id, specIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const { specApprover } = await import('./approval');
    const mayApprove = new Map<string, boolean>();
    const items: WaitingOnYouRawItem[] = [];
    for (const g of groups) {
      const s = byId.get(g.specId);
      if (!s || s.status === 'retired' || s.status === 'superseded') continue;
      if (!mayApprove.has(s.workspaceId)) mayApprove.set(s.workspaceId, (await specApprover({ kind: 'user', userId }, s.workspaceId)) !== null);
      if (!mayApprove.get(s.workspaceId)) continue;
      items.push({
        kind: 'spec_provisional',
        specId: s.id,
        specTitle: s.title,
        workspaceId: s.workspaceId,
        failureMessage: `${g.n} merged ${g.n === 1 ? 'task was' : 'tasks were'} built against revision ${g.revision} of "${s.title}", and nobody has approved it yet. Approving it grades that work.`,
        fixHref: `/app/specs/${s.id}`,
        fixLabel: 'Review spec',
      });
    }
    return items;
  } catch (err) {
    console.warn('[spec-provisional] Home read failed (non-fatal):', (err as Error)?.message ?? err);
    return [];
  }
}
