/**
 * Core vs module classification, and the core→module import scan behind
 * `scripts/module-boundaries.test.ts`.
 *
 * Buildd's coordination loop (create task → claim → run → report → PR → merge)
 * is the *core*. Everything else (missions, reviews, releases, knowledge,
 * notifications, chat, experiments, ...) is a *module*. The direction rule is:
 * core never imports a module; modules attach through hook points core declares.
 * Today core does import modules, hundreds of times. The baseline JSON freezes
 * those edges so the count can only fall.
 *
 * The classifier is a path-regex list, ordered: the first rule whose pattern
 * matches the file's path names its module, and a file no rule matches is core.
 * It is heuristic on purpose. Its job is to stop drift, not to be a perfect
 * audit, so a misfiled file is fixed by editing a rule in review.
 *
 *   bun scripts/module-boundaries.ts            # print counts
 *   bun scripts/module-boundaries.ts --prune    # drop baseline entries that no longer exist
 *
 * `--prune` only ever removes. A new core→module import is fixed by not adding
 * it (emit an event, move the file, or move the logic into core), never by
 * adding a line to the baseline by hand.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export type ModuleId =
  | 'workspace-migration' | 'intake-integrations' | 'connectors' | 'spec-conformance' | 'visual-qa'
  | 'onboarding' | 'experiments' | 'jev-decisions' | 'chat' | 'releases' | 'missions' | 'knowledge'
  | 'notifications' | 'schedules' | 'roles-skills' | 'reviews-merge' | 'health-quality' | 'model-tiers';

/** Ordered. First match wins; no match means core. Matched against '/' + repo-relative path. */
export const MODULE_RULES: ReadonlyArray<readonly [ModuleId, RegExp]> = [
  ['workspace-migration', /\/migrate\/|migration-slot|workspace-migration|migrate-access|migration-(inspector|outcomes|safety)/],
  ['intake-integrations', /linear|\/webhooks\/ingest|subject-intake/],
  ['connectors', /\/connectors|connector-|mcp-connector|required-connectors|cross-app|assertion/],
  ['spec-conformance', /spec-(conformance|discrepancy|doc-fix|recheck)|discrepanc|doc-fix/],
  ['visual-qa', /visual-(qa|review|audit|fix)|surface-audit|mcp-visual-review|page-source/],
  ['onboarding', /onboarding|workspace-readiness|\/readiness\//],
  ['experiments', /prompt-evals|experiment|readout|shadow-harness|health-experiments|\/api\/experiments|tier-explore/],
  ['jev-decisions', /decision|recoverable-blocker|prompted-decision|\/api\/decisions|question-gate-decision|strand-choice|inference-(client|route|policy|key)|\/api\/inference-keys|model-inference/],
  ['chat', /\/chat|chat-|conversation-title|\/api\/ai\/|\/lib\/ai\/|\/share\//],
  ['releases', /(?<!path-claim-)release|\/api\/deploy-identity|health-watcher-vercel|deploy-identity/],
  ['missions', /(?<!per)mission|initiative|heartbeat-(triage|prepass|wait|circuit)|approve-plan|goal-criteri|criteria-|orchestrat|loop-(dispatcher|webhook|config)|mission-loop|plan-first|surface-ordering|change-intent|action-queue|action-card|action-events|coordination-intent|subject-(intake|sweep|anchor|gate-contract)/],
  ['knowledge', /knowledge|memory|evidence|linked-knowledge|retrieval|feedback-digest|\/api\/feedback|recall|learn|embed|entity-|scip|prior-work|insight/],
  // `presence-token` is the agent plugin hooks' auth credential (core), not chat/notification presence.
  ['notifications', /notif|pushover|away-delivery|subscription|watch-|watched-project|artifact-notify|presence(?!-token)|stall-notify|connector-block-notify|personal-workspace-links/],
  ['schedules', /schedule/],
  ['roles-skills', /role-(config|colors|outcomes|tool-scope|routing|env)|default-roles|effective-roles|task-role|delegate-options|\/api\/roles|\/skills|role-gate|skill-and-role|role-model-routing|\/team\//],
  ['reviews-merge', /reviewer-evidence|(?<!p)review|merge-policy|auto-merge|pr-landing|landing-action|ci-red|ci-failure|ci-retry|ci-drift|ci-gate|ci-lifecycle|ci-job-log|failed-checks|conflict-retry|dead-zone|dead-pr|supersession|pr-re-review|stale-approval|pr-lede-correction|pr-activity|dependency-bot|pr-attention|pr-branch-update|base-refresh|pr-scope-reconcile|spec-|discrepanc|doc-fix|migration-collision|\/prs\//],
  ['health-quality', /(?<!credential-)health|post-session|quality-scout|scout-capabilit|failure-|error-pattern|error-traces|explain|insights|(?<!runner-)usage-|gate-analytics|coordination-stats|\/stats|spend-summary|fleet-view|queue-stall|mission-invariant|role-outcomes|cron-health|routing-calibration|routing-analytics|silent-completion|stranded|pacing-stall|workspace-error-traces|subagent-time|scheduling-metrics|model-quality|\/admin|platform-admin|task-category|dispatch-health|signal-registry|derived-metric|terminal-record|friction|bash-failure-trace/],
  ['model-tiers', /tier-|model-tier|\/settings\/models\/|\/api\/model-tiers|tier-weights|openrouter-rankings|litellm/],
];

export type Owner = ModuleId | 'core';

/** Core run-record helpers whose names also match broader module heuristics. */
const CORE_RUN_RECORD_FILES: ReadonlySet<string> = new Set([
  'packages/core/bash-failure-trace.ts',
  'apps/web/src/app/app/(protected)/tasks/[id]/error-evidence.ts',
  // The team credential policy (teams.credentialPolicy): it governs agent runs
  // and every provider (packages/core/providers/policy.ts), not just decision
  // and inference calls, so `inference-(…policy…)` misfiles it.
  'packages/core/inference-key-policy.ts',
]);

export function moduleOf(path: string): Owner {
  if (CORE_RUN_RECORD_FILES.has(path)) return 'core';
  const q = '/' + path;
  for (const [id, re] of MODULE_RULES) if (re.test(q)) return id;
  return 'core';
}

/**
 * Files allowed to import any module: the place modules are wired into core.
 * Core code reaches modules only through hook points; this list is where the
 * hooks are filled. Keep it short.
 */
export const COMPOSITION_ROOTS: ReadonlySet<string> = new Set<string>([
  // Core-event subscribers (lib/core-events.ts); core emits, this lists who reacts.
  'apps/web/src/modules.ts',
]);

const SCAN_ROOTS = ['apps/web/src', 'packages/core', 'packages/shared/src'];
const EXCLUDED = /(^|\/)(node_modules|__tests__|tests|__fixtures__)\/|^packages\/core\/drizzle\/|\.(test|spec)\.tsx?$|\.d\.ts$|[Ff]ixtures?\.tsx?$|fake-db/;

/** Runtime source files the guard polices (tests, fixtures and migrations excluded). */
export function scannedFiles(cwd = process.cwd()): string[] {
  const out = spawnSync('git', ['ls-files', '--', ...SCAN_ROOTS], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split('\n').filter(f => /\.tsx?$/.test(f) && !EXCLUDED.test(f));
}

// `import x from '...'`, `import '...'`, `export ... from '...'`. Group 1 = `type ` when type-only.
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Runtime import specifiers in a source file. Type-only imports are erased at build and do not count. */
export function runtimeSpecifiers(src: string): string[] {
  const specs: string[] = [];
  for (const m of src.matchAll(STATIC_IMPORT)) if (!m[1]) specs.push(m[2]!);
  for (const m of src.matchAll(DYNAMIC_IMPORT)) specs.push(m[1]!);
  return specs;
}

export function resolveSpecifier(spec: string, from: string, files: ReadonlySet<string>): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = 'apps/web/src/' + spec.slice(2);
  else if (spec === '@buildd/core') base = 'packages/core/index';
  else if (spec.startsWith('@buildd/core/')) base = 'packages/core/' + spec.slice('@buildd/core/'.length);
  else if (spec === '@buildd/shared') base = 'packages/shared/src/index';
  else if (spec.startsWith('@buildd/shared/')) base = 'packages/shared/src/' + spec.slice('@buildd/shared/'.length);
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec));
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base.replace(/\.js$/, '.ts')]) {
    if (files.has(c)) return c;
  }
  return null;
}

export type Layer = 'backend' | 'ui';
/** UI = React files (.tsx). Pages, layouts and components all land here; routes and libs are backend. */
export function layerOf(path: string): Layer {
  return path.endsWith('.tsx') ? 'ui' : 'backend';
}

/** `{ backend: { importer: { imported: module } }, ui: {...} }`, both levels sorted. */
export type Baseline = Record<Layer, Record<string, Record<string, ModuleId>>>;

export function scanCoreToModuleEdges(cwd = process.cwd()): Baseline {
  const files = scannedFiles(cwd);
  const set = new Set(files);
  const found: Baseline = { backend: {}, ui: {} };
  for (const f of files) {
    if (moduleOf(f) !== 'core' || COMPOSITION_ROOTS.has(f)) continue;
    const src = readFileSync(join(cwd, f), 'utf8');
    for (const spec of runtimeSpecifiers(src)) {
      const to = resolveSpecifier(spec, f, set);
      if (!to) continue;
      const owner = moduleOf(to);
      if (owner === 'core') continue;
      ((found[layerOf(f)][f] ??= {}))[to] = owner;
    }
  }
  return sortBaseline(found);
}

export function sortBaseline(b: Baseline): Baseline {
  const sortObj = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]!]));
  return {
    backend: sortObj(Object.fromEntries(Object.entries(b.backend).map(([k, v]) => [k, sortObj(v)]))),
    ui: sortObj(Object.fromEntries(Object.entries(b.ui).map(([k, v]) => [k, sortObj(v)]))),
  };
}

export function pairs(b: Baseline, layer: Layer): string[] {
  return Object.entries(b[layer]).flatMap(([from, tos]) => Object.keys(tos).map(to => `${from} -> ${to}`));
}

export const BASELINE_PATH = 'scripts/module-boundaries.baseline.json';

export function readBaseline(cwd = process.cwd()): Baseline {
  return JSON.parse(readFileSync(join(cwd, BASELINE_PATH), 'utf8')) as Baseline;
}

/** Baseline minus entries the scan no longer finds. Never adds. */
export function prune(baseline: Baseline, current: Baseline): Baseline {
  const out: Baseline = { backend: {}, ui: {} };
  for (const layer of ['backend', 'ui'] as const) {
    for (const [from, tos] of Object.entries(baseline[layer])) {
      for (const [to, mod] of Object.entries(tos)) {
        if (current[layer][from]?.[to]) ((out[layer][from] ??= {}))[to] = mod;
      }
    }
  }
  return sortBaseline(out);
}

if (import.meta.main) {
  const current = scanCoreToModuleEdges();
  if (process.argv.includes('--prune')) {
    const next = prune(readBaseline(), current);
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
  }
  const b = readBaseline();
  console.log(`baseline: backend ${pairs(b, 'backend').length}, ui ${pairs(b, 'ui').length}`);
  console.log(`current:  backend ${pairs(current, 'backend').length}, ui ${pairs(current, 'ui').length}`);
}
