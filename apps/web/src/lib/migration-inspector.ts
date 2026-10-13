import { githubApi } from '@/lib/github';
import {
  classifyPullRequestMigrations,
  getMigrationNumber,
  isGeneratedMigrationPath,
  isLegacyMigrationPath,
  type MigrationCollision,
  type MigrationSafety,
  type OpenPullRequestMigration,
  type PullRequestMigrationFile,
} from '@/lib/migration-safety';
import { effectiveDeltaFiles } from '@/lib/integration-refresh';
import { pairMovedMigrations } from '@buildd/core/generated-artifacts';

interface GitHubPullRequestFile {
  filename: string;
  status?: string;
  /** Set by GitHub on a `renamed` entry: the path the file had on the base. */
  previous_filename?: string | null;
}

async function listAll(
  installationId: number,
  path: string,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let page = 1; ; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await githubApi(
      installationId,
      `${path}${separator}per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new Error('malformed paginated GitHub response');
    results.push(...batch);
    if (batch.length < 100) return results;
  }
}

async function readFileAtRef(
  installationId: number,
  repoFullName: string,
  filename: string,
  ref: string,
): Promise<string | undefined> {
  const encodedPath = filename.split('/').map(encodeURIComponent).join('/');
  const data = await githubApi(
    installationId,
    `/repos/${repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
  );
  if (data?.encoding !== 'base64' || typeof data.content !== 'string') return undefined;
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

/**
 * Resolve the PR target's CURRENT tip to an immutable SHA, so every "already on
 * the base" read in one inspection sees the same snapshot. Not the merge base:
 * a mission branch refreshed from trunk carries trunk's migrations, and GitHub's
 * three-dot diff still lists them as added until the fork point moves.
 * Undefined when the base can't be resolved — callers then exclude nothing.
 */
async function resolveBaseSha(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  baseRef: string | null | undefined,
): Promise<string | undefined> {
  try {
    let ref = baseRef ?? undefined;
    if (!ref) {
      const pr = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
      ref = typeof pr?.base?.ref === 'string' ? pr.base.ref : undefined;
    }
    if (!ref) return undefined;
    const encodedRef = ref.split('/').map(encodeURIComponent).join('/');
    const data = await githubApi(installationId, `/repos/${repoFullName}/git/ref/heads/${encodedRef}`);
    return typeof data?.object?.sha === 'string' ? data.object.sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Migrations a refresh PR only moved: a `removed` entry (or a `renamed`
 * entry's previous path), read where the diff's base has it, paired one to
 * one with an `added` (or `renamed`) entry holding the same bytes at the head.
 * Returns both ends of each pair; an unreadable side never pairs, so the
 * deletion stays lineage.
 */
async function renumberedInRefresh(
  migrations: GitHubPullRequestFile[],
  withContent: PullRequestMigrationFile[],
  readOnBase: (path: string) => Promise<string | undefined>,
): Promise<Set<string>> {
  const left: Record<string, string | undefined> = {};
  const arrived: Record<string, string | undefined> = {};
  const renamedFrom = new Map<string, string>();
  for (const file of migrations) {
    const from = file.status === 'removed' ? file.filename
      : file.status === 'renamed' && file.previous_filename && isGeneratedMigrationPath(file.previous_filename) ? file.previous_filename
        : null;
    if (from) left[from] = await readOnBase(from);
    if (file.status === 'added' || file.status === 'renamed') {
      arrived[file.filename] = withContent.find((f) => f.filename === file.filename)?.content;
    }
    if (file.status === 'renamed' && from) renamedFrom.set(file.filename, from);
  }
  const pairs = pairMovedMigrations(left, arrived);
  // A rename that pairs with some other deletion instead of its own old path
  // still rewrote that path: only count it when its own previous path paired.
  for (const [to, from] of renamedFrom) {
    if (pairs.has(to) && !pairs.has(from)) pairs.delete(to);
  }
  return pairs;
}

type InspectParams = Parameters<typeof inspectOnce>[0];

/**
 * Load executable SQL and compare migration slots (see `inspectOnce`). A
 * verdict that is unsafe only because GitHub could not be read
 * (`kind: 'uninspectable'`) is retried once; a second failure is returned
 * as-is, so the caller still fails closed.
 */
export async function inspectPullRequestMigrations(params: InspectParams): Promise<MigrationSafety> {
  const first = await inspectOnce(params);
  if (first.safe || first.kind !== 'uninspectable') return first;
  return inspectOnce(params);
}

/**
 * What the drizzle dir holds at `ref`: legacy numbered files and drizzle v1
 * migration folders. Null when the listing can't be read.
 */
async function migrationNamesAt(
  installationId: number,
  repoFullName: string,
  dir: string,
  ref: string,
): Promise<{ legacy: string[]; v1Folders: string[] } | null> {
  try {
    const encodedDir = dir.split('/').map(encodeURIComponent).join('/');
    const data = await githubApi(installationId, `/repos/${repoFullName}/contents/${encodedDir}?ref=${encodeURIComponent(ref)}`);
    if (!Array.isArray(data)) return null;
    const entries = data.map((entry: { name?: unknown; type?: unknown }) => ({
      name: typeof entry?.name === 'string' ? entry.name : '',
      type: typeof entry?.type === 'string' ? entry.type : '',
    }));
    return {
      legacy: entries.map((e) => e.name).filter((name) => /^\d{4}_[^/]+\.sql$/.test(name)),
      v1Folders: entries.filter((e) => e.type === 'dir' && /^\d{14}_[^/]+$/.test(e.name)).map((e) => e.name),
    };
  } catch {
    return null;
  }
}

function basenameOf(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function numberOf(name: string): number {
  return Number(/^(\d{4})_/.exec(basenameOf(name))?.[1] ?? -1);
}

/** A migration whose slot is already used on the PR's base: a renumber, never a decision. */
function behindBase(file: string, otherFile: string, reason: string): MigrationSafety {
  const collision: MigrationCollision = { file: basenameOf(file), otherFile, otherPrNumber: null, against: 'base' };
  return { safe: false, operationClass: 'CONTRACT', reason, collision, kind: 'collision' };
}

/**
 * Load executable SQL and compare migration slots in PRs targeting the same
 * base. Identical files inherited by stacked PRs do not claim a second slot,
 * and SQL the target already carries byte-for-byte is not this PR's to
 * classify — see `resolveBaseSha`.
 */
async function inspectOnce(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  files: GitHubPullRequestFile[];
  /**
   * This PR's base branch (e.g. `dev`). Resolved to its current tip SHA; a
   * migration that exists there at the exact path with identical bytes is
   * inherited, so it is dropped from both this PR's own classification and
   * the collision candidate list. Both open PRs inheriting the same
   * already-merged migration from the base (because their diff is computed
   * against a stale fork point) is not a collision — see the PR #2540
   * gotcha. When omitted it is read from the PR; if that fails nothing is
   * excluded and the check fails closed exactly as before.
   */
  baseRef?: string | null;
  /**
   * Set for an integration-refresh PR (integration-refresh.ts): classify what
   * the head adds on top of this trunk (`deltaBase...head`) rather than the PR
   * diff, which lists trunk's own already-merged migration history — including
   * trunk deleting or squashing migrations — as if this PR did it. Mission
   * migrations are not on trunk, so they stay in the delta and are classified.
   * If the delta can't be read, the full PR file list is used, as before.
   */
  deltaBase?: string | null;
  /**
   * Open PRs this PR replaces (`predecessorPrNumbers`): their migration slots
   * are not collisions. A successor must never be told to renumber around
   * the PR it supersedes (spec workflow-state-kernel §13.11 rule 5).
   */
  ignorePrNumbers?: readonly number[];
}): Promise<MigrationSafety> {
  let completeFiles: GitHubPullRequestFile[] | null = null;
  let usedDelta = false;
  if (params.deltaBase) {
    completeFiles = await effectiveDeltaFiles(params.installationId, params.repoFullName, params.deltaBase, params.headSha);
    usedDelta = completeFiles !== null;
  }
  if (!completeFiles) {
    try {
      completeFiles = (await listAll(
        params.installationId,
        `/repos/${params.repoFullName}/pulls/${params.prNumber}/files`,
      )) as GitHubPullRequestFile[];
    } catch {
      return { safe: false, operationClass: 'CONTRACT', reason: 'could not inspect complete PR file list', kind: 'uninspectable' };
    }
  }

  const allMigrationFiles = completeFiles.filter((file) =>
    isGeneratedMigrationPath(file.filename),
  );
  const lineage = (reason: string): MigrationSafety => ({ safe: false, operationClass: 'CONTRACT', reason, kind: 'lineage' });
  // Deleting or renaming a migration rewrites lineage; no base comparison can
  // make that inherited. Only a refresh PR can show a deletion that is a
  // renumber (below), so anything else stops here without reading SQL.
  const firstRemoved = allMigrationFiles.find((file) => file.status === 'removed');
  if (firstRemoved && !params.deltaBase) return lineage(`deletes generated migration ${firstRemoved.filename}`);
  const touchesSchema = completeFiles.some(
    (file) => file.filename === 'packages/core/db/schema.ts',
  );
  if (!touchesSchema && allMigrationFiles.length === 0) return { safe: true, operationClass: 'EXPAND' };

  const filesWithContent: PullRequestMigrationFile[] = completeFiles.map((file) => ({
    filename: file.filename,
  }));
  for (const migration of allMigrationFiles) {
    if (migration.status === 'removed') continue;
    try {
      const target = filesWithContent.find((file) => file.filename === migration.filename)!;
      target.content = await readFileAtRef(
        params.installationId,
        params.repoFullName,
        migration.filename,
        params.headSha,
      );
    } catch {
      // Missing content is intentionally passed to the classifier, which fails closed.
    }
  }

  const baseSha = allMigrationFiles.length > 0
    ? await resolveBaseSha(params.installationId, params.repoFullName, params.prNumber, usedDelta ? params.deltaBase : params.baseRef)
    : undefined;
  const readOnBase = (path: string) =>
    baseSha
      ? readFileAtRef(params.installationId, params.repoFullName, path, baseSha).catch(() => undefined)
      : Promise.resolve(undefined);

  // An integration refresh whose merge moved the mission's own migration to a
  // free index past trunk's (`bun run migrations:regenerate`, legacy layout only) shows a deletion
  // paired one to one with an addition holding the same bytes. That is a
  // renumber, the shape the review exemption skips (`renumberedMigrations`);
  // the moved SQL is still classified below. Spec db-migration-gates.md
  // "A renumber in a refresh PR is not lineage".
  const removed = new Set(allMigrationFiles.filter((file) => file.status === 'removed').map((file) => file.filename));
  const moved = params.deltaBase
    ? await renumberedInRefresh(allMigrationFiles, filesWithContent, readOnBase)
    : new Set<string>();
  const removedMigration = allMigrationFiles.find((file) => file.status === 'removed' && !moved.has(file.filename));
  if (removedMigration) return lineage(`deletes generated migration ${removedMigration.filename}`);

  const inherited = new Set<string>();
  for (const migration of allMigrationFiles) {
    if (migration.status !== 'added' && migration.status !== 'modified') continue;
    const own = filesWithContent.find((file) => file.filename === migration.filename)!;
    if (own.content === undefined) continue;
    if ((await readOnBase(migration.filename)) === own.content) inherited.add(migration.filename);
  }

  const changedExistingMigration = allMigrationFiles.find(
    (file) => file.status !== 'added' && !removed.has(file.filename) && !inherited.has(file.filename) && !moved.has(file.filename),
  );
  if (changedExistingMigration) return lineage(`modifies existing migration ${changedExistingMigration.filename}`);

  // Novel SQL must sort after everything already on the target, or drizzle
  // would apply it out of order there: after what this PR inherits, and after
  // what the base merged since the branch forked (a same-number migration the
  // branch never saw). Either one is a renumber, not a decision; destructive
  // SQL in the same PR still wins (see the end of this function).
  const novel = allMigrationFiles.filter((file) => !removed.has(file.filename) && !inherited.has(file.filename));
  // Slots only exist in the legacy layout. A v1 migration is a timestamped
  // folder two branches cannot both take, so it is never ordered against a
  // slot; it goes through the SQL classifier alone.
  const novelLegacy = novel.filter((file) => isLegacyMigrationPath(file.filename));
  const highestInherited = Math.max(-1, ...[...inherited].filter(isLegacyMigrationPath).map(numberOf));
  let baseCollision: MigrationSafety | null = null;
  const outOfOrder = novelLegacy.find((file) => numberOf(file.filename) <= highestInherited);
  if (outOfOrder) {
    const highest = [...inherited].find((path) => numberOf(path) === highestInherited)!;
    baseCollision = behindBase(
      outOfOrder.filename,
      basenameOf(highest),
      `migration ${outOfOrder.filename} is ordered before migrations already on the base`,
    );
  } else if (baseSha && novelLegacy.length > 0) {
    // An unreadable listing skips this check, as before it existed; the
    // journal conflict on merge stays the backstop.
    const dir = novelLegacy[0].filename.split('/').slice(0, -1).join('/');
    const listing = await migrationNamesAt(params.installationId, params.repoFullName, dir, baseSha);
    const names = listing?.legacy ?? null;
    const highestOnBase = Math.max(-1, ...(names ?? []).map(numberOf));
    const behind = novelLegacy.find((file) => numberOf(file.filename) <= highestOnBase);
    if (listing && listing.v1Folders.length > 0) {
      // A numbered file over a v1 base is never read there: its DDL would be
      // silently skipped with the deploy green (the 0067 class). Fail closed;
      // the repair is to regenerate with the base's own drizzle-kit.
      const own = novelLegacy[0];
      baseCollision = behindBase(
        own.filename,
        listing.v1Folders[listing.v1Folders.length - 1]!,
        `legacy migration ${basenameOf(own.filename)} is in a repo whose base uses drizzle v1 migration folders, where a numbered file is never read: merge the base and run bun run migrations:regenerate`,
      );
    } else if (names && behind) {
      const taken = names.find((name) => numberOf(name) === numberOf(behind.filename))
        ?? names.find((name) => numberOf(name) === highestOnBase)!;
      baseCollision = behindBase(
        behind.filename,
        taken,
        `migration number collision: ${basenameOf(behind.filename)} is at or below ${taken}, already on the base`,
      );
    }
  }

  const openPullRequestMigrations: OpenPullRequestMigration[] = [];
  try {
    const pulls = await listAll(
      params.installationId,
      `/repos/${params.repoFullName}/pulls?state=open`,
    );
    for (const pull of pulls) {
      if (typeof pull !== 'object' || pull === null || !('number' in pull)) {
        return { safe: false, operationClass: 'CONTRACT', reason: 'could not check migration number collisions', kind: 'uninspectable' };
      }
      if (pull.number === params.prNumber) continue;
      if (params.ignorePrNumbers?.includes(pull.number as number)) continue;
      const peer = pull as { number: number; base?: { ref?: string }; head?: { sha?: string } };
      // Separate integration branches acquire a shared namespace only when
      // their integration PRs target the same branch.
      if (params.baseRef && peer.base?.ref && peer.base.ref !== params.baseRef) continue;
      const files = (await listAll(
        params.installationId,
        `/repos/${params.repoFullName}/pulls/${pull.number}/files`,
      )) as GitHubPullRequestFile[];
      const migrationPaths = files
        .filter((file: GitHubPullRequestFile) => file.status !== 'removed')
        .map((file: GitHubPullRequestFile) => file.filename)
        .filter(isGeneratedMigrationPath);
      for (const path of migrationPaths) {
        const own = filesWithContent.find((file) => file.filename === path);
        // Stacked PRs may carry the same migration before it reaches the base.
        // Require the exact path AND bytes, read at the peer's immutable head.
        if (own?.content !== undefined && peer.head?.sha) {
          const peerContent = await readFileAtRef(
            params.installationId, params.repoFullName, path, peer.head.sha,
          ).catch(() => undefined);
          if (peerContent === own.content) continue;
        }
        // A path alone cannot prove inheritance: changed SQL in the same file
        // still occupies the same slot.
        if (own?.content !== undefined && (await readOnBase(path)) === own.content) continue;
        openPullRequestMigrations.push({ path, prNumber: pull.number as number });
      }
    }
  } catch {
    return { safe: false, operationClass: 'CONTRACT', reason: 'could not check migration number collisions', kind: 'uninspectable' };
  }

  const verdict = classifyPullRequestMigrations(
    filesWithContent.filter((file) => !inherited.has(file.filename) && !removed.has(file.filename)),
    openPullRequestMigrations,
    params.prNumber,
  );
  // Destructive SQL, a mixed PR or unreadable SQL outranks a slot already
  // taken on the base: those still need their own handling.
  if (!verdict.safe && verdict.kind !== 'collision') return verdict;
  if (baseCollision && !baseCollision.safe && baseCollision.collision) {
    // Migration lane: an earlier open PR minting the same slot lands first, so
    // this renumber waits for it instead of racing it to the next index.
    const mine = numberOf(baseCollision.collision.file);
    const ahead = openPullRequestMigrations
      .filter((m) => m.prNumber < params.prNumber && numberOf(m.path) === mine)
      .sort((a, b) => a.prNumber - b.prNumber)[0];
    if (ahead) baseCollision.collision.queuedBehind = ahead.prNumber;
  }
  if (baseCollision || !verdict.safe) return baseCollision ?? verdict;
  // Last: the verdict is otherwise safe, so the only thing left to prove is
  // that the commute check CI ran still describes this base.
  const novelV1 = novel.map((file) => file.filename).filter((name) => name.endsWith('/migration.sql'));
  if (baseSha && novelV1.length > 0) {
    const stale = await staleSnapshotParent(params, novelV1, baseSha);
    if (stale) return stale;
  }
  return verdict;
}

/**
 * The stale-parent rule (spec db-migration-gates.md). `drizzle-kit check` proves
 * two snapshots commute only for the base a PR was tested against. If the PR's
 * new snapshots name a parent that is no longer a leaf of the base, a sibling
 * landed since, and the earlier green never saw it. Drizzle v1 only; a snapshot
 * that cannot be read leaves the rule off (CI's commute check is the backstop).
 */
async function staleSnapshotParent(
  params: { installationId: number; repoFullName: string; headSha: string },
  novelV1: readonly string[],
  baseSha: string,
): Promise<MigrationSafety | null> {
  const readSnapshot = async (path: string, ref: string) => {
    try {
      const parsed = JSON.parse((await readFileAtRef(params.installationId, params.repoFullName, path, ref)) ?? '');
      return typeof parsed?.id === 'string' && Array.isArray(parsed.prevIds)
        ? { id: parsed.id as string, prevIds: parsed.prevIds.filter((v: unknown): v is string => typeof v === 'string') }
        : null;
    } catch {
      return null;
    }
  };
  const dir = novelV1[0]!.split('/').slice(0, -2).join('/');
  const own = await Promise.all(novelV1.map((p) => readSnapshot(p.replace(/migration\.sql$/, 'snapshot.json'), params.headSha)));
  if (own.some((s) => !s)) return null;
  const ownIds = new Set(own.map((s) => s!.id));
  const parents = [...new Set(own.flatMap((s) => s!.prevIds).filter((id) => !ownIds.has(id)))];
  if (parents.length === 0) return null;

  const listing = await migrationNamesAt(params.installationId, params.repoFullName, dir, baseSha);
  if (!listing) return null;
  // The newest few base folders are enough to find the leaf: a chain's tip is its newest folder.
  const recent = [...listing.v1Folders].sort().slice(-5);
  const baseSnaps = (await Promise.all(recent.map((f) => readSnapshot(`${dir}/${f}/snapshot.json`, baseSha)))).filter(
    (s): s is { id: string; prevIds: string[] } => !!s,
  );
  if (baseSnaps.length === 0) return null;
  const referenced = new Set(baseSnaps.flatMap((s) => s.prevIds));
  const leaves = new Set(baseSnaps.filter((s) => !referenced.has(s.id)).map((s) => s.id));
  const stale = parents.filter((id) => !leaves.has(id));
  if (stale.length === 0) return null;
  return {
    safe: false,
    operationClass: 'CONTRACT',
    kind: 'stale_parent',
    reason:
      `migration snapshot parent is no longer a leaf of the base: a migration landed since CI ran, so the earlier ` +
      `green never tested the two together. CI must run again on a fresh base, needs rebase onto base branch`,
  };
}
