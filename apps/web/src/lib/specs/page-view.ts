import { db } from '@buildd/core/db';
import { specRevisions, specs, users, workspaces } from '@buildd/core/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { getSpec, listSpecs, reach, type SpecCaller, type SpecRow } from './store';
import { specApprover } from './approval';
import { diffSpecHunks, diffSpecRevisions, type DiffHunk } from './diff';
import { linkedRepoFullName } from './repo-source';
import type { RepoRef } from './repo-refs';

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
  | { state: 'ok'; workspace: { id: string; name: string }; specs: SpecListItem[] };

export async function specListView(userId: string, workspaceId: string): Promise<SpecListView> {
  const r = await listSpecs({ kind: 'user', userId }, workspaceId);
  if (!r.ok) return { state: 'not_found' };
  const [ws] = await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) return { state: 'not_found' };
  return { state: 'ok', workspace: ws, specs: specTree(r.specs) };
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
    repoRefs: Array<{ path: string; sha: string; href: string | null }>;
    /** Two picked revisions: the changes from `from` to `to`. */
    compare: (SpecPanes & { from: number; to: number }) | { error: string } | null;
    /** The reader may approve the waiting revision. */
    canApprove: boolean;
    /** With `review`: what approving the head would put in force, for an approver only. */
    review: SpecPanes | null;
  };

const personLabel = (label: string | null) => (label?.startsWith('user:') ? label.slice(5) : null);

function panes(hunks: DiffHunk[], omittedLines: number, body: string, revision: number, replaces: number | null): SpecPanes {
  return {
    replaces, revision, hunks, omittedLines, body, sectionCount: hunks.length,
    linesAdded: hunks.reduce((n, h) => n + h.linesAdded, 0),
    linesRemoved: hunks.reduce((n, h) => n + h.linesRemoved, 0),
  };
}

export async function specPageView(userId: string, specId: string, opts: { revision?: number; from?: number; to?: number; review?: boolean } = {}): Promise<SpecPageView> {
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

  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, spec.workspaceId)).limit(1);
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

  const refs = got.view.revision.repoRefs ?? [];
  const fullName = refs.length ? await linkedRepoFullName(spec.workspaceId) : null;
  const repoRefs = refs.map((r) => ({ path: r.path, sha: r.commitSha.slice(0, 12), href: repoRefHref(fullName, r) }));

  let compare: Extract<SpecPageView, { state: 'ok' }>['compare'] = null;
  if (opts.from !== undefined && opts.to !== undefined) {
    const d = await diffSpecRevisions(caller, specId, { from: opts.from, to: opts.to, rows: true });
    compare = d.ok
      ? { ...panes(d.diff.hunks ?? [], d.diff.omittedLines, d.diff.toBody ?? '', opts.to, opts.from), from: opts.from, to: opts.to }
      : { error: d.error };
  }

  const canApprove = pending && open && !!(await specApprover(caller, spec.workspaceId));
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

  return {
    state: 'ok',
    spec: { id: spec.id, title: spec.title, scope: spec.scope, status: spec.status, workspaceId: spec.workspaceId, workspaceName: ws?.name ?? '', version: spec.version, headRevision: spec.headRevision, approvedRevision: spec.approvedRevision },
    standing: specStanding(spec).standing,
    reading: { revision: got.view.revision.revision, approved: spec.approvedRevision === got.view.revision.revision, isHead: got.view.revision.revision === spec.headRevision },
    waiting: pending && open ? spec.headRevision : null,
    body: got.view.body,
    revisions, parent: parent ?? null, children, repoRefs, compare, canApprove, review,
  };
}
