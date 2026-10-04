/**
 * Seeding the `prompts` table from a prompts directory (format: below).
 *
 * A deployment that carries its own prompt text keeps it outside this repo, in
 * a directory with one file per prompt id and a `manifest.json`:
 *
 *   { "prompts": [ { "id": "...", "version": 1, "file": "....json", "sha256": "<hex>" } ] }
 *
 * `version` is the row version written to the table; `sha256` is the sha256
 * hex of the file's exact bytes, which is the row's `content_hash`. A file is
 * the override body verbatim: JSON questions for a decision, plain text for a
 * text prompt (`RegisteredPrompt.format`).
 *
 * The seed is all-or-nothing on validation: an unknown id, a file that does not
 * hash to its manifest entry, a body its reader would reject (a decision whose
 * questions change shape, say) or a version reused with different text refuses
 * the whole seed before anything is written. Writes are idempotent: a version
 * already in the table with the same hash is (re)activated, never rewritten.
 *
 * Pure apart from the GitHub reader's `fetch`. The DB side is
 * `prompt-seed-source.ts`. Nothing here logs or returns a prompt body.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivePrompt, RegisteredPrompt } from './prompts';

export interface PromptManifestEntry {
  id: string;
  version: number;
  file: string;
  sha256: string;
}

export interface PromptSeedEntry {
  id: string;
  version: number;
  contentHash: string;
  body: string;
}

export class PromptSeedError extends Error {
  constructor(readonly problems: string[]) {
    super(`prompt seed refused: ${problems.join('; ')}`);
    this.name = 'PromptSeedError';
  }
}

/** Reads a file of the prompts directory by its manifest-relative path. */
export interface PromptFileReader {
  read(path: string): Promise<string>;
}

export const PROMPT_MANIFEST_FILE = 'manifest.json';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A manifest-relative path that cannot leave the directory. */
function isSafeRelativePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

/** Parse and shape-check `manifest.json`. Collects every problem, then throws once. */
export function parsePromptManifest(raw: string): PromptManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PromptSeedError(['manifest.json is not JSON']);
  }
  const list = (parsed as { prompts?: unknown } | null)?.prompts;
  if (!Array.isArray(list)) throw new PromptSeedError(['manifest.json needs a "prompts" array']);

  const problems: string[] = [];
  const out: PromptManifestEntry[] = [];
  const seen = new Set<string>();
  list.forEach((e: unknown, i) => {
    const r = (e ?? {}) as Record<string, unknown>;
    const where = typeof r.id === 'string' && r.id ? `"${r.id}"` : `entry ${i}`;
    if (typeof r.id !== 'string' || r.id.trim() === '') return void problems.push(`${where}: no id`);
    if (seen.has(r.id)) return void problems.push(`${where}: listed twice`);
    seen.add(r.id);
    if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) {
      return void problems.push(`${where}: version must be a positive integer`);
    }
    if (typeof r.file !== 'string' || !isSafeRelativePath(r.file)) {
      return void problems.push(`${where}: file must be a relative path inside the directory`);
    }
    if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) {
      return void problems.push(`${where}: sha256 must be 64 lowercase hex characters`);
    }
    out.push({ id: r.id, version: r.version, file: r.file, sha256: r.sha256 });
  });
  if (problems.length > 0) throw new PromptSeedError(problems);
  return out;
}

/**
 * Read the manifest and every file it names, and check each against the
 * registered prompts. Throws `PromptSeedError` listing every problem (by id
 * and reason, never text) when anything does not fit.
 */
export async function loadPromptSeed(
  reader: PromptFileReader,
  registered: readonly RegisteredPrompt[],
): Promise<PromptSeedEntry[]> {
  const manifest = parsePromptManifest(await reader.read(PROMPT_MANIFEST_FILE));
  const byId = new Map(registered.map(r => [r.id, r]));
  const problems: string[] = [];
  const out: PromptSeedEntry[] = [];

  for (const e of manifest) {
    const reg = byId.get(e.id);
    if (!reg) {
      problems.push(`"${e.id}": not a registered prompt id`);
      continue;
    }
    let body: string;
    try {
      body = await reader.read(e.file);
    } catch (err) {
      problems.push(`"${e.id}": cannot read ${e.file} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const hash = sha256Hex(body);
    if (hash !== e.sha256) {
      problems.push(`"${e.id}": ${e.file} does not hash to its manifest sha256`);
      continue;
    }
    const rejected = reg.validate(body);
    if (rejected) {
      problems.push(`"${e.id}": rejected (${rejected})`);
      continue;
    }
    out.push({ id: e.id, version: e.version, contentHash: hash, body });
  }
  if (problems.length > 0) throw new PromptSeedError(problems);
  return out;
}

export interface ExistingPromptRow {
  id: string;
  version: number;
  contentHash: string;
  active: boolean;
}

export type PromptSeedAction =
  | { type: 'insert'; entry: PromptSeedEntry }
  | { type: 'activate'; id: string; version: number }
  | { type: 'unchanged'; id: string; version: number }
  | { type: 'deactivate'; id: string };

/**
 * What to write to make the table match the seed. Throws when a version
 * already in the table carries different text: versions are immutable, so a
 * changed file needs a new version.
 *
 * An id with an active row that the seed does not list is deactivated, so the
 * prompts directory is the whole truth and dropping a file falls back to the
 * public default.
 */
export function planPromptSeed(entries: readonly PromptSeedEntry[], existing: readonly ExistingPromptRow[]): PromptSeedAction[] {
  const rows = new Map(existing.map(r => [`${r.id}@${r.version}`, r]));
  const problems: string[] = [];
  const actions: PromptSeedAction[] = [];
  for (const e of entries) {
    const row = rows.get(`${e.id}@${e.version}`);
    if (!row) {
      actions.push({ type: 'insert', entry: e }, { type: 'activate', id: e.id, version: e.version });
    } else if (row.contentHash !== e.contentHash) {
      problems.push(`"${e.id}": version ${e.version} already exists with different content; bump its version`);
    } else if (row.active) {
      actions.push({ type: 'unchanged', id: e.id, version: e.version });
    } else {
      actions.push({ type: 'activate', id: e.id, version: e.version });
    }
  }
  if (problems.length > 0) throw new PromptSeedError(problems);

  const seeded = new Set(entries.map(e => e.id));
  const strays = [...new Set(existing.filter(r => r.active && !seeded.has(r.id)).map(r => r.id))].sort();
  for (const id of strays) actions.push({ type: 'deactivate', id });
  return actions;
}

/** One-line counts for the deploy log. Ids and versions only. */
export function summarizePromptSeed(actions: readonly PromptSeedAction[]): string {
  const n = (t: PromptSeedAction['type']) => actions.filter(a => a.type === t).length;
  return `${n('insert')} new version(s), ${n('activate') - n('insert')} reactivated, ${n('unchanged')} unchanged, ${n('deactivate')} deactivated`;
}

// ── What the seed promised ────────────────────────────────────────────────────

/** Written to `system_cache` after a seed, so the runtime knows rows are expected. Ids only. */
export interface PromptSeedMarker {
  seededAt: string;
  ids: string[];
}

export const PROMPT_SEED_MARKER_KEY = 'prompts:seed';

export interface PromptFallback {
  id: string;
  /** `missing`: no valid active row. `invalid`: a row the reader would reject (shape changed since the seed). */
  reason: 'missing' | 'invalid';
}

/**
 * The seeded ids that would resolve to their public default right now. Empty
 * when nothing was seeded: a deployment without its own prompts is healthy on
 * defaults. `active` is the loader's view (rows whose hash checks out).
 */
export function expectedPromptFallbacks(
  marker: PromptSeedMarker | null,
  active: ReadonlyMap<string, Pick<ActivePrompt, 'body'>>,
  registered: readonly RegisteredPrompt[],
): PromptFallback[] {
  if (!marker) return [];
  const byId = new Map(registered.map(r => [r.id, r]));
  const out: PromptFallback[] = [];
  for (const id of [...marker.ids].sort()) {
    const row = active.get(id);
    if (!row) {
      out.push({ id, reason: 'missing' });
      continue;
    }
    const reg = byId.get(id);
    if (reg && reg.validate(row.body)) out.push({ id, reason: 'invalid' });
  }
  return out;
}

export function parsePromptSeedMarker(raw: unknown): PromptSeedMarker | null {
  const r = raw as Partial<PromptSeedMarker> | null;
  if (!r || typeof r.seededAt !== 'string' || !Array.isArray(r.ids)) return null;
  const ids = r.ids.filter((x): x is string => typeof x === 'string');
  return ids.length > 0 ? { seededAt: r.seededAt, ids } : null;
}

// ── Readers ───────────────────────────────────────────────────────────────────

/** Reads a checked-out prompts directory. Paths were checked by `parsePromptManifest`. */
export function dirPromptReader(dir: string): PromptFileReader {
  return {
    async read(path: string) {
      if (path !== PROMPT_MANIFEST_FILE && !isSafeRelativePath(path)) throw new Error('path outside the directory');
      return readFile(join(dir, path), 'utf8');
    },
  };
}

/**
 * Reads a prompts directory from a GitHub repo through the contents API.
 * `repo` is `owner/name`; the token needs contents read on it.
 */
export function githubPromptReader(opts: {
  repo: string;
  ref: string;
  token: string;
  fetchImpl?: typeof fetch;
}): PromptFileReader {
  const f = opts.fetchImpl ?? fetch;
  return {
    async read(path: string) {
      const url = `https://api.github.com/repos/${opts.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(opts.ref)}`;
      const res = await f(url, {
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      return await res.text();
    },
  };
}
