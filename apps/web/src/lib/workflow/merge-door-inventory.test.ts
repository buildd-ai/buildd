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
  'apps/web/src/app/api/github/webhook/route.ts': { what: 'D7: release PR on green CI; a kernel PR lands through the kernel', calls: 1 },
  'apps/web/src/lib/release/pinned-merge.ts': { what: 'D8/D9/D10: the release doors, review gate + pinned to the verified head', calls: 1 },
  'apps/web/src/lib/specs/repo-copy.ts': { what: 'D14: a Living Spec\'s generated repo copy, only the generator\'s own commit, pinned (living-specs R-35)', calls: 1 },
  'apps/web/src/lib/release-executor.ts': { what: 'not a door: a branch-to-prod merge with no PR (POST /merges)', calls: 1 },
  'apps/web/src/lib/mission-branch-refresh.ts': { what: 'not a door: a base refresh into a mission branch (POST /merges)', calls: 1 },
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

  test('no GraphQL merge and no GitHub auto-merge anywhere', () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(r, files);
    const gql = files.filter((f) => PATTERNS.graphql_merge!.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))));
    expect(gql).toEqual([]);
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
