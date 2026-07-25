import { githubApi } from '@/lib/github';
import {
  classifyPullRequestMigrations,
  isGeneratedMigrationPath,
  type MigrationSafety,
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
}): Promise<MigrationSafety> {
  let completeFiles: GitHubPullRequestFile[];
  try {
    completeFiles = (await listAll(
      params.installationId,
      `/repos/${params.repoFullName}/pulls/${params.prNumber}/files`,
    )) as GitHubPullRequestFile[];
  } catch {
    return { safe: false, reason: 'could not inspect complete PR file list' };
  }

  const migrationFiles = completeFiles.filter(
    (file) => file.status !== 'removed' && isGeneratedMigrationPath(file.filename),
  );
  const touchesSchema = completeFiles.some(
    (file) => file.filename === 'packages/core/db/schema.ts',
  );
  if (!touchesSchema && migrationFiles.length === 0) return { safe: true };

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

  const openMigrationPaths: string[] = [];
  try {
    const pulls = await listAll(
      params.installationId,
      `/repos/${params.repoFullName}/pulls?state=open`,
    );
    for (const pull of pulls) {
      if (typeof pull !== 'object' || pull === null || !('number' in pull)) {
        return { safe: false, reason: 'could not check migration number collisions' };
      }
      if (pull.number === params.prNumber) continue;
      const files = (await listAll(
        params.installationId,
        `/repos/${params.repoFullName}/pulls/${pull.number}/files`,
      )) as GitHubPullRequestFile[];
      openMigrationPaths.push(
        ...files
          .filter((file: GitHubPullRequestFile) => file.status !== 'removed')
          .map((file: GitHubPullRequestFile) => file.filename)
          .filter(isGeneratedMigrationPath),
      );
    }
  } catch {
    return { safe: false, reason: 'could not check migration number collisions' };
  }

  return classifyPullRequestMigrations(filesWithContent, openMigrationPaths);
}
