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
 * Beyond hygiene, four checks test whether a spec is TRUE, not just well-formed:
 *   - symbol liveness: every backticked code symbol a spec names must exist
 *   - route liveness:  every backticked `/api/...` URL must resolve to a route.ts
 *   - verified_by:     an `active` spec must name the tests asserting its invariants
 *   - surface coverage: reports high-value modules no live spec claims (advisory)
 *
 * Deliberately NOT a check: "code newer than last_verified". Measured on this
 * corpus it flags 20 of 21 specs, because the hot files churn daily — a gate
 * that always fires teaches people to ignore it.
 *
 * Exit codes:
 *   0  clean (warnings allowed)
 *   1  one or more CONTENT errors (missing frontmatter, dead code-surface path,
 *      dead route URL in an `active` spec, duplicate active slug,
 *      superseded-without-successor) — a human judgment call, not fixable by
 *      just re-running the generator
 *   2  --check only, and the ONLY problem is a stale docs/specs/INDEX.md — pure
 *      mechanical drift that `bun run specs:check` fixes with no judgment call.
 *      Distinguished from 1 so a caller consuming this exit code (the runner's
 *      provisioning gate, apps/runner/src/env-verify.ts) can treat 2 as
 *      advisory — proceed, don't kill the worker — without also waving through
 *      a real spec error, which still exits 1 regardless of index staleness.
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
import {
  buildSpecIndex,
  codeSurfacePaths,
  crossCheckSpecs,
  lintSpecFile,
  parseSpecFrontmatter,
  SPEC_META_FILES,
  type SpecFrontmatter,
} from '../packages/spec-contract/src/repo-spec';

// The per-file rules, the parser and the index builder live in
// packages/spec-contract/src/repo-spec.ts so buildd runs the same functions on a
// generated repo copy before approval (docs/specs/living-specs.md §18, R-34).
export { codeSurfacePaths };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SPECS_DIR = join(ROOT, 'docs/specs');
const INDEX_FILE = join(SPECS_DIR, 'INDEX.md');

// Meta files that live in docs/specs/ but are not capability specs.
const META_FILES = SPEC_META_FILES;

const checkOnly = process.argv.includes('--check');

type Frontmatter = SpecFrontmatter;

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
  'codex-backend-spec',
  'db-migration-gates',
  'external-cron-triggers',
  'knowledge-store-retrieval',
  'mcp-connectors-and-roles',
  'mission-task-lifecycle',
  'provider-failover',
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

// ─── Load specs ──────────────────────────────────────────────────────────────

interface SpecFile {
  file: string;
  slug: string;
  fm: Frontmatter;
  body: string;
  errors: string[];
  warnings: string[];
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

// ─── Route-URL liveness ──────────────────────────────────────────────────────
//
// `codeSurfacePaths` checks FILE paths and `claimedSymbols` checks identifiers.
// Nothing checked the third kind of claim a spec makes: an endpoint URL in prose.
// mcp-connectors-and-roles.md asserted two routes as "(existing)" — a probe
// endpoint and a per-workspace enable/disable PATCH — and neither had ever been
// built. An agent reading that spec believes it may call them, so it does not
// build them, and the lie survives every gate. Route URLs are now resolved the
// same way symbols are.

/**
 * URL-shaped tokens. Deliberately greedy over placeholder punctuation
 * (`[id]`, `{wsId}`, `<ws>`, `${id}`, `*`) because every one of those spellings
 * occurs in the corpus, and a truncated URL resolves against nothing.
 */
const API_URL_RE = /\/api\/[A-Za-z0-9_\-/[\].$:<>*{}]*/g;

/** A route directory that matches one segment: `[id]`, `[workspaceId]`. */
const DIR_DYNAMIC = /^\[[^\]]+\]$/;
/** `[...slug]` — one or more segments. Always the last segment of a route. */
const DIR_CATCH_ALL = /^\[\.\.\.[^\]]+\]$/;
/** `[[...slug]]` — zero or more segments. */
const DIR_OPT_CATCH_ALL = /^\[\[\.\.\..+\]\]$/;

/**
 * Spellings a spec uses for "an id goes here". The parameter NAME is not the
 * contract — a spec may write `[wsId]` where the directory is `[workspaceId]`,
 * and that must resolve. Single capitals are included because the corpus uses
 * `/api/missions/M/artifacts` style stand-ins in acceptance criteria.
 */
function isParamPlaceholder(seg: string): boolean {
  return (
    /^\[.*\]$/.test(seg) || // [id], [...slug]
    /^\$?\{.*\}$/.test(seg) || // ${id}, {workspaceId}
    /^<.*>?$/.test(seg) || // <ws>, and `<old token>` truncated at the space
    /^:.+$/.test(seg) || // :id
    /^[A-Z]\d*$/.test(seg) // M, W, X2
  );
}

/** `*` in `/api/cron/*` — matches any one route segment, literal or dynamic. */
const WILDCARD = '*';

/**
 * Normalize one raw token into a comparable URL, or null if it is not a URL
 * claim at all. A `.ts` path is a file — `codeSurfacePaths` owns those, and
 * treating them as URLs would flag every `route.ts` citation in the corpus.
 */
function normalizeApiUrl(token: string): string | null {
  let u = token.split('?')[0].split('#')[0];
  u = u.replace(/:\d+(-\d+)?$/, ''); // `route.ts:45`, `route.ts:15-46`
  for (;;) {
    const last = u.at(-1);
    if (!last) break;
    if ('.,;:)\'"`/'.includes(last)) {
      u = u.slice(0, -1);
      continue;
    }
    // Strip a closing bracket only when it closes nothing — `…/[id])` yes,
    // `…/[id]` no. Same for `>` so `<workspace>` survives intact.
    const unbalanced = (open: string, close: string) =>
      (u.match(new RegExp(`\\${open}`, 'g')) ?? []).length <
      (u.match(new RegExp(`\\${close}`, 'g')) ?? []).length;
    if (last === ']' && unbalanced('[', ']')) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === '>' && unbalanced('<', '>')) {
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(u)) return null; // a file, not a URL
  if (u === '/api' || u === '') return null; // bare namespace root, says nothing
  return u;
}

/**
 * Every `/api/...` URL a spec body claims.
 *
 * Backticks are the signal, exactly as they are for symbols (SPEC-FORMAT rule
 * 7): a URL inside inline code or a fenced block is a claim that the endpoint
 * is live, and prose is not. That is what makes it possible to say a route is
 * NOT implemented — write the path as plain text and the linter stays out of
 * it. Scanning bare prose instead would make the honest statement unwritable
 * and push authors to delete the requirement, which is the worse outcome.
 */
export function claimedApiRoutes(body: string): string[] {
  const out = new Set<string>();
  const spans = [...body.matchAll(/```[\s\S]*?```/g), ...body.matchAll(/`[^`\n]+`/g)];
  for (const span of spans) {
    for (const m of span[0].matchAll(API_URL_RE)) {
      const u = normalizeApiUrl(m[0]);
      if (u) out.add(u);
    }
  }
  return [...out];
}

function segmentsOf(url: string): string[] {
  return url.split('/').filter(Boolean);
}

/**
 * Does `spec` name exactly this route? Strict in one direction on purpose: a
 * LITERAL spec segment must match a LITERAL directory. Letting a literal fall
 * through to `[id]` is what hid `/api/connectors/probe` — Next.js would route
 * that request to the `[id]` handler, so a lenient matcher calls it live while
 * the endpoint the spec describes does not exist.
 */
function matchesRoute(spec: string[], route: string[]): boolean {
  let i = 0;
  for (let j = 0; j < route.length; j++) {
    const r = route[j];
    if (DIR_OPT_CATCH_ALL.test(r)) return true; // eats 0+, always last
    if (DIR_CATCH_ALL.test(r)) return spec.length - i >= 1; // eats 1+, always last
    if (i >= spec.length) return false;
    const s = spec[i++];
    if (s === WILDCARD) continue;
    if (DIR_DYNAMIC.test(r)) {
      if (!isParamPlaceholder(s)) return false;
      continue;
    }
    if (isParamPlaceholder(s)) return false;
    if (s !== r) return false;
  }
  return i === spec.length;
}

let routeTableCache: string[][] | null = null;

/**
 * Every HTTP path this repo serves, as segment arrays.
 *
 * Two sources, one table, because one matcher is easier to trust than two:
 *   - the Next.js app-router tree (route groups `(protected)` contribute no
 *     segment, per app-router semantics)
 *   - literal `/api/...` paths registered by the runner's own local server,
 *     which is a Bun `switch`, not a file tree. Without these a spec citing
 *     `/api/doctor` would be flagged as fabricated.
 *
 * Known limitation: the table does not record WHICH server owns a path, so a
 * spec that attributes a runner-local path to the web app still passes. It
 * catches the failure that actually happened — a route nobody serves at all.
 */
export function apiRouteTable(): string[][] {
  if (routeTableCache) return routeTableCache;
  const table: string[][] = [];

  const walk = (dir: string, segs: string[]) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (d.isDirectory()) {
        walk(join(dir, d.name), /^\(.*\)$/.test(d.name) ? segs : [...segs, d.name]);
      } else if (d.name === 'route.ts' || d.name === 'route.tsx') {
        table.push(segs);
      }
    }
  };
  walk(join(ROOT, 'apps/web/src/app'), []);

  const runnerSrc = join(ROOT, 'apps/runner/src');
  const walkFiles = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walkFiles(p);
      else if (/\.tsx?$/.test(d.name)) {
        let text: string;
        try {
          text = readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        for (const m of text.matchAll(/['"`](\/api\/[^'"`\s$]*)['"`]/g)) {
          table.push(segmentsOf(m[1]));
        }
      }
    }
  };
  walkFiles(runnerSrc);

  routeTableCache = table;
  return table;
}

/**
 * `route`      — a handler serves exactly this path.
 * `namespace`  — the path is a proper prefix of real routes (`/api/cron`,
 *                `/api/.well-known`). Prose legitimately names a family, so
 *                this is resolved, not reported: three active specs do it.
 * `null`       — nothing in the repo serves this path or anything under it.
 */
export function resolveApiRoute(
  url: string,
  table: string[][] = apiRouteTable(),
): 'route' | 'namespace' | null {
  const spec = segmentsOf(url);
  if (spec.length === 0) return null;
  if (table.some((r) => matchesRoute(spec, r))) return 'route';
  if (table.some((r) => r.length > spec.length && matchesRoute(spec, r.slice(0, spec.length))))
    return 'namespace';
  return null;
}

function loadSpecs(): SpecFile[] {
  const files = readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith('.md') && !META_FILES.has(f))
    .sort();

  return files.map((file) => {
    const raw = readFileSync(join(SPECS_DIR, file), 'utf8');
    const { fm, body } = parseSpecFrontmatter(raw);
    const slug = file.replace(/\.md$/, '');
    const { errors, warnings } = lintSpecFile(slug, fm, body, {
      domains: DOMAINS,
      exists: (p) => existsSync(join(ROOT, p)),
      verifiedByDebt: VERIFIED_BY_DEBT,
    });
    return { file, slug, fm: fm ?? {}, body, errors, warnings };
  });
}

// ─── Cross-file checks ───────────────────────────────────────────────────────

const crossChecks = (specs: SpecFile[]): string[] => crossCheckSpecs(specs);

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

const buildIndex = (specs: SpecFile[]): string => buildSpecIndex(specs);

/**
 * Exit code for the CLI — see the "Exit codes" doc comment at the top of this
 * file. Pure so it is unit-testable without spawning the script or touching
 * docs/specs/ (the run block below is guarded by `import.meta.main` and reads
 * the real filesystem, neither of which this needs).
 */
export function checkSpecsExitCode(contentErrorCount: number, indexStale: boolean): number {
  if (contentErrorCount > 0) return 1;
  return indexStale ? 2 : 0;
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

// Route-URL liveness: same status ladder as symbols, for the same reason.
// `active` claims what IS, so an endpoint nobody serves is an error; a `draft`
// legitimately describes routes that are not built yet, so it warns.
//
// No grandfather set. Measured on the corpus at the time this landed, exactly
// two active-spec URLs failed — both in mcp-connectors-and-roles.md, both
// fabricated "(existing)" endpoints — and both were corrected in the same
// change. VERIFIED_BY_DEBT exists because 18 specs could not be fixed at once;
// two could, so grandfathering here would only preserve a lie.
{
  const live = specs.filter((s) => s.fm.status !== 'superseded');
  let urlsSeen = 0;
  for (const spec of live) {
    for (const url of claimedApiRoutes(spec.body)) {
      urlsSeen++;
      if (resolveApiRoute(url)) continue;
      const msg = `claims route \`${url}\`, which no route.ts in apps/web/src/app (nor the runner's local server) serves`;
      if (spec.fm.status === 'draft')
        spec.warnings.push(`${msg} — expected for a draft, but it cannot be verified`);
      else spec.errors.push(`${msg} — the endpoint does not exist`);
    }
  }
  // A check that measures nothing passes forever. If extraction ever silently
  // stops matching (a regex edit, a corpus-wide reformat), fail loudly rather
  // than reporting a clean corpus.
  if (live.length > 0 && urlsSeen === 0)
    crossErrors.push(
      `route-URL check extracted 0 \`/api/...\` URLs from ${live.length} live spec(s) — it measured nothing; the gate is not wired`,
    );
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

// Snapshot before the INDEX.md check below adds to errorCount, so the exit
// code can tell "a real content problem" apart from "just the generated index".
const contentErrorCount = errorCount;

// INDEX.md handling
const nextIndex = buildIndex(specs);
const currentIndex = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
let indexStale = false;
if (checkOnly) {
  if (nextIndex.trim() !== currentIndex.trim()) {
    console.error('✖ docs/specs/INDEX.md is stale — run `bun run specs:check` to regenerate');
    errorCount++;
    indexStale = true;
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
process.exit(checkSpecsExitCode(contentErrorCount, indexStale));
}
