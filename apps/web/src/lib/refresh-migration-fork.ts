/**
 * Did a clean refresh merge fork the Drizzle snapshot chain?
 *
 * drizzle v1 keeps each migration in its own `<YYYYMMDDHHMMSS>_<slug>/` folder,
 * so two branches' migrations never conflict as text and GitHub's merges API
 * lands them both with a 201. Each side's first new snapshot still names the
 * same parent (the merge base's newest), so the merged branch has two heads:
 * `drizzle-kit check` fails, `schema-matches-snapshot` goes red on every PR into
 * the branch, and the next `db:generate` diffs against whichever head it picks.
 *
 * This module only detects. Both heads are known before the merge, so the
 * refresh asks first and, on a fork, lands the merge with the mission's
 * migrations already regenerated on trunk's chain
 * (`lib/refresh-migration-reparent.ts`); when that is refused it files the
 * repair task, whose brief is `bun run migrations:regenerate --base=<trunk>`.
 *
 * Detection is by folder names, not snapshot contents. The mission head and
 * trunk each hold the merge base's folders plus their own new ones, so each
 * side's set difference is exactly what it added. A fork is both differences
 * non-empty. A side that already regenerated on top of the other holds all of
 * the other's folders, so a repaired branch never reads as forked again.
 */

import { githubApi } from '@/lib/github';
import { V1_FOLDER } from '@buildd/core/db/migrate-tree';

export interface MigrationFork {
  /** The Drizzle `out` dir, repo-relative (e.g. `packages/core/drizzle`). */
  drizzleDir: string;
  /** Folders the mission branch had that trunk did not. */
  missionOnly: string[];
  /** Folders trunk had that the mission branch did not. */
  trunkOnly: string[];
}

/** Every drizzle dir a compare's file list added a v1 migration folder to. */
export function drizzleDirsTouched(files: Array<{ filename?: string; status?: string }>): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    if (typeof f.filename !== 'string' || f.status === 'removed') continue;
    const parts = f.filename.split('/');
    if (parts.length < 2) continue;
    const leaf = parts[parts.length - 1];
    const folder = parts[parts.length - 2]!;
    if ((leaf !== 'migration.sql' && leaf !== 'snapshot.json') || !V1_FOLDER.test(folder)) continue;
    dirs.add(parts.slice(0, -2).join('/'));
  }
  return [...dirs].sort();
}

/** The two sides' own folders, or null when they do not fork. */
export function forkOf(drizzleDir: string, missionFolders: string[], trunkFolders: string[]): MigrationFork | null {
  const trunk = new Set(trunkFolders);
  const mission = new Set(missionFolders);
  const missionOnly = missionFolders.filter((f) => !trunk.has(f)).sort();
  const trunkOnly = trunkFolders.filter((f) => !mission.has(f)).sort();
  return missionOnly.length > 0 && trunkOnly.length > 0 ? { drizzleDir, missionOnly, trunkOnly } : null;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function filesBetween(installationId: number, repoFullName: string, base: string, head: string) {
  const cmp = await githubApi(installationId, `/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  return Array.isArray(cmp?.files) ? (cmp.files as Array<{ filename?: string; status?: string }>) : [];
}

async function foldersAt(installationId: number, repoFullName: string, dir: string, ref: string): Promise<string[]> {
  const entries = await githubApi(installationId, `/repos/${repoFullName}/contents/${encodePath(dir)}?ref=${encodeURIComponent(ref)}`);
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e: { type?: string; name?: unknown }) => e?.type === 'dir' && typeof e.name === 'string' && V1_FOLDER.test(e.name))
    .map((e: { name: string }) => e.name);
}

/**
 * The fork a merge of `trunkSha` into `missionHeadSha` (the branch head the
 * merge commit was made on) produced, or null. Each compare finds the drizzle
 * dirs one side touched; reading either is enough, so a side whose compare
 * GitHub truncated is covered by the other. Throws on a failed GitHub read: the
 * caller decides what an unknown answer means.
 */
export async function detectRefreshMigrationFork(args: {
  installationId: number;
  repoFullName: string;
  missionHeadSha: string;
  trunkSha: string;
}): Promise<MigrationFork | null> {
  const { installationId, repoFullName, missionHeadSha, trunkSha } = args;
  const [missionSide, trunkSide] = await Promise.all([
    filesBetween(installationId, repoFullName, trunkSha, missionHeadSha),
    filesBetween(installationId, repoFullName, missionHeadSha, trunkSha),
  ]);
  const missionDirs = new Set(drizzleDirsTouched(missionSide));
  const trunkDirs = drizzleDirsTouched(trunkSide);
  // A fork needs both sides to have added one, so a dir only one compare names
  // is still read: the other side's compare may be the truncated one.
  const dirs = [...new Set([...missionDirs, ...trunkDirs])].sort();
  for (const dir of dirs) {
    const [mission, trunk] = await Promise.all([
      foldersAt(installationId, repoFullName, dir, missionHeadSha),
      foldersAt(installationId, repoFullName, dir, trunkSha),
    ]);
    const fork = forkOf(dir, mission, trunk);
    if (fork) return fork;
  }
  return null;
}
