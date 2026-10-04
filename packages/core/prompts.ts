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
  fallbackListener = null;
}

// ── Fallback accounting ───────────────────────────────────────────────────────

/** `missing`: no active row. `invalid`: a row exists but its body was rejected. */
export type PromptFallbackReason = 'missing' | 'invalid';

const fallbacks = new Map<string, { missing: number; invalid: number }>();
const warned = new Set<string>();

let fallbackListener: ((id: string, reason: PromptFallbackReason) => void) | null = null;

/** Called on every fallback (after counting). The server installs one that logs in production; null removes it. */
export function setPromptFallbackListener(fn: ((id: string, reason: PromptFallbackReason) => void) | null): void {
  fallbackListener = fn;
}

function countFallback(id: string, reason: PromptFallbackReason): void {
  const c = fallbacks.get(id) ?? { missing: 0, invalid: 0 };
  c[reason]++;
  fallbacks.set(id, c);
  fallbackListener?.(id, reason);
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

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Every prompt id this codebase resolves, with its public default and the
 * check an override body must pass. `definePromptedDecision`,
 * `promptedDecisionKind` and each direct `resolvePrompt` call site register
 * their id here at module load, so a seed (`prompt-seed.ts`) can refuse an id
 * nothing reads and a body the reader would reject, before it is written.
 *
 * `format` is how the body is stored: `json` for a decision's questions (or
 * another structured override), `text` for a plain prompt.
 */
export interface RegisteredPrompt {
  id: string;
  format: 'text' | 'json';
  /** The public default as an override body: what a seed of the default would write. */
  publicDefault: string;
  /** Why `body` would be rejected by the reader, or null when it would be used. */
  validate(body: string): string | null;
}

const registry = new Map<string, RegisteredPrompt>();

/** Register a prompt id. Re-registering an id (module reload) replaces it. */
export function registerPrompt(entry: RegisteredPrompt): void {
  registry.set(entry.id, Object.freeze({ ...entry }));
}

/** Every registered prompt, sorted by id. Only ids whose modules have been imported. */
export function listRegisteredPrompts(): RegisteredPrompt[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The check for a plain-text prompt: any non-blank body. */
export function validateTextPrompt(body: string): string | null {
  return body.trim() === '' ? 'empty body' : null;
}

/**
 * What text is in effect in this process, as fingerprints only: id, row
 * version and content hash per active row, sorted by id. An id not listed
 * resolves to its public default. Never includes a body.
 */
export function activePromptFingerprints(): Array<{ id: string; version: number; contentHash: string }> {
  return [...promptsSnapshot.read().values()]
    .map(({ id, version, contentHash }) => ({ id, version, contentHash }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
