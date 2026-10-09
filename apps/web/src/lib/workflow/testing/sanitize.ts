/**
 * Sanitizer for the kernel replay corpus (scripts/forensics/export-kernel-corpus.ts).
 *
 * The corpus has to replay, so identifiers are not dropped but replaced by
 * stable pseudonyms: the same input always maps to the same output within one
 * export (one random salt per run, never written down), and a pseudonym
 * appears wherever the original did, including inside compound strings such as
 * idempotency and dedupe keys. That keeps the property replay needs:
 * sanitize(reduce(x)) = reduce(sanitize(x)).
 *
 *  - UUIDs → UUID-shaped pseudonyms (they are row ids in the replay database)
 *  - 40-hex SHAs → 40-hex opaque tokens
 *  - repository full names (owner and name) → `org-…/repo-…`
 *  - branch names → `branch-…`, except the conventional trunk names
 *  - people (`human:<id>` and similar actor prefixes, emails) → `user-…`
 *  - absolute timestamps → shifted so the delivery starts at 2000-01-01;
 *    relative timing survives, the date does not
 *  - prose (PR bodies, comments, summaries, reasons that embed user text) →
 *    `[redacted]`. Values under known free-text keys always; any other string
 *    that reads as prose (contains whitespace) too. `redactProse` is applied to
 *    the replayed side before comparing, so a sentence the reducer composes
 *    itself compares equal to its redacted recording.
 */
import { createHmac, randomBytes } from 'node:crypto';

type J = Record<string, unknown>;

export const REDACTED = '[redacted]';
export const EPOCH_BASE_MS = Date.UTC(2000, 0, 1);

/** Keys whose string values are always someone's words. */
const FREE_TEXT_KEYS = new Set([
  'body', 'prbody', 'comment', 'comments', 'summary', 'feedback', 'instructions', 'humaninstructions',
  'message', 'title', 'description', 'lasterror', 'excerpt', 'text', 'content', 'prompt', 'note_text', 'error', 'output',
]);
/** Keys that hold a branch name. */
const BRANCH_KEYS = new Set(['baseref', 'base_ref', 'headref', 'head_ref', 'ref', 'branch', 'basebranch', 'headbranch', 'integrationbranch']);
/** Keys that hold a repository full name. */
const REPO_KEYS = new Set(['repofullname', 'repo_full_name', 'headrepofullname', 'repo']);
/** Keys whose values are code-defined labels that may contain spaces (a route like `POST /api/tasks`). */
const PROSE_EXEMPT_KEYS = new Set(['surface']);
const TRUNK_NAMES = new Set(['main', 'master', 'dev', 'develop', 'trunk', 'staging', 'production']);
const IDENTITY_PREFIXES = ['human', 'user', 'github', 'login'];

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHA_RE = /\b[0-9a-f]{40}\b/gi;
const ISO_RE = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IDENTITY_RE = new RegExp(`\\b(${IDENTITY_PREFIXES.join('|')}):([^:\\s]+)`, 'g');
const PSEUDO_USER_RE = /^user-[0-9a-f]{10}$/;

/** A prose-shaped string, the rule `redactProse` and the exporter share. */
export function isProse(s: string): boolean {
  return /\s/.test(s.trim()) || s.length > 300;
}

/**
 * Collapse prose to `[redacted]`, at any depth: values under free-text keys,
 * and any string with whitespace. Idempotent; applied to both sides of a replay
 * comparison.
 */
export function redactProse<T>(v: T, key = ''): T {
  const walk = (x: unknown, k: string): unknown => {
    if (typeof x === 'string') return x && (FREE_TEXT_KEYS.has(k.toLowerCase()) || isProse(x)) ? REDACTED : x;
    if (Array.isArray(x)) return x.map((y) => walk(y, k));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as J).map(([kk, y]) => [kk, walk(y, kk)]));
    return x;
  };
  return walk(v, key) as T;
}

export class Pseudonymizer {
  private readonly salt: Buffer;
  private readonly repos = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly branches = new Map<string, string>();

  constructor(salt: Buffer = randomBytes(32)) {
    this.salt = salt;
  }

  private h(kind: string, value: string, len: number): string {
    return createHmac('sha256', this.salt).update(`${kind}\0${value}`).digest('hex').slice(0, len);
  }

  uuid(v: string): string {
    const x = this.h('uuid', v.toLowerCase(), 32);
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
  }

  sha(v: string): string {
    return this.h('sha', v.toLowerCase(), 40);
  }

  user(v: string): string {
    return PSEUDO_USER_RE.test(v) ? v : `user-${this.h('user', v, 10)}`;
  }

  /** Register a repository full name (owner/name) so every occurrence is replaced. */
  addRepo(full: string): void {
    if (!full || this.repos.has(full) || !full.includes('/')) return;
    const [owner, name] = full.split('/', 2);
    if (!this.owners.has(owner)) this.owners.set(owner, `org-${this.h('owner', owner, 8)}`);
    this.repos.set(full, `${this.owners.get(owner)}/repo-${this.h('repo', full, 8)}`);
  }

  /** Register a branch name; trunk names are not identifying and stay. */
  addBranch(name: string): void {
    if (!name || TRUNK_NAMES.has(name) || this.branches.has(name)) return;
    this.branches.set(name, `branch-${this.h('branch', name, 10)}`);
  }

  /** First pass over a raw value: learn every repo and branch it names, so the second pass replaces them inside any string. */
  collect(v: unknown, key = ''): void {
    if (typeof v === 'string') {
      const k = key.toLowerCase();
      if (REPO_KEYS.has(k)) this.addRepo(v);
      if (BRANCH_KEYS.has(k)) this.addBranch(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => this.collect(x, key)); return; }
    if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v as J)) this.collect(x, kk);
  }

  private shiftIso(createdAtMs: number) {
    return (_m: string, date: string, time: string, frac: string | undefined, zone: string): string => {
      const ms = Date.parse(`${date}T${time}${frac ?? ''}${zone.length === 3 ? `${zone}:00` : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`);
      if (Number.isNaN(ms)) return REDACTED;
      const iso = new Date(EPOCH_BASE_MS + (ms - createdAtMs)).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
      const [d2, rest] = iso.split('T');
      const t2 = rest.slice(0, 8);
      const f2 = frac ? `.${rest.slice(9, 12).padEnd(frac.length - 1, '0').slice(0, frac.length - 1)}` : '';
      return `${d2}T${t2}${f2}${zone === 'Z' ? 'Z' : '+00:00'}`;
    };
  }

  /** One string, identifiers replaced; prose and unknown links redacted. */
  string(s: string, key: string, createdAtMs: number): string {
    const k = key.toLowerCase();
    if (!s) return s;
    if (FREE_TEXT_KEYS.has(k)) return REDACTED;
    if (BRANCH_KEYS.has(k)) {
      this.addBranch(s);
      return this.branches.get(s) ?? s;
    }
    let out = s;
    for (const [real, fake] of [...this.repos].sort((a, b) => b[0].length - a[0].length)) out = out.split(real).join(fake);
    for (const [real, fake] of [...this.branches].sort((a, b) => b[0].length - a[0].length)) {
      // A branch is replaced inside a longer string only when it cannot be an ordinary word.
      if (out === real || (/[/-]/.test(real) && real.length >= 6)) out = out.split(real).join(fake);
    }
    out = out.replace(UUID_RE, (m) => this.uuid(m));
    out = out.replace(SHA_RE, (m) => this.sha(m));
    out = out.replace(ISO_RE, this.shiftIso(createdAtMs));
    out = out.replace(EMAIL_RE, (m) => `${this.user(m)}@example.invalid`);
    out = out.replace(IDENTITY_RE, (_m, p: string, id: string) => `${p}:${/^[0-9a-f]{8}-/.test(id) ? id : this.user(id)}`);
    for (const [real, fake] of this.owners) {
      // A bare owner (an org or account handle) left after the repo pass, e.g. in a URL path.
      out = out.replace(new RegExp(`(^|[/@:])${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/#:])`, 'g'), `$1${fake}`);
    }
    if (/^https?:\/\//.test(out) && !/^https:\/\/github\.com\/org-[0-9a-f]{8}\//.test(out)) return REDACTED;
    if (isProse(out) && !PROSE_EXEMPT_KEYS.has(k)) return REDACTED;
    return out;
  }

  /** Second pass: the sanitized copy. Call `collect` over everything first. */
  value<T>(v: T, createdAtMs: number, key = ''): T {
    const walk = (x: unknown, k: string): unknown => {
      if (typeof x === 'string') return this.string(x, k, createdAtMs);
      if (Array.isArray(x)) return x.map((y) => walk(y, k));
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as J).map(([kk, y]) => [kk, walk(y, kk)]));
      return x;
    };
    return walk(v, key) as T;
  }
}
