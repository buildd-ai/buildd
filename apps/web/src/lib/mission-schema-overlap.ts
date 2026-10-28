import { githubApi } from '@/lib/github';

/**
 * A schema object a PR adds that another open mission's integration branch
 * already adds over trunk. Both branches then ship their own migration for the
 * same table, and whichever mission lands second forks the snapshot chain: the
 * rename/rename conflict on its next refresh is resolved by deleting its copy
 * by hand. Nothing else sees it coming, because claim lanes are per task and
 * the migration inspector otherwise compares a PR only with its base and trunk.
 *
 * The usual cause is a task branch that merged the other mission's branch to
 * build on its code: the migration travels with the code and gets regenerated
 * as this mission's own. The remedy is to land the shared schema change on
 * trunk first (or merge the other mission), then regenerate.
 *
 * A hit is a hold on the merge, never a refusal: the SQL is still safe.
 */
export interface SchemaOverlapHold {
  missionId: string;
  missionTitle: string;
  branch: string;
  /** Human labels, e.g. `table "serial_lane_entries"`. */
  entities: string[];
  /** The task PR that put the first entity on the other branch, when GitHub can say. */
  landedBy: { prNumber: number; taskShortId: string | null } | null;
  reason: string;
}

/** Every hold's reason starts with this; `landPr` routes it to a wait (pr-landing.ts). */
export const SHARED_SCHEMA_HOLD_PREFIX = 'shared schema hold:';

/** Another mission's integration branch in the same repo. */
export interface MissionBranchRef {
  missionId: string;
  title: string;
  branch: string;
}

/** Missions whose integration branch can still ship: not completed or archived. */
const OPEN_MISSION_STATUSES = ['active', 'paused', 'budget_exhausted'] as const;

/** Open missions with an integration branch in `repoFullName`. */
export async function openMissionBranches(repoFullName: string): Promise<MissionBranchRef[]> {
  const { db } = await import('@buildd/core/db');
  const { missions, workspaces } = await import('@buildd/core/db/schema');
  const { and, eq, inArray, isNotNull } = await import('drizzle-orm');
  const rows = await db
    .select({ missionId: missions.id, title: missions.title, branch: missions.workingBranch })
    .from(missions)
    .innerJoin(workspaces, eq(workspaces.id, missions.workspaceId))
    .where(and(
      eq(workspaces.repo, repoFullName),
      eq(missions.integrationBranchEnabled, true),
      isNotNull(missions.workingBranch),
      inArray(missions.status, [...OPEN_MISSION_STATUSES]),
    ));
  return rows.filter((r): r is MissionBranchRef => typeof r.branch === 'string' && r.branch.length > 0);
}

/**
 * `<type>|<schema>|<table>|<name>`: what drizzle-kit's own diff resolvers
 * identify a v8 snapshot entity by.
 */
export function snapshotEntityKey(entity: unknown): string {
  if (!entity || typeof entity !== 'object') return `?|${JSON.stringify(entity)}`;
  const e = entity as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  if (typeof e.name !== 'string') return `${s(e.entityType)}|${JSON.stringify(entity)}`;
  return `${s(e.entityType)}|${s(e.schema)}|${s(e.table)}|${e.name}`;
}

/** Only these say "the same object exists twice"; an index or FK follows its table. */
const COMPARED_TYPES = new Set(['tables', 'enums', 'columns']);

interface Leaf {
  /** v1 folder names in the migrations dir. */
  folders: string[];
  /** Entity keys of the newest folder's snapshot, compared types only. */
  keys: Set<string>;
}

const LEAF_CACHE_LIMIT = 64;
const leafCache = new Map<string, Promise<Leaf | null>>();

/** Test hook. */
export function clearLeafCache(): void {
  leafCache.clear();
}

/**
 * The migrations dir's folders and its newest snapshot's entities at an
 * immutable `sha`: one listing, one raw read (a snapshot can pass the
 * contents API's 1 MB base64 limit, the raw media type does not). Cached by
 * sha; null when either read fails.
 */
function leafAt(installationId: number, repoFullName: string, dir: string, sha: string): Promise<Leaf | null> {
  const key = `${repoFullName}:${dir}@${sha}`;
  const hit = leafCache.get(key);
  if (hit) return hit;
  const load = (async (): Promise<Leaf | null> => {
    try {
      const encodedDir = dir.split('/').map(encodeURIComponent).join('/');
      const listing = await githubApi(installationId, `/repos/${repoFullName}/contents/${encodedDir}?ref=${encodeURIComponent(sha)}`);
      if (!Array.isArray(listing)) return null;
      const folders = listing
        .filter((e: { name?: unknown; type?: unknown }) => e?.type === 'dir' && typeof e.name === 'string' && /^\d{14}_[^/]+$/.test(e.name))
        .map((e: { name: string }) => e.name)
        .sort();
      const newest = folders.at(-1);
      if (!newest) return { folders, keys: new Set() };
      const snapshot = await githubApi(
        installationId,
        `/repos/${repoFullName}/contents/${encodedDir}/${encodeURIComponent(newest)}/snapshot.json?ref=${encodeURIComponent(sha)}`,
        { headers: { Accept: 'application/vnd.github.raw+json' } },
      );
      const parsed = snapshot?.encoding === 'base64' && typeof snapshot.content === 'string'
        ? JSON.parse(Buffer.from(snapshot.content.replace(/\n/g, ''), 'base64').toString('utf8'))
        : snapshot;
      if (!Array.isArray(parsed?.ddl)) return null;
      const keys = new Set<string>();
      for (const entity of parsed.ddl as unknown[]) {
        const type = (entity as { entityType?: unknown })?.entityType;
        if (typeof type === 'string' && COMPARED_TYPES.has(type)) keys.add(snapshotEntityKey(entity));
      }
      return { folders, keys };
    } catch {
      return null;
    }
  })();
  leafCache.set(key, load);
  load.then((leaf) => { if (!leaf) leafCache.delete(key); });
  while (leafCache.size > LEAF_CACHE_LIMIT) leafCache.delete(leafCache.keys().next().value!);
  return load;
}

function added(leaf: Leaf, over: Leaf): Set<string> {
  return new Set([...leaf.keys].filter((k) => !over.keys.has(k)));
}

/** Labels for the shared keys; a column of a table that is itself shared is not listed again. */
function labels(keys: readonly string[]): string[] {
  const parts = keys.map((k) => k.split('|'));
  const tables = new Set(parts.filter(([t]) => t === 'tables').map(([, schema, , name]) => `${schema}.${name}`));
  const q = (schema: string, name: string) => (schema && schema !== 'public' ? `"${schema}"."${name}"` : `"${name}"`);
  return parts
    .filter(([t, schema, table]) => t !== 'columns' || !tables.has(`${schema}.${table}`))
    .map(([t, schema, table, name]) =>
      t === 'tables' ? `table ${q(schema, name)}` : t === 'enums' ? `enum ${q(schema, name)}` : `column ${q(schema, table)}."${name}"`)
    .sort();
}

/**
 * The task PR that added the folder carrying the first shared entity to the
 * other mission's branch: the oldest commit touching that folder's SQL, and the
 * PR GitHub associates with it. Null when GitHub cannot say.
 */
async function landedBy(
  installationId: number,
  repoFullName: string,
  dir: string,
  branchSha: string,
  candidates: readonly string[],
  sharedKey: string,
): Promise<SchemaOverlapHold['landedBy']> {
  try {
    const [type, , table, name] = sharedKey.split('|');
    const needle = `"${type === 'columns' ? table : name}"`;
    let folder: string | undefined;
    for (const f of candidates) {
      const data = await githubApi(installationId, `/repos/${repoFullName}/contents/${dir.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(f)}/migration.sql?ref=${encodeURIComponent(branchSha)}`);
      const sql = data?.encoding === 'base64' && typeof data.content === 'string'
        ? Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
        : '';
      if (sql.includes(needle)) { folder = f; break; }
    }
    folder ??= candidates.at(-1);
    if (!folder) return null;
    const commits = await githubApi(
      installationId,
      `/repos/${repoFullName}/commits?sha=${encodeURIComponent(branchSha)}&path=${encodeURIComponent(`${dir}/${folder}/migration.sql`)}&per_page=100`,
    );
    const oldest = Array.isArray(commits) ? commits.at(-1)?.sha : undefined;
    if (typeof oldest !== 'string') return null;
    const pulls = await githubApi(installationId, `/repos/${repoFullName}/commits/${oldest}/pulls`);
    const pr = Array.isArray(pulls) ? pulls[0] : undefined;
    if (typeof pr?.number !== 'number') return null;
    const ref = typeof pr.head?.ref === 'string' ? pr.head.ref : '';
    return { prNumber: pr.number, taskShortId: /(?:^|\/)([0-9a-f]{8})-/.exec(ref)?.[1] ?? null };
  } catch {
    return null;
  }
}

/**
 * The first other open mission whose integration branch adds, over trunk, a
 * table, enum or column this PR also adds over its base. Missions whose branch
 * is this PR's base or head are skipped (that is the mission's own work).
 * Null on no overlap, and whenever a read fails: the commute check in CI
 * stays the backstop, as it is for the stale-parent rule.
 */
export async function findMissionSchemaOverlap(params: {
  installationId: number;
  repoFullName: string;
  /** The migrations dir, e.g. `packages/core/drizzle`. */
  dir: string;
  headSha: string;
  baseSha: string;
  baseRef?: string;
  headRef?: string;
  /** Trunk's tip; the base's when the PR targets trunk. */
  trunkSha: string;
  /** Trunk's name, for the brief. */
  trunkRef: string;
  missionBranches: readonly MissionBranchRef[];
}): Promise<SchemaOverlapHold | null> {
  const others = params.missionBranches.filter((m) => m.branch !== params.baseRef && m.branch !== params.headRef);
  if (others.length === 0) return null;
  const read = (sha: string) => leafAt(params.installationId, params.repoFullName, params.dir, sha);
  const [head, base, trunk] = await Promise.all([read(params.headSha), read(params.baseSha), read(params.trunkSha)]);
  if (!head || !base || !trunk) return null;
  const ours = added(head, base);
  if (ours.size === 0) return null;

  for (const mission of others) {
    let sha: string | undefined;
    try {
      const encodedRef = mission.branch.split('/').map(encodeURIComponent).join('/');
      const ref = await githubApi(params.installationId, `/repos/${params.repoFullName}/git/ref/heads/${encodedRef}`);
      sha = typeof ref?.object?.sha === 'string' ? ref.object.sha : undefined;
    } catch {
      sha = undefined;
    }
    if (!sha || sha === params.headSha) continue;
    const theirs = await read(sha);
    if (!theirs) continue;
    const shared = [...added(theirs, trunk)].filter((k) => ours.has(k)).sort((a, b) => {
      // Name a table or enum before a column: it is the object the brief is about.
      const rank = (k: string) => (k.startsWith('columns|') ? 1 : 0);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    if (shared.length === 0) continue;

    const onTrunk = new Set(trunk.folders);
    const theirFolders = theirs.folders.filter((f) => !onTrunk.has(f));
    const landed = await landedBy(params.installationId, params.repoFullName, params.dir, sha, theirFolders, shared[0]!);
    const entities = labels(shared);
    const by = landed
      ? ` (landed there by ${landed.taskShortId ? `task ${landed.taskShortId} in ` : ''}PR #${landed.prNumber})`
      : '';
    return {
      missionId: mission.missionId,
      missionTitle: mission.title,
      branch: mission.branch,
      entities,
      landedBy: landed,
      reason:
        `${SHARED_SCHEMA_HOLD_PREFIX} this PR adds ${entities.join(', ')}, which mission "${mission.title}" already carries on its branch ${mission.branch}${by}. ` +
        `Two branches shipping their own migration for one object fork the migration chain. Land the shared schema change on ` +
        `${params.trunkRef} first (or merge that mission), then run bun run migrations:regenerate --base=origin/${params.trunkRef}`,
    };
  }
  return null;
}
