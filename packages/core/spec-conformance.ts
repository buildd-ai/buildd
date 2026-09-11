/**
 * Spec conformance checker core — Slice 1 of docs/design/spec-conformance.md.
 *
 * Evaluates the six assertion types (§1) against the filesystem and computes
 * a DERIVED status per doc (§2), independent of whatever status string the
 * doc's own frontmatter (or, for design docs that predate this change, its
 * bold `**Status:**` line) declares. No ledger table, no MCP tools, no CI
 * wiring — this module is the evaluator those later slices will read from.
 *
 * Portability (§14 pulled forward): every filesystem path this module touches
 * is either `repoRoot`-relative (given by the caller) or named by the
 * assertion itself. `specsRoot` / `designRoot` are caller-supplied with
 * buildd's own layout as the default, not a hardcoded assumption — see
 * `resolveConformanceConfig`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Assertion vocabulary (§1) ──────────────────────────────────────────────

export const ASSERTION_TYPES = [
  'symbol',
  'symbol_reachable',
  'route',
  'migration',
  'config_key',
  'test_file',
] as const;

export type AssertionType = (typeof ASSERTION_TYPES)[number];

/** As parsed off the page — every value is a raw string until validated. */
export interface RawAssertion {
  [key: string]: string | undefined;
}

/** A raw assertion that has passed required-field validation for its type. */
export interface TypedAssertion {
  id: string;
  type: AssertionType;
  fields: Record<string, string>;
  skipUntil?: string;
  skipReason?: string;
}

export interface AssertionValidationError {
  /** Position of the offending assertion within the doc's `assertions` list. */
  index: number;
  message: string;
}

// Required fields per type, beyond `id` and `type` (§1).
const REQUIRED_FIELDS: Record<AssertionType, string[]> = {
  symbol: ['name', 'path'],
  symbol_reachable: ['symbol', 'entry'],
  route: ['method', 'path', 'file'],
  migration: ['number', 'contains'],
  config_key: ['key', 'file'],
  test_file: ['path'],
};

/**
 * Validate the required-field shape of every raw assertion (Tier-1-equivalent,
 * §7's "an assertion without an id fails validation the same way a missing
 * path does today"). Returns the assertions that passed shape validation
 * separately from the ones that didn't — a doc with some invalid assertions
 * still evaluates the rest rather than being thrown out wholesale.
 */
export function validateAssertions(raw: RawAssertion[]): {
  valid: TypedAssertion[];
  errors: AssertionValidationError[];
} {
  const valid: TypedAssertion[] = [];
  const errors: AssertionValidationError[] = [];
  const seenIds = new Set<string>();

  raw.forEach((a, index) => {
    const id = a.id?.trim();
    if (!id) {
      errors.push({ index, message: 'missing required field "id" — an author-chosen, kebab-case, stable identity (§7)' });
      return;
    }
    if (seenIds.has(id)) {
      errors.push({ index, message: `duplicate id "${id}" within this doc — assertion ids must be unique per doc` });
      return;
    }

    const type = a.type as AssertionType | undefined;
    if (!type || !(ASSERTION_TYPES as readonly string[]).includes(type)) {
      errors.push({ index, message: `assertion "${id}": type "${a.type ?? '(missing)'}" is not one of ${ASSERTION_TYPES.join(', ')}` });
      return;
    }

    const missing = REQUIRED_FIELDS[type].filter((f) => !a[f]?.trim());
    if (missing.length > 0) {
      errors.push({ index, message: `assertion "${id}" (type ${type}): missing required field(s) ${missing.join(', ')}` });
      return;
    }

    if (a.skip_until && !a.skip_reason?.trim()) {
      errors.push({ index, message: `assertion "${id}": skip_until set without skip_reason — a suppression without a reason is a CI error (§6)` });
      return;
    }

    seenIds.add(id);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(a)) {
      if (v !== undefined && k !== 'id' && k !== 'type' && k !== 'skip_until' && k !== 'skip_reason') fields[k] = v;
    }
    valid.push({ id, type, fields, skipUntil: a.skip_until, skipReason: a.skip_reason });
  });

  return { valid, errors };
}

// ─── Suppression (§6) ───────────────────────────────────────────────────────

/** An expired `skip_until` is treated as if the suppression were absent — the assertion runs (§6). */
export function isSuppressed(a: TypedAssertion, now: Date): boolean {
  if (!a.skipUntil) return false;
  const until = new Date(a.skipUntil);
  if (Number.isNaN(until.getTime())) return false;
  return now.getTime() < until.getTime();
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

export type AssertionOutcome = 'pass' | 'fail' | 'suppressed';

export interface AssertionResult {
  id: string;
  type: AssertionType;
  outcome: AssertionOutcome;
  detail: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readLines(path: string): string[] | null {
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch {
    return null;
  }
}

/** ripgrep-equivalent: a line containing both an `export` token and the identifier as a whole word (§1 `symbol`). */
function evalSymbol(fields: Record<string, string>, repoRoot: string): { pass: boolean; detail: string } {
  const filePath = join(repoRoot, fields.path);
  const lines = readLines(filePath);
  if (lines === null) return { pass: false, detail: `file not found: ${fields.path}` };
  const wordRe = new RegExp(`\\b${escapeRegExp(fields.name)}\\b`);
  const hit = lines.some((l) => /\bexport\b/.test(l) && wordRe.test(l));
  return hit
    ? { pass: true, detail: `export of "${fields.name}" found in ${fields.path}` }
    : { pass: false, detail: `no exported "${fields.name}" found in ${fields.path}` };
}

/**
 * §1 `symbol_reachable`: the entry point must actually USE the symbol, not
 * merely mention its type. `as: assign` (recommended for loop-state style
 * assertions) requires `symbol =` that isn't `==`/`=>`; `as: import` requires
 * an import line naming the symbol; the default (any) accepts any whole-word
 * occurrence.
 */
function evalSymbolReachable(fields: Record<string, string>, repoRoot: string): { pass: boolean; detail: string } {
  const filePath = join(repoRoot, fields.entry);
  const lines = readLines(filePath);
  if (lines === null) return { pass: false, detail: `entry file not found: ${fields.entry}` };
  const symbol = escapeRegExp(fields.symbol);
  const mode = fields.as ?? 'any';

  let re: RegExp;
  let modeLabel: string;
  if (mode === 'assign') {
    re = new RegExp(`\\b${symbol}\\s*=(?!=|>)`);
    modeLabel = 'assignment';
  } else if (mode === 'import') {
    re = new RegExp(`\\bimport\\b[^\\n]*\\b${symbol}\\b`);
    modeLabel = 'import';
  } else if (mode === 'read') {
    re = new RegExp(`\\b${symbol}\\b`);
    modeLabel = 'read';
  } else {
    re = new RegExp(`\\b${symbol}\\b`);
    modeLabel = 'occurrence';
  }

  const hit = lines.some((l) => re.test(l));
  return hit
    ? { pass: true, detail: `${modeLabel} of "${fields.symbol}" found in ${fields.entry}` }
    : { pass: false, detail: `no ${modeLabel} of "${fields.symbol}" found in ${fields.entry}` };
}

/** §1 `route`: the named handler file exists and exports the named HTTP method. */
function evalRoute(fields: Record<string, string>, repoRoot: string): { pass: boolean; detail: string } {
  const filePath = join(repoRoot, fields.file);
  const lines = readLines(filePath);
  if (lines === null) return { pass: false, detail: `route file not found: ${fields.file}` };
  const method = fields.method.toUpperCase();
  const re = new RegExp(`\\bexport\\b[^\\n]*\\b${method}\\b`);
  const hit = lines.some((l) => re.test(l));
  return hit
    ? { pass: true, detail: `${method} handler exported from ${fields.file}` }
    : { pass: false, detail: `no exported ${method} handler found in ${fields.file}` };
}

/**
 * §1 `migration`: pre-commit tier only — glob the migration directory for a
 * file numbered `number` and grep it for `contains`. The CI-tier DB check
 * (verify the migration is recorded in `drizzle.__drizzle_migrations`) needs
 * DATABASE_URL and CI wiring; both are out of scope for this slice (no ledger,
 * no CI job yet) — see `evalMigrationAppliedInDb` for the opt-in follow-on.
 */
function evalMigration(fields: Record<string, string>, repoRoot: string, migrationsDir: string): { pass: boolean; detail: string } {
  const dir = join(repoRoot, migrationsDir);
  const num = fields.number.padStart(4, '0');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { pass: false, detail: `migrations directory not found: ${migrationsDir}` };
  }
  const match = files.find((f) => f.startsWith(`${num}_`) && f.endsWith('.sql'));
  if (!match) return { pass: false, detail: `no migration file numbered ${num} in ${migrationsDir}` };
  const content = readFileSync(join(dir, match), 'utf8');
  const hit = content.includes(fields.contains);
  return hit
    ? { pass: true, detail: `${match} contains "${fields.contains}"` }
    : { pass: false, detail: `${match} exists but does not contain "${fields.contains}"` };
}

/** §1 `config_key`: the key appears as a literal in the named file. */
function evalConfigKey(fields: Record<string, string>, repoRoot: string): { pass: boolean; detail: string } {
  const filePath = join(repoRoot, fields.file);
  const lines = readLines(filePath);
  if (lines === null) return { pass: false, detail: `file not found: ${fields.file}` };
  const re = new RegExp(`\\b${escapeRegExp(fields.key)}\\b`);
  const hit = lines.some((l) => re.test(l));
  return hit
    ? { pass: true, detail: `"${fields.key}" found in ${fields.file}` }
    : { pass: false, detail: `"${fields.key}" not found in ${fields.file}` };
}

/** §1 `test_file`: existence only — deliberately the weakest assertion. */
function evalTestFile(fields: Record<string, string>, repoRoot: string): { pass: boolean; detail: string } {
  const filePath = join(repoRoot, fields.path);
  const pass = existsSync(filePath);
  return pass ? { pass: true, detail: `${fields.path} exists` } : { pass: false, detail: `${fields.path} does not exist` };
}

export interface EvaluateOptions {
  repoRoot: string;
  /** Drizzle migration directory, repo-root-relative. Defaults to buildd's own layout. */
  migrationsDir?: string;
  now?: Date;
}

export function evaluateAssertion(a: TypedAssertion, opts: EvaluateOptions): AssertionResult {
  const now = opts.now ?? new Date();
  if (isSuppressed(a, now)) {
    return { id: a.id, type: a.type, outcome: 'suppressed', detail: `suppressed until ${a.skipUntil} — ${a.skipReason}` };
  }

  let result: { pass: boolean; detail: string };
  switch (a.type) {
    case 'symbol':
      result = evalSymbol(a.fields, opts.repoRoot);
      break;
    case 'symbol_reachable':
      result = evalSymbolReachable(a.fields, opts.repoRoot);
      break;
    case 'route':
      result = evalRoute(a.fields, opts.repoRoot);
      break;
    case 'migration':
      result = evalMigration(a.fields, opts.repoRoot, opts.migrationsDir ?? 'packages/core/drizzle');
      break;
    case 'config_key':
      result = evalConfigKey(a.fields, opts.repoRoot);
      break;
    case 'test_file':
      result = evalTestFile(a.fields, opts.repoRoot);
      break;
  }
  return { id: a.id, type: a.type, outcome: result.pass ? 'pass' : 'fail', detail: result.detail };
}

// ─── Derived status (§2) ────────────────────────────────────────────────────

export type DerivedStatus = 'implemented' | 'partial' | 'failing' | 'unverified';

/**
 * §2's table, plus §6's suppression carve-outs:
 *   - a suppressed assertion counts as partial, not pass — so any suppression
 *     mixed with otherwise-all-passing results still reads as `partial`.
 *   - a doc where EVERY assertion is suppressed reads as `unverified`, not
 *     `implemented` — nothing was actually evaluated.
 *   - zero assertions is `unverified` (§1's table row, and the whole point of
 *     §16: unverified must stay visible, never silently read as "fine").
 */
export function computeDerivedStatus(results: AssertionResult[]): DerivedStatus {
  if (results.length === 0) return 'unverified';
  const suppressed = results.filter((r) => r.outcome === 'suppressed').length;
  if (suppressed === results.length) return 'unverified';

  const pass = results.filter((r) => r.outcome === 'pass').length;
  if (pass === results.length) return 'implemented';

  const fail = results.length - pass - suppressed;
  if (pass === 0 && suppressed === 0 && fail === results.length) return 'failing';

  return 'partial';
}

// ─── Doc type + declared status ─────────────────────────────────────────────

export type DocType = 'design' | 'spec';

// Exported so the discrepancy ledger (spec-discrepancy-ledger.ts) can classify
// direction (§8) using the exact same terminal/non-terminal sets this module
// uses for the contradiction check — one definition, not two that can drift.
export const TERMINAL_STATUS: Record<DocType, string> = { design: 'implemented', spec: 'active' };
export const NON_TERMINAL_STATUS: Record<DocType, string[]> = {
  design: ['proposed', 'accepted'],
  spec: ['draft'],
};

export interface ParsedFrontmatter {
  status: string | null;
  assertions: RawAssertion[];
  /**
   * Part A escape hatch — mirrors `goalCriteria`'s `notMechanizableReason`
   * (`packages/core/mission-helpers.ts`, `validateGoalCriteria`): a terminal-
   * status doc with a genuinely un-mechanizable claim set may declare this
   * instead of an assertion, subject to the same 10-char floor.
   */
  notMechanizableReason: string | null;
}

/**
 * Parses only what this checker needs — `status` and a possibly-nested
 * `assertions` list — from a leading `---`-delimited YAML block. Deliberately
 * not a general YAML parser (this repo has never taken a YAML dependency;
 * `scripts/check-specs.ts` hand-rolls a flat parser for the same reason). The
 * grammar handled: top-level `key: value` scalars, and a top-level `key:`
 * followed by an indented block-sequence of flat maps (`- k: v` / `  k: v`),
 * which is exactly the shape §1's frontmatter examples use.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter | null {
  if (!content.startsWith('---\n') && content !== '---') return null;
  const lines = content.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const body = lines.slice(1, end);

  let status: string | null = null;
  let notMechanizableReason: string | null = null;
  const assertions: RawAssertion[] = [];

  let i = 0;
  while (i < body.length) {
    const line = body[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) {
      // Orphaned indented line (not under a recognized block key) — skip.
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const [, key, rest] = m;
    if (key === 'status') {
      status = unquote(rest.trim()) || null;
      i++;
      continue;
    }
    if (key === 'not_mechanizable_reason') {
      notMechanizableReason = unquote(rest.trim()) || null;
      i++;
      continue;
    }
    if (key === 'assertions') {
      i++;
      let current: RawAssertion | null = null;
      while (i < body.length) {
        const l = body[i];
        if (!l.trim()) {
          i++;
          continue;
        }
        if (!/^\s/.test(l)) break; // dedent — end of the assertions block
        const trimmed = l.trim();
        if (trimmed.startsWith('#')) {
          i++;
          continue;
        }
        if (trimmed.startsWith('- ')) {
          if (current) assertions.push(current);
          current = {};
          const kv = trimmed.slice(2).match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (kv) current[kv[1]] = unquote(kv[2].trim());
        } else if (current) {
          const kv = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (kv) current[kv[1]] = unquote(kv[2].trim());
        }
        i++;
      }
      if (current) assertions.push(current);
      continue;
    }
    i++;
  }

  return { status, assertions, notMechanizableReason };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Design docs predate this design's frontmatter block (only a handful have
 * adopted it so far) and mostly still carry the bold `**Status:** X` header
 * line from DESIGN-FORMAT.md. Falling back to it lets the checker report a
 * meaningful declared status for the other ~70 design docs today rather than
 * treating every one of them as having no declared status at all. The first
 * status word is taken and lowercased — design docs in the wild append all
 * kinds of trailing prose ("Proposed — prerequisites merged...").
 */
export function extractBoldStatus(content: string): string | null {
  const m = content.match(/^\*\*Status:?\*\*:?\s*([A-Za-z][A-Za-z-]*)/m);
  if (!m) return null;
  return m[1].toLowerCase();
}

export function declaredStatus(content: string, frontmatter: ParsedFrontmatter | null, docType: DocType): string | null {
  if (frontmatter?.status) return frontmatter.status.toLowerCase();
  if (docType === 'design') return extractBoldStatus(content);
  return null;
}

// ─── Contradiction (§2 CI failure conditions) ───────────────────────────────

export interface Contradiction {
  kind: 'declared-ahead-of-derived' | 'derived-ahead-of-declared' | 'missing-assertions';
  message: string;
}

/**
 * §2's two CI failure conditions. Case 3 (partial/failing + non-terminal) is
 * the expected in-progress state and is not a contradiction. `superseded` (or
 * any status outside the known terminal/non-terminal sets, e.g. a doc that
 * hasn't adopted the enum at all) is excluded — promotion logic doesn't apply
 * to a doc that has been explicitly retired or whose status this checker
 * couldn't parse.
 */
export function checkContradiction(docType: DocType, declared: string | null, derived: DerivedStatus): Contradiction | null {
  if (!declared || derived === 'unverified') return null;
  const terminal = TERMINAL_STATUS[docType];
  const nonTerminal = NON_TERMINAL_STATUS[docType];

  if (declared === terminal && (derived === 'partial' || derived === 'failing')) {
    return {
      kind: 'declared-ahead-of-derived',
      message: `Status declares '${declared}' but derived status is '${derived}'. Fix the assertions or update the status.`,
    };
  }
  if (derived === 'implemented' && nonTerminal.includes(declared)) {
    return {
      kind: 'derived-ahead-of-declared',
      message: `All assertions pass but status declares '${declared}'. Promote the status to '${terminal}', or add a skip_until suppression if the mismatch is intentional.`,
    };
  }
  return null;
}

// ─── Missing-assertions gate (Part A — enforce first) ──────────────────────

/**
 * Pre-existing docs that declared a terminal status with zero assertions
 * before this gate existed. Grandfathered so landing the gate doesn't turn
 * every PR red at once — mirrors `VERIFIED_BY_DEBT` in `scripts/check-specs.ts`
 * exactly: this list only ever SHRINKS as real assertions are backfilled
 * (§5 migration order), and a new doc may never be added to it. A doc that
 * needs a permanent exemption uses `not_mechanizable_reason` instead (below),
 * which requires a stated reason rather than silent grandfathering.
 */
export const MISSING_ASSERTIONS_DEBT = new Set<string>([
  'docs/design/backend-failover-policy.md',
  'docs/design/change-intent.md',
  'docs/design/friction-dedup-serialization.md',
  'docs/design/mobile-artifact-feed.md',
  'docs/design/mobile-filter-pattern.md',
  'docs/design/model-tiers.md',
  'docs/design/task-classification-and-wait.md',
  'docs/design/task-model-visibility.md',
  'docs/design/workspace-memory-digest-arm.md',
  'docs/specs/artifacts-and-sharing.md',
  'docs/specs/auth-oauth-boundaries.md',
  'docs/specs/codebase-memory-graph.md',
  'docs/specs/codex-backend-spec.md',
  'docs/specs/credential-isolation.md',
  'docs/specs/human-in-the-loop-protocol.md',
  'docs/specs/knowledge-ingest-pipeline.md',
  'docs/specs/knowledge-store-retrieval.md',
  'docs/specs/mcp-action-contracts.md',
  'docs/specs/mcp-connectors-and-roles.md',
  'docs/specs/migration-execution.md',
  'docs/specs/mission-structure-view.md',
  'docs/specs/mission-task-lifecycle.md',
  'docs/specs/model-routing-and-tiers.md',
  'docs/specs/pr-lifecycle-reconciliation.md',
  'docs/specs/team-namespace-scoping.md',
  'docs/specs/team-workspace-mission-onboarding.md',
  'docs/specs/timeline-dependency-geometry.md',
  'docs/specs/usage-and-cost-accounting.md',
  'docs/specs/work-tracker-integration.md',
  'docs/specs/worker-sandbox-isolation.md',
]);

const NOT_MECHANIZABLE_REASON_MIN_LENGTH = 10;

/**
 * Part A: a doc that declares a TERMINAL status (`implemented` for design,
 * `active` for spec) must carry at least one assertion — presence only, not
 * passing-ness; §2's existing checks already cover whether a declared
 * assertion actually passes. Without this, a doc can claim `active` with a
 * frontmatter block that has never been asked to prove anything, which is
 * exactly how 108 of 110 docs got to `unverified` with nobody noticing (§16).
 *
 * Carve-outs, in order:
 *   - non-terminal status (proposed/accepted/draft) — zero assertions is the
 *     honest backlog state per §5, never a failure.
 *   - `rawAssertionCount > 0` — an assertion under an active `skip_until`
 *     suppression (§6) still counts as "at least one assertion declared"; this
 *     check is about presence, not evaluated outcome, so a suppressed-only doc
 *     is unaffected (its own §2 contradiction check separately treats it as
 *     `unverified`, which never contradicts a terminal declared status either).
 *   - `not_mechanizable_reason` (10+ chars) — mirrors goalCriteria's
 *     `notMechanizableReason` escape hatch for a genuinely un-mechanizable claim.
 *   - `MISSING_ASSERTIONS_DEBT` — pre-existing docs grandfathered in; shrinks
 *     only, never grows.
 */
export function checkMissingAssertions(
  docPath: string,
  docType: DocType,
  declared: string | null,
  rawAssertionCount: number,
  notMechanizableReason: string | null,
): Contradiction | null {
  if (!declared) return null;
  if (declared !== TERMINAL_STATUS[docType]) return null;
  if (rawAssertionCount > 0) return null;
  if (notMechanizableReason && notMechanizableReason.trim().length >= NOT_MECHANIZABLE_REASON_MIN_LENGTH) return null;
  if (MISSING_ASSERTIONS_DEBT.has(docPath)) return null;

  return {
    kind: 'missing-assertions',
    message:
      `Status declares '${declared}' but no assertions are declared (§1). Add at least one real, ` +
      `resolvable assertion, or set not_mechanizable_reason (10+ chars) explaining why none of ` +
      `${ASSERTION_TYPES.join(', ')} can express this doc's claims.`,
  };
}

// ─── Doc discovery + full evaluation ────────────────────────────────────────

export interface ConformanceConfig {
  repoRoot: string;
  specsRoot: string;
  designRoot: string;
  migrationsDir: string;
}

/**
 * Part C — the portability seam. Buildd's own layout (`docs/specs`,
 * `docs/design`, `packages/core/drizzle`) is the DEFAULT, supplied here as
 * plain values rather than baked into the evaluators above (which only ever
 * see fields resolved off `repoRoot`). A future per-workspace config row
 * (§14, slice 7) plugs into `specsRoot`/`designRoot`/`migrationsDir` here
 * without touching anything above this function.
 */
export function resolveConformanceConfig(overrides: Partial<ConformanceConfig> & { repoRoot: string }): ConformanceConfig {
  return {
    repoRoot: overrides.repoRoot,
    specsRoot: overrides.specsRoot ?? 'docs/specs',
    designRoot: overrides.designRoot ?? 'docs/design',
    migrationsDir: overrides.migrationsDir ?? 'packages/core/drizzle',
  };
}

// Non-doc files that live in the spec/design roots but aren't themselves specs.
const SPEC_META_FILES = new Set(['SPEC-FORMAT.md', 'REPORT.md', 'INDEX.md']);
const DESIGN_META_FILES = new Set(['DESIGN-FORMAT.md']);

export interface DiscoveredDoc {
  /** Repo-root-relative path. */
  path: string;
  docType: DocType;
}

export function discoverDocs(config: ConformanceConfig): DiscoveredDoc[] {
  const docs: DiscoveredDoc[] = [];
  const specs = (() => {
    try {
      return readdirSync(join(config.repoRoot, config.specsRoot));
    } catch {
      return [];
    }
  })();
  for (const f of specs) {
    if (f.endsWith('.md') && !SPEC_META_FILES.has(f)) {
      docs.push({ path: join(config.specsRoot, f), docType: 'spec' });
    }
  }
  const designs = (() => {
    try {
      return readdirSync(join(config.repoRoot, config.designRoot));
    } catch {
      return [];
    }
  })();
  for (const f of designs) {
    if (f.endsWith('.md') && !DESIGN_META_FILES.has(f)) {
      docs.push({ path: join(config.designRoot, f), docType: 'design' });
    }
  }
  return docs;
}

export interface DocEvaluation {
  path: string;
  docType: DocType;
  declaredStatus: string | null;
  derivedStatus: DerivedStatus;
  results: AssertionResult[];
  validationErrors: AssertionValidationError[];
  contradiction: Contradiction | null;
}

export function evaluateDoc(doc: DiscoveredDoc, config: ConformanceConfig, now?: Date): DocEvaluation {
  const content = readFileSync(join(config.repoRoot, doc.path), 'utf8');
  const frontmatter = parseFrontmatter(content);
  const declared = declaredStatus(content, frontmatter, doc.docType);
  const { valid, errors } = validateAssertions(frontmatter?.assertions ?? []);
  const results = valid.map((a) => evaluateAssertion(a, { repoRoot: config.repoRoot, migrationsDir: config.migrationsDir, now }));
  const derived = computeDerivedStatus(results);
  const contradiction =
    checkContradiction(doc.docType, declared, derived) ??
    checkMissingAssertions(doc.path, doc.docType, declared, frontmatter?.assertions.length ?? 0, frontmatter?.notMechanizableReason ?? null);

  return {
    path: doc.path,
    docType: doc.docType,
    declaredStatus: declared,
    derivedStatus: derived,
    results,
    validationErrors: errors,
    contradiction,
  };
}

export function evaluateAllDocs(config: ConformanceConfig, now?: Date): DocEvaluation[] {
  return discoverDocs(config).map((d) => evaluateDoc(d, config, now));
}

// ─── Watch set (§4) ─────────────────────────────────────────────────────────

/**
 * §4's watch set: `docs/design/**` UNION every path referenced in any `path`,
 * `file`, or `entry` field across all spec and design docs. Deliberately NOT
 * `docs/specs/**` in full — the design doc names only `docs/design/**` as the
 * always-watched prefix; a spec doc's own file only enters the set via its
 * own assertions, same as any other doc.
 *
 * Fields are collected from every syntactically valid assertion regardless
 * of doc type or declared status — the watch set answers "what code proves or
 * disproves a claim somewhere in this repo", not "what currently passes".
 */
export interface WatchSet {
  /** Path prefixes: any changed file starting with one of these is watched in full. */
  prefixes: string[];
  /** Exact repo-root-relative paths referenced by an assertion's path/file/entry field. */
  paths: string[];
}

const WATCHED_ASSERTION_FIELDS = ['path', 'file', 'entry'];

export function computeWatchSet(config: ConformanceConfig): WatchSet {
  const paths = new Set<string>();

  for (const doc of discoverDocs(config)) {
    const content = readFileSync(join(config.repoRoot, doc.path), 'utf8');
    const frontmatter = parseFrontmatter(content);
    const { valid } = validateAssertions(frontmatter?.assertions ?? []);
    for (const assertion of valid) {
      for (const field of WATCHED_ASSERTION_FIELDS) {
        const value = assertion.fields[field];
        if (value) paths.add(value);
      }
    }
  }

  const designPrefix = config.designRoot.endsWith('/') ? config.designRoot : `${config.designRoot}/`;
  return { prefixes: [designPrefix], paths: [...paths].sort() };
}

/** Whether a repo-root-relative changed file falls inside the watch set. */
export function isWatched(changedFile: string, watchSet: WatchSet): boolean {
  if (watchSet.paths.includes(changedFile)) return true;
  return watchSet.prefixes.some((prefix) => changedFile.startsWith(prefix));
}
