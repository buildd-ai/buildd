/**
 * Claim-time memory as an index: one line per memory, bodies pulled on demand.
 *
 * See knowledge-base: buildd/design/memory-done-right.md ("Injection shape", Decisions #1). Every
 * push surface that puts memory in front of an agent at claim time (the
 * claim-time "Related prior work" block, the `claim_task` "Relevant Memory"
 * reply, the runner's `## Workspace Memory` block) renders through this module
 * when the workspace flag is on, so the agent sees one format and one set of
 * ids across all of them:
 *
 *   - <type> m:<8-char id> <title> (<why it matched>)
 *
 * The agent pulls a body with `recall` id=<the 8-char id>, which is recorded in
 * `memory_uses` as a pull. That pull is the signal the use ledger needs: a
 * pushed body gives no evidence it was read, a pulled one does.
 *
 * Flag: `gitConfig.memoryIndexInjection` (default off). Off means every surface
 * renders exactly what it did before this module existed; the golden tests pin
 * that. Pure: no DB, no store, safe to import from the runner (./memory-hit-scope
 * loads its DB resolver lazily).
 */

import { memoryIdOfHit } from './memory-hit-scope';

/** The workspace flag's key in `workspaces.git_config`. */
export const MEMORY_INDEX_FLAG = 'memoryIndexInjection';

/** Optional per-workspace budget override, in estimated tokens. */
export const MEMORY_INDEX_BUDGET_KEY = 'memoryIndexTokenBudget';

/** Default budget for the whole index an agent sees at claim time, in estimated tokens. */
export const DEFAULT_MEMORY_INDEX_TOKEN_BUDGET = 800;

/**
 * Where the claim route mirrors the entries it rendered, on the in-memory
 * claim response's `task.context` (never persisted). The runner and the
 * `claim_task` reply read it to dedupe against, and to charge the budget.
 */
export const MEMORY_INDEX_CONTEXT_KEY = 'memoryIndex';

/** Short ids are this many leading characters of the memory's UUID. */
export const MEMORY_SHORT_ID_LENGTH = 8;

/** The one header line. Rendered once per index, never per entry. */
export const MEMORY_INDEX_HEADER =
  'Memory index: titles only. Pull a body with `recall` id="<8-char id>" before relying on it.';

const MAX_TITLE_CHARS = 100;

/** Why a memory matched the task. Shown in parentheses at the end of its line. */
export type MemoryIndexWhy = 'path' | 'area' | 'title' | 'signature';

export interface MemoryIndexEntry {
  /** Full memory id. Rendered as its 8-char prefix. */
  id: string;
  type: string;
  title: string;
  why: MemoryIndexWhy;
}

const WHY_VALUES: ReadonlySet<string> = new Set<MemoryIndexWhy>(['path', 'area', 'title', 'signature']);

/** Whether index injection is on for a workspace. Anything but literal `true` is off. */
export function isMemoryIndexEnabled(gitConfig: unknown): boolean {
  return !!gitConfig && typeof gitConfig === 'object'
    && (gitConfig as Record<string, unknown>)[MEMORY_INDEX_FLAG] === true;
}

/** The workspace's index budget: its override when a positive number, else the default. */
export function memoryIndexTokenBudget(gitConfig: unknown): number {
  const raw = gitConfig && typeof gitConfig === 'object'
    ? (gitConfig as Record<string, unknown>)[MEMORY_INDEX_BUDGET_KEY]
    : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MEMORY_INDEX_TOKEN_BUDGET;
}

/** Token estimate used for the budget: characters / 4, rounded up. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function shortMemoryId(id: string): string {
  return id.slice(0, MEMORY_SHORT_ID_LENGTH);
}

/** One line, whitespace collapsed, heading marks stripped, capped. */
export function indexTitle(raw: string | null | undefined): string {
  const firstLine = (raw ?? '').split('\n').find(l => l.trim()) ?? '';
  const flat = firstLine.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 3)}...` : flat;
}

export function renderMemoryIndexLine(e: MemoryIndexEntry): string {
  const title = indexTitle(e.title) || '(untitled)';
  return `- ${e.type || 'memory'} m:${shortMemoryId(e.id)} ${title} (${e.why})`;
}

export interface BuildMemoryIndexOptions {
  /** Estimated tokens available, header included. Default 800. */
  budgetTokens?: number;
  /**
   * Ids already shown to the agent on another surface (full ids or 8-char
   * prefixes). Matching entries are skipped, not counted.
   */
  exclude?: Iterable<string>;
  /**
   * Omit the header: this index continues one the agent already has in the
   * same prompt, which carried the header.
   */
  continued?: boolean;
}

export interface MemoryIndex {
  /** Header (unless continued) then one line per shown entry. Empty when nothing fits. */
  lines: string[];
  shown: MemoryIndexEntry[];
  /** Entries left out by the budget. Excluded duplicates are not listed. */
  dropped: MemoryIndexEntry[];
  /** Estimated tokens of `lines`, newline-joined. */
  tokens: number;
}

/**
 * Render entries as an index under a token budget. Dedupes by id (first wins,
 * so pass entries in rank order) and against `exclude`. Stops at the first
 * entry that does not fit, so the index never skips a stronger hit to squeeze
 * in a weaker one. A budget too small for the header and one line yields an
 * empty index.
 */
export function buildMemoryIndex(
  entries: readonly MemoryIndexEntry[],
  opts: BuildMemoryIndexOptions = {},
): MemoryIndex {
  const budget = opts.budgetTokens ?? DEFAULT_MEMORY_INDEX_TOKEN_BUDGET;
  const excluded = new Set<string>();
  for (const id of opts.exclude ?? []) excluded.add(shortMemoryId(id));

  const header = opts.continued ? [] : [MEMORY_INDEX_HEADER];
  const body: string[] = [];
  const shown: MemoryIndexEntry[] = [];
  const dropped: MemoryIndexEntry[] = [];
  const seen = new Set<string>();
  // chars of header + body joined by '\n'
  let chars = header.reduce((n, l) => n + l.length, 0) + Math.max(header.length - 1, 0);
  let full = false;

  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    const key = shortMemoryId(e.id);
    if (seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    if (full) {
      dropped.push(e);
      continue;
    }
    const line = renderMemoryIndexLine(e);
    const next = chars + (chars > 0 ? 1 : 0) + line.length;
    if (Math.ceil(next / 4) > budget) {
      full = true;
      dropped.push(e);
      continue;
    }
    body.push(line);
    shown.push(e);
    chars = next;
  }

  if (body.length === 0) return { lines: [], shown: [], dropped, tokens: 0 };
  const lines = [...header, ...body];
  return { lines, shown, dropped, tokens: estimateTokens(lines.join('\n')) };
}

/**
 * The entries a claim response carried on `task.context.memoryIndex`, validated
 * field by field (the context is jsonb and arrives over the wire). Anything
 * malformed is dropped rather than trusted.
 */
export function readMemoryIndexEntries(context: unknown): MemoryIndexEntry[] {
  if (!context || typeof context !== 'object') return [];
  const raw = (context as Record<string, unknown>)[MEMORY_INDEX_CONTEXT_KEY];
  if (!Array.isArray(raw)) return [];
  const out: MemoryIndexEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { id, type, title, why } = r as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    out.push({
      id,
      type: typeof type === 'string' ? type : 'memory',
      title: typeof title === 'string' ? title : '',
      why: typeof why === 'string' && WHY_VALUES.has(why) ? (why as MemoryIndexWhy) : 'title',
    });
  }
  return out;
}

/** Tokens the claim-time entries already cost, so a later surface charges the same budget. */
export function memoryIndexEntriesTokens(entries: readonly MemoryIndexEntry[]): number {
  if (entries.length === 0) return 0;
  return estimateTokens([MEMORY_INDEX_HEADER, ...entries.map(renderMemoryIndexLine)].join('\n'));
}

/** The slice of a knowledge hit this needs. `QueryResult` satisfies it. */
export interface MemoryIndexHit {
  id: string;
  content: string;
  metadata?: Record<string, unknown> | null;
}

/** Memory rows by id; `MemoryHitScope.lookup` (MemoryStore.batch) satisfies it. */
export type MemoryIndexRowLookup = (
  ids: string[],
) => Promise<{ memories: ReadonlyArray<{ id: string; title?: string | null; type?: string | null }> }>;

/**
 * Index entries for knowledge-store memory hits, in hit order. Titles and
 * types come from the memories rows (the chunk carries only the body); a
 * failed lookup or a row without a title falls back to the body's first line
 * and the chunk's metadata type, so a lookup error degrades the title, never
 * the index.
 */
export async function memoryIndexEntriesFromHits(
  hits: readonly MemoryIndexHit[],
  why: MemoryIndexWhy,
  lookup?: MemoryIndexRowLookup,
): Promise<MemoryIndexEntry[]> {
  if (hits.length === 0) return [];
  const ids = hits.map(memoryIdOfHit);
  const rows = new Map<string, { title?: string | null; type?: string | null }>();
  if (lookup) {
    try {
      for (const r of (await lookup(ids)).memories) rows.set(r.id, r);
    } catch {
      // Fall back to the chunk's own text.
    }
  }
  return hits.map((h, i) => {
    const row = rows.get(ids[i]);
    const metaType = typeof h.metadata?.type === 'string' ? (h.metadata.type as string) : null;
    return {
      id: ids[i],
      type: row?.type || metaType || 'memory',
      title: row?.title || indexTitle(h.content),
      why,
    };
  });
}

/**
 * Parse what an agent passed to `recall` id=: a full id, an 8+ char prefix,
 * or either written `m:<id>` as the index shows it. Returns the bare id or
 * prefix, lower-cased, or null when it is not id-shaped.
 */
export function parseMemoryIdRef(raw: unknown): { kind: 'full' | 'prefix'; value: string } | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/^m:/i, '').toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return { kind: 'full', value: v };
  if (/^[0-9a-f]{8,}$/.test(v) && v.length < 32) return { kind: 'prefix', value: v };
  return null;
}
