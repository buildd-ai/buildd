import { currentFiling, filingViews, type FilingView } from './filings';
import { organizeWorkspace } from './organize';
import { db } from '@buildd/core/db';
import { artifacts, specFilings, specRevisions, specs, users, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import type { HubWorkspace } from './hub';
import { isUuid } from '@/lib/uuid';
import { getSpec, listSpecs, reach, type SpecCaller, type SpecRow } from './store';
import { listSpecComments, type CommentView } from './comments';
import { specCriteria } from '@buildd/spec-contract/requirements';
import { outlineOf } from '@buildd/core/artifact-read';
import { specApprover } from './approval';
import { diffSpecHunks, diffSpecRevisions, type DiffHunk } from './diff';
import { linkedRepoFullName } from './repo-source';
import { approvedDesignDrift } from './design';
import { attachmentSources, attachmentViews, sourcesOf, type AttachmentSource, type AttachmentView } from './attachments';
import { readSpecNeighbours, suggestParent, type NearbySpec } from './neighbours';
import { filingFacts, proposalAreas, type AreaProposal, type SpecIndexInput, type SpecSuggestion } from './index-view';
import type { RepoRef } from './repo-refs';
import { nativeSourceOn, repoCopyLine, repoCopyPreflight, type RepoCopyPreflight } from './repo-copy';
import { readSpecDelivery, type SpecDelivery } from './delivery';
import { specRetirement, type RetirementView } from './retire';

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
    specs: SpecListItem[];
    /** The same specs flat, for the index (§19): filings, suggestions and all. */
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

/** The newest filed or suggested placement still in effect, per spec, in one workspace (§17). */
async function liveFilings(workspaceId: string): Promise<Map<string, FilingView>> {
  const rows = await db.select().from(specFilings)
    .where(and(eq(specFilings.workspaceId, workspaceId), inArray(specFilings.kind, ['filed', 'suggested']), inArray(specFilings.status, ['applied', 'open'])))
    .orderBy(desc(specFilings.createdAt));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!newest.has(r.specId)) newest.set(r.specId, r);
  const views = await filingViews([...newest.values()]);
  return new Map(views.map((v, i) => [[...newest.keys()][i], v]));
}

/**
 * The index rows (§19). Placement comes from `spec_filings` (§17): a filing
 * in effect is "Filed by buildd" with its undo, an open suggestion is the
 * unfiled spec's suggestion. An unfiled spec with no filing row at all gets
 * `suggestParent` (§14) on its title, fail-open, for at most
 * MAX_LIST_SUGGESTIONS of them. Every read fails open: a missing filing never
 * hides a spec.
 */
export async function specIndexInputs(workspaceId: string, rows: ReadonlyArray<SpecRow>): Promise<SpecIndexInput[]> {
  const ids = new Set(rows.map((r) => r.id));
  const filings = await liveFilings(workspaceId).catch(() => new Map<string, FilingView>());
  const unfiled = rows.filter((r) => !(r.scope === 'product' || r.scope === 'domain') && !(r.parentSpecId && ids.has(r.parentSpecId)));
  const guesses = new Map<string, SpecSuggestion>();
  await Promise.all(unfiled.filter((r) => !filings.has(r.id)).slice(0, MAX_LIST_SUGGESTIONS).map(async (r) => {
    const s = await suggestParent(workspaceId, r.id, r.title).catch(() => null);
    if (s && ids.has(s.specId)) guesses.set(r.id, { kind: 'parent', specId: s.specId, title: s.title, reason: s.reason });
  }));
  return rows.map((r) => {
    const facts = filingFacts(r, filings.get(r.id));
    return {
      id: r.id, title: r.title, scope: r.scope, parentSpecId: r.parentSpecId, status: r.status,
      approvedRevision: r.approvedRevision, headRevision: r.headRevision, updatedAt: new Date(r.updatedAt).toISOString(),
      imported: r.repoSource?.state === 'imported',
      filedBy: facts.filedBy ?? null, filingId: facts.filingId ?? null,
      suggestion: facts.suggestion ?? guesses.get(r.id) ?? null,
    };
  });
}

/**
 * With no product or area yet, the taxonomy buildd would propose (§17 R-4,
 * a dry run: nothing is created). Needs write access, like organize; a reader
 * without it, or any error, gets none. Each area carries which proposal it
 * came from, so accepting it re-reads that same proposal.
 */
async function coldStartProposals(caller: SpecCaller, workspaceId: string, rows: ReadonlyArray<SpecRow>): Promise<AreaProposal[]> {
  const open = rows.filter((r) => r.status !== 'retired' && r.status !== 'superseded');
  if (open.some((r) => r.scope === 'product' || r.scope === 'domain') || open.length === 0) return [];
  // Never waits on the model: its proposal when organize already asked it, else the word-based one.
  const r = await organizeWorkspace(caller, { workspaceId, dryRun: true }, { cachedOnly: true }).catch(() => null);
  return r?.ok && r.result.mode === 'taxonomy' && r.result.dryRun ? proposalAreas(r.result.proposal, r.result.proposedBy.source) : [];
}

export async function specListView(userId: string, workspaceId: string): Promise<SpecListView> {
  const caller: SpecCaller = { kind: 'user', userId };
  const r = await listSpecs(caller, workspaceId);
  if (!r.ok) return { state: 'not_found' };
  const [ws] = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) return { state: 'not_found' };
  // The approver confirms imports and sees what waits for their approval first.
  const [index, canAct, approver] = await Promise.all([
    specIndexInputs(workspaceId, r.specs), reach(caller, workspaceId, true),
    specApprover(caller, workspaceId).catch(() => null),
  ]);
  const proposals = canAct ? await coldStartProposals(caller, workspaceId, r.specs) : [];
  return { state: 'ok', workspace: ws, specs: specTree(r.specs), index, proposals, canAct, canConfirm: !!approver, now: Date.now() };
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
    source?: { source: string; copy: string | null; behind: boolean } | null;
    /** With `review`: the repo checks on the would-be copy (R-34). Warns, never blocks. */
    preflight?: RepoCopyPreflight | null;
    /** Delivery and verification (Slice 13): the work that answered to this spec, one page. Null when it cannot be read. */
    delivery?: SpecDelivery | null;
    /** Why and by what the spec is retired (§22), when it is. */
    retirement?: RetirementView | null;
    /** The reader may retire or restore it (a person with approval rights, §22 R-51), and the live specs that could replace it. */
    canRetire?: boolean;
    retireTargets?: Array<{ id: string; title: string }>;
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

export async function specPageView(userId: string, specId: string, opts: { revision?: number; from?: number; to?: number; review?: boolean; deliveryCursor?: string } = {}): Promise<SpecPageView> {
  if (!isUuid(specId)) return { state: 'not_found' };
  const caller: SpecCaller = { kind: 'user', userId };
  const [row] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!row || !(await reach(caller, row.workspaceId, false))) return { state: 'not_found' };

  const pending = row.approvedRevision == null || row.headRevision > row.approvedRevision;
  const open = row.status !== 'retired' && row.status !== 'superseded';
  const readN = opts.revision ?? row.approvedRevision ?? row.headRevision;
  const got = await getSpec(caller, specId, { revision: readN });
  if (!got.ok) return { state: 'not_found' };
  const spec = got.view.spec;

  const [ws] = await db.select({ name: workspaces.name, gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, spec.workspaceId)).limit(1);
  const native = nativeSourceOn(ws?.gitConfig);
  const revRows = await db.select({
    revision: specRevisions.revision, authorKind: specRevisions.authorKind, changeSummary: specRevisions.changeSummary,
    approvedBy: specRevisions.approvedBy, approvedAt: specRevisions.approvedAt, createdAt: specRevisions.createdAt,
  }).from(specRevisions).where(eq(specRevisions.specId, specId)).orderBy(desc(specRevisions.revision));
  const approverIds = [...new Set(revRows.map((r) => personLabel(r.approvedBy)).filter((v): v is string => !!v && isUuid(v)))];
  const names = new Map<string, string>();
  if (approverIds.length) {
    for (const u of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, approverIds))) {
      if (u.name) names.set(u.id, u.name);
    }
  }
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

  // Parent and children only from the same workspace (a parent is always there, §1).
  const [parent] = spec.parentSpecId
    ? await db.select({ id: specs.id, title: specs.title }).from(specs)
      .where(and(eq(specs.workspaceId, spec.workspaceId), eq(specs.id, spec.parentSpecId))).limit(1)
    : [];
  const children = await db.select({ id: specs.id, title: specs.title }).from(specs)
    .where(and(eq(specs.workspaceId, spec.workspaceId), eq(specs.parentSpecId, spec.id))).orderBy(specs.title);
  const siblings = parent
    ? await db.select({ id: specs.id, title: specs.title }).from(specs)
      .where(and(eq(specs.workspaceId, spec.workspaceId), eq(specs.parentSpecId, parent.id), ne(specs.id, spec.id)))
      .orderBy(specs.title).limit(MAX_SIBLINGS)
    : [];

  const refs = got.view.revision.repoRefs ?? [];
  const fullName = refs.length ? await linkedRepoFullName(spec.workspaceId) : null;
  const repoRefs = refs.map((r) => ({ path: r.path, sha: r.commitSha.slice(0, 12), href: repoRefHref(fullName, r) }));

  const d0 = got.view.revision.design;
  let design: Extract<SpecPageView, { state: 'ok' }>['design'] = null;
  if (d0) {
    const [art] = d0.kind === 'artifact'
      ? await db.select({ title: artifacts.title }).from(artifacts).where(and(eq(artifacts.id, d0.ref), eq(artifacts.workspaceId, spec.workspaceId))).limit(1)
      : [];
    design = {
      label: art?.title ?? d0.ref,
      href: d0.kind === 'artifact' ? (art ? `/app/artifacts/${d0.ref}` : null) : d0.ref.startsWith('https://') ? d0.ref : null,
      version: d0.version,
      screens: (d0.screens ?? []).map((x) => x.name),
      changedSince: spec.approvedRevision === got.view.revision.revision ? await approvedDesignDrift(d0) : null,
    };
  }

  const readRev = got.view.revision.revision;
  const views = await attachmentViews(spec, readRev).catch(() => [] as AttachmentView[]);
  const sources = sourcesOf(views);
  const attachments = views.map((a) => ({ ...a, addedAgo: ago(a.addedAt) }));

  const nearby = await readSpecNeighbours(spec.id).catch(() => [] as NearbySpec[]);
  const filing = await currentFiling(spec.id).catch(() => null);
  const listed = await listSpecComments(caller, specId, { revision: got.view.revision.revision }).catch(() => null);
  const comments = listed?.ok ? listed.comments : [];
  const commentAnchors = [
    ...specCriteria(got.view.body).map((c) => ({ kind: 'criterion' as const, id: c.id, label: c.id })),
    ...outlineOf(got.view.body).map((s) => ({ kind: 'section' as const, id: s.id, label: s.title })),
  ];
  const canComment = await reach(caller, spec.workspaceId, true);

  let compare: Extract<SpecPageView, { state: 'ok' }>['compare'] = null;
  if (opts.from !== undefined && opts.to !== undefined) {
    const d = await diffSpecRevisions(caller, specId, { from: opts.from, to: opts.to, rows: true });
    compare = d.ok
      ? { ...panes(d.diff.hunks ?? [], d.diff.omittedLines, d.diff.toBody ?? '', opts.to, opts.from), from: opts.from, to: opts.to, attachmentSources: await attachmentSources(spec.id, opts.to).catch(() => ({})) }
      : { error: d.error };
  }

  const approver = !!(await specApprover(caller, spec.workspaceId));
  const canApprove = pending && open && approver;
  const retirement = open ? null : await specRetirement(spec.id).catch(() => null);
  // The replacements a person may pick (§22): live specs of the workspace, by title.
  const retireTargets = approver && open
    ? await db.select({ id: specs.id, title: specs.title }).from(specs)
      .where(and(eq(specs.workspaceId, spec.workspaceId), ne(specs.id, spec.id), notInArray(specs.status, ['retired', 'superseded'])))
      .orderBy(specs.title).limit(200)
    : [];
  let review: SpecPanes | null = null;
  if (opts.review && canApprove) {
    if (spec.approvedRevision != null) {
      const d = await diffSpecRevisions(caller, specId, { from: spec.approvedRevision, to: spec.headRevision, rows: true });
      if (d.ok) review = panes(d.diff.hunks ?? [], d.diff.omittedLines, d.diff.toBody ?? '', spec.headRevision, spec.approvedRevision);
    } else {
      const head = readN === spec.headRevision ? got : await getSpec(caller, specId, { revision: spec.headRevision });
      if (head.ok) {
        const h = diffSpecHunks('', head.view.body);
        review = panes(h.hunks, h.omittedLines, head.view.body, spec.headRevision, null);
      }
    }
  }

  if (review) review.attachmentSources = await attachmentSources(spec.id, review.revision).catch(() => ({}));

  const preflight = review && native ? await repoCopyPreflight(spec, spec.headRevision).catch(() => null) : null;
  // Fail-open (R-65): the page renders without the section when it cannot be read.
  const delivery = await readSpecDelivery(caller, spec.id, { cursor: opts.deliveryCursor ?? null }).catch((err) => {
    console.warn(`[spec-page] delivery for spec ${spec.id} failed:`, err);
    return null;
  });

  return {
    state: 'ok',
    source: repoCopyLine(native, spec.repoCopy, spec.approvedRevision != null, spec.repoSource),
    preflight,
    delivery,
    spec: { id: spec.id, title: spec.title, scope: spec.scope, status: spec.status, workspaceId: spec.workspaceId, workspaceName: ws?.name ?? '', version: spec.version, headRevision: spec.headRevision, approvedRevision: spec.approvedRevision },
    standing: specStanding(spec).standing,
    reading: { revision: got.view.revision.revision, approved: spec.approvedRevision === got.view.revision.revision, isHead: got.view.revision.revision === spec.headRevision },
    waiting: pending && open ? spec.headRevision : null,
    body: got.view.body,
    revisions, parent: parent ?? null, children, siblings, repoRefs, design, attachments, attachmentSources: sources, nearby, filing, comments, commentAnchors, canComment, compare, canApprove, review,
    retirement, canRetire: approver, retireTargets,
  };
}
