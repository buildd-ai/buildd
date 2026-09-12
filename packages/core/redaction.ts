/**
 * PII redaction for sensitive-workspace outbound traffic.
 *
 * This is a best-effort net, not a boundary. Known gaps:
 *   - Anthropic API traffic (transcript, tool-use payloads in agent context)
 *   - Cue tool results embedded in the agent's conversation history
 *   - Local runner logs (~/.buildd/logs/) and history archives
 *   - Git commit messages and committed code
 *   - Display names / email "From" headers that contain no address
 *   - Non-US (non-NANP) phone numbers
 *   - The /api/mcp route's createApi() path (uses plain fetch, not BuilddTransport)
 *
 * Frequent firing of counters returned by getRedactionCounts() signals that an
 * upstream layer (prompt design or retention policy) is leaking PII into
 * control-plane calls. That is the intended observability signal — this module
 * is a leak detector as much as a blocker.
 *
 * Activate only for workspaces where dataClass === 'sensitive':
 *   activateRedaction()   // call when sensitive worker session starts
 *   deactivateRedaction() // call in the session's finally block
 *
 * Wire the interceptor into BuilddTransport:
 *   interceptors: [createRedactionInterceptor()]
 */

import type { BodyInterceptor } from './buildd-transport';

// ── Pattern registry ──────────────────────────────────────────────────────────

type Replacement = string | ((...args: string[]) => string);

export interface PiiPattern {
  type: string;
  pattern: RegExp;
  replacement: Replacement;
}

/**
 * PII patterns covering the Cue workspace threat model.
 * Ordered from most-specific to least-specific to reduce false positives.
 */
export const PII_PATTERNS: PiiPattern[] = [
  {
    type: 'email',
    // RFC-5321 email address
    pattern: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
    replacement: '[REDACTED:email]',
  },
  {
    type: 'tracking',
    // UPS: 1Z followed by exactly 16 alphanumeric characters
    pattern: /\b1Z[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED:tracking]',
  },
  {
    type: 'tracking',
    // FedEx: 15, 20, or 22 consecutive digits (longest first to avoid partial matches)
    pattern: /\b(?:\d{22}|\d{20}|\d{15})\b/g,
    replacement: '[REDACTED:tracking]',
  },
  {
    type: 'phone',
    // NANP: optional +1 country code, optional parens around area code,
    // optional separators (space/dash/dot) between digit groups so that bare
    // 10-digit numbers like 5558675309 are matched alongside formatted ones.
    // Negative lookahead prevents matching a prefix of a longer digit run.
    pattern: /(\+?1[\s\-.]?)?\(?([0-9]{3})\)?[\s\-.]?([0-9]{3})[\s\-.]?([0-9]{4})(?!\d)/g,
    replacement: '[REDACTED:phone]',
  },
  {
    type: 'address',
    // Street number + multi-word name + common US street-type suffix
    pattern: /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(?:St|Ave|Blvd|Dr|Rd|Ln|Ct|Pl|Way|Terr|Circle|Court|Road|Street|Avenue|Boulevard|Drive|Lane|Place)\.?\b/gi,
    replacement: '[REDACTED:address]',
  },
  {
    type: 'order_ref',
    // Explicit label keyword followed by an alphanumeric ID.
    // Pure-numeric IDs of ≤6 digits are excluded: they are PR/issue references
    // like order #1310 (GitHub-style) that must not be redacted.
    pattern: /\b(?:order|invoice|tracking|shipment|ref(?:erence)?)\s*[#:]?\s*([A-Z0-9][A-Z0-9\-]{4,19})\b/gi,
    replacement: (_match: string, id: string) =>
      /^\d{1,6}$/.test(id) ? _match : '[REDACTED:order_ref]',
  },
];

// ── Free-text field list ──────────────────────────────────────────────────────

/**
 * Body fields that may carry user-authored free text and require PII scanning.
 * Structural, numeric, boolean, and pointer fields are intentionally excluded.
 * Keep this list explicit — do not derive it programmatically.
 */
export const FREE_TEXT_FIELDS = new Set([
  'message',
  'summary',
  'content',
  'prompt',
  'excerpt',
  'label',
  'body',
  'title',
]);

// ── Activation state ──────────────────────────────────────────────────────────

// Counts the number of currently-active sensitive workspace sessions.
// Redaction is a no-op when this is zero (standard workspaces are unaffected).
let activeSensitiveCount = 0;

/** Call when a sensitive-workspace worker session begins. */
export function activateRedaction(): void {
  activeSensitiveCount++;
}

/** Call in the finally block of a sensitive-workspace worker session. */
export function deactivateRedaction(): void {
  if (activeSensitiveCount > 0) activeSensitiveCount--;
}

// ── Hit counters ──────────────────────────────────────────────────────────────

const hitCounts = new Map<string, number>();

function hit(type: string, field: string): void {
  const key = `${type}:${field}`;
  hitCounts.set(key, (hitCounts.get(key) ?? 0) + 1);
}

/** Returns per-(type, field) hit counts. Include in heartbeat payloads. */
export function getRedactionCounts(): Record<string, number> {
  return Object.fromEntries(hitCounts);
}

/** Resets all counters. Intended for tests. */
export function resetRedactionCounts(): void {
  hitCounts.clear();
}

/** Resets the activation count to zero. Intended for tests. */
export function resetActivationState(): void {
  activeSensitiveCount = 0;
}

// ── Pre-scan masking ──────────────────────────────────────────────────────────

// UUID: 8-4-4-4-12 hex groups separated by hyphens
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Hex strings ≥7 chars that contain at least one letter (a-f) — git SHAs and
// similar hashes. The letter requirement is critical: pure-digit strings must
// NOT be masked here so that FedEx tracking patterns can still match them.
const HEX_RE = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi;

// ── Core redaction ────────────────────────────────────────────────────────────

function redactText(text: string, field: string): string {
  // 1. Mask UUIDs — their digit-group prefixes could trigger the phone pattern.
  const uuids: string[] = [];
  let s = text.replace(UUID_RE, (m) => {
    uuids.push(m);
    return `\x00U${uuids.length - 1}\x00`;
  });

  // 2. Mask pure-hex strings ≥7 chars (git SHAs, long commit hashes).
  const hexes: string[] = [];
  s = s.replace(HEX_RE, (m) => {
    hexes.push(m);
    return `\x00H${hexes.length - 1}\x00`;
  });

  // 3. Apply PII patterns in order. Reset lastIndex before each run (global flag).
  for (const { type, pattern, replacement } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    const before = s;
    if (typeof replacement === 'string') {
      s = s.replace(pattern, replacement);
    } else {
      s = s.replace(pattern, replacement as (...args: string[]) => string);
    }
    if (s !== before) {
      hit(type, field);
      console.log(JSON.stringify({ event: 'pii_redacted', type, field }));
    }
  }

  // 4. Restore hex tokens, then UUID tokens (restore inner first).
  s = s.replace(/\x00H(\d+)\x00/g, (_, i) => hexes[parseInt(i, 10)]);
  s = s.replace(/\x00U(\d+)\x00/g, (_, i) => uuids[parseInt(i, 10)]);

  return s;
}

function redactObject(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;

  if (Array.isArray(obj)) {
    return (obj as unknown[]).reduce<boolean>(
      (changed, item) => redactObject(item) || changed,
      false,
    );
  }

  const record = obj as Record<string, unknown>;
  let changed = false;

  for (const key of Object.keys(record)) {
    const value = record[key];
    if (FREE_TEXT_FIELDS.has(key) && typeof value === 'string') {
      const redacted = redactText(value, key);
      if (redacted !== value) {
        record[key] = redacted;
        changed = true;
      }
    } else if (value && typeof value === 'object') {
      if (redactObject(value)) changed = true;
    }
  }

  return changed;
}

function redactBody(body: string, _route: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;

  const changed = redactObject(parsed);
  return changed ? JSON.stringify(parsed) : body;
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Returns a BuilddTransport BodyInterceptor that scans outbound JSON bodies for
 * PII in free-text fields and replaces matches with [REDACTED:type] tokens.
 *
 * The interceptor is a no-op unless at least one sensitive-workspace session is
 * active (activateRedaction() / deactivateRedaction() control this). Add it to
 * BuilddTransportConfig.interceptors unconditionally — it costs a single integer
 * comparison on every request when inactive.
 */
export function createRedactionInterceptor(): BodyInterceptor {
  return (body: string, route: string): string => {
    if (activeSensitiveCount === 0) return body;
    return redactBody(body, route);
  };
}

// ── Secret-value redaction ────────────────────────────────────────────────────
//
// Unlike PII redaction above (which uses patterns), secret redaction operates on
// known plaintext values (BUILDD_API_KEY, MCP credential values). Redacts all
// occurrences of each secret with [REDACTED] before the text is persisted or
// emitted via Pusher.
//
// Values shorter than MIN_SECRET_LEN are excluded — short strings cause too many
// false positives (e.g., common substrings like "true", "dev", version numbers).

const MIN_SECRET_LEN = 8;

export interface SecretRedactionValue {
  label: string;
  value: string;
}

type SecretInput = string | SecretRedactionValue;

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+[A-Za-z0-9][^\s,;"']*/gi, replacement: 'Authorization: [REDACTED:authorization]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED:jwt]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED:token]' },
  { pattern: /\b(?:bld|dsp|ghp|gho|github_pat|xox[baprs])_[A-Za-z0-9_-]{16,}\b/g, replacement: '[REDACTED:token]' },
  { pattern: /\b(?:[a-fA-F0-9]{48,})\b/g, replacement: '[REDACTED:credential]' },
  // Full base64/base64url alphabet, including `-`/`_`. Those two chars are also
  // every kebab-case/snake-case identifier's word separator, and this codebase
  // mints plenty of long ones (mission branch names like
  // `mission/<slug>-<missionId8>-w<workerId8>` easily clear 48 chars of
  // lowercase letters, digits, and hyphens) — matching them here would corrupt
  // structural fields like `branch` or `lastCommitSha`. Rather than narrowing
  // the alphabet (which silently drops coverage for real base64url secrets
  // pasted into free-text fields), generic patterns in this array are only
  // applied to fields on the SECRET_SCAN_FIELDS allowlist by
  // redactSecretsInBody — structural fields get exact-value matching only.
  // See PR #2305 / its follow-up for the incident this guards against.
  { pattern: /\b(?=[A-Za-z0-9+/=_-]{48,}\b)(?=[A-Za-z0-9+/=_-]*[A-Za-z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{48,}\b/g, replacement: '[REDACTED:credential]' },
];

/**
 * Body fields scanned with the generic SECRET_PATTERNS regexes by
 * redactSecretsInBody. Mirrors FREE_TEXT_FIELDS above, extended with the
 * additional free-text-bearing keys used on worker PATCH bodies and session
 * transcripts (tool input/output, transcript text, currentAction, error).
 *
 * Fields NOT in this set still get exact-value secret matching (safe — no
 * false-positive risk) but never generic pattern matching, so a structural
 * identifier (branch, lastCommitSha, ids, status, ...) can never be corrupted
 * by a credential-shaped heuristic, now or as new patterns are added. Keep
 * this list explicit — do not derive it programmatically.
 */
export const SECRET_SCAN_FIELDS = new Set([
  ...FREE_TEXT_FIELDS,
  'error',
  'currentAction',
  'output',
  'input',
  'command',
  'text',
  'nextSuggestion',
  'line',
  'stderr',
  'result',
]);

/**
 * Build the exact-value lookup for a set of known secret values.
 * Values shorter than 8 chars or empty are skipped.
 * Longer secrets sort first to prevent partial matches (if secretA is a
 * prefix of secretB, secretB is replaced first).
 */
function buildExactValueTable(secrets: SecretInput[]): Array<[string, string | null]> {
  const byValue = new Map<string, string | null>();
  for (const secret of secrets) {
    const value = typeof secret === 'string' ? secret : secret?.value;
    if (typeof value !== 'string' || value.trim().length < MIN_SECRET_LEN) continue;
    const rawLabel = typeof secret === 'string' ? null : secret.label;
    const label = rawLabel?.replace(/[^A-Za-z0-9_.-]/g, '_') || null;
    byValue.set(value, label);
  }
  return [...byValue.entries()].sort(([a], [b]) => b.length - a.length);
}

/** Replaces exact occurrences of known secret values. No false-positive risk — safe on any field. */
function redactExactValues(text: string, table: Array<[string, string | null]>): string {
  let result = text;
  for (const [secret, label] of table) {
    if (result.includes(secret)) {
      // Simple global string replace — no regex so secret chars need no escaping
      result = result.split(secret).join(label ? `[REDACTED:${label}]` : '[REDACTED]');
    }
  }
  return result;
}

/** Applies the generic credential-shaped regexes. Only safe on known free-text fields. */
function redactSecretPatterns(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Build a redactor function for a set of known secret values.
 * Applies exact-value matching plus the generic credential-shaped patterns.
 * Intended for callers that already know they're handling free text (e.g. a
 * milestone label, a tool-call log line) — not for scanning an arbitrary body
 * with structural fields. Use redactSecretsInBody for that.
 */
export function createSecretRedactor(secrets: SecretInput[]): (text: string) => string {
  const table = buildExactValueTable(secrets);
  return (text: string): string => {
    if (!text) return text;
    return redactSecretPatterns(redactExactValues(text, table));
  };
}

/**
 * Redact known secret values from the mutable fields of a PATCH /api/workers/[id]
 * request body (or an equivalent worker-session record) before DB writes,
 * Pusher emission, or object-storage upload.
 *
 * Every string field gets exact-value matching against `secrets` regardless of
 * its name — that carries no false-positive risk. The generic credential-shaped
 * SECRET_PATTERNS regexes additionally run, but ONLY on fields named in
 * SECRET_SCAN_FIELDS — a structural identifier (branch, lastCommitSha, ids,
 * status, ...) is never at risk of being rewritten to "[REDACTED:credential]"
 * by a heuristic, no matter how it's shaped. See SECRET_SCAN_FIELDS for why.
 *
 * Returns a shallow copy of the body with the relevant string fields cleaned.
 * The original body object is NOT mutated.
 */
export function redactSecretsInBody<T extends Record<string, unknown>>(
  body: T,
  secrets: SecretInput[],
): T {
  const table = buildExactValueTable(secrets);
  const visit = (value: unknown, field?: string): unknown => {
    if (typeof value === 'string') {
      if (!value) return value;
      const exact = redactExactValues(value, table);
      return field && SECRET_SCAN_FIELDS.has(field) ? redactSecretPatterns(exact) : exact;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, field));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, key)]));
    }
    return value;
  };
  return visit(body) as T;
}
