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
  'landing-gate']);
const COMPOSITION_ROOT = 'apps/web/src/modules.ts';
// The package is matched too: importing `@buildd/workflow-kernel/reducer` is importing the reducer, and its
// root (`@buildd/workflow-kernel`, every module at once) reads as `index`, which is no entry point.
const KERNEL_IMPORT = /(?:from\s+|import\()\s*['"](?:(?:@\/lib\/workflow|(?:\.\.?\/)+(?:lib\/)?workflow|@buildd\/workflow-kernel)\/([a-z][a-z/-]*)|@buildd\/workflow-kernel()(?=['"]))['"]/g;

const TABLES = 'workflow_deliveries|workflow_review_rounds|workflow_facts|workflow_transitions|workflow_effects|workflow_attempts|workflow_commands|trunk_incidents';
const SYMBOLS = 'workflowDeliveries|workflowReviewRounds|workflowFacts|workflowTransitions|workflowEffects|workflowAttempts|workflowCommands|trunkIncidents';
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
    ]) expect(SQL_ACCESS.test(s)).toBe(true);
    for (const s of [
      'db.update(workflowDeliveries).set({ state: "MERGED" })',
      'db.insert(workflowEffects).values(row)',
      'db.select().from(workflowReviewRounds)',
      'db.query.trunkIncidents.findFirst()',
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
