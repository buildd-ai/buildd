/**
 * The merge door inventory, held to the code (docs/specs/workflow-state-kernel.md
 * §13.13 D1–D14; workflow-kernel-library.md §4). Every place that can merge a
 * PR on GitHub is listed here with the door it is and how it reaches the
 * landing gate. A new merge call anywhere fails this test until it is routed
 * through the gate and added to the inventory, so a door cannot appear
 * silently (the class #4686 was).
 *
 * Each door's behaviour is proven where it lives; `PROVEN_BY` names that test.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../../../../..');
const ROOTS = ['apps/web/src', 'packages/core', 'apps/control-plane/src', 'packages/workflow-kernel/src', 'apps/dispatch/src'];

/** A reference to the one REST merge helper, a REST merge path, a branch-to-branch merge, or a GraphQL merge. */
const PATTERNS: Record<string, RegExp> = {
  merge_helper: /\bmergePullRequest\b/,
  rest_merge: /\/pulls\/\$\{[^}]+\}\/merge[`'"]/,
  branch_merge: /\/merges[`'"]/,
  graphql_merge: /enablePullRequestAutoMerge|mergePullRequest\s*\(\s*input/,
};

/** File → what it is (doors name their §13.13 id) and how many merge calls it holds. */
const INVENTORY: Record<string, { what: string; calls: number }> = {
  'apps/web/src/lib/github.ts': { what: 'the one REST merge helper, pinned with `sha` (its definition and its URL)', calls: 2 },
  'apps/web/src/lib/workflow/kernel-ports.ts': { what: 'D1: the kernel merge_call effect (GithubWrites.mergeAtHead), behind the gate at merge time', calls: 1 },
  'apps/web/src/lib/pr-landing.ts': { what: 'D2/D3: landPr; a kernel PR lands through the kernel', calls: 1 },
  'apps/web/src/lib/auto-merge.ts': { what: 'D4: tryAutoMergeWorkerPr; never without a workspace to read the verdict in', calls: 1 },
  'apps/web/src/app/api/github/pr/route.ts': { what: 'D5: merge_pr; `force` never skips the review verdict', calls: 1 },
  'apps/web/src/app/api/prs/[prNumber]/merge/route.ts': { what: 'D6: the dashboard merge (a person may override, recorded)', calls: 1 },
  'apps/web/src/lib/held-pr-tasks.ts': { what: 'D7: release PR on green CI (webhook and the held-release sweep); a kernel PR lands through the kernel', calls: 1 },
  'apps/web/src/lib/release/pinned-merge.ts': { what: 'D8/D9/D10: the release doors, review gate + pinned to the verified head (release-executor.ts holds no merge call of its own: a branch with no PR is refused, never merged)', calls: 1 },
  'apps/web/src/lib/specs/repo-copy.ts': { what: 'D14: a Living Spec\'s generated repo copy, only the generator\'s own commit, pinned (living-specs R-35)', calls: 1 },
  'apps/web/src/lib/mission-branch-refresh.ts': { what: 'not a door: a base refresh into a mission branch (POST /merges)', calls: 1 },
  'apps/web/src/lib/workflow/delivery-epochs.ts': { what: 'not a door: the settlement tree probe, a test merge onto a scratch ref deleted in the same step (POST /merges, workflow-kernel-library §6)', calls: 1 },
};

/** One merge call: the helper called, a REST merge path, a branch merge, the kernel's pinned call. */
const CALL = /\bmergePullRequest\(|\/pulls\/\$\{[^}]+\}\/merge[`'"]|\/merges[`'"]|\bmerge\(installationId/g;

const PROVEN_BY: Record<string, string> = {
  D1: 'packages/workflow-kernel/src/conformance/scenarios.ts (AC-14, gate at merge time) on both stores',
  D2: 'apps/web/src/lib/pr-landing.test.ts',
  D3: 'apps/web/src/lib/pr-landing-sweep.landpr.test.ts',
  D4: 'apps/web/src/lib/auto-merge.test.ts (D4)',
  D5: 'apps/web/src/app/api/github/pr/route.test.ts (D5)',
  D6: 'apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts',
  D7: 'apps/web/src/app/api/github/webhook/route.test.ts (D7)',
  D8: 'apps/web/src/lib/release-executor.test.ts (AC-16)',
  D9: 'apps/web/src/lib/release-executor.test.ts (D9)',
  D10: 'apps/web/src/lib/release/pinned-merge.test.ts',
  D11: 'packages/workflow-kernel/src/landing-gate.test.ts (policy rule passes an escalation only)',
  D12: 'packages/workflow-kernel/src/conformance/scenarios.ts (AC-15) and the buildd/landing status',
  D13: 'apps/runner/__tests__/unit/pr-mutation-enforcement.test.ts and apps/cloud-runner/src/outbound.test.ts',
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(join(ROOT, dir))) return;
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === 'testing' || name.startsWith('.')) continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
}

describe('merge door inventory (§13.13)', () => {
  test('every place that can merge a PR is a known door, and every known door still exists', () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);
    const found = files.filter((f) => {
      const src = stripComments(readFileSync(join(ROOT, f), 'utf8'));
      return Object.values(PATTERNS).some((re) => re.test(src));
    }).sort();
    expect(found, 'a new merge call: route it through the landing gate (kernel-client landThroughKernel, or release/pinned-merge.ts) and add it to §13.13 and INVENTORY').toEqual(Object.keys(INVENTORY).sort());
  });

  test('each known door holds exactly the merge calls it is known for: a second merge inside a door is a new door', () => {
    const counts = Object.fromEntries(Object.keys(INVENTORY).map((f) => [f, (stripComments(readFileSync(join(ROOT, f), 'utf8')).match(CALL) ?? []).length]));
    expect(counts).toEqual(Object.fromEntries(Object.entries(INVENTORY).map(([f, v]) => [f, v.calls])));
  });

  test('D8/D9: the release executor holds no merge call of its own; both arms merge through release/pinned-merge.ts', () => {
    // It used to POST /merges a worker branch with no PR into the prod branch, past the review
    // gate, CI and any head pin (task d932a5b4). That arm is now a refusal.
    const src = stripComments(readFileSync(join(ROOT, 'apps/web/src/lib/release-executor.ts'), 'utf8'));
    expect(src.match(CALL) ?? []).toEqual([]);
    expect(Object.values(PATTERNS).some((re) => re.test(src))).toBe(false);
    expect(src.match(/\bmergeReleasePrPinned\(/g)?.length).toBe(2);
  });

  test('no GraphQL merge and no GitHub auto-merge anywhere', () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);
    const gql = files.filter((f) => PATTERNS.graphql_merge!.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))));
    expect(gql).toEqual([]);
  });

  /**
   * AC-13 (§4): a PR with no delivery is adopted (open_delivery) before a worker door decides who
   * owns it, so the door lands it through the kernel's gate; a refused adoption merges nothing.
   * Each door asks `adoptBeforeMerge` before its kernel-ownership read and before its legacy merge
   * call, and its legacy merge call is reachable only on the adoption's `legacy` answer (kill switch
   * off, or a delivery released to legacy). The release doors D7–D10 keep the release gate (§4).
   */
  const ADOPTING_DOORS: Record<string, { door: string; ownership: RegExp }> = {
    'apps/web/src/lib/pr-landing.ts': { door: 'D2/D3', ownership: /kernelView = await kernelStatus\(\);\n\s*if \(kernelView\?\.current\.state === 'REPAIRING'\)/ },
    'apps/web/src/lib/auto-merge.ts': { door: 'D4', ownership: /const kernelLand = / },
    'apps/web/src/app/api/github/pr/route.ts': { door: 'D5', ownership: /const kernelView = await kernelLandingView\(worker\.workspaceId, repo\.fullName, prNumber\)/ },
    'apps/web/src/app/api/prs/[prNumber]/merge/route.ts': { door: 'D6', ownership: /const kernelView = await kernelLandingView\(worker\.workspaceId, repoFullName, prNumber\)/ },
  };
  for (const [file, { door, ownership }] of Object.entries(ADOPTING_DOORS)) {
    test(`${door}: a PR with no delivery is adopted before the door reads who owns it or merges it`, () => {
      const src = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      const adopt = src.indexOf('adoptBeforeMerge(');
      expect(adopt, `${file} must call adoptBeforeMerge`).toBeGreaterThan(-1);
      expect(src.match(/adoptBeforeMerge\(/g)?.length, `${file}: one adoption per door`).toBe(1);
      const own = src.search(ownership);
      expect(own, `${file}: the kernel-ownership read moved; update ADOPTING_DOORS`).toBeGreaterThan(-1);
      expect(adopt, `${file}: adoption comes before the ownership read`).toBeLessThan(own);
      expect(adopt, `${file}: adoption comes before the legacy merge call`).toBeLessThan(src.indexOf('mergePullRequest('));
      // A refused adoption returns before anything else runs.
      expect(src.slice(adopt, adopt + 1200)).toMatch(/adoption\.kind === 'refused'/);
    });
  }

  test('the release doors D7–D10 do not adopt: their bookkeeping lives outside the kernel (§4)', () => {
    for (const f of ['apps/web/src/lib/held-pr-tasks.ts', 'apps/web/src/lib/release/pinned-merge.ts', 'apps/web/src/lib/release-executor.ts']) {
      expect(stripComments(readFileSync(join(ROOT, f), 'utf8')).includes('adoptBeforeMerge('), f).toBe(false);
    }
  });

  test('every door D1–D13 names the test that proves it reaches the gate, and that test exists', () => {
    for (let i = 1; i <= 13; i++) expect(PROVEN_BY[`D${i}`], `D${i}`).toBeDefined();
    for (const [door, where] of Object.entries(PROVEN_BY)) {
      for (const path of where.match(/[\w./[\]-]+\.test\.ts|[\w./-]+scenarios\.ts/g) ?? []) {
        expect(existsSync(join(ROOT, path)), `${door}: ${path}`).toBe(true);
      }
    }
  });
});
