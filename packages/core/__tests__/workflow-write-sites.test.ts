/**
 * Write-site guard for the workflow state kernel
 * (docs/specs/workflow-state-kernel.md §7.6, S14, AC-7): only
 * the kernel (apps/web/src/lib/workflow/ and its pure core,
 * packages/workflow-kernel/src/) touches the workflow_* tables and
 * trunk_incidents. Everything else reaches them through `ingestFact` /
 * `applyCommand`, so no sweep, route or reaper can assign delivery state.
 *
 * Blocking mode (Slice F, §13.10): the allowlist is empty. The scan covers
 * every deployed module (apps, packages, scripts), tests excluded by the same
 * rule as `pr-fact-write-sites.test.ts`, and it flags table ACCESS: raw SQL
 * that reads or writes a kernel table, and a Drizzle query builder handed one
 * of its table objects. A declaration is not access, so the schema needs no
 * exemption: `pgTable('workflow_deliveries', …)`, an FK `references(() => …)`
 * and `typeof workflowDeliveries.$inferSelect` name a table without touching it.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { offendingSites, taskStatusSites } from './_write-site-scan';

const repo = join(import.meta.dir, '../../..');
const tracked = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'], { cwd: repo })
  .stdout.toString()
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));
/** Deployed source: tests are not write sites (same rule as the PR fact guard). */
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || /__tests__\//.test(f) || /(^|\/)tests\//.test(f);
const files = tracked.filter((f) => !isTest(f));

const KERNEL_DIR = 'apps/web/src/lib/workflow/';
/** The kernel's pure core (docs/specs/workflow-kernel-library.md §2), re-exported by shims under KERNEL_DIR. */
const KERNEL_PACKAGE_DIR = 'packages/workflow-kernel/src/';
const KERNEL_DIRS = [KERNEL_DIR, KERNEL_PACKAGE_DIR];
const inKernel = (f: string) => KERNEL_DIRS.some((dir) => f.startsWith(dir));
/** Slice F: empty. A module outside the kernel that needs a kernel table goes through the kernel. */
const ALLOWED = new Set<string>();

/**
 * S14: routes, sweeps and the reaper reach the kernel only through its route
 * API (seam.ts), the kill switch (authority.ts) and the live reader
 * (github-facts.ts); the composition root alone wires the effect handlers.
 * None of them imports the reducer, the CAS runner or the fact funnel, so none
 * can assign a delivery state.
 */
// Part 3 adds three, none of which can assign a state either: the read model
// (`projections` is pure, `delivery-view` only SELECTs) and the activity-note
// funnel (`pr-activity-effects` records a fact and enqueues a render, §12.1).
// Slice D adds `delivery-ship`: mission completion's input, a SELECT like `delivery-view`.
// Slice E adds `delivery-display`: the pure, serialisable slice of the read model that
// list surfaces carry to the client. No SQL, no command, so it cannot assign a state.
// `base-delta` is the S15 disjoint-delta rule as pure functions (no I/O, no kernel table): the legacy
// landing door shares it with the reducer so the two cannot drift.
// The visual-review trio is the merge gate's and cron's way in: `visual-review-state` is pure,
// `visual-review-state-load` only SELECTs the integration PR's delivery row (head SHA, state), and
// `visual-review-schedule-run` files audit tasks, never a delivery state. `visual-review-presentation`
// and `visual-review-diagnostics` are pure readings of that state (copy, redaction) with no I/O; `visual-review-policy` is pure config resolution; `visual-review-impact` is the pure
// impact classifier the mission completion gate also asks (the decider is injected; no I/O, no kernel table).
// `pr-display` is the package's PR vocabulary (two types, no code): `pr-presentation` re-exports it so there is one definition.
// S3a (workflow-kernel-library.md §3) adds the single host's way in. `kernel-client` is the one client every door
// submits a command through (it runs the seam's door functions locally or on the control plane, never the reducer);
// `command-api` is the control plane's command endpoint over those same functions and its ledger; `kernel-floor` is
// the drain-and-floor pass both schedules call (seam functions only); `kernel-host` is the host tag (no I/O);
// `command-keys` is the command key ring alone (no I/O), which the control plane's entry reads at load.
const KERNEL_ENTRY_POINTS = new Set(['kernel-client', 'command-api', 'command-keys', 'kernel-floor', 'kernel-host', 'seam', 'authority', 'github-facts', 'projections', 'delivery-view', 'pr-activity-effects', 'delivery-ship', 'delivery-display', 'base-delta', 'visual-review-state', 'visual-review-state-load', 'visual-review-schedule-run', 'visual-review-presentation', 'visual-review-diagnostics', 'visual-review-policy', 'visual-review-impact', 'pr-display',
  // 58c8961e: rounds per merged PR by trigger, for get_failure_analytics. A read-only aggregate, like projections.
  'review-round-metrics',
  // The landing gate's pure answer and the `buildd/landing` context (workflow-kernel-library.md §4): read-only, like projections.
  'landing-gate',
  // S4a: the PR fact funnel's scope for terminal facts (a predicate, no command): the way a funnel caller
  // records a merge or close without deciding it for a delivery-owned row.
  'pr-fact-scope',
  // S4a review: the fast heal's due-queue (kernel-heal.ts). Its tick calls the floor pass for named
  // deliveries (seam functions only), like kernel-floor; it never imports the reducer.
  'kernel-heal',
  // S4b: the one automated mission-completion write, compare-and-set on the mission's delivery records
  // (a fingerprint read and one UPDATE of missions; it reads the epochs and writes no kernel table).
  'mission-completion-write']);
const COMPOSITION_ROOT = 'apps/web/src/modules.ts';
// The package is matched too: importing `@buildd/workflow-kernel/reducer` is importing the reducer, and its
// root (`@buildd/workflow-kernel`, every module at once) reads as `index`, which is no entry point.
const KERNEL_IMPORT = /(?:from\s+|import\()\s*['"](?:(?:@\/lib\/workflow|(?:\.\.?\/)+(?:lib\/)?workflow|@buildd\/workflow-kernel)\/([a-z][a-z/-]*)|@buildd\/workflow-kernel()(?=['"]))['"]/g;

const TABLES = 'workflow_deliveries|workflow_review_rounds|workflow_findings|workflow_facts|workflow_transitions|workflow_effects|workflow_attempts|workflow_commands|workflow_mission_epochs|workflow_scope_amendments|trunk_incidents';
const SYMBOLS = 'workflowDeliveries|workflowReviewRounds|workflowFindings|workflowFacts|workflowTransitions|workflowEffects|workflowAttempts|workflowCommands|workflowMissionEpochs|workflowScopeAmendments|trunkIncidents';
/** Raw SQL that reads or writes a kernel table: FROM, JOIN, INSERT INTO, UPDATE, DELETE FROM, TRUNCATE, ALTER/DROP TABLE. */
const SQL_ACCESS = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TRUNCATE|TABLE)\\s+(?:ONLY\\s+)?(?:(?:"?public"?)\\.)?"?(?:${TABLES})\\b`, 'i');
/** A Drizzle query builder over a kernel table object: db.insert/update/delete/select…from/join(t), db.query.t. */
const DRIZZLE_ACCESS = new RegExp(`(?:\\b(?:insert|update|delete|from|join|leftJoin|rightJoin|innerJoin|fullJoin)\\(\\s*(?:${SYMBOLS})\\b|\\.query\\.(?:${SYMBOLS})\\b)`);

function code(file: string): string {
  return readFileSync(join(repo, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('workflow kernel tables have one writer', () => {
  it('scans a real tree that contains the kernel and the schema', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(`${KERNEL_DIR}kernel.ts`);
    expect(files).toContain(`${KERNEL_PACKAGE_DIR}reducer.ts`);
    expect(files).toContain('packages/core/db/schema.ts');
  });

  it('blocking mode: the allowlist beyond apps/web/src/lib/workflow/ is empty', () => {
    expect([...ALLOWED]).toEqual([]);
  });

  it('no deployed module outside apps/web/src/lib/workflow/ reads or writes a kernel table in SQL', () => {
    const offenders = files.filter((f) => !inKernel(f) && !ALLOWED.has(f) && SQL_ACCESS.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('no deployed module outside apps/web/src/lib/workflow/ queries the Drizzle table objects', () => {
    const offenders = files.filter((f) => !inKernel(f) && !ALLOWED.has(f) && DRIZZLE_ACCESS.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('S14: outside the kernel, only its route API, kill switch and live reader are imported', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (inKernel(f) || ALLOWED.has(f) || !f.startsWith('apps/web/src/')) continue;
      for (const m of code(f).matchAll(KERNEL_IMPORT)) {
        const mod = m[1] || 'index';
        if (!KERNEL_ENTRY_POINTS.has(mod) && f !== COMPOSITION_ROOT) offenders.push(`${f} → workflow/${mod}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the S14 import scan can fail: it sees the route API being imported', () => {
    const hits = files.filter((f) => f.startsWith('apps/web/src/app/api/') && [...code(f).matchAll(KERNEL_IMPORT)].some((m) => m[1] === 'seam'));
    expect(hits.length).toBeGreaterThan(0);
    expect([...`import { reduce } from '@/lib/workflow/reducer';`.matchAll(KERNEL_IMPORT)].map((m) => m[1])).toEqual(['reducer']);
    expect([...`import { reduce } from '@buildd/workflow-kernel/reducer';`.matchAll(KERNEL_IMPORT)].map((m) => m[1])).toEqual(['reducer']);
    expect([...`import { reduce } from '@buildd/workflow-kernel';`.matchAll(KERNEL_IMPORT)].map((m) => m[1] || 'index')).toEqual(['index']);
    // A deep path is seen whole, so it can never slip past as an unmatched import.
    expect([...`import { h } from '@buildd/workflow-kernel/conformance/harness';`.matchAll(KERNEL_IMPORT)].map((m) => m[1])).toEqual(['conformance/harness']);
  });

  it('the guard can fail: it sees the kernel itself, and every access shape', () => {
    expect(SQL_ACCESS.test(code(`${KERNEL_DIR}kernel.ts`))).toBe(true);
    for (const s of [
      'UPDATE workflow_deliveries SET state = $1',
      'insert into "workflow_effects" (kind) values ($1)',
      'DELETE FROM public.workflow_attempts WHERE id = $1',
      'SELECT * FROM workflow_transitions tr JOIN trunk_incidents i ON true',
      'TRUNCATE workflow_facts',
      // Mission deliveries (workflow-kernel-library.md §6) have the same one writer.
      'UPDATE workflow_mission_epochs SET state = $1',
    ]) expect(SQL_ACCESS.test(s)).toBe(true);
    for (const s of [
      'db.update(workflowDeliveries).set({ state: "MERGED" })',
      'db.insert(workflowEffects).values(row)',
      'db.select().from(workflowReviewRounds)',
      'db.query.trunkIncidents.findFirst()',
      'db.insert(workflowMissionEpochs).values(row)',
    ]) expect(DRIZZLE_ACCESS.test(s)).toBe(true);
  });

  it('a declaration is not access: the schema passes without an exemption', () => {
    const schema = code('packages/core/db/schema.ts');
    // It does declare the tables, so a pass here is the access rule, not an empty scan.
    expect(new RegExp(`pgTable\\('(?:${TABLES})'`).test(schema)).toBe(true);
    expect(SQL_ACCESS.test(schema)).toBe(false);
    expect(DRIZZLE_ACCESS.test(schema)).toBe(false);
    for (const s of [
      "export const workflowDeliveries = pgTable('workflow_deliveries', {",
      'deliveryId: uuid(\'delivery_id\').references(() => workflowDeliveries.id)',
      'export type WorkflowDeliveryRow = typeof workflowDeliveries.$inferSelect;',
      "uniqueIndex('workflow_deliveries_owner_unique')",
    ]) expect(SQL_ACCESS.test(s) || DRIZZLE_ACCESS.test(s)).toBe(false);
  });
});

/**
 * S3a (docs/specs/workflow-kernel-library.md §3): every door reaches a kernel command
 * through ONE client, `kernel-client.ts`, which runs it where the kernel is hosted (the
 * control plane in own mode). A door that imports one of these straight from the seam
 * would apply the command on whatever host it runs on. `attemptEnded` (T4) is one too: the
 * worker PATCH, the reaper, a cancel and a reviewer takeover report an attempt's end from the
 * web host, and in own mode only the control plane applies it (AC-9). So is `observeCiFailure`
 * (T10): the red-PR sweep (`cron:ci-red`), the landing path and the check_suite subscriber
 * report a CI failure through `ci-failure-retry.ts`, and only the control plane applies it.
 */
const DOOR_COMMANDS = ['landThroughKernel', 'applyRecommendationThroughKernel', 'policyMergeThroughKernel', 'requestReview', 'requestCiRetry', 'recordSupersession', 'abandonDelivery', 'openKernelDelivery', 'attemptEnded', 'observeCiFailure'];
/** The seam by any path: the alias, or a relative path however deep (`../../src/lib/workflow/seam`). */
const SEAM_SPEC = String.raw`['"](?:@\/lib\/workflow|(?:\.\.?\/)+(?:[\w.-]+\/)*workflow)\/seam(?:\.ts)?['"]`;
/** `import { a, b as c } from '…/seam'`, `const { a } = await import('…/seam')`, `(await import('…/seam')).a`. */
const SEAM_NAMED = new RegExp(String.raw`(?:import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${SEAM_SPEC}|\{([^}]*)\}\s*=\s*await\s+import\(\s*${SEAM_SPEC}\s*\))`, 'g');
const SEAM_MEMBER = new RegExp(String.raw`\(\s*await\s+import\(\s*${SEAM_SPEC}\s*\)\s*\)\s*\.\s*([A-Za-z_$][\w$]*)`, 'g');
/** A name bound to the whole module: `import * as seam from '…/seam'`, `const seam = await import('…/seam')`. */
const SEAM_NAMESPACE = new RegExp(String.raw`(?:import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*${SEAM_SPEC}|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*${SEAM_SPEC}\s*\))`, 'g');
/** `import('…/seam').then((m) => m.a)`. */
const SEAM_THEN = new RegExp(String.raw`import\(\s*${SEAM_SPEC}\s*\)\s*\.then\(\s*\(?\s*([A-Za-z_$][\w$]*)`, 'g');

function seamDoorImports(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(SEAM_NAMED)) {
    for (const part of (m[1] ?? m[2] ?? '').split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  for (const m of src.matchAll(SEAM_MEMBER)) names.push(m[1]);
  const bound = [...src.matchAll(SEAM_NAMESPACE)].map((m) => m[1] ?? m[2]).concat([...src.matchAll(SEAM_THEN)].map((m) => m[1]));
  for (const ns of bound) {
    for (const m of src.matchAll(new RegExp(String.raw`\b${ns.replace(/\$/g, '\\$')}\s*\.\s*([A-Za-z_$][\w$]*)`, 'g'))) names.push(m[1]);
  }
  return [...new Set(names.filter((n) => DOOR_COMMANDS.includes(n)))];
}

/** Files allowed to call a door command on the seam directly, each with its reason. */
const DOOR_DIRECT_ALLOWED: Record<string, string> = {
  // The web-down e2e's own harness: it seeds the delivery itself (as create_pr would) in a process
  // that is neither host, then drives only the control plane over HTTP. Never deployed.
  'apps/web/scripts/control-plane/web-down-callbacks.ts': 'e2e harness seeding a delivery; not a door',
};

describe('S3a: doors submit kernel commands through the one client', () => {
  it('no module outside the kernel imports a door command from the seam', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (inKernel(f) || !f.startsWith('apps/') || DOOR_DIRECT_ALLOWED[f]) continue;
      for (const n of seamDoorImports(code(f))) offenders.push(`${f} → seam.${n}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the scan can fail: it sees every import shape, and the client is what doors use', () => {
    expect(seamDoorImports(`import { kernelLandingView, landThroughKernel, type KernelLanding } from '@/lib/workflow/seam';`)).toEqual(['landThroughKernel']);
    expect(seamDoorImports(`import { requestReview as requestKernelReview } from '@/lib/workflow/seam';`)).toEqual(['requestReview']);
    expect(seamDoorImports(`const { abandonDelivery } = await import('@/lib/workflow/seam');`)).toEqual(['abandonDelivery']);
    expect(seamDoorImports(`const m = deps.x ?? (await import('./workflow/seam')).policyMergeThroughKernel;`)).toEqual(['policyMergeThroughKernel']);
    expect(seamDoorImports(`import { landThroughKernel } from '@/lib/workflow/kernel-client';`)).toEqual([]);
    expect(seamDoorImports(`import * as seam from '@/lib/workflow/seam';\nawait seam.landThroughKernel(x);`)).toEqual(['landThroughKernel']);
    expect(seamDoorImports(`const seam = await import('./workflow/seam');\nseam.requestCiRetry(p); seam.kernelLandingView(a);`)).toEqual(['requestCiRetry']);
    expect(seamDoorImports(`const r = await import('@/lib/workflow/seam').then((m) => m.abandonDelivery(p));`)).toEqual(['abandonDelivery']);
    expect(seamDoorImports(`import { openKernelDelivery } from '../../src/lib/workflow/seam';`)).toEqual(['openKernelDelivery']);
    expect(seamDoorImports(`import { openKernelDelivery } from '../../src/lib/workflow/seam.ts';`)).toEqual(['openKernelDelivery']);
    expect(seamDoorImports(`import { noopEvidenceOf, attemptEnded as workflowAttemptEnded } from '@/lib/workflow/seam';`)).toEqual(['attemptEnded']);
    expect(seamDoorImports(`const { attemptEnded: workflowAttemptEnded } = await import('@/lib/workflow/seam');`)).toEqual(['attemptEnded']);
    expect(seamDoorImports(`import { attemptEnded } from '@/lib/workflow/kernel-client';`)).toEqual([]);
    expect(seamDoorImports(`import { observeCiFailure } from '@/lib/workflow/seam';`)).toEqual(['observeCiFailure']);
    expect(seamDoorImports(`const { observeCiFailure } = await import('@/lib/workflow/seam');`)).toEqual(['observeCiFailure']);
    // Every allowed file still exists and still needs the exception, so the list cannot rot.
    for (const f of Object.keys(DOOR_DIRECT_ALLOWED)) {
      expect(files).toContain(f);
      expect(seamDoorImports(code(f)).length).toBeGreaterThan(0);
    }
    const viaClient = files.filter((f) => !inKernel(f) && /from\s+['"]@\/lib\/workflow\/kernel-client['"]|import\(\s*['"](?:@\/lib\/|\.\/)workflow\/kernel-client['"]\s*\)/.test(code(f)));
    expect(viaClient.length).toBeGreaterThan(5);
  });
});

/**
 * S4a: the delivery-columns write-site guard (docs/specs/workflow-kernel-library.md §1 AC-1, §9).
 *
 * For a delivery-owned task `workers.merged_at` and `workers.pr_lifecycle_status` change only
 * in the kernel transition that changes the delivery: T17 / T18 project the merge or close onto
 * every worker row of the PR inside the transition's own statement (kernel.ts `w_proj`).
 * Everything else is a fact funnel:
 *
 *  - The only SQL that writes those columns is `packages/core/pr-facts.ts` (`recordPrFact`) and
 *    `pr-fact-sql.ts` (the projection fragment the transition embeds). A raw or Drizzle write anywhere else fails here.
 *  - A terminal fact (merged, closed) needs a scope, and scopes are minted only in the kernel
 *    (`apps/web/src/lib/workflow/pr-fact-scope.ts`): `factFunnelScope` keeps a kernel-owned row out
 *    unless its delivery already says the same thing. So a caller records the fact; the reducer
 *    decides. The type requires the scope and the funnel refuses a terminal fact without one.
 *  - Every module outside the kernel that calls the funnel is listed below with its reason, so a
 *    new caller fails naming its file, and a listed caller that stops calling it fails too.
 *
 * Still allowed, and listed here so the debt is visible: the funnel's NON-terminal facts
 * (pr_open, ci_*, conflict, unresolvable) for delivery-owned rows, and every `tasks.status` /
 * `tasks.result` writer. Both are S4b's.
 */
const PR_FACTS = new Set(['packages/core/pr-facts.ts', 'packages/core/pr-fact-sql.ts']);
const WORKERS_COLUMN_DECLARATIONS = new Set<string>([
  // Declares the columns.
  'packages/core/db/schema.ts',
  // The demo stack seeds a scripted timeline into its own local database; never a real PR.
  'scripts/demo/advance.ts',
]);

/** Terminal facts here go under `factFunnelScope`; non-terminal facts are TODO S4b. */
const FUNNEL = 'records PR facts through the funnel; a terminal fact under factFunnelScope (delivery-owned rows take only what their delivery says)';
const FUNNEL_CALLERS: Record<string, string> = {
  'apps/web/src/app/api/github/webhook/route.ts': `${FUNNEL}; CI, conflict and open facts unscoped (TODO S4b). A kernel-owned merge is T17's, reached through observePrState`,
  'apps/web/src/app/api/github/pr/route.ts': `${FUNNEL}: the legacy merge door's receipt`,
  'apps/web/src/app/api/prs/[prNumber]/merge/route.ts': `${FUNNEL}: the dashboard merge door's receipt`,
  'apps/web/src/app/api/admin/backfill-merged-prs/route.ts': 'unresolvable bookkeeping only (non-terminal; TODO S4b)',
  'apps/web/src/lib/dead-pr-shutdown.ts': `${FUNNEL}: the loser of a duplicate PR closes`,
  'apps/web/src/lib/dead-zone-sweep.ts': `${FUNNEL}: the sweep heals a missed merge or close`,
  'apps/web/src/lib/mission-pr.ts': `${FUNNEL}; the open fact unscoped (TODO S4b). The mission PR has no delivery until S6`,
  'apps/web/src/lib/pr-fact-import.ts': `${FUNNEL}: the reconcile script's import`,
  'apps/web/src/lib/pr-merge-stamp.ts': `${FUNNEL}: stampPrMergedOnAllRows, the legacy merge's stamp`,
  // runMergedPrWork stamps only with \`stamp: true\`: the webhook's legacy path. A kernel-owned PR's
  // work runs from the emit_pr_merged effect with \`stamp: false\`, after T17 already projected the rows.
  'apps/web/src/lib/pr-merged-work.ts': `${FUNNEL}: stampPrMergedOnAllRows for a PR the kernel does not own`,
  'apps/web/src/lib/pr-reconcile.ts': `${FUNNEL}; conflict and unresolvable unscoped (TODO S4b)`,
  'apps/web/src/lib/pr-review-request.ts': `${FUNNEL}; the open fact unscoped (TODO S4b)`,
  'apps/web/src/lib/pr-state-refresh.ts': `${FUNNEL}; the CI fact unscoped (TODO S4b). The render read-through itself retires with AC-3`,
  'apps/web/src/lib/register-local-pr.ts': 'the open fact only (non-terminal; TODO S4b)',
  'apps/web/src/lib/worker-pr-slot.ts': 'the open fact only (non-terminal; TODO S4b): the sibling owner row of a second PR from one worker',
  // Cannot import apps/web, so it mints an unscoped scope (below).
  'packages/core/scripts/backfill-mergedat.ts': 'manual operator backfill, run by hand; unscoped. TODO S4b: heal through the kernel floor instead',
};
/** Minting a terminal-fact scope outside the kernel bypasses the delivery check. */
const SCOPE_MINTERS: Record<string, string> = {
  'packages/core/scripts/backfill-mergedat.ts': 'manual operator backfill in @buildd/core, which cannot import the kernel. TODO S4b',
};
const FUNNEL_CALL = /\b(?:recordPrFact|stampPrMergedOnAllRows)\b/;
/** The funnel's SQL builders write the columns: only the funnel and the kernel may run them. */
const FUNNEL_SQL = /\b(?:recordPrFactSql|prFactProjectionSql)\b/;
/** Minting a scope, or borrowing the kernel's own unscoped one (only `stamp_pr_rows` may write past the delivery check). */
const SCOPE_MINT = /\b(?:unscopedPrFactScope|PR_FACT_SCOPE|kernelProjectionScope)\b/;

/**
 * S4b: every `tasks.status` / `tasks.result` writer outside the kernel, each with why it may stay.
 *
 * The delivery's own move of a task's lifecycle is the merge: T17 completes the owner task in its
 * statement (task-projection.ts), and `runMergedPrWork` only reports what it did. What remains
 * here is one of:
 *
 *  - GUARDED: a writer that INFERS where a task's PR went (a merge matched by branch name, the
 *    stale-failure archive, a dependency failure cascading). It skips a delivery-owned task in its
 *    own WHERE (`deliveryOwnedTaskSql`, pr-fact-scope.ts) and keeps today's write for every other
 *    task. The test below pins that each still carries the predicate.
 *  - ATTEMPT: the end or requeue of a worker's own attempt. The kernel reads the end from the
 *    worker row (`ownerAttemptEndOf`: `forwardOwnerEnd` re-sends a finished worker's end even while
 *    the task is still assigned; a requeue is deliberately not an attempt end), but nothing projects
 *    the end back onto the task yet. Skipping these for a delivery-owned task would leave it in
 *    progress after its delivery moved on.
 *  - PERSON: a person's explicit act on the task (or an external tracker acting for one). Not a
 *    delivery fact; the delivery is settled by its own transitions.
 *  - NON_DELIVERY: provably never a delivery-owned task (a task that never started, a release
 *    task, a reviewer task), per the WHERE named.
 *  - NOT_LIFECYCLE: writes `result` keys that are not delivery fields (evidence, shipped record).
 */
const GUARDED = (why: string) => `GUARDED: ${why}; skips a delivery-owned task (deliveryOwnedTaskSql)`;
const ATTEMPT = (why: string) => `ATTEMPT: ${why}; the attempt's own lifecycle, which the kernel reads from the worker row (forwardOwnerEnd, T4)`;
const PERSON = (why: string) => `PERSON: ${why}`;
const NON_DELIVERY = (why: string) => `NON_DELIVERY: ${why}`;
const TASK_STATUS_WRITERS: Record<string, string> = {
  'apps/web/src/lib/pr-merged-legacy-task.ts': `${GUARDED('a merge seen by branch name (completeTaskOnBranchMatchMerge)')}. Its other writer, legacyCompleteTaskOnMerge, runs only for a PR the kernel does not own (the webhook's legacy path, or an emit_pr_merged effect queued before S4b)`,
  'apps/web/src/lib/task-archive.ts': GUARDED('the weekly archive of stale failed tasks; a failed owner whose delivery is still live keeps its status'),
  'apps/web/src/lib/task-dependencies.ts': `${GUARDED('the dependency-failure cascade, for a live delivery')}. Its other writer cancels stale "Aggregate results" children of a planning task, which open no PR`,
  'apps/web/src/app/api/workers/[id]/route.ts': `${ATTEMPT('the worker PATCH: completion snapshot, requeues on budget, mount, auth and codex deferral, mission-budget failure, release outcome')}. The reviewer-verdict writes target the reviewer task. The completion snapshot copies prUrl/prNumber from the worker row, which carries the delivery's PR (TODO S7: derive on read)`,
  'apps/web/src/app/api/workers/claim/route.ts': ATTEMPT('the claim (pending to assigned) and its rollbacks; the repair-attempt defer is the kernel\'s own decision'),
  'apps/web/src/app/api/tasks/cleanup/route.ts': ATTEMPT('a stalled worker: retry-cap failure, requeue, or promotion of a completed worker\'s deliverables'),
  'apps/web/src/lib/stale-workers.ts': ATTEMPT('the reaper: silent start, retry and infra caps, requeue, released interactive leases, expired loop waits, unanswered questions; deliverable promotion already skips a kernel attempt'),
  'apps/web/src/lib/interactive-detach.ts': ATTEMPT('a released interactive session requeues its open task'),
  'apps/web/src/lib/credential-recovery.ts': ATTEMPT('requeue of tasks failed on an auth error once the credential is back'),
  'apps/web/src/lib/github-repo-access-store.ts': ATTEMPT('requeue of a task failed on blocked GitHub access, once access is verified'),
  'apps/web/src/lib/task-recovery-hold.ts': ATTEMPT('a credential hold requeues the task to its probe floor'),
  'apps/web/src/lib/conflict-retry.ts': ATTEMPT('recovery of a stalled conflict-fix attempt task (never the owner)'),
  'apps/web/src/lib/ci-failure-retry.ts': ATTEMPT('CI retries exhausted; for a kernel-owned PR it is the kernel\'s own Escalate effect that calls it (ci-retry-effects.ts), and the legacy callers return early for a kernel PR'),
  'apps/web/src/lib/loop-webhook.ts': ATTEMPT('a loop task\'s exit condition (pr_merged, pr_checks_green) is met: loopState and the status it implies; on a merge T17 already completed the task'),
  'apps/web/src/app/api/tasks/[id]/route.ts': PERSON('PATCH /api/tasks/[id] and update_task; a cancel tells the kernel through the cancel side effects'),
  'apps/web/src/app/api/tasks/bulk/route.ts': PERSON('admin bulk cancel; merges into result, so PR fields survive'),
  'apps/web/src/app/api/tasks/[id]/reassign/route.ts': PERSON('force reassign or retry of a failed task'),
  'apps/web/src/lib/task-pr-attach.ts': PERSON('correct_task_result attaches the PR that delivered a task closed without a worker'),
  'apps/web/src/lib/visual-review-decisions.ts': `${PERSON('a visual-review decision and its undo')}; targets are fix tasks with no worker`,
  'apps/web/src/lib/surface-audit-waiver-cancel.ts': `${PERSON('a recorded surface-audit waiver')}; WHERE pending, unclaimed, no live worker`,
  'apps/web/src/lib/linear-webhook.ts': PERSON('the linked Linear issue was closed'),
  'apps/web/src/app/api/webhooks/ingest/route.ts': PERSON('an external tracker issue closed or reopened'),
  'apps/web/src/app/api/github/webhook/route.ts': `${PERSON('a GitHub issue closed or reopened')}; ${NON_DELIVERY('a release task\'s release PR CI (releaseResult, context.releasePrPending)')}. The branch-name merge match moved to pr-merged-legacy-task.ts`,
  'apps/web/src/app/api/workers/[id]/interrupt/route.ts': NON_DELIVERY('a person takes over from a reviewer: the reviewer task (category review), never the owner; the kernel gets human_takeover (T27)'),
  'apps/web/src/lib/held-pr-tasks.ts': NON_DELIVERY('settles a release task held on its release PR (context.releasePrPending); release PRs never open a delivery'),
  'apps/web/src/lib/mission-surface-audit.ts': NON_DELIVERY('cancels a pending, unclaimed surface audit left with no dependencies'),
  'apps/web/src/lib/quality-scout-actions.ts': NON_DELIVERY('retires a pending, unclaimed scout follow-up'),
  'apps/web/src/lib/supersession-store.ts': NON_DELIVERY('supersession rules bind away from a task with its own live PR (boundFor own_live_pr), and the not-started rules exclude owners'),
  'apps/web/src/lib/task-evidence-store.ts': 'NOT_LIFECYCLE: merges run evidence and mismatch flags into result',
  'apps/web/src/lib/task-shipped-store.ts': 'NOT_LIFECYCLE: merges the "what shipped" display record into result',
  // An operator script scrubbing leaked secrets out of task results.
  'packages/core/scripts/scrub-exposed-secrets.ts': 'NOT_LIFECYCLE: an operator script redacting leaked secrets in result text, run by hand',
};
/**
 * S4b review: no ATTEMPT writer may move a task the kernel finished (completed, its delivery MERGED).
 * A number is how many of the file's statements carry `notKernelMergedTaskSql()` (each statement
 * that can move a task away from completed); a string is why the file's writes cannot.
 */
const ATTEMPT_MERGED_GUARD: Record<string, number | string> = {
  // 9 includes the reactivation (worker resumes from completed): a person's follow-up on a shipped
  // task runs the worker, but the task keeps completed. Kept guarded rather than exempted, so a
  // follow-up that then fails or is requeued can never reopen work that already merged.
  'apps/web/src/app/api/workers/[id]/route.ts': 9,
  'apps/web/src/lib/stale-workers.ts': 8,
  'apps/web/src/app/api/tasks/cleanup/route.ts': 2,
  'apps/web/src/lib/task-recovery-hold.ts': 1,
  'apps/web/src/lib/ci-failure-retry.ts': 1,
  'apps/web/src/app/api/workers/claim/route.ts': "moves only a pending task (WHERE status = 'pending') or rolls back its own assigned claim",
  'apps/web/src/lib/interactive-detach.ts': 'WHERE the task is not terminal: never a completed one',
  'apps/web/src/lib/credential-recovery.ts': "WHERE status = 'failed'",
  'apps/web/src/lib/github-repo-access-store.ts': "WHERE status = 'failed'",
  'apps/web/src/lib/conflict-retry.ts': 'the conflict-fix attempt task, WHERE its status is still the live one it read',
  'apps/web/src/lib/loop-webhook.ts': 'writes completed only',
};

/**
 * AC-1 ratchet: the rest of AC-1 for `tasks.status` (workflow-kernel-library.md §9) moves these
 * ATTEMPT writers behind an attempt-to-task projection one family at a time. Until then each
 * file's count of `tasks.status` / `tasks.result` write statements is pinned here, and the count
 * only goes down: a new ATTEMPT file, or a new statement in one of these, fails CI. Moving a
 * family lowers its number (to 0, then the file leaves TASK_STATUS_WRITERS); never raise one.
 */
const ATTEMPT_SITE_CEILING: Record<string, number> = {
  'apps/web/src/app/api/workers/[id]/route.ts': 13,
  'apps/web/src/app/api/workers/claim/route.ts': 4,
  'apps/web/src/app/api/tasks/cleanup/route.ts': 3,
  'apps/web/src/lib/stale-workers.ts': 11,
  'apps/web/src/lib/interactive-detach.ts': 1,
  'apps/web/src/lib/credential-recovery.ts': 1,
  'apps/web/src/lib/github-repo-access-store.ts': 1,
  'apps/web/src/lib/task-recovery-hold.ts': 1,
  'apps/web/src/lib/conflict-retry.ts': 1,
  'apps/web/src/lib/ci-failure-retry.ts': 1,
  'apps/web/src/lib/loop-webhook.ts': 2,
};

/** The GUARDED writers: each must still carry the delivery-owned predicate. */
const GUARDED_WRITERS = Object.entries(TASK_STATUS_WRITERS).filter(([, why]) => why.startsWith('GUARDED')).map(([f]) => f);

/** S4b: writes of `missions.status = 'completed'` outside the kernel (a person's act only). */
const MISSION_COMPLETERS: Record<string, string> = {};
function missionCompleteSites(src: string): string[] {
  const out: string[] = [];
  const line = (i: number) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/\bupdate\(\s*missions\s*\)/g)) {
    const rest = src.slice(m.index!);
    const end = rest.search(/\.(?:where|returning)\(/);
    const block = rest.slice(0, end > 0 ? end : 1500);
    if (/\bstatus\s*:\s*['"]completed['"]/.test(block)) out.push(`update(missions)@${line(m.index!)}`);
  }
  for (const m of src.matchAll(/UPDATE\s+"?missions"?(?:\s+(?!SET\b)\w+)?\s+SET\b/gi)) {
    const rest = src.slice(m.index!);
    const end = rest.search(/\bWHERE\b/i);
    if (/\bstatus\s*=\s*'completed'/.test(rest.slice(0, end > 0 ? end : 1500))) out.push(`raw UPDATE missions@${line(m.index!)}`);
  }
  return out;
}

describe('S4a: the delivery columns (workers.merged_at, workers.pr_lifecycle_status) move only through the kernel', () => {
  const outside = files.filter((f) => !inKernel(f) && !PR_FACTS.has(f));

  it('no module outside the funnel and the kernel writes the columns in SQL', () => {
    const offenders = outside.filter((f) => !WORKERS_COLUMN_DECLARATIONS.has(f)).flatMap((f) => offendingSites(code(f)).map((s) => `${f} ${s}`));
    expect(offenders).toEqual([]);
  });

  it('every caller of the funnel outside the kernel is listed with its reason', () => {
    const callers = outside.filter((f) => FUNNEL_CALL.test(code(f)));
    expect(callers.filter((f) => !FUNNEL_CALLERS[f])).toEqual([]);
    // The list cannot rot: every entry still exists and still calls the funnel.
    expect(Object.keys(FUNNEL_CALLERS).filter((f) => !callers.includes(f))).toEqual([]);
  });

  it("the funnel's SQL builders run only in the funnel and the kernel", () => {
    expect(outside.filter((f) => FUNNEL_SQL.test(code(f)))).toEqual([]);
  });

  it('a terminal-fact scope is minted only in the kernel', () => {
    const minters = outside.filter((f) => SCOPE_MINT.test(code(f)));
    expect(minters.filter((f) => !SCOPE_MINTERS[f])).toEqual([]);
    expect(Object.keys(SCOPE_MINTERS).filter((f) => !minters.includes(f))).toEqual([]);
    // The kernel mints them where the funnel's callers import them from.
    expect(SCOPE_MINT.test(code(`${KERNEL_DIR}pr-fact-scope.ts`))).toBe(true);
  });

  it('the kernel transition is the writer for a delivery: T17 / T18 project the worker rows in their own statement', () => {
    const kernel = code(`${KERNEL_DIR}kernel.ts`);
    expect(/w_proj AS \(/.test(kernel)).toBe(true);
    expect(/prFactProjectionSql\(/.test(kernel)).toBe(true);
  });

  it('every tasks.status / tasks.result writer outside the kernel is listed with its reason (S4b)', () => {
    const writers = files.filter((f) => !inKernel(f) && taskStatusSites(code(f)).length > 0);
    expect(writers.filter((f) => !TASK_STATUS_WRITERS[f])).toEqual([]);
    expect(Object.keys(TASK_STATUS_WRITERS).filter((f) => !writers.includes(f))).toEqual([]);
    // No entry is left as debt without a reason.
    expect(Object.entries(TASK_STATUS_WRITERS).filter(([, why]) => !/^(GUARDED|ATTEMPT|PERSON|NON_DELIVERY|NOT_LIFECYCLE): /.test(why) || /TODO S4b/.test(why))).toEqual([]);
  });

  it('S4b review: every ATTEMPT writer is covered: it carries notKernelMergedTaskSql, or says why it cannot move a completed task', () => {
    const attempt = Object.entries(TASK_STATUS_WRITERS).filter(([, why]) => why.startsWith('ATTEMPT')).map(([f]) => f).sort();
    expect(Object.keys(ATTEMPT_MERGED_GUARD).sort()).toEqual(attempt);
    for (const [f, want] of Object.entries(ATTEMPT_MERGED_GUARD)) {
      const n = (code(f).match(/\bnotKernelMergedTaskSql\(\)/g) ?? []).length;
      if (typeof want === 'number') expect(`${f}: ${n}`).toBe(`${f}: ${want}`);
      else expect(want.length).toBeGreaterThan(10);
    }
  });

  it('AC-1 ratchet: the ATTEMPT writers only shrink: no new file, and no new statement in one', () => {
    const attempt = Object.entries(TASK_STATUS_WRITERS).filter(([, why]) => why.startsWith('ATTEMPT')).map(([f]) => f).sort();
    expect(attempt).toEqual(Object.keys(ATTEMPT_SITE_CEILING).sort());
    const over = Object.entries(ATTEMPT_SITE_CEILING)
      .map(([f, max]) => [f, taskStatusSites(code(f)).length, max] as const)
      .filter(([, n, max]) => n !== max)
      .map(([f, n, max]) => `${f}: ${n} statements, pinned at ${max}${n < max ? ' (lower the pin: the ratchet only goes down)' : ''}`);
    expect(over).toEqual([]);
  });

  it('S4b: a GUARDED writer still skips a delivery-owned task in its own statement', () => {
    expect(GUARDED_WRITERS.length).toBeGreaterThan(0);
    expect(GUARDED_WRITERS.filter((f) => !/\bdeliveryOwnedTaskSql\(/.test(code(f)))).toEqual([]);
  });

  it('S4b (AC-2): the merge transition is the writer of a delivery-owned task\'s completion; runMergedPrWork writes no task', () => {
    const kernel = code(`${KERNEL_DIR}kernel.ts`);
    expect(/mergeTaskProjectionCtes\(/.test(kernel)).toBe(true);
    expect(/t_proj AS \(/.test(code(`${KERNEL_DIR}task-projection.ts`))).toBe(true);
    expect(taskStatusSites(code('apps/web/src/lib/pr-merged-work.ts'))).toEqual([]);
  });

  it('S4b: mission completion on an automated path has one writer, the kernel\'s CAS on delivery records', () => {
    const outsideMission = files.filter((f) => !inKernel(f) && missionCompleteSites(code(f)).length > 0);
    expect(outsideMission.filter((f) => !MISSION_COMPLETERS[f])).toEqual([]);
    expect(missionCompleteSites(code(`${KERNEL_DIR}mission-completion-write.ts`)).length).toBe(1);
    expect(/claimMissionCompletion\(/.test(code('apps/web/src/lib/mission-completion.ts'))).toBe(true);
    // The scanner can fail.
    expect(missionCompleteSites(`await db.update(missions).set({ status: 'completed' }).where(x);`)).toEqual(['update(missions)@1']);
    expect(missionCompleteSites("sql`UPDATE missions m SET status = 'completed' WHERE m.id = 1`")).toEqual(['raw UPDATE missions@1']);
  });

  it('the guard can fail: it names each new writer shape', () => {
    expect(offendingSites(`await db.update(workers).set({ mergedAt: new Date() }).where(eq(workers.id, id));`).length).toBeGreaterThan(0);
    expect(offendingSites('await db.execute(sql`UPDATE workers SET pr_lifecycle_status = \'merged\' WHERE id = 1`)')).toEqual(['raw UPDATE workers@1']);
    expect(FUNNEL_CALL.test(`await recordPrFact({ workerId }, { kind: 'merged', mergedAt }, { scope: factFunnelScope });`)).toBe(true);
    expect(FUNNEL_CALL.test(`const { recordPrFact } = await import('@buildd/core/pr-facts');`)).toBe(true);
    expect(SCOPE_MINT.test(`const s = unscopedPrFactScope('why');`)).toBe(true);
    expect(SCOPE_MINT.test(`await recordPrFact(t, f, { scope: kernelProjectionScope });`)).toBe(true);
    expect(taskStatusSites(`await db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, id));`)).toEqual(['update(tasks)@1']);
    expect(taskStatusSites(`await db.update(tasks).set(patch).where(eq(tasks.id, id));`)).toEqual(['update(tasks)@1']);
    expect(taskStatusSites('sql`UPDATE tasks t SET result = $1 WHERE t.id = $2`')).toEqual(['raw UPDATE tasks@1']);
    expect(taskStatusSites(`await db.update(tasks).set({ title: 'x' }).where(eq(tasks.id, id));`)).toEqual([]);
  });
});
