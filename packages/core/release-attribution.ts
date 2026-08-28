import { eq, inArray, isNotNull, and } from 'drizzle-orm';
import { workers, releaseTasks, githubInstallations } from './db/schema';
import type { ReleaseArchetype } from './release-archetype';

// Structural type for the Drizzle db instance — only what this module uses.
export type DrizzleDb = {
  select: () => {
    from: (table: any) => {
      where: (condition: any) => Promise<any[]>;
    };
  };
  insert: (table: any) => {
    values: (rows: any[]) => {
      onConflictDoNothing: () => Promise<any>;
    };
  };
  query: {
    githubInstallations: {
      findFirst: (opts: any) => Promise<any>;
    };
  };
};

export interface AttributeReleaseInput {
  releaseId: string;
  workspaceId: string;
  previousSha: string;
  headSha: string;
  archetype: ReleaseArchetype;
  /** "owner/repo" — needed to construct the GitHub compare URL */
  repoFullName: string;
  githubInstallationId: number;
  db: DrizzleDb;
  /** Injected for testing. Defaults to a real GitHub API call using the cached installation token. */
  githubFetch?: (path: string) => Promise<any>;
}

async function defaultGithubFetch(db: DrizzleDb, installationId: number, path: string): Promise<any> {
  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
  });
  const token = installation?.accessToken;
  if (!token) {
    throw new Error(`No cached GitHub token for installation ${installationId}`);
  }
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
  }
  return response.json();
}

/** Extract PR numbers from merge commits using the standard GitHub merge commit message pattern. */
function extractPrNumbers(commits: any[]): Map<number, string> {
  const prToSha = new Map<number, string>();
  for (const commit of commits) {
    const match = (commit.commit?.message as string | undefined)?.match(
      /Merge pull request #(\d+)/,
    );
    if (match) {
      const pr = parseInt(match[1], 10);
      if (!prToSha.has(pr)) {
        prToSha.set(pr, commit.sha as string);
      }
    }
  }
  return prToSha;
}

export async function attributeRelease(
  input: AttributeReleaseInput,
): Promise<{ attributed: number; skipped: number }> {
  const { releaseId, workspaceId, previousSha, headSha, archetype, repoFullName, githubInstallationId, db } =
    input;

  const doFetch =
    input.githubFetch ??
    ((path: string) => defaultGithubFetch(db, githubInstallationId, path));

  const compare = await doFetch(`/repos/${repoFullName}/compare/${previousSha}...${headSha}`);
  const commits: any[] = compare?.commits ?? [];

  if (commits.length === 0) {
    return { attributed: 0, skipped: 0 };
  }

  if (archetype === 'continuous') {
    return attributeBySha({ releaseId, workspaceId, commits, db });
  }

  return attributeByPr({ releaseId, workspaceId, commits, db });
}

async function attributeBySha(params: {
  releaseId: string;
  workspaceId: string;
  commits: any[];
  db: DrizzleDb;
}): Promise<{ attributed: number; skipped: number }> {
  const { releaseId, workspaceId, commits, db } = params;

  const shas = commits.map((c: any) => c.sha as string).filter(Boolean);
  if (shas.length === 0) return { attributed: 0, skipped: 0 };

  const matched: any[] = await db
    .select()
    .from(workers)
    .where(and(inArray(workers.lastCommitSha, shas), eq(workers.workspaceId, workspaceId)));

  // Build sha → first worker with a taskId
  const shaToWorker = new Map<string, any>();
  for (const w of matched) {
    if (w.taskId && !shaToWorker.has(w.lastCommitSha)) {
      shaToWorker.set(w.lastCommitSha, w);
    }
  }

  const rows: Array<{ releaseId: string; taskId: string; prNumber: null; commitSha: string }> = [];
  let skipped = 0;

  for (const sha of shas) {
    const w = shaToWorker.get(sha);
    if (w?.taskId) {
      rows.push({ releaseId, taskId: w.taskId as string, prNumber: null, commitSha: sha });
    } else {
      skipped++;
    }
  }

  if (rows.length > 0) {
    await db.insert(releaseTasks).values(rows).onConflictDoNothing();
  }

  return { attributed: rows.length, skipped };
}

async function attributeByPr(params: {
  releaseId: string;
  workspaceId: string;
  commits: any[];
  db: DrizzleDb;
}): Promise<{ attributed: number; skipped: number }> {
  const { releaseId, workspaceId, commits, db } = params;

  const prToSha = extractPrNumbers(commits);
  const prNumbers = [...prToSha.keys()];

  if (prNumbers.length === 0) {
    return { attributed: 0, skipped: 0 };
  }

  const matched: any[] = await db
    .select()
    .from(workers)
    .where(
      and(
        inArray(workers.prNumber, prNumbers),
        eq(workers.workspaceId, workspaceId),
        isNotNull(workers.mergedAt),
      ),
    );

  const seenPrs = new Set<number>();
  const rows: Array<{ releaseId: string; taskId: string; prNumber: number; commitSha: string | null }> = [];

  for (const w of matched) {
    if (!w.taskId || !w.prNumber || seenPrs.has(w.prNumber)) continue;
    seenPrs.add(w.prNumber as number);
    rows.push({
      releaseId,
      taskId: w.taskId as string,
      prNumber: w.prNumber as number,
      commitSha: prToSha.get(w.prNumber as number) ?? null,
    });
  }

  const skipped = prNumbers.length - seenPrs.size;

  if (rows.length > 0) {
    await db.insert(releaseTasks).values(rows).onConflictDoNothing();
  }

  return { attributed: rows.length, skipped };
}
