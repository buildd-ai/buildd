/**
 * Regenerate a mission's migrations inside the refresh merge itself.
 *
 * `lib/refresh-migration-fork.ts` says whether a trunk→mission merge forks the
 * Drizzle snapshot chain. This module does what `migrations:regenerate` would
 * do about it, from the server, with GitHub's Git Data API and no checkout: it
 * reads the three snapshots the fork is made of (the fork point, trunk's leaf,
 * the mission's own), asks `@buildd/core/db/snapshot-reparent` for the
 * mission's snapshots re-parented on trunk's leaf, and writes a merge commit
 * whose tree is the clean merge's tree with the mission's folders moved past
 * trunk's: same `migration.sql` bytes under a new name, a snapshot that names
 * trunk's leaf as its parent and carries trunk's entities.
 *
 * The plan refuses whenever the answer is not that pure function (the two sides
 * touched one object, a rename, a non-linear chain, a read that failed, more
 * snapshots than it will read); the refresh then lands the plain merge and
 * files the regenerate task as before. The write is a fast-forward of the
 * branch from the head the merge was computed on: a branch that moved in the
 * meantime refuses it and nothing is written.
 */

import { randomUUID } from 'node:crypto';
import { githubApi } from '@/lib/github';
import { V1_FOLDER } from '@buildd/core/db/migrate-tree';
import { planReparent, serializeSnapshot, type MissionSnapshot, type ReparentRefusal, type V1Snapshot } from '@buildd/core/db/snapshot-reparent';
import type { MigrationFork } from '@/lib/refresh-migration-fork';

/** The most snapshots one plan reads: each is the whole schema (about a megabyte here). */
export const MAX_SNAPSHOTS_READ = 8;
/** How many of the newest common folders are read looking for the fork point. */
export const FORK_POINT_SEARCH_DEPTH = 3;

export interface ReparentedRefreshFolder {
  from: string;
  to: string;
  /** The mission's `migration.sql` blob, reused under the new name: byte-identical by construction. */
  sqlSha: string;
  /** The re-parented `snapshot.json`, serialised as the kit writes it. */
  snapshotJson: string;
}

export interface RefreshReparentPlan {
  drizzleDir: string;
  /** Trunk's leaf folder, the new parent. */
  trunkLeaf: string;
  folders: ReparentedRefreshFolder[];
}

export type RefreshReparentRefusal = ReparentRefusal | 'read' | 'too_large';

export type RefreshReparentOutcome =
  | { ok: true; plan: RefreshReparentPlan }
  | { ok: false; reason: RefreshReparentRefusal; detail: string };

type Api = typeof githubApi;

interface Listing { name: string; sha: string; type: string }

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function listDir(api: Api, installationId: number, repoFullName: string, dir: string, ref: string): Promise<Listing[]> {
  const entries = await api(installationId, `/repos/${repoFullName}/contents/${encodePath(dir)}?ref=${encodeURIComponent(ref)}`);
  if (!Array.isArray(entries)) throw new Error(`${dir} at ${ref.slice(0, 7)} is not a directory`);
  return entries
    .filter((e: { name?: unknown; sha?: unknown; type?: unknown }) => typeof e?.name === 'string' && typeof e.sha === 'string' && typeof e.type === 'string')
    .map((e: { name: string; sha: string; type: string }) => ({ name: e.name, sha: e.sha, type: e.type }));
}

async function readBlobJson(api: Api, installationId: number, repoFullName: string, sha: string): Promise<unknown> {
  const blob = await api(installationId, `/repos/${repoFullName}/git/blobs/${encodeURIComponent(sha)}`);
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`blob ${sha.slice(0, 7)} is not base64`);
  return JSON.parse(Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf8'));
}

function asSnapshot(folder: string, raw: unknown): V1Snapshot {
  const s = raw as Partial<V1Snapshot> | null;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !Array.isArray(s.prevIds) || !Array.isArray(s.ddl) || typeof s.version !== 'string' || typeof s.dialect !== 'string') {
    throw new Error(`${folder}/snapshot.json is not a drizzle v1 snapshot`);
  }
  return s as V1Snapshot;
}

/** A migration folder's two files, by blob sha. */
async function folderFiles(api: Api, installationId: number, repoFullName: string, drizzleDir: string, folder: string, ref: string): Promise<{ sqlSha: string; snapshotSha: string }> {
  const files = await listDir(api, installationId, repoFullName, `${drizzleDir}/${folder}`, ref);
  const sql = files.find((f) => f.name === 'migration.sql' && f.type === 'file');
  const snapshot = files.find((f) => f.name === 'snapshot.json' && f.type === 'file');
  if (!sql || !snapshot) throw new Error(`${folder} at ${ref.slice(0, 7)} lacks migration.sql or snapshot.json`);
  return { sqlSha: sql.sha, snapshotSha: snapshot.sha };
}

/**
 * The regenerated folders for a fork, or why there are none. Reads are capped
 * (`MAX_SNAPSHOTS_READ`); a failed GitHub read is `read`, never a throw.
 */
export async function planRefreshReparent(args: {
  installationId: number;
  repoFullName: string;
  fork: MigrationFork;
  /** The mission head the merge was computed on. */
  missionHeadSha: string;
  trunkSha: string;
  nowMs?: number;
  api?: Api;
}): Promise<RefreshReparentOutcome> {
  const { installationId, repoFullName, fork, missionHeadSha, trunkSha, nowMs } = args;
  const api = args.api ?? githubApi;
  const { drizzleDir } = fork;
  if (fork.missionOnly.length + fork.trunkOnly.length + 1 > MAX_SNAPSHOTS_READ) {
    return { ok: false, reason: 'too_large', detail: `${fork.missionOnly.length + fork.trunkOnly.length} new migration folders across both sides; the plan reads at most ${MAX_SNAPSHOTS_READ - 1}` };
  }
  try {
    const side = async (folders: string[], ref: string): Promise<Array<MissionSnapshot & { sqlSha: string }>> =>
      Promise.all(folders.map(async (folder) => {
        const files = await folderFiles(api, installationId, repoFullName, drizzleDir, folder, ref);
        return { folder, sqlSha: files.sqlSha, snapshot: asSnapshot(folder, await readBlobJson(api, installationId, repoFullName, files.snapshotSha)) };
      }));
    const [mission, trunk, trunkListing] = await Promise.all([
      side(fork.missionOnly, missionHeadSha),
      side(fork.trunkOnly, trunkSha),
      listDir(api, installationId, repoFullName, drizzleDir, trunkSha),
    ]);

    // The fork point: the one parent each side's chain starts from, which both
    // sides hold. It is almost always the newest common folder, so the search
    // is newest-first and shallow.
    const parentOf = (s: MissionSnapshot[]): string | null => {
      const own = new Set(s.map((x) => x.snapshot.id));
      const roots = [...new Set(s.flatMap((x) => x.snapshot.prevIds).filter((p) => !own.has(p)))];
      return roots.length === 1 ? roots[0]! : null;
    };
    const missionRoot = parentOf(mission);
    const trunkRoot = parentOf(trunk);
    if (!missionRoot || !trunkRoot || missionRoot !== trunkRoot) {
      return { ok: false, reason: 'chain', detail: `the two sides do not start from one shared snapshot (mission ${missionRoot ?? 'several'}, trunk ${trunkRoot ?? 'several'})` };
    }
    const trunkOnly = new Set(fork.trunkOnly);
    const common = trunkListing
      .filter((e) => e.type === 'dir' && V1_FOLDER.test(e.name) && !trunkOnly.has(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, FORK_POINT_SEARCH_DEPTH);
    let base: V1Snapshot | null = null;
    for (const folder of common) {
      const files = await folderFiles(api, installationId, repoFullName, drizzleDir, folder, trunkSha);
      const s = asSnapshot(folder, await readBlobJson(api, installationId, repoFullName, files.snapshotSha));
      if (s.id === missionRoot) { base = s; break; }
    }
    if (!base) {
      return { ok: false, reason: 'chain', detail: `the fork point ${missionRoot} is not among the ${FORK_POINT_SEARCH_DEPTH} newest folders both sides hold` };
    }
    const existingFolders = [
      ...trunkListing.filter((e) => e.type === 'dir' && V1_FOLDER.test(e.name)).map((e) => e.name),
      ...fork.missionOnly,
    ];
    const plan = planReparent({ base, trunk, mission, existingFolders, nowMs });
    if (!plan.ok) return plan;
    const sqlShaOf = new Map(mission.map((m) => [m.folder, m.sqlSha] as const));
    return {
      ok: true,
      plan: {
        drizzleDir,
        trunkLeaf: plan.trunkLeaf.folder,
        folders: plan.folders.map((f) => ({ from: f.from, to: f.to, sqlSha: sqlShaOf.get(f.from)!, snapshotJson: serializeSnapshot(f.snapshot) })),
      },
    };
  } catch (err) {
    return { ok: false, reason: 'read', detail: err instanceof Error ? err.message : String(err) };
  }
}

export type WriteReparentedOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'branch_moved' | 'write'; detail: string };

/**
 * One merge commit on `branch`: the clean merge's tree with the plan's folders
 * moved, the same two parents, landed by fast-forward from the mission head the
 * merge was computed on. Nothing is written to the branch on any failure.
 */
export async function writeReparentedRefresh(args: {
  installationId: number;
  repoFullName: string;
  branch: string;
  /** The clean merge commit the merges API produced (on a scratch ref). */
  mergeSha: string;
  mergeTreeSha?: string | null;
  parents: [missionHeadSha: string, trunkSha: string];
  message: string;
  plan: RefreshReparentPlan;
  api?: Api;
}): Promise<WriteReparentedOutcome> {
  const { installationId, repoFullName, branch, mergeSha, parents, message, plan } = args;
  const api = args.api ?? githubApi;
  const repo = `/repos/${repoFullName}`;
  const post = (path: string, body: unknown) => api(installationId, `${repo}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let commitSha: string;
  try {
    let baseTree = args.mergeTreeSha ?? null;
    if (!baseTree) {
      const commit = await api(installationId, `${repo}/git/commits/${mergeSha}`);
      baseTree = typeof commit?.tree?.sha === 'string' ? commit.tree.sha : null;
    }
    if (!baseTree) return { ok: false, reason: 'write', detail: `merge commit ${mergeSha.slice(0, 7)} has no tree` };
    const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
    for (const f of plan.folders) {
      const blob = await post('/git/blobs', { content: f.snapshotJson, encoding: 'utf-8' });
      if (typeof blob?.sha !== 'string') return { ok: false, reason: 'write', detail: `snapshot blob for ${f.to} not created` };
      tree.push(
        { path: `${plan.drizzleDir}/${f.from}/migration.sql`, mode: '100644', type: 'blob', sha: null },
        { path: `${plan.drizzleDir}/${f.from}/snapshot.json`, mode: '100644', type: 'blob', sha: null },
        { path: `${plan.drizzleDir}/${f.to}/migration.sql`, mode: '100644', type: 'blob', sha: f.sqlSha },
        { path: `${plan.drizzleDir}/${f.to}/snapshot.json`, mode: '100644', type: 'blob', sha: blob.sha },
      );
    }
    const newTree = await post('/git/trees', { base_tree: baseTree, tree });
    if (typeof newTree?.sha !== 'string') return { ok: false, reason: 'write', detail: 'tree not created' };
    const commit = await post('/git/commits', { message, tree: newTree.sha, parents });
    if (typeof commit?.sha !== 'string') return { ok: false, reason: 'write', detail: 'commit not created' };
    commitSha = commit.sha;
  } catch (err) {
    return { ok: false, reason: 'write', detail: err instanceof Error ? err.message : String(err) };
  }
  // Fast-forward only: the branch must still be at the head the merge was made on.
  try {
    await api(installationId, `${repo}/git/refs/heads/${encodePath(branch)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: commitSha, force: false }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/422|not a fast forward|fast-forward/i.test(msg)) return { ok: false, reason: 'branch_moved', detail: msg };
    return { ok: false, reason: 'write', detail: msg };
  }
  return { ok: true, sha: commitSha };
}

/** The commit message of a refresh merge that carries regenerated migrations: greppable, and names the move. */
export function reparentedMergeMessage(trunk: string, branch: string, plan: RefreshReparentPlan): string {
  const moves = plan.folders.map((f) => `${f.from} -> ${f.to}`).join(', ');
  return `Merge ${trunk} into ${branch} (mission branch refresh)\n\nRegenerated the mission's migrations on ${trunk}'s snapshot chain: ${moves} (parent ${plan.trunkLeaf}).`;
}

/** What a refresh merge regenerated, as the outcome, the gate ledger and the mission feed report it. */
export interface RegeneratedMigrations {
  drizzleDir: string;
  trunkLeaf: string;
  folders: Array<{ from: string; to: string }>;
}

/** Why a refresh landed the plain merge instead of regenerating. */
export interface RegenerateRefusal {
  reason: RefreshReparentRefusal | 'write';
  detail: string;
}

export type MergeRegeneratingOutcome =
  | { kind: 'merged'; commit: { sha: string; parents: Array<{ sha: string }> }; regenerated?: RegeneratedMigrations; refusal?: RegenerateRefusal }
  | { kind: 'already_current' }
  | { kind: 'conflict' }
  /** The branch moved while the merge was computed: nothing was written, the next refresh starts over. */
  | { kind: 'moved'; detail: string }
  | { kind: 'error'; detail: string };

function githubStatus(err: unknown): number | null {
  const m = /GitHub API error: (\d{3})/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : null;
}

/**
 * Merge trunk into the mission branch when the merge is known to fork the
 * snapshot chain. The merge is computed on a scratch ref cut at
 * `missionHeadSha`, so the branch itself is written once, by fast-forward, to
 * either the merge commit with the mission's migrations regenerated in it, or,
 * when regeneration is refused, the plain merge commit as before (the caller
 * then files the repair). A 409 and a 204 mean what they mean on the branch.
 * A branch that moved under the computation refuses the fast-forward: nothing
 * is written, and the next refresh starts over. The scratch ref is deleted on
 * every exit.
 */
export async function mergeTrunkRegeneratingMigrations(args: {
  installationId: number;
  repoFullName: string;
  branch: string;
  trunk: string;
  trunkSha: string;
  missionHeadSha: string;
  fork: MigrationFork;
  nowMs?: number;
  api?: Api;
}): Promise<MergeRegeneratingOutcome> {
  const { installationId, repoFullName, branch, trunk, trunkSha, missionHeadSha, fork, nowMs } = args;
  const api = args.api ?? githubApi;
  const repo = `/repos/${repoFullName}`;
  const json = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
    api(installationId, `${repo}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const plainMessage = `Merge ${trunk} into ${branch} (mission branch refresh)`;

  const scratch = `buildd-refresh/${branch.split('/').pop()}-${randomUUID().slice(0, 8)}`;
  try {
    await json('POST', '/git/refs', { ref: `refs/heads/${scratch}`, sha: missionHeadSha });
  } catch (err) {
    return { kind: 'error', detail: `could not cut the scratch ref for the refresh merge: ${msg(err)}` };
  }
  try {
    let merged: { sha?: string; parents?: Array<{ sha?: string }>; commit?: { tree?: { sha?: string } } } | null;
    try {
      merged = await json('POST', '/merges', { base: scratch, head: trunk, commit_message: plainMessage });
    } catch (err) {
      if (githubStatus(err) === 409) return { kind: 'conflict' };
      return { kind: 'error', detail: `merges API failed: ${msg(err)}` };
    }
    if (!merged) return { kind: 'already_current' };
    const mergeSha = merged.sha;
    if (typeof mergeSha !== 'string') return { kind: 'error', detail: 'merges API answered without a commit sha' };
    const parents: [string, string] = [missionHeadSha, trunkSha];

    let refusal: RegenerateRefusal | undefined;
    const planned = await planRefreshReparent({ installationId, repoFullName, fork, missionHeadSha, trunkSha, nowMs, api });
    if (planned.ok) {
      const written = await writeReparentedRefresh({
        installationId, repoFullName, branch, mergeSha, mergeTreeSha: merged.commit?.tree?.sha ?? null, parents,
        message: reparentedMergeMessage(trunk, branch, planned.plan), plan: planned.plan, api,
      });
      if (written.ok) {
        return {
          kind: 'merged',
          commit: { sha: written.sha, parents: parents.map((sha) => ({ sha })) },
          regenerated: { drizzleDir: planned.plan.drizzleDir, trunkLeaf: planned.plan.trunkLeaf, folders: planned.plan.folders.map((f) => ({ from: f.from, to: f.to })) },
        };
      }
      if (written.reason === 'branch_moved') {
        return { kind: 'moved', detail: `${branch} moved while the refresh merge was being computed; nothing was written (${written.detail})` };
      }
      refusal = { reason: 'write', detail: written.detail };
    } else {
      refusal = { reason: planned.reason, detail: planned.detail };
    }

    // Regeneration refused: the plain merge lands, as it did before, and the caller files the repair.
    try {
      await json('PATCH', `/git/refs/heads/${encodePath(branch)}`, { sha: mergeSha, force: false });
    } catch (err) {
      if (/422|not a fast forward|fast-forward/i.test(msg(err))) {
        return { kind: 'moved', detail: `${branch} moved while the refresh merge was being computed; nothing was written (${msg(err)})` };
      }
      return { kind: 'error', detail: `could not land the refresh merge on ${branch}: ${msg(err)}` };
    }
    return { kind: 'merged', commit: { sha: mergeSha, parents: parents.map((sha) => ({ sha })) }, refusal };
  } finally {
    await api(installationId, `${repo}/git/refs/heads/${encodePath(scratch)}`, { method: 'DELETE' }).catch((err: unknown) => {
      console.error(`[mission-branch-refresh] could not delete scratch ref ${scratch} in ${repoFullName}:`, err);
    });
  }
}
