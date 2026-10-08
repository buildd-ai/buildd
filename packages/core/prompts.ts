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
import { createRuntimeSnapshot, sharedProcessState } from './runtime-snapshot';

export interface ActivePrompt {
  id: string;
  version: number;
  /** sha256 hex of `body`. */
  contentHash: string;
  body: string;
}

export type PromptSnapshot = ReadonlyMap<string, ActivePrompt>;

const EMPTY: PromptSnapshot = new Map();

/**
 * The shared snapshot; `prompts-source.ts` loads it. Process-wide (see
 * `runtime-snapshot.ts`): instrumentation installs it in its own bundle and
 * every route handler reads it from theirs.
 */
export const promptsSnapshot = createRuntimeSnapshot<PromptSnapshot>(EMPTY, { sharedKey: 'buildd.prompts.snapshot' });

/** Replace the active prompts. Called by the server loader; tests may call it directly. */
export function installPrompts(rows: Iterable<ActivePrompt>): void {
  const map = new Map<string, ActivePrompt>();
  for (const row of rows) map.set(row.id, row);
  promptsSnapshot.install(map);
}

// ── Scoped overlay ────────────────────────────────────────────────────────────
//
// An eval scores prompt text that is not (yet) the deployment's: a push to the
// prompts repo, before it is seeded. Installing that text into the shared
// snapshot would change what every live call in the process resolves, so an
// eval runs inside a scope instead (`prompt-overlay.ts`, AsyncLocalStorage).
// This module stays pure: it only asks an injected provider for the scope's
// snapshot. Null (no provider, or outside any scope) means the shared one.

let overlayProvider: (() => PromptSnapshot | null) | null = null;

/** Installed by `prompt-overlay.ts`. Null removes it. */
export function setPromptOverlayProvider(fn: (() => PromptSnapshot | null) | null): void {
  overlayProvider = fn;
}

function currentOverlay(): PromptSnapshot | null {
  return overlayProvider?.() ?? null;
}

/** The snapshot in effect for this call: the scope's overlay, else the shared one. */
function effectiveSnapshot(): PromptSnapshot {
  return currentOverlay() ?? promptsSnapshot.read();
}

/** Back to public defaults, no refresher, zeroed counters. For tests. */
export function resetPrompts(): void {
  promptsSnapshot.reset();
  fallbacks.clear();
  warned.clear();
  accounting.listener = null;
  valueCache.clear();
}

// ── Fallback accounting ───────────────────────────────────────────────────────

/** `missing`: no active row. `invalid`: a row exists but its body was rejected. */
export type PromptFallbackReason = 'missing' | 'invalid';

// Process-wide for the same reason as the snapshot: the listener is installed
// at boot (instrumentation's bundle), resolves count in the routes' bundles, and
// deploy-identity reports the counts from its own.
const accounting = sharedProcessState('buildd.prompts.fallbacks', () => ({
  fallbacks: new Map<string, { missing: number; invalid: number }>(),
  warned: new Set<string>(),
  listener: null as ((id: string, reason: PromptFallbackReason) => void) | null,
}));
const fallbacks = accounting.fallbacks;
const warned = accounting.warned;

/** Called on every fallback (after counting). The server installs one that logs in production; null removes it. */
export function setPromptFallbackListener(fn: ((id: string, reason: PromptFallbackReason) => void) | null): void {
  accounting.listener = fn;
}

function countFallback(id: string, reason: PromptFallbackReason): void {
  // An eval's fallbacks are its own business: the counters and the listener
  // feed the deployment's fallback alert, which must see live resolves only.
  if (currentOverlay()) return;
  const c = fallbacks.get(id) ?? { missing: 0, invalid: 0 };
  c[reason]++;
  fallbacks.set(id, c);
  accounting.listener?.(id, reason);
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
  if (currentOverlay() || warned.has(key)) return;
  warned.add(key);
  console.warn(`[prompts] active row "${row.id}" v${row.version} rejected (${reason}); using the public default`);
}

// ── Resolution ────────────────────────────────────────────────────────────────

/** The active row for `id`, or null. Counts a `missing` fallback when null. */
export function activePrompt(id: string): ActivePrompt | null {
  const row = effectiveSnapshot().get(id) ?? null;
  if (!row) countFallback(id, 'missing');
  return row;
}

export interface ResolvedPrompt {
  body: string;
  /** Which text is in effect. */
  source: 'active' | 'default';
  /** The active row's version; null for the default. */
  version: number | null;
  /**
   * The active row's content hash (sha256 hex of `body`); null for the
   * default. Lets a caller name the private text it ran without the text.
   */
  contentHash: string | null;
}

/** THE read path for prompt text: the active row's body, else the public default. */
export function resolvePromptEntry(id: string, publicDefault: string): ResolvedPrompt {
  const row = activePrompt(id);
  if (!row) return { body: publicDefault, source: 'default', version: null, contentHash: null };
  if (row.body.trim() === '') {
    notePromptRejected(row, 'empty body');
    return { body: publicDefault, source: 'default', version: null, contentHash: null };
  }
  return { body: row.body, source: 'active', version: row.version, contentHash: row.contentHash };
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
  return [...effectiveSnapshot().values()]
    .map(({ id, version, contentHash }) => ({ id, version, contentHash }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ── Templates ─────────────────────────────────────────────────────────────────
//
// A template prompt keeps its interpolation in code: the public default names
// each value it needs as `{{name}}`, and the caller passes the values. An active
// row must use exactly the same placeholders. A row that drops one would
// silently lose a value the caller computed (a PR number, a threshold, a whole
// generated section); a row that adds one would ship a literal `{{x}}` to the
// model. Either is rejected, counted as an `invalid` fallback, and the public
// template runs.

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** The placeholder names a template uses, in first-seen order. */
export function templatePlaceholders(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out];
}

/** Why `candidate` cannot stand in for `publicTemplate`, or null when it can. */
export function templateMismatch(publicTemplate: string, candidate: string): string | null {
  const want = new Set(templatePlaceholders(publicTemplate));
  const got = new Set(templatePlaceholders(candidate));
  const missing = [...want].filter(p => !got.has(p));
  if (missing.length > 0) return `missing placeholder${missing.length > 1 ? 's' : ''} ${missing.map(p => `{{${p}}}`).join(', ')}`;
  const unknown = [...got].filter(p => !want.has(p));
  if (unknown.length > 0) return `unknown placeholder${unknown.length > 1 ? 's' : ''} ${unknown.map(p => `{{${p}}}`).join(', ')}`;
  return null;
}

/**
 * Fill a template in ONE pass over the template text. Values are never
 * re-scanned, so a value that itself contains `{{x}}` (a task description, a
 * PR body) is inserted verbatim. A placeholder with no value renders empty.
 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** The template in effect for `id`: the active row when its placeholders match, else the public one. */
export function resolvePromptTemplateEntry(id: string, publicTemplate: string): ResolvedPrompt {
  const entry = resolvePromptEntry(id, publicTemplate);
  if (entry.source !== 'active') return entry;
  const mismatch = templateMismatch(publicTemplate, entry.body);
  if (mismatch) {
    notePromptRejected({ id, version: entry.version! }, mismatch);
    return { body: publicTemplate, source: 'default', version: null, contentHash: null };
  }
  return entry;
}

/** Resolve the template for `id` and fill it. Never throws, never reads the DB. */
export function resolvePromptTemplate(id: string, publicTemplate: string, vars: Readonly<Record<string, string | number>>): string {
  return renderTemplate(resolvePromptTemplateEntry(id, publicTemplate).body, vars);
}

// ── Structured prompts ────────────────────────────────────────────────────────
//
// Some prompt text is structured: a table of definitions per label, a list of
// actions per phase. Its body is JSON of exactly the public default's shape:
// the same keys at every level, the same type at every leaf, every string
// non-empty and carrying the placeholders its public counterpart carries. An
// array may change length (its items are checked against the first public
// item). Call sites index into these values by key, so a body of a different
// shape is rejected rather than half-applied.

/** Why `candidate` does not have `publicValue`'s shape, or null when it does. */
export function promptShapeMismatch(publicValue: unknown, candidate: unknown, path = '$'): string | null {
  if (typeof publicValue === 'string') {
    if (typeof candidate !== 'string' || candidate.trim() === '') return `${path} must be a non-empty string`;
    const m = templateMismatch(publicValue, candidate);
    return m ? `${path}: ${m}` : null;
  }
  if (typeof publicValue === 'number' || typeof publicValue === 'boolean') {
    return typeof candidate === typeof publicValue ? null : `${path} must be a ${typeof publicValue}`;
  }
  if (publicValue === null) return candidate === null ? null : `${path} must be null`;
  if (Array.isArray(publicValue)) {
    if (!Array.isArray(candidate)) return `${path} must be an array`;
    if (publicValue.length > 0 && candidate.length === 0) return `${path} must not be empty`;
    if (publicValue.length === 0) return candidate.length === 0 ? null : `${path} must be empty`;
    for (let i = 0; i < candidate.length; i++) {
      const m = promptShapeMismatch(publicValue[0], candidate[i], `${path}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (typeof publicValue === 'object') {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return `${path} must be an object`;
    // A key whose default is `undefined` has no JSON form, so it is not part of the shape.
    const want = Object.keys(publicValue as object).filter(k => (publicValue as Record<string, unknown>)[k] !== undefined).sort();
    const got = Object.keys(candidate as object).sort();
    if (want.join('\n') !== got.join('\n')) return `${path} keys differ from the default`;
    for (const k of want) {
      const m = promptShapeMismatch((publicValue as Record<string, unknown>)[k], (candidate as Record<string, unknown>)[k], `${path}.${k}`);
      if (m) return m;
    }
    return null;
  }
  return `${path} has an unsupported default type`;
}

export interface ResolvedPromptValue<T> {
  value: T;
  source: 'active' | 'default';
  version: number | null;
}

const valueCache = new Map<string, { key: string; value: unknown | null }>();

/**
 * A structured prompt: the active row's JSON body when it parses and fits the
 * default's shape (`promptShapeMismatch`), else `publicValue`. The parsed value
 * is cached per row version, so a resolve is a map lookup.
 */
export function resolvePromptValueEntry<T>(id: string, publicValue: T): ResolvedPromptValue<T> {
  const row = activePrompt(id);
  if (!row) return { value: publicValue, source: 'default', version: null };
  const key = `${row.version}:${row.contentHash}`;
  let cached = valueCache.get(id);
  if (!cached || cached.key !== key) {
    let value: unknown | null = null;
    try {
      const parsed: unknown = JSON.parse(row.body);
      const mismatch = promptShapeMismatch(publicValue, parsed);
      if (mismatch) notePromptRejected(row, mismatch);
      else value = parsed;
    } catch {
      notePromptRejected(row, 'body is not JSON');
    }
    cached = { key, value };
    valueCache.set(id, cached);
  } else if (cached.value === null) {
    // Same rejected row again: count it, the warning was already logged.
    notePromptRejected(row, 'cached rejection');
  }
  if (cached.value === null) return { value: publicValue, source: 'default', version: null };
  return { value: cached.value as T, source: 'active', version: row.version };
}

/** `resolvePromptValueEntry(...).value`. Never throws, never reads the DB. */
export function resolvePromptValue<T>(id: string, publicValue: T): T {
  return resolvePromptValueEntry(id, publicValue).value;
}

// ── Registration helpers, one per read path ───────────────────────────────────
//
// Each mirrors the check its resolve function applies, so a seed refuses
// exactly what a resolve would reject. Call them at module scope next to the
// public default; `apps/web/src/lib/prompt-catalog.test.ts` enforces it.

/** For an id read with `resolvePrompt` / `resolvePromptEntry`. */
export function registerTextPrompt(id: string, publicDefault: string): void {
  registerPrompt({ id, format: 'text', publicDefault, validate: validateTextPrompt });
}

/** For an id read with `resolvePromptTemplate` / `resolvePromptTemplateEntry`. */
export function registerTemplatePrompt(id: string, publicTemplate: string): void {
  registerPrompt({
    id,
    format: 'text',
    publicDefault: publicTemplate,
    validate: body => validateTextPrompt(body) ?? templateMismatch(publicTemplate, body),
  });
}

/** For an id read with `resolvePromptValue` / `resolvePromptValueEntry`. */
export function registerValuePrompt(id: string, publicValue: unknown): void {
  registerPrompt({
    id,
    format: 'json',
    publicDefault: `${JSON.stringify(publicValue, null, 2)}\n`,
    validate: body => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return 'body is not JSON';
      }
      return promptShapeMismatch(publicValue, parsed);
    },
  });
}
