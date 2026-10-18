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
const KERNEL_ENTRY_POINTS = new Set(['kernel-client', 'command-api', 'command-keys', 'kernel-floor', 'kernel-host', 'seam', 'authority', 'github-facts', 'projections', 'delivery-view', 'pr-activity-effects', 'delivery-ship', 'delivery-display', 'escalation-brief', 'base-delta', 'visual-review-state', 'visual-review-state-load', 'visual-review-schedule-run', 'visual-review-presentation', 'visual-review-diagnostics', 'visual-review-policy', 'visual-review-impact', 'pr-display',
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
  'mission-completion-write',
  // AC-1 slice 4: a task's PR derived on read (one SELECT fragment over the task's delivery and
  // worker rows); no command, so it cannot assign a state, like delivery-view.
  'task-pr',
  // AC-1 slice 9: an owner task's moves for the attempt writers outside the worker PATCH, each a door
  // call (kernel-client) then the seam's guarded projection of the same move; never the reducer.
  'owner-attempt']);
const COMPOSITION_ROOT = 'apps/web/src/modules.ts';
// The package is matched too: importing `@buildd/workflow-kernel/reducer` is importing the reducer, and its
// root (`@buildd/workflow-kernel`, every module at once) reads as `index`, which is no entry point.
const KERNEL_IMPORT = /(?:from\s+|import\()\s*['"](?:(?:@\/lib\/workflow|(?:\.\.?\/)+(?:lib\/)?workflow|@buildd\/workflow-kernel)\/([a-z][a-z/-]*)|@buildd\/workflow-kernel()(?=['"]))['"]/g;

const TABLES = 'workflow_deliveries|workflow_review_rounds|workflow_findings|workflow_facts|workflow_transitions|workflow_effects|workflow_attempts|workflow_commands|workflow_command_outbox|workflow_mission_epochs|workflow_scope_amendments|trunk_incidents';
const SYMBOLS = 'workflowDeliveries|workflowReviewRounds|workflowFindings|workflowFacts|workflowTransitions|workflowEffects|workflowAttempts|workflowCommands|workflowCommandOutbox|workflowMissionEpochs|workflowScopeAmendments|trunkIncidents';
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
 * And `observeCiGreen` (CiGreenObserved, and the CiObserved reading outside a repair): the
 * check_suite success webhook reports a green head, and only the control plane applies it.
 * And T6 and T9: `recordReviewVerdict` and `adoptReviewVerdict` (the worker PATCH reports a
 * reviewer's verdict) and `claimFix` (the claim route revalidates a fix at claim).
 * And T12: `observeConflict` (the conflict door reports a conflicted PR).
 * And the last three (AC-9 met): `observePrState` (T17 to T19), `observeHead` (T3) and
 * `observeBase` (T29), which the GitHub webhook, the reviewer's push subscriber, the reconcile and
 * refresh sweeps and the dependency gate report. With them every seam command the web host reaches
 * is a door op: no module outside the kernel imports one from the seam.
 * And AC-1 slice 6's `attemptRequeued` (AttemptRequeued): the worker PATCH's retries, loop holds and
 * budget, mount, auth and codex requeues, and the conflict-fix recovery, applied only on the control plane.
 * And AC-1 slice 7's `attemptStarted` (AttemptStarted): the claim route's start of a kernel owner task.
 */
const DOOR_COMMANDS = ['landThroughKernel', 'applyRecommendationThroughKernel', 'policyMergeThroughKernel', 'requestReview', 'requestCiRetry', 'recordSupersession', 'abandonDelivery', 'openKernelDelivery', 'attemptEnded', 'attemptRequeued', 'attemptStarted', 'observeCiFailure', 'observeCiGreen', 'recordReviewVerdict', 'adoptReviewVerdict', 'claimFix', 'observeConflict', 'observePrState', 'observeHead', 'observeBase'];
/** The seam by any path: the alias, or a relative path however deep (`../../src/lib/workflow/seam`). */
const SEAM_SPEC = String.raw`['"](?:@\/lib\/workflow|(?:\.\.?\/)+(?:[\w.-]+\/)*workflow)\/seam(?:\.ts)?['"]`;
/** `import { a, b as c } from '…/seam'`, `const { a } = await import('…/seam')`, `(await import('…/seam')).a`. */
const SEAM_NAMED = new RegExp(String.raw`(?:import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${SEAM_SPEC}|\{([^}]*)\}\s*=\s*await\s+import\(\s*${SEAM_SPEC}\s*\))`, 'g');
const SEAM_MEMBER = new RegExp(String.raw`\(\s*await\s+import\(\s*${SEAM_SPEC}\s*\)\s*\)\s*\.\s*([A-Za-z_$][\w$]*)`, 'g');
/** A name bound to the whole module: `import * as seam from '…/seam'`, `const seam = await import('…/seam')`. */
const SEAM_NAMESPACE = new RegExp(String.raw`(?:import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*${SEAM_SPEC}|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*${SEAM_SPEC}\s*\))`, 'g');
/** `import('…/seam').then((m) => m.a)`. */
const SEAM_THEN = new RegExp(String.raw`import\(\s*${SEAM_SPEC}\s*\)\s*\.then\(\s*\(?\s*([A-Za-z_$][\w$]*)`, 'g');
/** `import('…/seam').then(({ a, b: c }) => a(p))`. */
const SEAM_THEN_NAMED = new RegExp(String.raw`import\(\s*${SEAM_SPEC}\s*\)\s*\.then\(\s*(?:async\s*)?\(\s*\{([^}]*)\}`, 'g');

function seamDoorImports(src: string): string[] {
  const names: string[] = [];
  for (const m of [...src.matchAll(SEAM_NAMED), ...src.matchAll(SEAM_THEN_NAMED)]) {
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
    // AC-1 slice 6: the requeue is a door; its fallback projection and guard are not commands.
    expect(seamDoorImports(`import { attemptRequeued, projectRequeue, requeueingAttemptIsCurrentSql } from '@/lib/workflow/seam';`)).toEqual(['attemptRequeued']);
    expect(seamDoorImports(`const { attemptRequeued: requeue } = await import('@/lib/workflow/seam');`)).toEqual(['attemptRequeued']);
    expect(seamDoorImports(`import { attemptRequeued } from '@/lib/workflow/kernel-client';`)).toEqual([]);
    // AC-1 slice 7: the start is a door; its fallback projection and the claim's own race guard are not commands.
    expect(seamDoorImports(`import { cancelSkippedTask, isRepairRole, ownerClaimOpenSql, projectAttemptStart } from '@/lib/workflow/seam';`)).toEqual([]);
    expect(seamDoorImports(`import { attemptStarted } from '@/lib/workflow/seam';`)).toEqual(['attemptStarted']);
    expect(seamDoorImports(`import { observeCiFailure } from '@/lib/workflow/seam';`)).toEqual(['observeCiFailure']);
    expect(seamDoorImports(`const { observeCiFailure } = await import('@/lib/workflow/seam');`)).toEqual(['observeCiFailure']);
    expect(seamDoorImports(`import { observeBase, observeCiGreen, observePrState } from '@/lib/workflow/seam';`)).toEqual(['observeBase', 'observeCiGreen', 'observePrState']);
    expect(seamDoorImports(`import { observeHead, policyFindingFor } from '@/lib/workflow/seam';`)).toEqual(['observeHead']);
    expect(seamDoorImports(`await import('@/lib/workflow/seam').then(({ observePrState }) => observePrState(p));`)).toEqual(['observePrState']);
    expect(seamDoorImports(`await import('@/lib/workflow/seam').then((m) => m.observePrState(p));`)).toEqual(['observePrState']);
    expect(seamDoorImports(`const { recordPrStateObserved } = await import('@/lib/workflow/seam');`)).toEqual([]);
    expect(seamDoorImports(`import { observeBase, observePrState } from '@/lib/workflow/kernel-client';`)).toEqual([]);
    expect(seamDoorImports(`import { observeCiGreen } from '@/lib/workflow/kernel-client';`)).toEqual([]);
    expect(seamDoorImports(`import { adoptReviewVerdict, fixedElsewhereOf, recordReviewVerdict } from '@/lib/workflow/seam';`)).toEqual(['adoptReviewVerdict', 'recordReviewVerdict']);
    expect(seamDoorImports(`import { cancelSkippedTask, claimFix as claimKernelFix, isRepairRole } from '@/lib/workflow/seam';`)).toEqual(['claimFix']);
    expect(seamDoorImports(`import { claimFix, recordReviewVerdict } from '@/lib/workflow/kernel-client';`)).toEqual([]);
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

/** Terminal facts here go under `factFunnelScope`; non-terminal facts (open, CI, conflict, unresolvable) stay unscoped: S4a and S4b did not scope them and no open slice owns it (a follow-up task, if wanted). */
const FUNNEL = 'records PR facts through the funnel; a terminal fact under factFunnelScope (delivery-owned rows take only what their delivery says)';
const FUNNEL_CALLERS: Record<string, string> = {
  'apps/web/src/app/api/github/webhook/route.ts': `${FUNNEL}; CI, conflict and open facts unscoped (unscoped, no owning slice). A kernel-owned merge is T17's, reached through observePrState`,
  'apps/web/src/app/api/github/pr/route.ts': `${FUNNEL}: the legacy merge door's receipt`,
  'apps/web/src/app/api/prs/[prNumber]/merge/route.ts': `${FUNNEL}: the dashboard merge door's receipt`,
  'apps/web/src/app/api/admin/backfill-merged-prs/route.ts': 'unresolvable bookkeeping only (non-terminal, unscoped; no owning slice)',
  'apps/web/src/lib/dead-pr-shutdown.ts': `${FUNNEL}: the loser of a duplicate PR closes`,
  'apps/web/src/lib/dead-zone-sweep.ts': `${FUNNEL}: the sweep heals a missed merge or close`,
  'apps/web/src/lib/mission-pr.ts': `${FUNNEL}; the open fact unscoped (unscoped; no owning slice). The mission PR's delivery is opened by openMissionPrDelivery (S6)`,
  'apps/web/src/lib/pr-fact-import.ts': `${FUNNEL}: the reconcile script's import`,
  'apps/web/src/lib/pr-merge-stamp.ts': `${FUNNEL}: stampPrMergedOnAllRows, the legacy merge's stamp`,
  // runMergedPrWork stamps only with \`stamp: true\`: the webhook's legacy path. A kernel-owned PR's
  // work runs from the emit_pr_merged effect with \`stamp: false\`, after T17 already projected the rows.
  'apps/web/src/lib/pr-merged-work.ts': `${FUNNEL}: stampPrMergedOnAllRows for a PR the kernel does not own`,
  'apps/web/src/lib/pr-reconcile.ts': `${FUNNEL}; conflict and unresolvable unscoped (unscoped; no owning slice)`,
  'apps/web/src/lib/pr-review-request.ts': `${FUNNEL}; the open fact unscoped (unscoped; no owning slice)`,
  'apps/web/src/lib/pr-state-refresh.ts': `${FUNNEL}; the CI fact unscoped (unscoped; no owning slice). The render read-through itself retires with AC-3`,
  'apps/web/src/lib/register-local-pr.ts': 'the open fact only (non-terminal, unscoped; no owning slice)',
  'apps/web/src/lib/worker-pr-slot.ts': 'the open fact only (non-terminal, unscoped; no owning slice): the sibling owner row of a second PR from one worker',
  // Cannot import apps/web, so it mints an unscoped scope (below).
  'packages/core/scripts/backfill-mergedat.ts': 'manual operator backfill, run by hand; unscoped. Healing through the kernel floor instead has no owning slice',
};
/** Minting a terminal-fact scope outside the kernel bypasses the delivery check. */
const SCOPE_MINTERS: Record<string, string> = {
  'packages/core/scripts/backfill-mergedat.ts': 'manual operator backfill in @buildd/core, which cannot import the kernel. Moving it behind the kernel floor has no owning slice',
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
  'apps/web/src/lib/pr-merged-legacy-task.ts': `${GUARDED('a merge seen by branch name (completeTaskOnBranchMatchMerge)')}. Its other writer, legacyCompleteTaskOnMerge, runs only for a PR the kernel does not own (the webhook's legacy path, or an emit_pr_merged effect queued before S4b shipped, #4856)`,
  'apps/web/src/lib/task-archive.ts': GUARDED('the weekly archive of stale failed tasks; a failed owner whose delivery is still live keeps its status'),
  'apps/web/src/lib/task-dependencies.ts': `${GUARDED('the dependency-failure cascade, for a live delivery')}. Its other writer cancels stale "Aggregate results" children of a planning task, which open no PR`,
  'apps/web/src/app/api/workers/[id]/route.ts': `${ATTEMPT('the worker PATCH: completion snapshot, requeues on budget, mount, auth and codex deferral, mission-budget failure, release outcome')}. For the plain end of a kernel owner attempt (AC-1 slice 3) the completion snapshot writes result, loop and context but not status: T4 projects it (t_attempt, projectOwnerEnd). A kernel owner's requeue (a retry, a loop hold, the budget, mount, auth and codex requeues: AC-1 slice 6) writes no status or claim either: AttemptRequeued moves it (t_requeue, projectRequeue). The reviewer-verdict writes target the reviewer task. No attempt writer stores result.prUrl / prNumber: they are derived on read (workflow/task-pr.ts, AC-1 slice 4). The silent-completion retry and the credential hold of an owner are AttemptRequeued, its spent silent-completion retry AttemptEnded (AC-1 slice 8)`,
  'apps/web/src/app/api/workers/claim/route.ts': `${ATTEMPT('the claim (pending to assigned) of a task with no delivery, a repair or a review, and the rollback of its own assigned claim; the repair-attempt defer is the kernel\'s own decision')}. A kernel owner task's claim (AC-1 slice 7) writes no status: its compare-and-set stamps the claim and AttemptStarted moves it (t_start, projectAttemptStart)`,
  'apps/web/src/app/api/tasks/cleanup/route.ts': `${ATTEMPT('a stalled worker: retry-cap failure, requeue, or promotion of a completed worker\'s deliverables')}. A delivery owner's goes through the kernel (AC-1 slice 9): its current attempt's AttemptRequeued / AttemptEnded, or AttemptWithdrawn for a claim no attempt ran under`,
  'apps/web/src/lib/stale-workers.ts': `${ATTEMPT('the reaper: silent start, retry and infra caps, requeue, released interactive leases, expired loop waits, unanswered questions; deliverable promotion already skips a kernel attempt')}. For the current attempt of a kernel owner task (AC-1 slice 5) the caps write result but not status, and the unanswered-question sweep writes nothing: AttemptEnded(lost) projects it (t_attempt, projectOwnerEnd). A late reap after a re-claim, or a placeholder row, ends nothing (reapedOwnerAttemptIsCurrent). Its infra requeue and its release of an interactive or undelivered claim are AttemptRequeued for an owner (AC-1 slice 8); its loop-wait and reviewer writes skip an owner in their own WHERE (notDeliveryOwnedTaskSql)`,
  'apps/web/src/lib/interactive-detach.ts': `${ATTEMPT('a released interactive session requeues its open task')}. A delivery owner's goes back through AttemptRequeued (AC-1 slice 8)`,
  'apps/web/src/lib/credential-recovery.ts': `${ATTEMPT('requeue of tasks failed on an auth error once the credential is back')}. A delivery owner is reopened through AttemptReopened (AC-1 slice 9)`,
  'apps/web/src/lib/github-repo-access-store.ts': `${ATTEMPT('requeue of a task failed on blocked GitHub access, once access is verified')}. A delivery owner is reopened through AttemptReopened (AC-1 slice 9)`,
  'apps/web/src/lib/task-recovery-hold.ts': `${ATTEMPT('a credential hold requeues the task to its probe floor')}. A delivery owner's hold writes the floor only; AttemptRequeued moves it (AC-1 slice 8)`,
  'apps/web/src/lib/conflict-retry.ts': ATTEMPT('recovery of a stalled conflict-fix attempt task (never the owner); a kernel repair with a worker row goes through AttemptRequeued (AC-1 slice 6), one with no worker row has no attempt to requeue'),
  'apps/web/src/lib/ci-failure-retry.ts': ATTEMPT('CI retries exhausted; for a kernel-owned PR it is the kernel\'s own Escalate effect that calls it (ci-retry-effects.ts), and the legacy callers return early for a kernel PR. The owner of a kernel delivery keeps its status in the statement itself: the escalating transition fails it (t_escalate, AC-1 slice 8)'),
  'apps/web/src/lib/loop-webhook.ts': ATTEMPT('a loop task\'s exit condition (pr_merged, pr_checks_green) is met: loopState and the status it implies. For a kernel owner the loop writes its own fields only: T17 completes it on a merge, and a green-checks exit re-sends the held end and runs projectLoopExit (AC-1 slice 8)'),
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
  // 7 includes the reactivation (worker resumes from completed): a person's follow-up on a shipped
  // task runs the worker, but the task keeps completed. Kept guarded rather than exempted, so a
  // follow-up that then fails or is requeued can never reopen work that already merged.
  // AC-1 slice 6: the budget, codex, mount-gap and auth-failover requeues share one helper
  // (`requeueWorkerTask`): its two statements (the no-delivery requeue, a kernel owner's fields).
  'apps/web/src/app/api/workers/[id]/route.ts': 7,
  'apps/web/src/lib/stale-workers.ts': 6,
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
 * AC-1 (workflow-kernel-library.md §9): every `tasks.status` / `tasks.result` statement in an
 * ATTEMPT file, named by what it writes and classified. `at` must match the statement's own text
 * (from `update(tasks)` through its WHERE) and exactly one statement, so a site is found by what it
 * is, not by its line, and a new statement fails CI until it is classified here.
 *
 *  - KERNEL: for the owner task of a kernel delivery the statement writes no status: the kernel
 *    command named in `via` moves it (in its transition's own statement, with its guarded
 *    projection behind it). The file must still call it (`calls`), and the statement itself must
 *    keep every `status` it sets behind its owner check (`ownerSkip`): inside the spread an owner
 *    skips (`spread`, e.g. `ownerAttempt ? {} : {`), as a value that keeps an owner's status in SQL
 *    (`value`), or on a branch only a non-owner reaches (`branch`, read off the code before it).
 *  - NOT_OWNER: its status write never reaches a kernel delivery's owner task. With `predicate`
 *    the statement says so in its own WHERE (`notDeliveryOwnedTaskSql`); otherwise `why` names the
 *    code path's condition.
 *  - NO_STATUS: it writes `result` or `context` keys only.
 *  - DEBT: it still sets a kernel owner's status directly. The rest of AC-1, listed in §9.
 */
type OwnerSkip = { spread: string } | { value: RegExp } | { branch: RegExp };
type AttemptSite =
  | { at: RegExp; kind: 'KERNEL'; via: string; calls: RegExp; ownerSkip: OwnerSkip; why: string }
  | { at: RegExp; kind: 'NOT_OWNER'; predicate?: true; why: string }
  | { at: RegExp; kind: 'NO_STATUS'; why: string }
  | { at: RegExp; kind: 'DEBT'; why: string };
const ATTEMPT_SITES: Record<string, AttemptSite[]> = {
  'apps/web/src/app/api/workers/[id]/route.ts': [
    { at: /\.\.\.\(p\.set \?\? \{\}\), status: 'pending'/, kind: 'NOT_OWNER', why: 'requeueWorkerTask\'s write for a task with no delivery or not its owner; an owner goes through requeueOwnerAttempt' },
    { at: /status: 'assigned', updatedAt/, kind: 'NOT_OWNER', predicate: true, why: 'a worker resuming from completed/failed reopens its task (reactivation); an owner is reopened by AttemptReopened(assigned) (AC-1 slice 9)' },
    { at: /silentCompletionRetryCount/, kind: 'KERNEL', via: 'AttemptRequeued (retry left) / AttemptEnded (retry spent)', calls: /requeueOwnerAttempt\(\{ task: ownerTask[\s\S]*endOwnerAttemptFailed\(\{ task: ownerTask/, ownerSkip: { spread: 'ownerAttempt ? {} : {' }, why: 'AC-1 slice 8: the silent-completion retry' },
    { at: /\.\.\.taskFields/, kind: 'KERNEL', via: 'AttemptEnded (t_attempt, projectOwnerEnd) / AttemptRequeued (t_requeue)', calls: /(?=[\s\S]*\bworkflowAttemptEnd\(\))(?=[\s\S]*\bprojectOwnerEnd\(\{[\s\S]{0,200}status: contractViolation \|\| slotFailure)(?=[\s\S]*\brequeueOwnerAttempt\(\{)/, ownerSkip: { spread: 'ownerTask ? {} : {' }, why: 'the completion snapshot: an owner end (slice 3), its contract or loop failure override (slice 9: the end is sent failed) and its retry or loop hold (slice 6) write no status' },
    { at: /releaseResult,\s*result: resultWithRelease,\s*updatedAt: new Date\(\),\s*\}\)/, kind: 'KERNEL', via: 'AttemptEnded(failed) (t_attempt, projectOwnerEnd)', calls: /status: \(contractViolation \|\| slotFailure \? 'failed' : status\)/, ownerSkip: { spread: 'ownerTask ? {} : {' }, why: 'AC-1 slice 9: a failed release; an owner\'s end below is sent failed (slotFailure) and projected' },
    { at: /releasePrPending: true/, kind: 'NO_STATUS', why: 'a release held for CI: releaseResult, result and context' },
    { at: /\.set\(\{ releaseResult, result: resultWithRelease, updatedAt/, kind: 'NO_STATUS', why: 'the release record' },
    { at: /\.set\(\{ status: 'failed', updatedAt: new Date\(\) \}\)[\s\S]*not\(eq\(tasks\.status, 'cancelled'\)\)/, kind: 'NOT_OWNER', predicate: true, why: 'a sandbox mount gap whose cost exhausts its mission fails the requeued task; an owner is refused by AttemptWithdrawn(failed, no claim) (AC-1 slice 9)' },
    { at: /'effectiveVerdictReason', \$\{copyGate\.reason/, kind: 'NO_STATUS', why: 'the copy review\'s verdict on the reviewer task\'s result' },
    { at: /'effectiveVerdictReason', \$\{serverOverrideReason\}/, kind: 'NO_STATUS', why: 'the server\'s escalation on the reviewer task\'s result' },
    { at: /'evidenceSha', \$\{evidenceSha\}/, kind: 'NO_STATUS', why: 'the commit the reviewer read its verdict at, on the reviewer task\'s result' },
  ],
  'apps/web/src/app/api/workers/claim/route.ts': [
    { at: /claimedBy: null, claimedAt: null, expiresAt: null, status: 'pending'/, kind: 'NOT_OWNER', predicate: true, why: 'rollBackClaim gives back the route\'s own assigned claim (a fix the kernel deferred, a worker the account cap refused); an owner\'s is AttemptWithdrawn(requeued) on exactly that claim (AC-1 slice 9)' },
    { at: /context: mismatchContext,\s*\}\)/, kind: 'NOT_OWNER', predicate: true, why: 'a pending task pinned to a project its workspace lacks is failed at claim; an owner is refused by AttemptWithdrawn(failed, no claim) (AC-1 slice 9)' },
    { at: /\.set\(\{ \.\.\.claimFields, status: 'assigned' \}\)/, kind: 'KERNEL', via: 'AttemptStarted', calls: /\bkernelAttemptStarted\(/, ownerSkip: { branch: /= kernelOwner\s*\?\s*await db\s*\.update\(tasks\)\s*\.set\(\{ \.\.\.claimFields \}\)[\s\S]{0,400}:\s*await db\s*\.$/ }, why: 'AC-1 slice 7: a kernel owner\'s claim stamps the claim fields only; this branch is every other task\'s claim' },
  ],
  'apps/web/src/app/api/tasks/cleanup/route.ts': [
    { at: /context: capContext,\s*\}\)/, kind: 'NOT_OWNER', predicate: true, why: 'the runner\'s cleanup call fails a task past its retry cap; an owner\'s current attempt ends through AttemptEnded(lost), a claim with no attempt through AttemptWithdrawn(failed) (AC-1 slice 9)' },
    { at: /status: 'pending'[\s\S]*FORCE_CLAIM_CONTEXT_KEY/, kind: 'NOT_OWNER', predicate: true, why: 'the runner\'s cleanup call requeues a stalled task; an owner through AttemptRequeued, or AttemptWithdrawn(requeued) for a claim with no attempt (AC-1 slice 9)' },
    { at: /result: \{\s*branch: completedWorker\.branch/, kind: 'KERNEL', via: 'AttemptEnded(success) (t_attempt, projectOwnerEnd)', calls: /endOwner\(\{[\s\S]{0,300}workerId: completedWorker\.id, status: 'completed'/, ownerSkip: { spread: 'ownerAttempt ? {} : {' }, why: 'AC-1 slice 9: the cleanup call completes a task whose worker completed; an owner\'s is that worker\'s end' },
  ],
  'apps/web/src/lib/stale-workers.ts': [
    { at: /error: waitReason/, kind: 'NOT_OWNER', predicate: true, why: 'an expired loop wait; a kernel owner\'s wait ends with its delivery (T17 on a merge, the loop exit on green checks)' },
    { at: /Agent review stalled/, kind: 'NOT_OWNER', predicate: true, why: 'a reviewer round\'s own task, at its infra cap; a kernel round hears ReviewRoundFailed' },
    { at: /Agent review failed \(/, kind: 'NOT_OWNER', predicate: true, why: 'a reviewer round\'s own task, requeued after a pre-start failure' },
    { at: /'agent review timed out'/, kind: 'NOT_OWNER', predicate: true, why: 'a reviewer round\'s own task, timed out; a kernel round hears ReviewRoundFailed' },
    { at: /reaperAutoCompleted: true/, kind: 'NOT_OWNER', why: 'deliverable promotion runs only with no kernel delivery (hasDeliverables requires !kernelDeliveryId)' },
    { at: /Previous worker expired \(infra failure\)/, kind: 'KERNEL', via: 'AttemptRequeued', calls: /requeueReapedOwnerAttempt\(\{[^}]*reason: 'infra_retry'/, ownerSkip: { spread: 'ownerAttempt ? {} : {' }, why: 'AC-1 slice 8: the infra requeue' },
    { at: /result: failure as any/, kind: 'KERNEL', via: 'AttemptEnded(lost)', calls: /workflowAttemptEnded\(\{[\s\S]*status: 'lost'/, ownerSkip: { spread: 'ownerAttempt ? {} : {' }, why: 'AC-1 slice 5: the silent-start, retry and infra caps' },
    { at: /CLAIM_RESPONSE_LOST_ERROR/, kind: 'KERNEL', via: 'AttemptRequeued', calls: /reason: undelivered \? 'claim_undelivered' : 'interactive_release'/, ownerSkip: { spread: 'ownerAttempt ? {} : {' }, why: 'AC-1 slice 8: a released interactive lease or an undelivered claim' },
    { at: /eq\(tasks\.id, originalTask\.id\)/, kind: 'KERNEL', via: 'AttemptEnded(lost) (t_attempt, projectOwnerEnd)', calls: /source: 'sweep:waiting-input'[\s\S]{0,600}projectOwnerEnd\(\{/, ownerSkip: { branch: /const ownerAttempt = !!kernelDeliveryId && originalTask\.deliveryRole === 'owner';[\s\S]{0,600}if \(!ownerAttempt\) \{\s*await db\s*\.$/ }, why: 'AC-1 slice 5 / 9: an unanswered question, superseded by recovery or not, ends the owner attempt (the recovery later reopens it, AttemptReopened); only a non-owner reaches this write' },
  ],
  'apps/web/src/lib/interactive-detach.ts': [
    { at: /notExists\(otherLive\)/, kind: 'KERNEL', via: 'AttemptRequeued', calls: /requeueOwnerThroughKernel\(/, ownerSkip: { branch: /if \(task\?\.deliveryId && task\.deliveryRole === 'owner'\) \{\s*if \(await requeueOwnerThroughKernel\([\s\S]{0,200}return;\s*\}[\s\S]{0,400}const \[requeued\] = await db\s*\.$/ }, why: 'AC-1 slice 8: "Release slot"; an owner task returns before this write' },
  ],
  'apps/web/src/lib/credential-recovery.ts': [
    { at: /eq\(tasks\.status, 'failed'\)/, kind: 'NOT_OWNER', predicate: true, why: 'a task failed on an auth error is requeued once its credential is back; an owner is reopened by AttemptReopened(pending) naming its failed attempt (AC-1 slice 9)' },
  ],
  'apps/web/src/lib/github-repo-access-store.ts': [
    { at: /status: 'pending',\s*context: sql`jsonb_set\(\$\{tasks\.context\}, '\{githubAccessBlock,resumedAt\}'/, kind: 'NOT_OWNER', predicate: true, why: 'a task failed on blocked GitHub access is requeued once access is verified; an owner is reopened by AttemptReopened(pending), as credential recovery (AC-1 slice 9)' },
  ],
  'apps/web/src/lib/task-recovery-hold.ts': [
    { at: /startAt: plan\.startAt/, kind: 'KERNEL', via: 'AttemptRequeued', calls: /input\.ownerAttempt\.requeue\(\)/, ownerSkip: { spread: 'input.ownerAttempt ? {} : {' }, why: 'AC-1 slice 8: a credential hold; the worker PATCH passes ownerAttempt for an owner task' },
  ],
  'apps/web/src/lib/conflict-retry.ts': [
    { at: /conflictRecovery'->>'at'/, kind: 'NOT_OWNER', why: 'a stalled conflict fix is a repair task, never the delivery\'s owner; a kernel repair with a worker row is requeued by AttemptRequeued (slice 6), and one with no worker row (claimed, never started) has no attempt to requeue, so its status write stays' },
  ],
  'apps/web/src/lib/ci-failure-retry.ts': [
    { at: /CI retry stopped/, kind: 'KERNEL', via: 't_escalate (the escalating transition)', calls: /THEN \$\{tasks\.status\} ELSE 'failed' END/, ownerSkip: { value: /status: sql`CASE WHEN \$\{kernelOwned\} THEN \$\{tasks\.status\} ELSE 'failed' END`/ }, why: 'AC-1 slice 8: CI retries exhausted; the statement keeps a kernel owner\'s status in SQL' },
  ],
  'apps/web/src/lib/loop-webhook.ts': [
    { at: /`PR #\$\{worker\.prNumber\} merged`/, kind: 'KERNEL', via: 'T17 (the merge transition)', calls: /completeParkedOwner\(\{ taskId, deliveryId: kernelDeliveryId \}\)/, ownerSkip: { spread: 'kernelDeliveryId ? {} : {' }, why: 'AC-1 slice 8: a pr_merged loop exit; a task T17 left open because a local session ran it is completed by projectLoopExit' },
    { at: /checks green \(\$\{prLifecycleStatus\}\)/, kind: 'KERNEL', via: 'AttemptEnded (re-sent) + projectLoopExit', calls: /settleKernelLoopExit\(\{/, ownerSkip: { spread: 'kernelDeliveryId ? {} : {' }, why: 'AC-1 slice 8: a pr_checks_green loop exit' },
  ],
};

/**
 * AC-1 ratchet: the ATTEMPT statements that still set a kernel owner's status directly (DEBT
 * above). The count only goes down; it is 0 when AC-1 is done for `tasks.status`.
 */
const ATTEMPT_SITE_CEILING = 0;

/** A statement's own text: from `update(tasks)` at `i` through the close of its `.where(...)`. */
function statementText(src: string, i: number): string {
  const rest = src.slice(i);
  const next = rest.slice(5).search(/\bupdate\(\s*tasks\s*\)/);
  const w = rest.indexOf('.where(');
  if (w < 0 || (next >= 0 && w > next + 5)) return rest.slice(0, 1500);
  let depth = 0;
  let j = w + 6;
  for (; j < rest.length; j++) {
    if (rest[j] === '(') depth++;
    else if (rest[j] === ')' && --depth === 0) break;
  }
  return rest.slice(0, j + 1);
}
/** Each scanned site's statement, in source order: its text and where it starts. */
function attemptStatementsAt(src: string): Array<{ text: string; at: number }> {
  return taskStatusSites(src).map((site) => {
    const line = Number(site.split('@')[1]);
    const offset = src.split('\n').slice(0, line - 1).join('\n').length;
    const i = src.slice(offset).search(/\bupdate\(\s*tasks\s*\)|UPDATE\s+"?tasks"?/i);
    const at = offset + Math.max(0, i);
    return { text: statementText(src, at), at };
  });
}
/** Each scanned site's statement text, in source order. */
function attemptStatements(src: string): string[] {
  return attemptStatementsAt(src).map((s) => s.text);
}

/** The statement's `.set(...)` part: everything before its WHERE. */
const setPart = (st: string): string => (st.indexOf('.where(') > 0 ? st.slice(0, st.indexOf('.where(')) : st);
/** Cut every `prefix … }` (the brace `prefix` opens, balanced) out of `text`. */
function cutSpreads(text: string, prefix: string): string {
  let out = text;
  for (let i = out.indexOf(prefix); i >= 0; i = out.indexOf(prefix)) {
    let depth = 0;
    let j = i + prefix.length - 1;
    for (; j < out.length; j++) {
      if (out[j] === '{') depth++;
      else if (out[j] === '}' && --depth === 0) break;
    }
    out = out.slice(0, i) + out.slice(j + 1);
  }
  return out;
}
const STATUS_KEY = /(?<![.\w$])status\s*:/;
/** A not-owner statement says so in its own WHERE: no kernel delivery owns the task, or it is no delivery's owner. */
const NOT_OWNER_PREDICATE = /\b(?:notDeliveryOwnedTaskSql|notOwnerTaskSql)\(\)/;

/** A balanced `{…}` starting at `open` (the index of its `{`). */
function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return src.slice(open);
}
/**
 * #5131 review: the per-statement check reads the statement's own text, so a status supplied
 * through a pre-built object (`...fields`, `...(p.set ?? {})`, `.set(fields)`) is invisible to it.
 * At a classed KERNEL or NO_STATUS statement every such object must resolve, in the same file, to
 * one that cannot carry `status`: an object literal with no status key (its own pre-built spreads
 * resolved the same way), or a rest binding of a destructure that takes `status` out. A member
 * (`p.set`), a parameter, anything else, or any `name.status =` assignment, fails.
 */
function prebuiltStatusProblem(src: string, stmt: string, depth = 0): string | null {
  const set = setPart(stmt);
  const names = new Set<string>();
  const whole = /\.set\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/.exec(set);
  if (whole) names.add(whole[1]);
  const open = set.indexOf('{', Math.max(0, set.indexOf('.set(')));
  if (open >= 0) for (const n of topLevelSpreads(braceBlock(set, open))) names.add(n);
  for (const n of names) {
    const why = objectStatusProblem(src, n, depth);
    if (why) return `takes status through \`${n}\` (${why})`;
  }
  return null;
}
/**
 * The names an object literal spreads at its own top level (`...name`, `...a.b`, `...(name ?? {})`):
 * the keys it takes from a pre-built object. A conditional spread (`...(c ? {} : {…})`) is inline
 * text the statement check reads, and a spread inside a nested value (`context: { ...ctx }`) sets
 * keys of that value, not of the row.
 */
function topLevelSpreads(lit: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch === '`') { i = lit.indexOf('`', i + 1); if (i < 0) break; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (depth === 1 && lit.startsWith('...', i)) {
      const m = /^\.\.\.\s*(?:\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\?\?\s*\{\s*\}\s*\)|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*))\s*[,}\n]/.exec(lit.slice(i));
      if (m) out.push(m[1] ?? m[2]);
      i += 2;
    }
  }
  return out;
}
function objectStatusProblem(src: string, name: string, depth: number): string | null {
  if (name.includes('.')) return 'a member, which the guard cannot resolve';
  if (depth > 3) return 'nested too deep to resolve';
  const esc = name.replace(/\$/g, '\\$');
  if (new RegExp(`(?<![\\w$.])${esc}\\s*(?:\\.\\s*status|\\[\\s*['"]status['"]\\s*\\])\\s*=(?!=)`).test(src)) return 'status is assigned on it';
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
  if (decl) {
    const lit = braceBlock(src, decl.index + decl[0].length - 1);
    if (STATUS_KEY.test(lit)) return 'its literal sets status';
    return prebuiltStatusProblem(src, `.set(${lit})`, depth + 1);
  }
  const rest = new RegExp(`\\b(?:const|let)\\s*\\{([^}]*)\\.\\.\\.\\s*${esc}\\s*\\}\\s*=`).exec(src);
  if (rest) return /(?<![\w$])status\b/.test(rest[1]) ? null : 'a rest binding that keeps status';
  return 'not declared in this file as an object literal or a rest binding without status';
}
/**
 * Why a KERNEL statement could set a kernel owner's status itself, or null: a `status` key in its
 * set that is not behind its own owner check.
 */
function ownerSkipProblem(skip: OwnerSkip, stmt: string, before: string): string | null {
  if ('branch' in skip) return skip.branch.test(before) ? null : 'no longer on a branch only a non-owner reaches';
  const set = 'spread' in skip ? cutSpreads(setPart(stmt), skip.spread) : setPart(stmt).replace(skip.value, '');
  return STATUS_KEY.test(set) ? 'sets status outside its owner check' : null;
}
/** Every way one ATTEMPT file's statements break their classification. */
function attemptSiteProblems(f: string, src: string, sites: AttemptSite[]): string[] {
  const problems: string[] = [];
  const stmts = attemptStatementsAt(src);
  stmts.forEach((st, n) => {
    const hits = sites.filter((e) => e.at.test(st.text));
    if (hits.length !== 1) problems.push(`${f} statement ${n + 1} matched ${hits.length} entries: ${st.text.replace(/\s+/g, ' ').slice(0, 120)}`);
  });
  for (const e of sites) {
    const mine = stmts.filter((st) => e.at.test(st.text));
    if (mine.length !== 1) problems.push(`${f} ${e.at}: matched ${mine.length} statements`);
    if (e.kind === 'KERNEL') {
      if (!e.calls.test(src)) problems.push(`${f} ${e.at}: routed through ${e.via}, but the file no longer calls it (${e.calls})`);
      for (const st of mine) {
        const why = ownerSkipProblem(e.ownerSkip, st.text, src.slice(Math.max(0, st.at - 1500), st.at));
        if (why) problems.push(`${f} ${e.at}: KERNEL statement ${why}`);
      }
    }
    if (e.kind === 'NOT_OWNER' && e.predicate && !mine.some((st) => NOT_OWNER_PREDICATE.test(st.text.slice(st.text.indexOf('.where('))))) problems.push(`${f} ${e.at}: lost notDeliveryOwnedTaskSql / notOwnerTaskSql in its WHERE`);
    if (e.kind === 'KERNEL' || e.kind === 'NO_STATUS') {
      for (const st of mine) {
        const why = prebuiltStatusProblem(src, st.text);
        if (why) problems.push(`${f} ${e.at}: ${e.kind} statement ${why}`);
      }
    }
    if (e.kind === 'NO_STATUS' && mine.some((st) => STATUS_KEY.test(setPart(st.text)))) problems.push(`${f} ${e.at}: NO_STATUS but sets status`);
  }
  return problems;
}

/**
 * AC-1 slice 4 step 1: a task's PR is derived on read (`apps/web/src/lib/workflow/task-pr.ts`), so
 * no ATTEMPT writer puts `prUrl` / `prNumber` into a result it writes. The scan finds every object
 * literal assigned to `result` (`result: {…}`, `result = {…}`, `.result = {…}`) and flags one that
 * names either key. A person's act (correct_task_result) still attaches a PR, and is not scanned.
 */
function resultPrWrites(src: string): string[] {
  const out: string[] = [];
  const line = (i: number) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(/\bresult\s*(?::|=(?!=))\s*(?:\(?\s*)?\{/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    // A key (`prUrl:`, shorthand `{ prUrl, …}`), never a member read such as `${w.prNumber}`.
    if (/(?<![.\w$])pr(?:Url|Number)\s*[:,}]/.test(src.slice(open, end + 1))) out.push(`result@${line(m.index!)}`);
  }
  return out;
}

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

  it('AC-1: every statement of every ATTEMPT writer is named and classified, and each name finds exactly one', () => {
    const attempt = Object.entries(TASK_STATUS_WRITERS).filter(([, why]) => why.startsWith('ATTEMPT')).map(([f]) => f).sort();
    expect(attempt).toEqual(Object.keys(ATTEMPT_SITES).sort());
    expect(Object.entries(ATTEMPT_SITES).flatMap(([f, sites]) => attemptSiteProblems(f, code(f), sites))).toEqual([]);
  });

  it('AC-1: a KERNEL statement is checked on its own: putting back a direct status write fails the guard', () => {
    // The three reverts the slice 8 review made, each on the real file: the guard must name the statement.
    const reverts: Array<[string, string, string]> = [
      ['apps/web/src/lib/loop-webhook.ts', "...(kernelDeliveryId ? {} : { status: 'completed' as const }),", "status: 'completed',"],
      ['apps/web/src/app/api/workers/[id]/route.ts', "...(ownerAttempt ? {} : { status: next.retry ? 'pending' as const : 'failed' as const, claimedBy: null, claimedAt: null }),", "status: next.retry ? 'pending' as const : 'failed' as const, claimedBy: null, claimedAt: null,"],
      ['apps/web/src/lib/stale-workers.ts', "...(ownerAttempt ? {} : { status: 'pending' as const, claimedBy: null, claimedAt: null }),", "status: 'pending' as const, claimedBy: null, claimedAt: null,"],
    ];
    for (const [f, from, to] of reverts) {
      const src = code(f);
      expect(`${f}: ${src.includes(from)}`).toBe(`${f}: true`);
      expect(attemptSiteProblems(f, src, ATTEMPT_SITES[f])).toEqual([]);
      const problems = attemptSiteProblems(f, src.replace(from, to), ATTEMPT_SITES[f]);
      expect(problems.some((p) => p.includes('KERNEL statement sets status outside its owner check'))).toBe(true);
    }
    // A branch check fails when the owner's early return goes: the write is then reached by an owner.
    const detach = 'apps/web/src/lib/interactive-detach.ts';
    const noReturn = code(detach).replace(/if \(task\?\.deliveryId && task\.deliveryRole === 'owner'\) \{[\s\S]*?return;\s*\}/, '');
    expect(attemptSiteProblems(detach, noReturn, ATTEMPT_SITES[detach]).some((p) => p.includes('no longer on a branch only a non-owner reaches'))).toBe(true);
    // The pieces: a spread an owner skips is cut whole, nested braces included; a bare status is not.
    expect(cutSpreads("set({ ...(o ? {} : { status: 'p', ...(u ? { e: null } : {}) }), x: 1 })", 'o ? {} : {')).toBe('set({ ...(), x: 1 })');
    expect(STATUS_KEY.test("set({ result: { a: 1 }, releaseResult: r.status })")).toBe(false);
    expect(STATUS_KEY.test("set({ status: 'failed' })")).toBe(true);
  });

  it('AC-1 slice 9: every moved site fails the guard when its direct status write comes back', () => {
    const reverts: Array<[string, string, string, string]> = [
      ['apps/web/src/app/api/tasks/cleanup/route.ts', "...(ownerAttempt ? {} : { status: 'completed' as const }),", "status: 'completed' as const,", 'KERNEL statement sets status outside its owner check'],
      ['apps/web/src/app/api/workers/[id]/route.ts', "...(ownerTask ? {} : { status: 'failed' as const }),", "status: 'failed' as const,", 'KERNEL statement sets status outside its owner check'],
      // The completion snapshot's fields keep status again: the pre-built object now carries it.
      ['apps/web/src/app/api/workers/[id]/route.ts', 'const { status: intendedTaskStatus, ...taskFields } = taskUpdate;', 'const { ...taskFields } = taskUpdate; const intendedTaskStatus = taskUpdate.status;', 'takes status through `taskFields`'],
      // A superseded question's task is failed by the reaper itself again.
      ['apps/web/src/lib/stale-workers.ts', "const ownerAttempt = !!kernelDeliveryId && originalTask.deliveryRole === 'owner';", "const ownerAttempt = !!kernelDeliveryId && originalTask.deliveryRole === 'owner' && !superseded;", 'no longer on a branch only a non-owner reaches'],
    ];
    for (const [f, from, to, want] of reverts) {
      const src = code(f);
      expect(`${f}: ${src.includes(from)}`).toBe(`${f}: true`);
      expect(attemptSiteProblems(f, src, ATTEMPT_SITES[f])).toEqual([]);
      const problems = attemptSiteProblems(f, src.replace(from, to), ATTEMPT_SITES[f]);
      expect(`${f} ${want}: ${problems.some((p) => p.includes(want))} ${problems.join(' | ')}`).toStartWith(`${f} ${want}: true`);
    }
    // Every not-owner statement that says so in its WHERE fails once the predicate goes.
    let checked = 0;
    for (const [f, sites] of Object.entries(ATTEMPT_SITES)) {
      const src = code(f);
      for (const e of sites.filter((x) => x.kind === 'NOT_OWNER' && x.predicate)) {
        const st = attemptStatementsAt(src).find((x) => e.at.test(x.text))!;
        const stripped = st.text.replace(/,?\s*(?:notDeliveryOwnedTaskSql|notOwnerTaskSql)\(\)/g, '');
        expect(`${f} ${e.at}: ${stripped !== st.text}`).toBe(`${f} ${e.at}: true`);
        const broken = src.slice(0, st.at) + stripped + src.slice(st.at + st.text.length);
        expect(`${f} ${e.at}: ${attemptSiteProblems(f, broken, sites).some((p) => p.includes('lost notDeliveryOwnedTaskSql / notOwnerTaskSql'))}`).toBe(`${f} ${e.at}: true`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  it('#5131 review: a status supplied through a pre-built object is seen at a classed statement', () => {
    const stmt = (set: string) => `db.update(tasks).set(${set}).where(eq(tasks.id, id))`;
    // A literal with status, a member, a parameter, and a rest binding that keeps status: each named.
    expect(prebuiltStatusProblem("const f = { status: 'failed', a: 1 };", stmt('{ ...f, b: 2 }'))).toContain('its literal sets status');
    expect(prebuiltStatusProblem('', stmt('{ ...(p.set ?? {}), b: 2 }'))).toContain('a member');
    expect(prebuiltStatusProblem('function g(fields) {}', stmt('{ ...fields }'))).toContain('not declared in this file');
    expect(prebuiltStatusProblem('const { ...rest } = u;', stmt('{ ...rest }'))).toContain('a rest binding that keeps status');
    expect(prebuiltStatusProblem("const u = { status: 'pending' };", stmt('u'))).toContain('its literal sets status');
    // Resolved through a second level, and a status assigned on it later.
    expect(prebuiltStatusProblem("const a = { status: 'x' }; const b = { ...a, c: 1 };", stmt('{ ...b }'))).toContain('takes status through `a`');
    expect(prebuiltStatusProblem("const { status: s, ...rest } = u; rest.status = 'failed';", stmt('{ ...rest }'))).toContain('status is assigned on it');
    // What may stay: a rest binding that takes status out, a literal without it, a conditional spread
    // (the statement check reads it), and a spread inside a nested value.
    expect(prebuiltStatusProblem('const { status: s, ...rest } = u;', stmt('{ ...rest, x: 1 }'))).toBeNull();
    expect(prebuiltStatusProblem('const c = { claimedBy: id, claimedAt: now };', stmt('{ ...c }'))).toBeNull();
    expect(prebuiltStatusProblem('', stmt("{ ...(o ? {} : { status: 'failed' }), x: 1 }"))).toBeNull();
    expect(prebuiltStatusProblem('', stmt('{ context: { ...ctx, a: 1 } }'))).toBeNull();
  });

  it('AC-1 ratchet: the statements that still set a kernel owner\'s status directly only go down', () => {
    const debt = Object.entries(ATTEMPT_SITES).flatMap(([f, sites]) => sites.filter((e) => e.kind === 'DEBT').map((e) => `${f}: ${e.why}`));
    expect(`${debt.length} DEBT sites`).toBe(`${ATTEMPT_SITE_CEILING} DEBT sites`);
    // The scanners can fail: a statement whose WHERE drops the predicate, and one with no WHERE.
    const st = attemptStatements("await db.update(tasks).set({ status: 'failed' }).where(and(eq(tasks.id, id), notDeliveryOwnedTaskSql()));\nawait db.update(tasks).set({ result: { a: 1 } });");
    expect(st.length).toBe(2);
    expect(/\bnotDeliveryOwnedTaskSql\(\)/.test(st[0])).toBe(true);
    expect(st[0].endsWith('notDeliveryOwnedTaskSql()))')).toBe(true);
  });

  it('AC-1 slice 7: the claim of a kernel owner task writes no status; AttemptStarted moves it, with the route\'s guarded projection behind it', () => {
    const route = code('apps/web/src/app/api/workers/claim/route.ts');
    // The kernel owner's compare-and-set: the claim fields only, still WHERE pending, plus no other claim in flight.
    expect(/\.set\(\{ \.\.\.claimFields \}\)\s*\.where\(and\(eq\(tasks\.id, task\.id\), eq\(tasks\.status, 'pending'\), ownerClaimOpenSql\(\)\)\)/.test(route)).toBe(true);
    expect(/claimFields = \{[^}]*\bstatus\b/.test(route)).toBe(false);
    // The start goes through the door, and the route projects it itself when the kernel did not.
    expect(/\bkernelAttemptStarted\(/.test(route)).toBe(true);
    expect(/\bprojectAttemptStart\(\{/.test(route)).toBe(true);
    // The transition moves the task in its own statement.
    const kernel = code(`${KERNEL_DIR}kernel.ts`);
    expect(/ctes\.push\(\.\.\.startTaskProjectionCtes\(d, 'd'\)\)/.test(kernel)).toBe(true);
  });

  it('AC-1 slice 3: the worker PATCH leaves an owner end\'s status to the projection, and T4 projects it in its own statement', () => {
    const route = code('apps/web/src/app/api/workers/[id]/route.ts');
    // The completion snapshot takes status out of its fields and sets it only for a task that is no
    // delivery's owner (AC-1 slice 9); the route projects the owner's end after it.
    expect(/const \{ status: intendedTaskStatus, \.\.\.taskFields \} = taskUpdate;/.test(route)).toBe(true);
    expect(/\.set\(\{ \.\.\.taskFields, \.\.\.\(ownerTask \? \{\} : \{ status: intendedTaskStatus/.test(route)).toBe(true);
    expect(/\bprojectOwnerEnd\(\{/.test(route)).toBe(true);
    // The end goes to the kernel before the reads of the status in the same request.
    const endAt = route.indexOf('await workflowAttemptEnd();');
    expect(endAt).toBeGreaterThan(0);
    for (const reader of ["type: 'task.terminal'", "runStep('resolve-dependencies'", "type: 'worker.reported'", 'COMPLETION_POLICIES.release.settled(']) {
      expect(`${reader} after the end: ${route.indexOf(reader) > endAt}`).toBe(`${reader} after the end: true`);
    }
    const kernel = code(`${KERNEL_DIR}kernel.ts`);
    expect(/attemptEndTaskProjectionCtes\(/.test(kernel)).toBe(true);
    expect(/t_attempt AS \(/.test(code(`${KERNEL_DIR}task-projection.ts`))).toBe(true);
  });

  it('AC-1 slice 4: no ATTEMPT writer stores result.prUrl / prNumber; the PR is derived on read', () => {
    const attempt = Object.entries(TASK_STATUS_WRITERS).filter(([, why]) => why.startsWith('ATTEMPT')).map(([f]) => f);
    expect(attempt.flatMap((f) => resultPrWrites(code(f)).map((s) => `${f} ${s}`))).toEqual([]);
    // The one reader exists and the helper is what surfaces import.
    expect(/export function taskPrJsonSql\(/.test(code(`${KERNEL_DIR}task-pr.ts`))).toBe(true);
    // The scan can fail: each shape a snapshot took.
    expect(resultPrWrites(`taskUpdate.result = {\n summary,\n prUrl: w.prUrl ?? undefined,\n};`)).toEqual(['result@1']);
    expect(resultPrWrites(`.set({ status: 'completed', result: { summary: s, ...(w.prNumber ? { prNumber: w.prNumber } : {}) } })`)).toEqual(['result@1']);
    expect(resultPrWrites(`const result = { prUrl, commits };`)).toEqual(['result@1']);
    expect(resultPrWrites(`.set({ result: { summary: 'PR merged', loopHistory } })`)).toEqual([]);
    expect(resultPrWrites('.set({ result: { summary: `PR #${worker.prNumber} merged` } })')).toEqual([]);
    expect(resultPrWrites(`if (result == null) { prUrl: 1 }`)).toEqual([]);
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
