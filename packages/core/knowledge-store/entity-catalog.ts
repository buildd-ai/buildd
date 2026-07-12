import { sql } from 'drizzle-orm';

/**
 * Entity catalog for claim-time context injection (knowledge-graph-retrieval
 * §8.4). Given a task's likely file paths, surface the workspace's canonical
 * entity names so agents reference real entities instead of inventing loose
 * refs that pile up in pending_entity_refs.
 *
 * Everything here is best-effort: catalog lookup must NEVER fail a claim, so
 * fetch degrades to partial (or empty) results on any DB error.
 */

export interface CatalogEntity {
  kind: string;
  key: string;
  canonicalName: string;
}

/** Minimal executor shape (matches drizzle db.execute) — injectable for tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- contravariant param: real db.execute takes SQLWrapper
type SqlExecutor = { execute: (query: any) => PromiseLike<{ rows: unknown[] }> };

// ── File-path extraction ──────────────────────────────────────────────────────

const DEFAULT_MAX_PATHS = 8;

// Path segments allow word chars plus Next.js dynamic segments / route groups.
const PATH_RE = /^[\w.@()[\]-]+(?:\/[\w.@()[\]-]+)+$/;
const BARE_FILE_RE = /^[\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9]{1,8}$/;
const EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/;

function cleanToken(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^[*('"<[{]+/, '').replace(/[*)'">\]},;:!?]+$/, '');
  t = t.replace(/#[^/]*$/, '');        // symbol fragment: path.ts#name
  t = t.replace(/:\d+(?::\d+)?$/, ''); // line/col suffix: path.ts:12:5
  t = t.replace(/\.+$/, '');           // sentence-ending dot(s)
  if (t.startsWith('./')) t = t.slice(2);
  return t;
}

/**
 * Extract likely repo-relative file paths from free text (task title,
 * description, mission context). Backtick-quoted tokens are high-signal, so
 * bare filenames (no directory) are accepted there; elsewhere a token must
 * look like `dir/sub/file.ext`. Pure — no I/O.
 */
export function extractFilePaths(text: string, max = DEFAULT_MAX_PATHS): string[] {
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();

  const consider = (raw: string, allowBareFilename: boolean) => {
    const t = cleanToken(raw);
    if (!t || t.includes('://') || /^www\./i.test(t)) return;
    const isPath = PATH_RE.test(t) && EXTENSION_RE.test(t);
    const isBareFile = allowBareFilename && !t.includes('/') && BARE_FILE_RE.test(t);
    if (!isPath && !isBareFile) return;
    if (!seen.has(t)) {
      seen.add(t);
      found.push(t);
    }
  };

  // Backticked spans first; remove them so the bare scan doesn't re-see them.
  const remainder = text.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
    for (const tok of inner.split(/\s+/)) consider(tok, true);
    return ' ';
  });
  for (const tok of remainder.split(/\s+/)) consider(tok, false);

  return found.slice(0, max);
}

// ── Catalog fetch ─────────────────────────────────────────────────────────────

export interface EntityCatalogParams {
  workspaceId: string;
  /** Likely file paths from extractFilePaths (full paths and/or bare filenames). */
  paths?: string[];
  maxFiles?: number;
  maxSymbols?: number;
  maxTopConnected?: number;
  maxEntities?: number;
}

type EntityRow = { id?: string; kind?: string; key?: string; canonical_name?: string };

/**
 * Fetch the entity catalog for a task: file entities matching the given paths,
 * symbols those files define (via `defines` edges), and the workspace's
 * most-connected non-code entities as general vocabulary. All lookups are
 * indexed and LIMITed; any failure degrades to whatever was fetched so far.
 */
export async function fetchEntityCatalog(
  db: SqlExecutor,
  params: EntityCatalogParams,
): Promise<CatalogEntity[]> {
  const {
    workspaceId,
    paths = [],
    maxFiles = 8,
    maxSymbols = 16,
    maxTopConnected = 8,
    maxEntities = 30,
  } = params;

  const out: CatalogEntity[] = [];
  const seen = new Set<string>();
  const addRows = (rows: unknown[]) => {
    for (const r of rows as EntityRow[]) {
      if (!r?.kind || !r.key || !r.canonical_name) continue; // guard malformed rows
      const dedupeKey = `${r.kind}:${r.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ kind: r.kind, key: r.key, canonicalName: r.canonical_name });
    }
  };

  try {
    // 1. File entities for the task's likely paths. Full paths match on key
    //    (unique index); bare filenames match on canonical_name within the
    //    workspace's kind='file' partition.
    let fileIds: string[] = [];
    if (paths.length > 0) {
      const fullPaths = paths.filter(p => p.includes('/'));
      const basenames = paths.filter(p => !p.includes('/'));
      const conds = [];
      if (fullPaths.length > 0) {
        conds.push(sql`key IN (${sql.join(fullPaths.map(p => sql`${p}`), sql`, `)})`);
      }
      if (basenames.length > 0) {
        conds.push(sql`canonical_name IN (${sql.join(basenames.map(b => sql`${b}`), sql`, `)})`);
      }
      const fileRes = await db.execute(sql`
        SELECT id, kind, key, canonical_name
        FROM knowledge_entities
        WHERE workspace_id = ${workspaceId}
          AND kind = 'file'
          AND (${sql.join(conds, sql` OR `)})
        LIMIT ${maxFiles}
      `);
      addRows(fileRes.rows);
      fileIds = (fileRes.rows as EntityRow[]).map(r => r.id).filter((id): id is string => !!id);
    }

    // 2. Symbols defined by those files: (file) -defines-> (symbol) edges.
    if (fileIds.length > 0) {
      const symRes = await db.execute(sql`
        SELECT s.id, s.kind, s.key, s.canonical_name
        FROM knowledge_edges e
        JOIN knowledge_entities s ON s.id = e.to_entity_id
        WHERE e.workspace_id = ${workspaceId}
          AND e.type = 'defines'
          AND e.from_entity_id IN (${sql.join(fileIds.map(id => sql`${id}`), sql`, `)})
        LIMIT ${maxSymbols}
      `);
      addRows(symRes.rows);
    }

    // 3. Most-connected non-code entities (concepts, features, components…)
    //    as general workspace vocabulary.
    const topRes = await db.execute(sql`
      SELECT ke.id, ke.kind, ke.key, ke.canonical_name
      FROM knowledge_entities ke
      JOIN (
        SELECT entity_id, COUNT(*) AS degree
        FROM (
          SELECT from_entity_id AS entity_id FROM knowledge_edges WHERE workspace_id = ${workspaceId}
          UNION ALL
          SELECT to_entity_id AS entity_id FROM knowledge_edges WHERE workspace_id = ${workspaceId}
        ) d
        GROUP BY entity_id
      ) deg ON deg.entity_id = ke.id
      WHERE ke.workspace_id = ${workspaceId}
        AND ke.kind NOT IN ('symbol', 'file')
      ORDER BY deg.degree DESC
      LIMIT ${maxTopConnected}
    `);
    addRows(topRes.rows);
  } catch {
    // Best-effort: return whatever was fetched before the failure.
  }

  return out.slice(0, maxEntities);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export interface RenderCatalogOptions {
  maxEntities?: number;
  maxChars?: number;
}

/**
 * Render the catalog as a compact prompt block. This is a vocabulary hint, not
 * a dump: hard-capped by entity count and total characters. Returns '' when
 * there is nothing to show.
 */
export function renderEntityCatalog(
  entities: CatalogEntity[],
  opts: RenderCatalogOptions = {},
): string {
  const { maxEntities = 30, maxChars = 1500 } = opts;
  if (entities.length === 0) return '';

  const header = [
    '\n## Known entities',
    'Use these exact names when writing memories, summaries, or entity refs — do not invent variants.',
  ];
  let used = header.reduce((n, l) => n + l.length + 1, 0);
  const lines: string[] = [];
  for (const e of entities.slice(0, maxEntities)) {
    // Files: the repo-relative path (key) IS the name agents should use.
    const label = e.kind !== 'file' && e.canonicalName && e.canonicalName !== e.key
      ? `${e.canonicalName} (${e.key})`
      : e.key;
    const line = `- ${e.kind}: ${label}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  return [...header, ...lines].join('\n');
}
