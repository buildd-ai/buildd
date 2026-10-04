/**
 * Versioned prompts with public fallbacks.
 *
 * Prompt text the server sends a model (decision questions, the chat system
 * prompt) is compiled into this repo as a working public default. A
 * deployment can replace any of it at runtime with an active row in the
 * `prompts` table (`db/schema.ts`): one row per (id, version), at most one
 * active per id. `resolvePrompt(id, publicDefault)` returns the active body, or
 * the default when there is none.
 *
 * Rows are read into an in-process snapshot by `prompts-source.ts` at boot and
 * refreshed in the background (`runtime-snapshot.ts`), so a resolve never reads
 * the database. A missing table, row or database never fails a call: it
 * resolves to the public default, and the fallback is counted
 * (`promptFallbackCounts`) so an operator can tell a deployment that is
 * expected to carry its own text from one that silently runs on defaults.
 *
 * Pure: no DB, no env. Safe to import anywhere a public default is; the
 * runner and client bundles never install a snapshot, so they see defaults.
 */
import { createRuntimeSnapshot } from './runtime-snapshot';

export interface ActivePrompt {
  id: string;
  version: number;
  /** sha256 hex of `body`. */
  contentHash: string;
  body: string;
}

export type PromptSnapshot = ReadonlyMap<string, ActivePrompt>;

const EMPTY: PromptSnapshot = new Map();

/** The shared snapshot; `prompts-source.ts` loads it. */
export const promptsSnapshot = createRuntimeSnapshot<PromptSnapshot>(EMPTY);

/** Replace the active prompts. Called by the server loader; tests may call it directly. */
export function installPrompts(rows: Iterable<ActivePrompt>): void {
  const map = new Map<string, ActivePrompt>();
  for (const row of rows) map.set(row.id, row);
  promptsSnapshot.install(map);
}

/** Back to public defaults, no refresher, zeroed counters. For tests. */
export function resetPrompts(): void {
  promptsSnapshot.reset();
  fallbacks.clear();
  warned.clear();
}

// ── Fallback accounting ───────────────────────────────────────────────────────

/** `missing`: no active row. `invalid`: a row exists but its body was rejected. */
export type PromptFallbackReason = 'missing' | 'invalid';

const fallbacks = new Map<string, { missing: number; invalid: number }>();
const warned = new Set<string>();

function countFallback(id: string, reason: PromptFallbackReason): void {
  const c = fallbacks.get(id) ?? { missing: 0, invalid: 0 };
  c[reason]++;
  fallbacks.set(id, c);
}

/** Per prompt id, how many resolves in this process fell back to the public default. */
export function promptFallbackCounts(): Record<string, { missing: number; invalid: number }> {
  return Object.fromEntries([...fallbacks].map(([id, c]) => [id, { ...c }]));
}

/**
 * Record that an active row was rejected (its body did not parse or did not
 * fit the default's shape) and the default ran instead. Logs once per row
 * version, naming the id and the reason, never the text.
 */
export function notePromptRejected(row: Pick<ActivePrompt, 'id' | 'version'>, reason: string): void {
  countFallback(row.id, 'invalid');
  const key = `${row.id}@${row.version}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[prompts] active row "${row.id}" v${row.version} rejected (${reason}); using the public default`);
}

// ── Resolution ────────────────────────────────────────────────────────────────

/** The active row for `id`, or null. Counts a `missing` fallback when null. */
export function activePrompt(id: string): ActivePrompt | null {
  const row = promptsSnapshot.read().get(id) ?? null;
  if (!row) countFallback(id, 'missing');
  return row;
}

export interface ResolvedPrompt {
  body: string;
  /** Which text is in effect. */
  source: 'active' | 'default';
  /** The active row's version; null for the default. */
  version: number | null;
}

/** THE read path for prompt text: the active row's body, else the public default. */
export function resolvePromptEntry(id: string, publicDefault: string): ResolvedPrompt {
  const row = activePrompt(id);
  if (!row) return { body: publicDefault, source: 'default', version: null };
  if (row.body.trim() === '') {
    notePromptRejected(row, 'empty body');
    return { body: publicDefault, source: 'default', version: null };
  }
  return { body: row.body, source: 'active', version: row.version };
}

/** The active body for `id`, else `publicDefault`. Never throws, never reads the DB. */
export function resolvePrompt(id: string, publicDefault: string): string {
  return resolvePromptEntry(id, publicDefault).body;
}

/**
 * A prompt version that names the text in effect: the public version for the
 * default, `<public>+p<row version>` for an active row. Contains no `|` or
 * whitespace, so it is valid wherever a decision `promptVersion` is.
 */
export function resolvedPromptVersion(publicVersion: string, resolved: Pick<ResolvedPrompt, 'source' | 'version'>): string {
  return resolved.source === 'active' && resolved.version !== null ? `${publicVersion}+p${resolved.version}` : publicVersion;
}
