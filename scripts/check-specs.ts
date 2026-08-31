#!/usr/bin/env bun
/**
 * Spec hygiene linter + index generator.
 *
 * Keeps docs/specs/ clean: every capability spec must carry lifecycle
 * frontmatter, its `Code surface:` paths must resolve, superseded specs must
 * name a successor, and no two ACTIVE specs may claim the same slug (dup guard).
 * Also regenerates docs/specs/INDEX.md so the live/retired split is always
 * visible at a glance.
 *
 * Beyond hygiene, three checks test whether a spec is TRUE, not just well-formed:
 *   - symbol liveness: every backticked code symbol a spec names must exist
 *   - verified_by:     an `active` spec must name the tests asserting its invariants
 *   - surface coverage: reports high-value modules no live spec claims (advisory)
 *
 * Deliberately NOT a check: "code newer than last_verified". Measured on this
 * corpus it flags 20 of 21 specs, because the hot files churn daily — a gate
 * that always fires teaches people to ignore it.
 *
 * Exit codes:
 *   0  clean (warnings allowed)
 *   1  one or more errors (missing frontmatter, dead code-surface path,
 *      duplicate active slug, superseded-without-successor)
 *
 * Usage:
 *   bun run scripts/check-specs.ts            # lint + rewrite INDEX.md
 *   bun run scripts/check-specs.ts --check    # lint only; fail if INDEX.md stale
 *   bun run scripts/check-specs.ts --orphans  # also list every unspecced module
 *
 * Specs live in docs/specs/. SPEC-FORMAT.md, REPORT.md, and INDEX.md are meta
 * files and are skipped by the frontmatter checks.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SPECS_DIR = join(ROOT, 'docs/specs');
const INDEX_FILE = join(SPECS_DIR, 'INDEX.md');

// Meta files that live in docs/specs/ but are not capability specs.
const META_FILES = new Set(['SPEC-FORMAT.md', 'REPORT.md', 'INDEX.md']);

const VALID_STATUS = new Set(['active', 'draft', 'superseded']);
const STALE_DAYS = 90;

const checkOnly = process.argv.includes('--check');

// ─── Minimal frontmatter parser ──────────────────────────────────────────────
// Specs use a flat YAML block: string scalars, ISO dates, and one-line arrays
// (`supersedes: [a, b]`). No nesting — a full YAML dep would be overkill.

interface Frontmatter {
  title?: string;
  status?: string;
  owner?: string;
  last_verified?: string;
  /** One-sentence capability statement — what MUST hold. Required. */
  summary?: string;
  /** Controlled vocabulary, see DOMAINS. Required. */
  domain?: string;
  /** Primary implementation paths — the 2-4 files to open first. */
  surfaces?: string[];
  /** Sibling spec slugs. Validated: a dead reference is an error. */
  related?: string[];
  /** Retrieval aliases — terms a reader would search that the title omits. */
  keywords?: string[];
  /**
   * Test files that actually assert this spec's invariants. Required for
   * `status: active` — a contract nobody can fail is a wish, not a contract.
   */
  verified_by?: string[];
  supersedes?: string[];
  superseded_by?: string;
}

/**
 * Domain vocabulary. Deliberately small and flat: a spec belongs to exactly one
 * domain, so the index groups cleanly and a retrieval filter is a single
 * equality check. Adding a value is a deliberate act — extend this list in the
 * same PR as the spec that needs it.
 */
const DOMAINS = new Set([
  'missions',
  'tasks',
  'runners',
  'releases',
  'knowledge',
  'auth',
  'mcp',
  'surfaces',
  'integrations',
  'billing',
]);

/** Longer than this and it is not a summary; it is the spec. */
const SUMMARY_MAX = 220;

/**
 * Specs that predate the `verified_by` requirement.
 *
 * Every entry is debt: the spec asserts invariants that no named test guards, so
 * a regression against it is invisible. The list only ever SHRINKS — remove a
 * slug by naming the tests that genuinely assert its invariants. Adding a slug
 * here is not an option for a new spec: without `verified_by`, a new spec must
 * be `status: draft`, which is the honest state for a contract with no guard.
 */
export const VERIFIED_BY_DEBT = new Set([
  'auth-oauth-boundaries',
  'codex-backend-spec',
  'credential-isolation',
  'db-migration-gates',
  'external-cron-triggers',
  'knowledge-store-retrieval',
  'mcp-action-contracts',
  'mcp-connectors-and-roles',
  'mission-task-lifecycle',
  'provider-failover',
  'release-flow',
  'runner-liveness',
  'scheduled-task-merge-policy',
  'subject-anchor-liveness',
  'team-namespace-scoping',
  'team-workspace-mission-onboarding',
  'timeline-dependency-geometry',
  'webhook-dataflow',
  'work-tracker-integration',
]);

/**
 * Symbol-liveness heuristics.
 *
 * A spec that names `isCleanupExpiry` as the guard on a transition is making a
 * checkable claim: that identifier exists in the code. Path existence was
 * already enforced; the prose was not, and six such symbols in four active
 * specs turned out to name nothing at all.
 *
 * Deliberately narrow — only backticked tokens shaped like code we own:
 * camelCase with an internal hump, or SCREAMING_SNAKE. PascalCase is excluded
 * because most of it is imported library types (`NextRequest`), and snake_case
 * because it is mostly third-party MCP tool names (`index_repository`). On the
 * current corpus this shape yields 418 claims and no false positives.
 *
 * Known limitation: a mention inside a comment counts as existing, so a symbol
 * deleted from code but named in a nearby comment still passes.
 */
const SYM_CAMEL = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/;
const SYM_SCREAMING = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

function parseFrontmatter(raw: string): { fm: Frontmatter | null; body: string } {
  if (!raw.startsWith('---')) return { fm: null, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { fm: null, body: raw };
  const block = raw.slice(3, end).trim();
  const body = raw.slice(end + 4);
  const fm: Record<string, unknown> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { fm: fm as Frontmatter, body };
}

// ─── Load specs ──────────────────────────────────────────────────────────────

interface SpecFile {
  file: string;
  slug: string;
  fm: Frontmatter;
  body: string;
  errors: string[];
  warnings: string[];
}

function daysSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

// Pull file paths out of the `Code surface:` section so we can confirm they
// still exist (SPEC-FORMAT rule #4, previously unenforced).
function codeSurfacePaths(body: string): string[] {
  // Three spellings occur in the wild: `**Code surface**:`, `Code surface:`, and a
  // `## Code surface` heading. Missing the heading form meant one spec's dead path
  // sat unnoticed — the check silently found zero paths and passed.
  const start = body.search(/\*\*Code surface\*\*|^#{2,4} Code surface|Code surface:/im);
  if (start === -1) return [];
  // Stop at the next bold label or heading, but not on the heading we just matched.
  const rest = body.slice(start);
  const section = rest.slice(0, 1) + rest.slice(1).split(/\n\*\*|\n#{2,4} /)[0];
  const paths = new Set<string>();
  for (const m of section.matchAll(/`([^`]+)`/g)) {
    const token = m[1].split(/[\s:#]/)[0]; // strip `:symbol` / line refs
    if (/^(apps|packages|docs|scripts)\//.test(token)) paths.add(token);
  }
  return [...paths];
}

/**
 * Backticked tokens in the body that claim a code symbol exists.
 * Paths, prose, and dotted expressions are skipped — `codeSurfacePaths` owns paths.
 */
export function claimedSymbols(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    if (raw.includes('/') || raw.includes(' ') || raw.includes('.')) continue;
    const token = raw.replace(/[()]+$/, '');
    if (SYM_CAMEL.test(token) || SYM_SCREAMING.test(token)) out.add(token);
  }
  return [...out];
}

/** Tracked file types worth searching for a code symbol. */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|sh|sql|ya?ml)$|Dockerfile$/i;
/** Tests are not a code surface a spec may cite — see resolveSymbols. */
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/;

/**
 * Resolve every claimed symbol against the tracked source tree in one pass.
 *
 * Tokenizes each file once and diffs against the claim set: ~1600 files / 35 MB,
 * about a second. The obvious `git grep -F -e sym1 -e sym2 …` is pathological at
 * this scale — with the ~800 symbols the corpus now claims it ran past 100
 * seconds, versus 80 ms for five. Cost is per-byte here, not per-symbol.
 *
 * `docs/` is excluded on purpose. A symbol mentioned only in another spec, or in
 * a design doc proposing a name that never shipped, must NOT count as existing —
 * that is precisely the drift this check exists to catch.
 *
 * Test files are excluded for the same reason, plus one of its own: a spec
 * describes shipped behaviour, so a symbol that exists ONLY in a test is not a
 * live code surface. Without this, the corpus also swallows its own tail — this
 * checker's tests must name deliberately-fake symbols to prove the check can
 * fail, and those literals would otherwise satisfy the very search they test.
 */
export function resolveSymbols(symbols: string[]): Set<string> {
  if (symbols.length === 0) return new Set();
  const wanted = new Set(symbols);
  const found = new Set<string>();

  const ls = spawnSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = (ls.stdout ?? '')
    .split('\0')
    .filter((f) => f && !f.startsWith('docs/') && SOURCE_EXT.test(f) && !TEST_FILE.test(f));

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // unreadable or binary — nothing to learn from it
    }
    for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      if (wanted.has(m[0])) {
        found.add(m[0]);
        if (found.size === wanted.size) return new Set(); // every claim resolved
      }
    }
  }
  return new Set(symbols.filter((s) => !found.has(s)));
}

function loadSpecs(): SpecFile[] {
  const files = readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith('.md') && !META_FILES.has(f))
    .sort();

  return files.map((file) => {
    const raw = readFileSync(join(SPECS_DIR, file), 'utf8');
    const { fm, body } = parseFrontmatter(raw);
    const errors: string[] = [];
    const warnings: string[] = [];
    const slug = file.replace(/\.md$/, '');

    if (!fm) {
      errors.push('missing frontmatter block (--- ... ---)');
      return { file, slug, fm: {}, body, errors, warnings };
    }

    if (!fm.title) errors.push('frontmatter missing `title`');
    if (!fm.status) errors.push('frontmatter missing `status`');
    else if (!VALID_STATUS.has(fm.status))
      errors.push(`invalid status "${fm.status}" (active | draft | superseded)`);
    if (!fm.owner) errors.push('frontmatter missing `owner`');

    if (!fm.last_verified) {
      warnings.push('frontmatter missing `last_verified`');
    } else {
      const age = daysSince(fm.last_verified);
      if (age === null) errors.push(`last_verified "${fm.last_verified}" is not a valid date`);
      else if (age > STALE_DAYS)
        warnings.push(`last_verified is ${age}d old (>${STALE_DAYS}d) — re-verify against code`);
    }

    if (fm.status === 'superseded' && !fm.superseded_by)
      errors.push('status is `superseded` but no `superseded_by` successor named');

    // ── Ingestion fields ──────────────────────────────────────────────────────
    // A spec that cannot be summarised in one line and filed under one domain is
    // not readable by a person skimming the index, and not retrievable by an
    // agent that has to pick one spec out of twenty.
    if (!fm.summary) {
      errors.push('frontmatter missing `summary` (one sentence: what MUST hold)');
    } else if (Array.isArray(fm.summary)) {
      // The parser coerces any `[...]` value to an array. Without this branch the
      // presence check passes, the length check silently measures item count, and
      // INDEX.md renders the comma-joined array as the summary.
      errors.push('`summary` must be a single sentence, not a list — it must not start with `[`');
    } else if (fm.summary.length > SUMMARY_MAX) {
      warnings.push(`summary is ${fm.summary.length} chars (>${SUMMARY_MAX}) — compress it`);
    }

    if (!fm.domain) {
      errors.push(`frontmatter missing \`domain\` (one of: ${[...DOMAINS].join(', ')})`);
    } else if (!DOMAINS.has(fm.domain)) {
      errors.push(`invalid domain "${fm.domain}" (one of: ${[...DOMAINS].join(', ')})`);
    }

    if (fm.surfaces && fm.surfaces.length > 4) {
      warnings.push(`surfaces lists ${fm.surfaces.length} paths (>4) — it is a shortlist, not the full Code surface section`);
    }
    for (const p of fm.surfaces ?? []) {
      if (!existsSync(join(ROOT, p))) errors.push(`surfaces path does not exist: ${p}`);
    }

    // ── verified_by: the spec's invariants must be machine-checkable ──────────
    const guards = fm.verified_by ?? [];
    if (fm.status === 'active' && guards.length === 0) {
      if (VERIFIED_BY_DEBT.has(slug)) {
        warnings.push(
          `no \`verified_by\` — pre-existing debt, ${VERIFIED_BY_DEBT.size} spec(s) still owe guards`,
        );
      } else {
        errors.push(
          'status is `active` but `verified_by` is empty — name the tests that assert these invariants, or set `status: draft`',
        );
      }
    }
    for (const p of guards) {
      if (!existsSync(join(ROOT, p))) errors.push(`verified_by path does not exist: ${p}`);
      else if (!/\.test\.(ts|tsx)$/.test(p) && !p.includes('__tests__'))
        warnings.push(`verified_by path is not a test file: ${p}`);
    }

    for (const p of codeSurfacePaths(body)) {
      // Globs/placeholders (`00XX_*.sql`) can't be existence-checked — warn so the
      // author fills in the real path, but don't hard-fail CI on a template token.
      if (/[*]|\bXX\b|\bNN\b|X{2,}/i.test(p)) {
        warnings.push(`code surface path is an unresolved placeholder: ${p}`);
      } else if (!existsSync(join(ROOT, p))) {
        errors.push(`code surface path does not exist: ${p}`);
      }
    }

    return { file, slug, fm, body, errors, warnings };
  });
}

// ─── Cross-file checks ───────────────────────────────────────────────────────

function crossChecks(specs: SpecFile[]): string[] {
  const errors: string[] = [];

  // Dup guard: no two ACTIVE specs may share a title (compared lowercased/trimmed).
  const byTitle = new Map<string, string[]>();
  for (const s of specs) {
    if (s.fm.status !== 'active' || !s.fm.title) continue;
    const key = s.fm.title.toLowerCase().trim();
    byTitle.set(key, [...(byTitle.get(key) ?? []), s.file]);
  }
  for (const [title, files] of byTitle) {
    if (files.length > 1)
      errors.push(`duplicate active title "${title}" in: ${files.join(', ')}`);
  }

  // Referential integrity: supersedes / superseded_by must point at real slugs.
  const slugs = new Set(specs.map((s) => s.slug));
  for (const s of specs) {
    for (const ref of s.fm.supersedes ?? [])
      if (!slugs.has(ref)) errors.push(`${s.file}: supersedes unknown spec "${ref}"`);
    if (s.fm.superseded_by && !slugs.has(s.fm.superseded_by))
      errors.push(`${s.file}: superseded_by unknown spec "${s.fm.superseded_by}"`);
    for (const ref of s.fm.related ?? []) {
      if (ref === s.slug) errors.push(`${s.file}: related lists itself`);
      else if (!slugs.has(ref)) errors.push(`${s.file}: related unknown spec "${ref}"`);
    }
  }

  return errors;
}

// ─── Surface coverage audit ──────────────────────────────────────────────────
// The dup guard answers "are two specs claiming the same capability?". Nothing
// answered the reverse — "is a capability running unspecced?" — which is how a
// default-on MCP layer (CBM) shipped across six modules, a DB column, an API
// route and a fleet alert with no contract at all. This lists the high-value
// modules no active or draft spec names.

interface Coverage {
  guarded: number;
  total: number;
  orphanCrons: string[];
  orphanModules: string[];
}

function listFiles(dir: string, filter: (f: string) => boolean): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isFile() && filter(d.name))
    .map((d) => `${dir}/${d.name}`);
}

function surfaceCoverage(specs: SpecFile[]): Coverage {
  const live = specs.filter((s) => s.fm.status !== 'superseded');
  const guardedPaths = new Set<string>();
  for (const s of live) {
    for (const p of s.fm.surfaces ?? []) guardedPaths.add(p);
    for (const p of codeSurfacePaths(s.body)) guardedPaths.add(p);
  }
  const allBodies = live.map((s) => s.body).join('\n');

  const cronDir = 'apps/web/src/app/api/cron';
  const cronRoutes = existsSync(join(ROOT, cronDir))
    ? readdirSync(join(ROOT, cronDir), { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(ROOT, cronDir, d.name, 'route.ts')))
        .map((d) => d.name)
    : [];
  // A cron route counts as specced when a spec names its file OR its route path
  // — the manifest-driven specs cite `/api/cron/<name>`, not the handler file.
  const orphanCrons = cronRoutes.filter(
    (name) =>
      !guardedPaths.has(`${cronDir}/${name}/route.ts`) && !allBodies.includes(`/api/cron/${name}`),
  );

  const modules = [
    ...listFiles('apps/runner/src', (f) => f.endsWith('.ts')),
    ...listFiles('packages/core', (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
  ];
  const orphanModules = modules.filter((m) => !guardedPaths.has(m));

  const total = cronRoutes.length + modules.length;
  const guarded = total - orphanCrons.length - orphanModules.length;
  return { guarded, total, orphanCrons, orphanModules };
}

// ─── Index generation ────────────────────────────────────────────────────────

function buildIndex(specs: SpecFile[]): string {
  const line = (s: SpecFile) => {
    const title = s.fm.title ?? s.slug;
    const verified = s.fm.last_verified ? ` — verified ${s.fm.last_verified}` : '';
    const owner = s.fm.owner ? ` · @${s.fm.owner}` : '';
    const summary = s.fm.summary ? `\n  ${s.fm.summary}` : '';
    return `- [${title}](./${s.file})${owner}${verified}${summary}`;
  };
  const group = (status: string) => specs.filter((s) => s.fm.status === status);

  /** Active specs, grouped by domain, so the index reads as a map of the system. */
  const byDomain = (items: SpecFile[]): string[] => {
    const domains = [...new Set(items.map((s) => s.fm.domain ?? 'unfiled'))].sort();
    const out: string[] = [];
    for (const d of domains) {
      const inDomain = items.filter((s) => (s.fm.domain ?? 'unfiled') === d);
      out.push(`### ${d} (${inDomain.length})`, '', ...inDomain.map(line), '');
    }
    return out;
  };

  const active = group('active');
  const draft = group('draft');
  const superseded = group('superseded');

  const out: string[] = [
    '<!-- GENERATED by scripts/check-specs.ts — do not edit by hand. -->',
    '# Spec Index',
    '',
    'Living capability contracts for buildd. Format: [SPEC-FORMAT.md](./SPEC-FORMAT.md).',
    'Canonical source of truth is [../SPEC.md](../SPEC.md); these are per-capability contracts.',
    '',
    `## Active (${active.length})`,
    '',
    ...(active.length ? byDomain(active) : ['_none_', '']),
    `## Draft (${draft.length})`,
    '',
    ...(draft.length ? draft.map(line) : ['_none_']),
    '',
    `## Superseded (${superseded.length})`,
    '',
    ...(superseded.length
      ? superseded.map((s) => `${line(s)} → replaced by \`${s.fm.superseded_by ?? '?'}\``)
      : ['_none_']),
    '',
  ];
  return out.join('\n');
}

// ─── Run ─────────────────────────────────────────────────────────────────────
// Guarded so `check-specs.test.ts` can import the checkable units above without
// running the lint (and calling process.exit) on import — same shape as sync-crons.ts.

if (import.meta.main) {
const specs = loadSpecs();
const crossErrors = crossChecks(specs);

// Symbol liveness: one batched git grep for every claim in the corpus.
//
// Status decides the severity, because status decides what a symbol name MEANS:
//   * superseded — skipped entirely. These are history; their symbols are
//     supposed to be gone.
//   * draft — warning. A draft describes a design that is not built yet, so
//     naming a symbol that does not exist is the normal, correct state (see
//     mission-structure-view.md, which specifies a contention-edge prop for an
//     unshipped feature). Erroring here would punish specs for being drafts and
//     pressure authors to either de-backtick honest design or promote the spec
//     to active before the code lands.
//   * active — error. An active spec claims to describe what IS, so a symbol
//     that resolves nowhere is a stale claim.
{
  const live = specs.filter((s) => s.fm.status !== 'superseded');
  const claims = new Map<SpecFile, string[]>(live.map((s) => [s, claimedSymbols(s.body)]));
  const dead = resolveSymbols([...new Set([...claims.values()].flat())]);
  for (const [spec, syms] of claims) {
    for (const sym of syms) {
      if (!dead.has(sym)) continue;
      const msg = `names \`${sym}\`, which exists nowhere in the tracked source tree`;
      if (spec.fm.status === 'draft') spec.warnings.push(`${msg} — expected for a draft, but it cannot be verified`);
      else spec.errors.push(`${msg} — the claim is stale`);
    }
  }
}

let errorCount = crossErrors.length;
let warnCount = 0;

for (const s of specs) {
  for (const e of s.errors) {
    console.error(`✖ ${s.file}: ${e}`);
    errorCount++;
  }
  for (const w of s.warnings) {
    console.warn(`⚠ ${s.file}: ${w}`);
    warnCount++;
  }
}
for (const e of crossErrors) console.error(`✖ ${e}`);

// INDEX.md handling
const nextIndex = buildIndex(specs);
const currentIndex = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
if (checkOnly) {
  if (nextIndex.trim() !== currentIndex.trim()) {
    console.error('✖ docs/specs/INDEX.md is stale — run `bun run specs:check` to regenerate');
    errorCount++;
  }
} else if (nextIndex.trim() !== currentIndex.trim()) {
  writeFileSync(INDEX_FILE, nextIndex);
  console.log('✎ regenerated docs/specs/INDEX.md');
}

// Coverage is reported, never fatal: an unspecced module is a backlog item, not
// a broken build, and failing here would block every PR that adds a file.
// It is deliberately kept OUT of INDEX.md — a repo-derived number in a generated
// file would make INDEX stale on unrelated changes.
const cov = surfaceCoverage(specs);
console.log(
  `\nsurface coverage: ${cov.guarded}/${cov.total} high-value modules named by a live spec`,
);
if (cov.orphanCrons.length)
  console.log(`  cron routes with no spec (${cov.orphanCrons.length}): ${cov.orphanCrons.join(', ')}`);
if (cov.orphanModules.length) {
  const show = process.argv.includes('--orphans');
  console.log(
    `  unspecced modules: ${cov.orphanModules.length}${show ? '' : ' (--orphans to list)'}`,
  );
  if (show) for (const m of cov.orphanModules) console.log(`    · ${m}`);
}

console.log(
  `\n${specs.length} specs · ${errorCount} error(s) · ${warnCount} warning(s)`,
);
process.exit(errorCount > 0 ? 1 : 0);
}
