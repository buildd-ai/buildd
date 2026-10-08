import { githubApi } from '@/lib/github';
import {
  classifyPullRequestMigrations,
  getMigrationNumber,
  isGeneratedMigrationPath,
  type MigrationSafety,
  type OpenPullRequestMigration,
  type PullRequestMigrationFile,
} from '@/lib/migration-safety';
import { effectiveDeltaFiles } from '@/lib/integration-refresh';

interface GitHubPullRequestFile {
  filename: string;
  status?: string;
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
 * Load executable SQL and compare migration slots in PRs targeting the same
 * base. Identical files inherited by stacked PRs do not claim a second slot,
 * and SQL the target already carries byte-for-byte is not this PR's to
 * classify — see `resolveBaseSha`.
 */
export async function inspectPullRequestMigrations(params: {
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
      return { safe: false, operationClass: 'CONTRACT', reason: 'could not inspect complete PR file list' };
    }
  }

  const allMigrationFiles = completeFiles.filter((file) =>
    isGeneratedMigrationPath(file.filename),
  );
  // Deleting or renaming a migration rewrites lineage; no base comparison can
  // make that inherited.
  const removedMigration = allMigrationFiles.find((file) => file.status === 'removed');
  if (removedMigration) {
    return {
      safe: false,
      operationClass: 'CONTRACT',
      reason: `deletes generated migration ${removedMigration.filename}`,
    };
  }
  const touchesSchema = completeFiles.some(
    (file) => file.filename === 'packages/core/db/schema.ts',
  );
  if (!touchesSchema && allMigrationFiles.length === 0) return { safe: true, operationClass: 'EXPAND' };

  const filesWithContent: PullRequestMigrationFile[] = completeFiles.map((file) => ({
    filename: file.filename,
  }));
  for (const migration of allMigrationFiles) {
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

  const inherited = new Set<string>();
  for (const migration of allMigrationFiles) {
    if (migration.status !== 'added' && migration.status !== 'modified') continue;
    const own = filesWithContent.find((file) => file.filename === migration.filename)!;
    if (own.content === undefined) continue;
    if ((await readOnBase(migration.filename)) === own.content) inherited.add(migration.filename);
  }

  const changedExistingMigration = allMigrationFiles.find(
    (file) => file.status !== 'added' && !inherited.has(file.filename),
  );
  if (changedExistingMigration) {
    return {
      safe: false,
      operationClass: 'CONTRACT',
      reason: `modifies existing migration ${changedExistingMigration.filename}`,
    };
  }

  // Novel SQL must sort after everything it inherits, or drizzle would apply
  // it out of order on the target.
  const highestInherited = Math.max(-1, ...[...inherited].map((path) => Number(getMigrationNumber(path))));
  const outOfOrder = allMigrationFiles.find(
    (file) => !inherited.has(file.filename) && Number(getMigrationNumber(file.filename)) <= highestInherited,
  );
  if (outOfOrder) {
    return {
      safe: false,
      operationClass: 'CONTRACT',
      reason: `migration ${outOfOrder.filename} is ordered before migrations already on the base`,
    };
  }

  const openPullRequestMigrations: OpenPullRequestMigration[] = [];
  try {
    const pulls = await listAll(
      params.installationId,
      `/repos/${params.repoFullName}/pulls?state=open`,
    );
    for (const pull of pulls) {
      if (typeof pull !== 'object' || pull === null || !('number' in pull)) {
        return { safe: false, operationClass: 'CONTRACT', reason: 'could not check migration number collisions' };
      }
      if (pull.number === params.prNumber) continue;
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
    return { safe: false, operationClass: 'CONTRACT', reason: 'could not check migration number collisions' };
  }

  return classifyPullRequestMigrations(
    filesWithContent.filter((file) => !inherited.has(file.filename)),
    openPullRequestMigrations,
    params.prNumber,
  );
}
