import { githubApi } from '@/lib/github';
import {
  classifyPullRequestMigrations,
  isGeneratedMigrationPath,
  type MigrationSafety,
  type OpenPullRequestMigration,
  type PullRequestMigrationFile,
} from '@/lib/migration-safety';

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
 * Load the executable SQL for this PR and migration filenames from every other
 * open PR, then run the conservative pure classifier.
 */
export async function inspectPullRequestMigrations(params: {
  installationId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  files: GitHubPullRequestFile[];
  /**
   * This PR's base branch (e.g. `dev`) — when given, a path that already
   * exists on the base with that exact name is dropped from the collision
   * candidate list before number-matching. Both open PRs inheriting the same
   * already-merged migration byte-for-byte from the base (because their diff
   * is computed against a stale fork point) is not a collision — see the
   * PR #2540 gotcha. Omit only when the base branch genuinely can't be
   * determined; the check then fails closed exactly as before.
   */
  baseRef?: string | null;
}): Promise<MigrationSafety> {
  let completeFiles: GitHubPullRequestFile[];
  try {
    completeFiles = (await listAll(
      params.installationId,
      `/repos/${params.repoFullName}/pulls/${params.prNumber}/files`,
    )) as GitHubPullRequestFile[];
  } catch {
    return { safe: false, operationClass: 'CONTRACT', reason: 'could not inspect complete PR file list' };
  }

  const allMigrationFiles = completeFiles.filter((file) =>
    isGeneratedMigrationPath(file.filename),
  );
  const removedMigration = allMigrationFiles.find((file) => file.status === 'removed');
  if (removedMigration) {
    return {
      safe: false,
      operationClass: 'CONTRACT',
      reason: `deletes generated migration ${removedMigration.filename}`,
    };
  }
  const changedExistingMigration = allMigrationFiles.find(
    (file) => file.status !== 'added',
  );
  if (changedExistingMigration) {
    return {
      safe: false,
      operationClass: 'CONTRACT',
      reason: `modifies existing migration ${changedExistingMigration.filename}`,
    };
  }
  const migrationFiles = allMigrationFiles;
  const touchesSchema = completeFiles.some(
    (file) => file.filename === 'packages/core/db/schema.ts',
  );
  if (!touchesSchema && migrationFiles.length === 0) return { safe: true, operationClass: 'EXPAND' };

  const filesWithContent: PullRequestMigrationFile[] = completeFiles.map((file) => ({
    filename: file.filename,
  }));
  for (const migration of migrationFiles) {
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
      const files = (await listAll(
        params.installationId,
        `/repos/${params.repoFullName}/pulls/${pull.number}/files`,
      )) as GitHubPullRequestFile[];
      const migrationPaths = files
        .filter((file: GitHubPullRequestFile) => file.status !== 'removed')
        .map((file: GitHubPullRequestFile) => file.filename)
        .filter(isGeneratedMigrationPath);
      for (const path of migrationPaths) {
        // Exact same path already on the base branch means this is history
        // both PRs inherited, not a slot the other PR is newly claiming.
        if (params.baseRef) {
          const onBase = await readFileAtRef(params.installationId, params.repoFullName, path, params.baseRef).catch(
            () => undefined,
          );
          if (onBase !== undefined) continue;
        }
        openPullRequestMigrations.push({ path, prNumber: pull.number as number });
      }
    }
  } catch {
    return { safe: false, operationClass: 'CONTRACT', reason: 'could not check migration number collisions' };
  }

  return classifyPullRequestMigrations(filesWithContent, openPullRequestMigrations, params.prNumber);
}
