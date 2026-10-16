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
  // The landing gate's pure answer and the `buildd/landing` context (workflow-kernel-library.md §4): read-only, like projections.
  'landing-gate',
  // S4a: the PR fact funnel's scope for terminal facts (a predicate, no command): the way a funnel caller
  // records a merge or close without deciding it for a delivery-owned row.
  'pr-fact-scope',
  // S4a review: the fast heal's due-queue (kernel-heal.ts). Its tick calls the floor pass for named
  // deliveries (seam functions only), like kernel-floor; it never imports the reducer.
  'kernel-heal']);
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
 * would apply the command on whatever host it runs on.
 */
const DOOR_COMMANDS = ['landThroughKernel', 'applyRecommendationThroughKernel', 'policyMergeThroughKernel', 'requestReview', 'requestCiRetry', 'recordSupersession', 'abandonDelivery', 'openKernelDelivery'];
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

/** Every `tasks.status` / `tasks.result` writer outside the kernel. S4b moves the delivery-owned half into transitions. */
const S4B = 'TODO S4b: tasks.status/result writer (§9); for a task with no delivery it stays';
const TASK_STATUS_WRITERS: Record<string, string> = Object.fromEntries([
  'apps/web/src/app/api/cron/task-archive/route.ts',
  'apps/web/src/app/api/github/webhook/route.ts',
  'apps/web/src/app/api/tasks/[id]/reassign/route.ts',
  'apps/web/src/app/api/tasks/[id]/route.ts',
  'apps/web/src/app/api/tasks/bulk/route.ts',
  'apps/web/src/app/api/tasks/cleanup/route.ts',
  'apps/web/src/app/api/webhooks/ingest/route.ts',
  'apps/web/src/app/api/workers/[id]/interrupt/route.ts',
  'apps/web/src/app/api/workers/[id]/route.ts',
  'apps/web/src/app/api/workers/claim/route.ts',
  'apps/web/src/lib/approve-plan.ts',
  'apps/web/src/lib/ci-failure-retry.ts',
  'apps/web/src/lib/conflict-retry.ts',
  'apps/web/src/lib/credential-recovery.ts',
  'apps/web/src/lib/github-repo-access-store.ts',
  'apps/web/src/lib/held-pr-tasks.ts',
  'apps/web/src/lib/interactive-detach.ts',
  'apps/web/src/lib/linear-webhook.ts',
  'apps/web/src/lib/loop-webhook.ts',
  'apps/web/src/lib/mission-surface-audit.ts',
  // runMergedPrWork: the merge completes the task. Its worker stamp is legacy-only (stamp: false on the kernel path).
  'apps/web/src/lib/pr-merged-work.ts',
  'apps/web/src/lib/quality-scout-actions.ts',
  'apps/web/src/lib/stale-workers.ts',
  'apps/web/src/lib/supersession-store.ts',
  'apps/web/src/lib/surface-audit-waiver-cancel.ts',
  'apps/web/src/lib/task-dependencies.ts',
  'apps/web/src/lib/task-evidence-store.ts',
  'apps/web/src/lib/task-pr-attach.ts',
  'apps/web/src/lib/task-recovery-hold.ts',
  'apps/web/src/lib/task-shipped-store.ts',
  'apps/web/src/lib/visual-review-decisions.ts',
  // An operator script scrubbing leaked secrets out of task results.
  'packages/core/scripts/scrub-exposed-secrets.ts',
].map((f) => [f, S4B]));

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

  it('every tasks.status / tasks.result writer outside the kernel is listed (S4b burns the list down)', () => {
    const writers = files.filter((f) => !inKernel(f) && taskStatusSites(code(f)).length > 0);
    expect(writers.filter((f) => !TASK_STATUS_WRITERS[f])).toEqual([]);
    expect(Object.keys(TASK_STATUS_WRITERS).filter((f) => !writers.includes(f))).toEqual([]);
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
