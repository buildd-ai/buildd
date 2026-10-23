import { currentFiling, filingViews, filingViewsFrom, type FilingRow, type FilingView } from './filings';
import { organizeWorkspace } from './organize';
import { db } from '@buildd/core/db';
import { artifactRevisions, artifacts, specFilings, specRevisions, specs, users } from '@buildd/core/db/schema';
import { readRound } from '@/lib/read-round';
import { and, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import type { HubWorkspace } from './hub';
import { isUuid } from '@/lib/uuid';
import { fail, importedRefusal, listSpecIndexRows, personReach, reach, type SpecCaller, type SpecError, type SpecRevisionRow, type SpecRow } from './store';
import { after } from 'next/server';
import { TTLCache } from '@/lib/cache';
import { commentsOnRevision, type CommentView } from './comments';
import { criteriaUnreadText, specCriteria } from '@buildd/spec-contract/requirements';
import { outlineOf } from '@buildd/core/artifact-read';
import { specApprover } from './approval';
import { diffSpecRowRevisions, type DiffHunk } from './diff';
import { linkedRepoFullName } from './repo-source';
import { approvedDesignDrift } from './design';
import { attachmentSources, attachmentViews, sourcesOf, type AttachmentSource, type AttachmentView } from './attachments';
import { readSpecNeighbours, suggestParent, type NearbySpec } from './neighbours';
import { filingFacts, proposalAreas, type AreaProposal, type SpecIndexInput, type SpecSuggestion } from './index-view';
import type { RepoRef } from './repo-refs';
import { nativeSourceOn, repoCopyLine, repoCopyPreflight, type RepoCopyPreflight } from './repo-copy';
import { readSpecDelivery, type SpecDelivery } from './delivery';
import { specRestoredRepoFile, specRetirement, type RetirementView } from './retire';
import { revisionReview, type RevisionReview } from './revision-changes';
import { readCriterionHistory, type CriterionHistory } from './criteria';
import { importConfirmPath } from './import';
import { holdsInWorkspace } from '@/lib/team-access';

/**
 * What the dashboard's spec pages show (living-specs.md §9): a workspace's
 * specs as a tree, and one spec's revision in force, its history, the changes
 * between two revisions and, for a person who may approve, the waiting
 * revision with one Approve action. Read-only: every read goes through the
 * same reach check and readers as the specs API (store.ts, diff.ts), and
 * approving stays §6's route.
 */

/** "3d ago", for a page rendered on the server (no hydration: the strings are part of the view). */
export function ago(at: Date | string, now = Date.now()): string {
  const mins = Math.floor((now - new Date(at).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type StandingInput = Pick<SpecRow, 'status' | 'approvedRevision' | 'headRevision'>;

/** Where a spec stands, in words, and the revision waiting for approval when the head is newer than the approved one. */
export function specStanding(s: StandingInput): { standing: string; waiting: number | null } {
  if (s.status === 'retired' || s.status === 'superseded') return { standing: s.status, waiting: null };
  if (s.approvedRevision == null) return { standing: 'draft, never approved', waiting: null };
  return {
    standing: `approved at revision ${s.approvedRevision}`,
    waiting: s.headRevision > s.approvedRevision ? s.headRevision : null,
  };
}

export interface SpecListItem {
  id: string;
  title: string;
  scope: string;
  standing: string;
  waiting: number | null;
  updatedAt: string;
  /** When it last changed, in words. */
  updatedAgo: string;
  children: SpecListItem[];
}

/** Specs as a tree by parent; a spec whose parent is not in `rows` sits at the top. Order is kept within each level. */
export function specTree(rows: ReadonlyArray<SpecRow>): SpecListItem[] {
  const ids = new Set(rows.map((r) => r.id));
  const byId = new Map<string, SpecListItem>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id, title: r.title, scope: r.scope, ...specStanding(r),
      updatedAt: new Date(r.updatedAt).toISOString(), updatedAgo: ago(r.updatedAt), children: [],
    });
  }
  const roots: SpecListItem[] = [];
  for (const r of rows) {
    const item = byId.get(r.id)!;
    if (r.parentSpecId && ids.has(r.parentSpecId) && r.parentSpecId !== r.id) byId.get(r.parentSpecId)!.children.push(item);
    else roots.push(item);
  }
  return roots;
}

/** A cited repo file at its commit on GitHub; null without a linked repo. */
export function repoRefHref(fullName: string | null, ref: RepoRef): string | null {
  if (!fullName) return null;
  return `https://github.com/${fullName}/blob/${ref.commitSha}/${ref.path.split('/').map(encodeURIComponent).join('/')}`;
}

export type SpecListView =
  | { state: 'not_found' }
  | {
    state: 'ok';
    workspace: { id: string; name: string };
    /** The specs flat, for the index (§19): filings, suggestions and all. */
    index: SpecIndexInput[];
    /** A cold-start taxonomy proposal's areas (§17 R-4), shown as possible areas. */
    proposals: AreaProposal[];
    /** The reader may file, undo, dismiss and accept (write access). */
    canAct: boolean;
    /** The reader may confirm imports here (approve_specs, §18 R-19). */
    canConfirm: boolean;
    /** When the page was read, so relative times match between server and client. */
    now: number;
  };

/** Unfiled specs with no filing row that get a `suggestParent` guess on one page load; the sweep (§17 R-10) records the rest. */
export const MAX_LIST_SUGGESTIONS = 12;

/**
 * The newest filed or suggested placement still in effect, per spec, in one
 * workspace (§17): one row per spec (DISTINCT ON), and of the proposal only
 * the keys a filing's view reads. A parent is named from `titles` (the specs
 * the page already holds) when given, else read.
 */
async function liveFilings(workspaceId: string, titles?: ReadonlyMap<string, string>): Promise<Map<string, FilingView>> {
  const rows = await db.selectDistinctOn([specFilings.specId], {
    id: specFilings.id, workspaceId: specFilings.workspaceId, specId: specFilings.specId, kind: specFilings.kind,
    status: specFilings.status, parentSpecId: specFilings.parentSpecId, previousParentId: specFilings.previousParentId,
    source: specFilings.source, createdAt: specFilings.createdAt,
    proposal: sql<Record<string, unknown> | null>`jsonb_build_object('p', ${specFilings.proposal}->'p', 'answer', ${specFilings.proposal}->'answer', 'title', ${specFilings.proposal}->'title', 'charter', ${specFilings.proposal}->'charter')`,
  }).from(specFilings)
    .where(and(eq(specFilings.workspaceId, workspaceId), inArray(specFilings.kind, ['filed', 'suggested']), inArray(specFilings.status, ['applied', 'open'])))
    .orderBy(specFilings.specId, desc(specFilings.createdAt));
  const newest = new Map(rows.map((r) => [r.specId, r as unknown as FilingRow]));
  const views = titles ? filingViewsFrom([...newest.values()], titles) : await filingViews([...newest.values()]);
  return new Map(views.map((v, i) => [[...newest.keys()][i], v]));
}

/**
 * Parent guesses for unfiled specs no filing names (§14 `suggestParent`):
 * they ask the embedding service, so a page never computes them before it
 * responds (spec 3ef37387 R-14). The page shows the guesses this server
 * worked out after an earlier load, and works out the missing ones after it
 * responds.
 */
const parentGuesses = new TTLCache<SpecSuggestion | null>({ maxSize: 5000, ttlMs: 10 * 60 * 1000 });
const guessKey = (workspaceId: string, r: { id: string; title: string }) => `${workspaceId}:${r.id}:${r.title}`;

/** A row the index reads: the index listing, or a whole spec row. */
type IndexInputRow = Pick<SpecRow, 'id' | 'title' | 'scope' | 'parentSpecId' | 'status' | 'approvedRevision' | 'headRevision' | 'updatedAt'>
  & { repoSourceState?: string | null; repoSource?: SpecRow['repoSource'] };

/**
 * The index rows (§19). Placement comes from `spec_filings` (§17): a filing
 * in effect is "Filed by buildd" with its undo, an open suggestion is the
 * unfiled spec's suggestion. An unfiled spec with no filing row at all gets
 * `suggestParent` (§14) on its title, fail-open, for at most
 * MAX_LIST_SUGGESTIONS of them, worked out after the response (parentGuesses).
 * Every read fails open: a missing filing never hides a spec.
 */
export async function specIndexInputs(workspaceId: string, rows: ReadonlyArray<IndexInputRow>): Promise<SpecIndexInput[]> {
  const ids = new Set(rows.map((r) => r.id));
  const titles = new Map(rows.map((r) => [r.id, r.title]));
  const filings = await liveFilings(workspaceId, titles).catch(() => new Map<string, FilingView>());
  const unfiled = rows.filter((r) => !(r.scope === 'product' || r.scope === 'domain') && !(r.parentSpecId && ids.has(r.parentSpecId)));
  const guesses = new Map<string, SpecSuggestion>();
  const toGuess: IndexInputRow[] = [];
  for (const r of unfiled.filter((x) => !filings.has(x.id)).slice(0, MAX_LIST_SUGGESTIONS)) {
    const g = parentGuesses.get(guessKey(workspaceId, r));
    if (g === undefined) toGuess.push(r);
    else if (g && g.kind === 'parent' && ids.has(g.specId)) guesses.set(r.id, g);
  }
  if (toGuess.length) {
    afterResponse(async () => {
      await Promise.all(toGuess.map(async (r) => {
        const s = await suggestParent(workspaceId, r.id, r.title).catch(() => null);
        parentGuesses.set(guessKey(workspaceId, r), s ? { kind: 'parent', specId: s.specId, title: s.title, reason: s.reason } : null);
      }));
    });
  }
  return rows.map((r) => {
    const facts = filingFacts(r, filings.get(r.id));
    return {
      id: r.id, title: r.title, scope: r.scope, parentSpecId: r.parentSpecId, status: r.status,
      approvedRevision: r.approvedRevision, headRevision: r.headRevision, updatedAt: new Date(r.updatedAt).toISOString(),
      imported: (r.repoSourceState ?? r.repoSource?.state) === 'imported',
      filedBy: facts.filedBy ?? null, filingId: facts.filingId ?? null,
      suggestion: facts.suggestion ?? guesses.get(r.id) ?? null,
    };
  });
}

/** Run after the response when there is a request (Next's after()); else now, in the background. */
function afterResponse(fn: () => Promise<void>): void {
  const run = () => fn().catch((err) => console.warn('[specs] deferred work failed:', (err as Error)?.message ?? err));
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * With no product or area yet, the taxonomy buildd would propose (§17 R-4,
 * a dry run: nothing is created). Needs write access, like organize; a reader
 * without it, or any error, gets none. Each area carries which proposal it
 * came from, so accepting it re-reads that same proposal.
 */
async function coldStartProposals(caller: SpecCaller, workspaceId: string, rows: ReadonlyArray<Pick<SpecRow, 'status' | 'scope'>>): Promise<AreaProposal[]> {
  const open = rows.filter((r) => r.status !== 'retired' && r.status !== 'superseded');
  if (open.some((r) => r.scope === 'product' || r.scope === 'domain') || open.length === 0) return [];
  // Never waits on the model: its proposal when organize already asked it, else the word-based one.
  const r = await organizeWorkspace(caller, { workspaceId, dryRun: true }, { cachedOnly: true }).catch(() => null);
  return r?.ok && r.result.mode === 'taxonomy' && r.result.dryRun ? proposalAreas(r.result.proposal, r.result.proposedBy.source) : [];
}

export async function specListView(userId: string, workspaceId: string): Promise<SpecListView> {
  const caller: SpecCaller = { kind: 'user', userId };
  // A person's reach, once for the request: the workspace's name comes with it.
  const ws = await personReach(userId, workspaceId);
  if (!ws) return { state: 'not_found' };
  const r = await listSpecIndexRows(caller, workspaceId);
  if (!r.ok) return { state: 'not_found' };
  // The approver confirms imports and sees what waits for their approval first.
  // For a person, write reach is the read reach above (workspace-access.ts).
  const canAct = true;
  const [index, approver] = await Promise.all([
    specIndexInputs(workspaceId, r.specs),
    specApprover(caller, workspaceId).catch(() => null),
  ]);
  const proposals = canAct ? await coldStartProposals(caller, workspaceId, r.specs) : [];
  return { state: 'ok', workspace: ws, index, proposals, canAct, canConfirm: !!approver, now: Date.now() };
}

/**
 * Spec counts for `/app/specs` over the workspaces of the reader's active team
 * (the layout's scope) that they may read, counted as the index counts them.
 */
export async function specHubWorkspaces(userId: string, all: ReadonlyArray<{ id: string; name: string }>): Promise<HubWorkspace[]> {
  const caller: SpecCaller = { kind: 'user', userId };
  // Only workspaces whose specs this reader may open (a restricted workspace may not be).
  const readable = await Promise.all(all.map((w) => reach(caller, w.id, false).catch(() => false)));
  const list = all.filter((_, i) => readable[i]);
  if (!list.length) return [];
  const rows = await db
    .select({
      workspaceId: specs.workspaceId,
      n: sql<number>`count(*)::int`,
      waiting: sql<number>`count(*) filter (where ${specs.approvedRevision} is not null and ${specs.headRevision} > ${specs.approvedRevision})::int`,
    })
    .from(specs)
    .where(and(
      inArray(specs.workspaceId, list.map((w) => w.id)),
      notInArray(specs.status, ['retired', 'superseded']),
      notInArray(specs.scope, ['product', 'domain']),
    ))
    .groupBy(specs.workspaceId);
  const by = new Map(rows.map((r) => [r.workspaceId, r]));
  return list.map((w) => ({ id: w.id, name: w.name, specs: Number(by.get(w.id)?.n ?? 0), waiting: Number(by.get(w.id)?.waiting ?? 0) }));
}

export interface SpecRevisionLine {
  revision: number;
  author: 'person' | 'agent';
  changeSummary: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  /** createdAt and approvedAt in words. */
  createdAgo: string;
  approvedAgo: string | null;
}

export interface SpecPanes {
  /** Approved revision this one is compared with; null when nothing is approved (or for a plain compare, the `from`). */
  replaces: number | null;
  revision: number;
  hunks: DiffHunk[];
  omittedLines: number;
  linesAdded: number;
  linesRemoved: number;
  sectionCount: number;
  body: string;
  /** What `attachment:<name>` resolves to on `revision` (§21); a name absent here renders as missing. */
  attachmentSources?: Record<string, AttachmentSource>;
  /** Review only: the change summary, the per-criterion change list, the other text and the summary check ("Reviewing a spec revision" R-1 to R-5). */
  changes?: Pick<RevisionReview, 'summary' | 'lines' | 'otherText' | 'mismatch'>;
  /** Review only, nothing approved yet: what this revision changed from the one before it, so a later draft still shows its own change. */
  since?: { revision: number; changes: Pick<RevisionReview, 'summary' | 'lines' | 'otherText' | 'mismatch'> } | null;
}

export type SpecPageView =
  | { state: 'not_found' }
  | {
    state: 'ok';
    spec: { id: string; title: string; scope: string; status: string; workspaceId: string; workspaceName: string; version: number; headRevision: number; approvedRevision: number | null };
    standing: string;
    /** The revision rendered, and whether it is the approved one. */
    reading: { revision: number; approved: boolean; isHead: boolean };
    /** The head, when it is newer than the approved revision (or nothing is approved). */
    waiting: number | null;
    body: string;
    revisions: SpecRevisionLine[];
    parent: { id: string; title: string } | null;
    children: Array<{ id: string; title: string }>;
    /** The other specs under the same parent (§19 R-28), at most MAX_SIBLINGS. */
    siblings: Array<{ id: string; title: string }>;
    repoRefs: Array<{ path: string; sha: string; href: string | null }>;
    /**
     * The design the revision being read is built to (§12), and, when that is
     * the approved revision, whether the design has a newer version since.
     */
    /** Derived neighbours (§14), strongest first, each with why it is near. */
    nearby: NearbySpec[];
    /** Where buildd filed this spec, or the place it suggests (§17), if either is in effect. */
    filing: FilingView | null;
    /** Comments readable on the revision being read (§16), and where one can be added. */
    comments: CommentView[];
    commentAnchors: Array<{ kind: 'criterion' | 'section'; id: string; label: string }>;
    /** The reader may comment (write access) and resolve (a person with write access). */
    canComment: boolean;
    design: { label: string; href: string | null; version: string; screens: string[]; changedSince: { pinned: string; current: string } | null } | null;
    /** The Files section (§21): the attachments that apply to the revision read, each binding one against the approval record. */
    attachments: Array<AttachmentView & { addedAgo: string }>;
    /** What `attachment:<name>` resolves to on the revision read. */
    attachmentSources: Record<string, AttachmentSource>;
    /** Two picked revisions: the changes from `from` to `to`. */
    compare: (SpecPanes & { from: number; to: number }) | { error: string } | null;
    /** The reader may approve the waiting revision. */
    canApprove: boolean;
    /** With `review`: what approving the head would put in force, for an approver only. */
    review: SpecPanes | null;
    /** The one source (§18, R-13) and how the repo copy stands (AC-79); absent when the workspace has not opted in. */
    source?: { source: string | null; path?: string; href?: string; copy: string | null; behind: boolean; publishAnyway?: boolean } | null;
    /** Slice 14, R-68: the reader may publish a kept-private revision anyway (a person who may approve here). */
    canPublishAnyway?: boolean;
    /** A standard of its workspace (Living Specs D-43): its criteria apply to every mission that starts building. */
    standard?: boolean;
    /** The reader may set or clear the standard mark: an owner or admin, from this session. */
    canMarkStandard?: boolean;
    /** An imported spec's criteria the parser could not read, in words ("N criteria could not be read; ..."); null when none. */
    criteriaUnread?: string | null;
    /** The review panel shows the repo checks on the would-be copy (R-34): the workspace writes repo copies and the reader may approve. Fetched by the panel, never read here (they ask GitHub). */
    repoChecks?: boolean;
    /** Delivery and verification (Slice 13): the work that answered to this spec, one page. Null when it cannot be read. */
    delivery?: SpecDelivery | null;
    /** Why and by what the spec is retired (§22), when it is. */
    retirement?: RetirementView | null;
    /** A live spec a person restored after its retirement reached the repo file (R-80): that the file still reads superseded. */
    restoredRepoNote?: string | null;
    /** The reader may retire or restore it (a person with approval rights, §22 R-51), and the live specs that could replace it. */
    canRetire?: boolean;
    retireTargets?: Array<{ id: string; title: string }>;
    /** With `history`: that criterion's wordings ("Reviewing a spec revision" R-12); null when the spec never had it. */
    criterionHistory?: { criterionId: string; history: CriterionHistory | null } | null;
    /**
     * An import waiting for a person's confirmation (§18, R-19). While it is
     * set the repo file is the source: nothing waits for approval, there is no
     * review, and confirming is the one act. `previous` is the earlier
     * import a re-import replaced, to compare the repo's own change against.
     */
    importConfirmation?: { revision: number; path: string; commit: string; href: string | null; canConfirm: boolean; batchHref: string; previous: number | null } | null;
  };

const personLabel = (label: string | null) => (label?.startsWith('user:') ? label.slice(5) : null);

function panes(hunks: DiffHunk[], omittedLines: number, body: string, revision: number, replaces: number | null): SpecPanes {
  return {
    replaces, revision, hunks, omittedLines, body, sectionCount: hunks.length,
    linesAdded: hunks.reduce((n, h) => n + h.linesAdded, 0),
    linesRemoved: hunks.reduce((n, h) => n + h.linesRemoved, 0),
  };
}

/** Siblings read for a spec page; the list shows them all, the graph its own cap. */
export const MAX_SIBLINGS = 12;

type Reading = { revision: SpecRevisionRow; body: string };

/** One revision of a spec row the caller already holds, and its text; null when there is no such revision. */
async function readRevision(spec: SpecRow, n: number): Promise<Reading | null> {
  // One statement: the revision and its body.
  const [row] = await db.select({ revision: specRevisions, content: artifactRevisions.content }).from(specRevisions)
    .leftJoin(artifactRevisions, and(eq(artifactRevisions.artifactId, spec.bodyArtifactId), eq(artifactRevisions.revision, specRevisions.artifactRevision)))
    .where(and(eq(specRevisions.specId, spec.id), eq(specRevisions.revision, n))).limit(1);
  if (!row) return null;
  return { revision: row.revision, body: row.content ?? '' };
}

/**
 * What approving the head would put in force: the approved revision against
 * the head, or with nothing approved the whole head, from the kept review of
 * that pair (R-8), and then also what the head changed from the revision
 * before it (both pairs are kept when a revision is written). The caller has
 * read the spec row, checked reach and checked that the reader may approve.
 */
async function reviewPanes(spec: SpecRow, reading: Reading | null): Promise<SpecPanes | null> {
  const sources = attachmentSources(spec.id, spec.headRevision).catch(() => ({}));
  const headP = reading?.revision.revision === spec.headRevision ? Promise.resolve(reading) : readRevision(spec, spec.headRevision);
  const head = await headP;
  if (!head) return null;
  const bodies = new Map([[spec.headRevision, head.body]]);
  const before = spec.approvedRevision == null && spec.headRevision > 1 ? spec.headRevision - 1 : null;
  const [r, since] = await Promise.all([
    revisionReview(spec, spec.approvedRevision ?? 0, spec.headRevision, bodies),
    before ? revisionReview(spec, before, spec.headRevision, bodies).catch(() => null) : null,
  ]);
  if (!r) return null;
  const review = panes(r.hunks, r.omittedLines, head.body, spec.headRevision, spec.approvedRevision);
  review.changes = { summary: r.summary, lines: r.lines, otherText: r.otherText, mismatch: r.mismatch };
  review.since = before && since ? { revision: before, changes: { summary: since.summary, lines: since.lines, otherText: since.otherText, mismatch: since.mismatch } } : null;
  review.attachmentSources = await sources;
  return review;
}

/**
 * The review panel alone (R-7 to R-10), for the spec page's Review action to
 * fetch without rebuilding the page: the same panes `specPageView` gives with
 * `review`, plus the spec's version for Approve. Only for a person who may
 * approve, and only while a revision waits.
 */
export async function specReviewView(caller: SpecCaller, specId: string): Promise<{ ok: true; review: SpecPanes & { version: number } } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const [row] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!row) return fail(404, 'Spec not found');
  const reached = reach(caller, row.workspaceId, false);
  const [ok, approver] = await Promise.all([reached, specApprover(caller, row.workspaceId, reached)]);
  if (!ok) return fail(404, 'Spec not found');
  if (!approver) return fail(403, 'Only someone who may approve specs here can review a revision for approval.');
  const importRefused = importedRefusal(row);
  if (importRefused) return importRefused;
  const pending = row.approvedRevision == null || row.headRevision > row.approvedRevision;
  if (!pending || row.status === 'retired' || row.status === 'superseded') return fail(409, 'No revision of this spec waits for approval.');
  const review = await reviewPanes(row, null);
  if (!review) return fail(409, `The body of revision ${row.headRevision} could not be read`);
  return { ok: true, review: { ...review, version: row.version } };
}

/**
 * The repo checks on the waiting revision's would-be copy (R-34), on their
 * own request: they ask GitHub, so the review panel shows first and these
 * after (R-9). Null when the workspace writes no repo copies. Same gate as
 * the review panel.
 */
export async function specRepoChecks(caller: SpecCaller, specId: string): Promise<{ ok: true; revision: number; preflight: RepoCopyPreflight | null } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const [row] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!row) return fail(404, 'Spec not found');
  const reached = reach(caller, row.workspaceId, false);
  const [ok, approver] = await Promise.all([reached, specApprover(caller, row.workspaceId, reached)]);
  if (!ok) return fail(404, 'Spec not found');
  if (!approver) return fail(403, 'Only someone who may approve specs here can see the repo checks on a waiting revision.');
  const p = await repoCopyPreflight(row, row.headRevision).catch(() => null);
  return { ok: true, revision: row.headRevision, preflight: p?.state === 'off' ? null : p };
}

/**
 * The spec page. Every read that needs only the spec row starts at once, after
 * the one reach check they all share; the ones that need the revision read
 * wait for that read alone. neon-http pays a round trip per statement, so the
 * page costs the longest chain of reads, not their sum.
 */
export async function specPageView(userId: string, specId: string, opts: { revision?: number; from?: number; to?: number; review?: boolean; deliveryCursor?: string; history?: string } = {}): Promise<SpecPageView> {
  if (!isUuid(specId)) return { state: 'not_found' };
  const caller: SpecCaller = { kind: 'user', userId };
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec) return { state: 'not_found' };
  // The person's reach, once: it carries the workspace's name and Living Specs settings.
  const wsRowP = personReach(userId, spec.workspaceId);
  const reached = wsRowP.then((w) => !!w);
  const approverP = specApprover(caller, spec.workspaceId, reached);
  // The standard mark (D-43) is an owner's or admin's: the same cached role read specApprover makes first.
  const ownerOrAdminP = holdsInWorkspace(userId, spec.workspaceId, 'approve_specs').catch(() => false);
  if (!(await reached)) {
    await approverP.catch(() => null);
    return { state: 'not_found' };
  }

  const open = spec.status !== 'retired' && spec.status !== 'superseded';
  // An unconfirmed import is not waiting for approval (approve refuses it, store.ts importedRefusal): it waits for confirm_import.
  const imported = spec.repoSource?.state === 'imported' ? spec.repoSource : null;
  const pending = !imported && (spec.approvedRevision == null || spec.headRevision > spec.approvedRevision);
  const readN = opts.revision ?? spec.approvedRevision ?? spec.headRevision;
  const readP = readRevision(spec, readN);
  const wsP = wsRowP.then((w) => [w ? { name: w.name, gitConfig: { livingSpecs: w.livingSpecs } } : undefined] as const);
  // One round trip for the reads that need only the spec row and who is asking
  // (readRound): revisions, parent, siblings, children and, for someone who may
  // retire it, the replacements they may pick (§22: live specs of the workspace).
  const roundP = approverP.catch(() => null).then((approver) => readRound({
    revRows: db.select({
      id: specRevisions.id, revision: specRevisions.revision, authorKind: specRevisions.authorKind, changeSummary: specRevisions.changeSummary,
      approvedBy: specRevisions.approvedBy, approvedAt: specRevisions.approvedAt, createdAt: specRevisions.createdAt,
    }).from(specRevisions).where(eq(specRevisions.specId, specId)).orderBy(desc(specRevisions.revision)),
    // Parent, siblings and children only from the same workspace (a parent is always there, §1).
    parent: spec.parentSpecId
      ? db.select({ id: specs.id, title: specs.title }).from(specs)
        .where(and(eq(specs.workspaceId, spec.workspaceId), eq(specs.id, spec.parentSpecId))).limit(1)
      : null,
    siblings: spec.parentSpecId
      ? db.select({ id: specs.id, title: specs.title }).from(specs)
        .where(and(eq(specs.workspaceId, spec.workspaceId), eq(specs.parentSpecId, spec.parentSpecId), ne(specs.id, spec.id)))
        .orderBy(specs.title).limit(MAX_SIBLINGS)
      : null,
    children: db.select({ id: specs.id, title: specs.title }).from(specs)
      .where(and(eq(specs.workspaceId, spec.workspaceId), eq(specs.parentSpecId, spec.id))).orderBy(specs.title),
    retireTargets: approver && open
      ? db.select({ id: specs.id, title: specs.title }).from(specs)
        .where(and(eq(specs.workspaceId, spec.workspaceId), ne(specs.id, spec.id), notInArray(specs.status, ['retired', 'superseded'])))
        .orderBy(specs.title).limit(200)
      : null,
  }));
  const revRowsP = roundP.then((r) => r.revRows);
  const namesP = revRowsP.then(async (revRows) => {
    const approverIds = [...new Set(revRows.map((r) => personLabel(r.approvedBy)).filter((v): v is string => !!v && isUuid(v)))];
    const names = new Map<string, string>();
    if (approverIds.length) {
      for (const u of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, approverIds))) {
        if (u.name) names.set(u.id, u.name);
      }
    }
    return names;
  });
  const parentP = roundP.then((r) => r.parent ?? []);
  const siblingsP = roundP.then((r) => r.siblings ?? []);
  const childrenP = roundP.then((r) => r.children);

  const repoRefsP = readP.then(async (read) => {
    const refs = read?.revision.repoRefs ?? [];
    const fullName = refs.length ? await linkedRepoFullName(spec.workspaceId) : null;
    return refs.map((r) => ({ path: r.path, sha: r.commitSha.slice(0, 12), href: repoRefHref(fullName, r) }));
  });
  const designP = readP.then(async (read): Promise<Extract<SpecPageView, { state: 'ok' }>['design']> => {
    const d0 = read?.revision.design;
    if (!d0) return null;
    const [[art], changedSince] = await Promise.all([
      d0.kind === 'artifact'
        ? db.select({ title: artifacts.title }).from(artifacts).where(and(eq(artifacts.id, d0.ref), eq(artifacts.workspaceId, spec.workspaceId))).limit(1)
        : Promise.resolve([]),
      spec.approvedRevision === read.revision.revision ? approvedDesignDrift(d0) : Promise.resolve(null),
    ]);
    return {
      label: art?.title ?? d0.ref,
      href: d0.kind === 'artifact' ? (art ? `/app/artifacts/${d0.ref}` : null) : d0.ref.startsWith('https://') ? d0.ref : null,
      version: d0.version,
      screens: (d0.screens ?? []).map((x) => x.name),
      changedSince,
    };
  });
  const viewsP = readP.then((read) => (read ? attachmentViews(spec, read.revision.revision) : [])).catch(() => [] as AttachmentView[]);
  const commentsP = Promise.all([readP, revRowsP])
    .then(([read, revs]) => (read ? commentsOnRevision(spec.id, read.revision.revision, read.body, revs) : []))
    .catch(() => [] as CommentView[]);
  const nearbyP = readSpecNeighbours(spec.id, undefined, spec.workspaceId).catch(() => [] as NearbySpec[]);
  const filingP = currentFiling(spec.id).catch(() => null);

  const compareP: Promise<Extract<SpecPageView, { state: 'ok' }>['compare']> = opts.from !== undefined && opts.to !== undefined
    ? Promise.all([
      diffSpecRowRevisions(caller, spec, { from: opts.from, to: opts.to, rows: true }),
      attachmentSources(spec.id, opts.to).catch(() => ({})),
    ]).then(([d, sources]) => (d.ok
      ? { ...panes(d.diff.hunks ?? [], d.diff.omittedLines, d.diff.toBody ?? '', opts.to!, opts.from!), from: opts.from!, to: opts.to!, attachmentSources: sources }
      : { error: d.error }))
    : Promise.resolve(null);

  const retirementP = open ? Promise.resolve(null) : specRetirement(spec.id).catch(() => null);
  // Only a spec that came from or was copied to a repo file can have one.
  const restoredNoteP = open && (spec.repoSource || spec.repoCopy?.path) ? specRestoredRepoFile(spec.id, spec.status).catch(() => null) : Promise.resolve(null);
  // The replacements a person may pick (§22): live specs of the workspace, by title.
  const retireTargetsP = roundP.then((r) => r.retireTargets ?? []);
  // The repo checks (R-34) are not read here: they ask GitHub, so the panel fetches them on its own (/api/specs/[id]/preflight).
  const reviewP = opts.review && pending && open
    ? Promise.all([approverP, readP]).then(([approver, read]) => (approver ? reviewPanes(spec, read) : null))
    : Promise.resolve(null);
  const historyP = opts.history
    ? readCriterionHistory(spec, opts.history).then((history) => ({ criterionId: opts.history!, history })).catch(() => null)
    : Promise.resolve(null);
  // Fail-open (R-65): the page renders without the section when it cannot be read.
  const deliveryP = readSpecDelivery(caller, spec.id, { cursor: opts.deliveryCursor ?? null, checkedSpec: spec }).catch((err) => {
    console.warn(`[spec-page] delivery for spec ${spec.id} failed:`, err);
    return null;
  });

  const [read, [ws], revRows, names, [parent], siblings, children, repoRefs, design, views, comments, nearby, filing, compare, approverId, retirement, retireTargets, review, delivery, criterionHistory, restoredRepoNote] = await Promise.all([
    readP, wsP, revRowsP, namesP, parentP, siblingsP, childrenP, repoRefsP, designP, viewsP, commentsP, nearbyP, filingP, compareP, approverP, retirementP, retireTargetsP, reviewP, deliveryP, historyP, restoredNoteP,
  ]);
  if (!read) return { state: 'not_found' };

  const revisions: SpecRevisionLine[] = revRows.map((r) => {
    const pid = personLabel(r.approvedBy);
    return {
      revision: r.revision, author: r.authorKind === 'user' ? 'person' : 'agent', changeSummary: r.changeSummary,
      approvedBy: r.approvedAt ? (pid && names.get(pid)) || 'a person' : null,
      approvedAt: r.approvedAt ? new Date(r.approvedAt).toISOString() : null,
      createdAt: new Date(r.createdAt).toISOString(),
      createdAgo: ago(r.createdAt), approvedAgo: r.approvedAt ? ago(r.approvedAt) : null,
    };
  });
  const readRev = read.revision.revision;
  const commentAnchors = [
    ...specCriteria(read.body).map((c) => ({ kind: 'criterion' as const, id: c.id, label: c.id })),
    ...outlineOf(read.body).map((s) => ({ kind: 'section' as const, id: s.id, label: s.title })),
  ];
  const approver = !!approverId;
  const ownerOrAdmin = await ownerOrAdminP;
  const native = nativeSourceOn(ws?.gitConfig);
  const source: (ReturnType<typeof repoCopyLine> & { href?: string }) | null = repoCopyLine(native, spec.repoCopy, spec.approvedRevision != null, spec.repoSource);
  const fullName = source?.path || imported ? await linkedRepoFullName(spec.workspaceId) : null;
  if (source?.path && fullName) source.href = `https://github.com/${fullName}/blob/HEAD/${source.path.split('/').map(encodeURIComponent).join('/')}`;
  const importConfirmation = imported && open ? {
    revision: imported.revision, path: imported.path, commit: imported.commitSha.slice(0, 7),
    href: fullName ? `https://github.com/${fullName}/blob/${imported.commitSha}/${imported.path.split('/').map(encodeURIComponent).join('/')}` : null,
    canConfirm: approver, batchHref: importConfirmPath(spec.workspaceId),
    previous: imported.revision > 1 ? imported.revision - 1 : null,
  } : null;

  return {
    state: 'ok',
    source,
    // Slice 14, R-68: a person who may approve here.
    canPublishAnyway: !!source?.publishAnyway && approver,
    criteriaUnread: criteriaUnreadText(spec.metadata?.criteria_unread) || null,
    standard: spec.metadata?.standard === true,
    canMarkStandard: ownerOrAdmin && open,
    repoChecks: native && pending && open && approver,
    delivery,
    spec: { id: spec.id, title: spec.title, scope: spec.scope, status: spec.status, workspaceId: spec.workspaceId, workspaceName: ws?.name ?? '', version: spec.version, headRevision: spec.headRevision, approvedRevision: spec.approvedRevision },
    standing: importConfirmation ? 'imported, awaiting confirmation' : specStanding(spec).standing,
    reading: { revision: readRev, approved: spec.approvedRevision === readRev, isHead: readRev === spec.headRevision },
    waiting: pending && open ? spec.headRevision : null,
    // With the review open the page shows the review panel, which carries its own text: the read revision's is not sent twice.
    body: review ? '' : read.body,
    revisions, parent: parent ?? null, children, siblings, repoRefs, design,
    attachments: views.map((a) => ({ ...a, addedAgo: ago(a.addedAt) })), attachmentSources: sourcesOf(views),
    nearby, filing, comments, commentAnchors,
    // For a person, write reach is the same team-membership check as read reach (workspace-access.ts).
    canComment: true,
    compare, canApprove: pending && open && approver, review,
    retirement, canRetire: approver, retireTargets, restoredRepoNote,
    criterionHistory,
    importConfirmation,
  };
}
