import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { computeMissionProgress, isWork, isBookkeeping, isAttempt, attachAttempts } from '../mission-helpers';

// ── Banned predicate grep ────────────────────────────────────────────────────
// These patterns represent the five divergent predicates that taskClass replaces.
// No UI filter code may use them — they are the banned read sites.
//
// Patterns are scoped to catch the OLD code forms without hitting legitimate uses:
//   - root/child split: requires `!` before parentTaskId inside a .filter( callback
//   - mode===planning: requires mode===planning to appear BEFORE .filter on the same line
//     (i.e. used as an exclusion predicate passed to filter, not found inside a filter callback)
//   - title.startsWith: requires a .filter( on the same line before the startsWith call
//   - deriveTaskType !== null: exact old collapse-predicate form

const BANNED_PATTERNS: Array<{ label: string; re: RegExp }> = [
  // .filter(t => !t.parentTaskId) — raw root/child split
  { label: 'raw root/child split: !parentTaskId inside .filter()', re: /filter\s*\([^)]*!\s*\w*\.?parentTaskId/ },
  // mode===planning used as a classification predicate *before* .filter on the same line
  // Does NOT fire when mode===planning appears inside a filter callback (filter comes first)
  { label: 'mode===planning as pre-filter exclusion variable', re: /mode\s*===?\s*['"]planning['"][^;\n]*\.filter\s*\(/ },
  // title.startsWith inside a .filter( callback on the same line
  { label: 'title.startsWith(bookkeeping prefix) inside .filter()', re: /\.filter\s*\([^;\n]*title.*\.startsWith\s*\(\s*['"](?:Aggregate|Mission:|Evaluate|Close mission)/ },
  // Old collapse predicate: deriveTaskType(t) !== null
  { label: 'old collapse predicate: deriveTaskType(...) !== null', re: /deriveTaskType[^)]*\)\s*!==?\s*null/ },
];

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (full.endsWith('.tsx') || full.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

// Scan apps/web/src/app/**/page.tsx and route.ts
const appDir = join(__dirname, '../../../apps/web/src/app');
const uiFiles = collectTsFiles(appDir).filter(f =>
  f.endsWith('/page.tsx') || f.endsWith('/route.ts') || f.endsWith('/TaskGrid.tsx'),
);

describe('banned predicate enforcement (A.5.i)', () => {
  for (const { label, re } of BANNED_PATTERNS) {
    it(`no UI file uses: ${label}`, () => {
      const violations: string[] = [];
      for (const file of uiFiles) {
        const src = readFileSync(file, 'utf8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            // Ignore comment-only lines
            const trimmed = lines[i].trimStart();
            if (!trimmed.startsWith('//') && !trimmed.startsWith('*')) {
              violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

// ── PRS ≤ TASKS invariant (A.5.ii) ──────────────────────────────────────────
// For any mission task list, the number of PR-producing tasks must not exceed
// the number of tasks counted in the progress denominator.

type TaskFixture = Parameters<typeof computeMissionProgress>[0][number] & {
  workers?: Array<{ prUrl: string | null }>;
};

function countPRs(tasks: TaskFixture[]): number {
  return tasks.flatMap(t => t.workers ?? []).filter(w => w.prUrl).length;
}

function assertPrsLeTasksInvariant(tasks: TaskFixture[]) {
  const { totalTasks } = computeMissionProgress(tasks);
  const prs = countPRs(tasks);
  if (totalTasks > 0) {
    expect(prs).toBeLessThanOrEqual(totalTasks);
  }
}

describe('PRS ≤ TASKS invariant (A.5.ii)', () => {
  it('holds for a simple mission with one work task and one PR', () => {
    const tasks: TaskFixture[] = [
      { status: 'completed', title: 'Build feature', taskClass: 'work', workers: [{ prUrl: 'https://github.com/org/repo/pull/1' }] },
    ];
    assertPrsLeTasksInvariant(tasks);
  });

  it('holds when attempts have their own PRs (attempts collapse under parent)', () => {
    const tasks: TaskFixture[] = [
      {
        id: 'root',
        status: 'completed',
        title: 'Build feature',
        taskClass: 'work',
        workers: [{ prUrl: 'https://github.com/org/repo/pull/1' }],
      },
      {
        id: 'retry1',
        status: 'failed',
        title: '[CI Retry #1] Build feature',
        taskClass: 'attempt',
        parentTaskId: 'root',
        workers: [{ prUrl: null }],
      },
    ];
    assertPrsLeTasksInvariant(tasks);
  });

  it('holds for a bookkeeping-only mission (0 tasks, 0 PRs)', () => {
    const tasks: TaskFixture[] = [
      { status: 'completed', title: 'Mission: plan', taskClass: 'bookkeeping', mode: 'planning', workers: [] },
      { status: 'completed', title: 'Aggregate results: done', taskClass: 'bookkeeping', workers: [] },
    ];
    assertPrsLeTasksInvariant(tasks);
  });

  it('holds for mixed work + bookkeeping mission', () => {
    const tasks: TaskFixture[] = [
      { status: 'completed', title: 'Implement auth', taskClass: 'work', workers: [{ prUrl: 'https://github.com/org/repo/pull/2' }] },
      { status: 'completed', title: 'Add tests', taskClass: 'work', workers: [{ prUrl: 'https://github.com/org/repo/pull/3' }] },
      { status: 'completed', title: 'Aggregate results: sprint', taskClass: 'bookkeeping', workers: [] },
      { status: 'completed', title: 'Mission: planning slot', taskClass: 'bookkeeping', mode: 'planning', workers: [] },
    ];
    assertPrsLeTasksInvariant(tasks);
  });
});

// ── Regression fixtures ──────────────────────────────────────────────────────
// Mission shapes from incidents described in the design spec.

describe('regression: de0357c2 mission shape (1 work + 1 bookkeeping)', () => {
  // The mission that triggered the "TASKS 1 vs View all 2" discrepancy.
  // One real work task + one bookkeeping orchestrator task.
  const tasks: TaskFixture[] = [
    { id: 't1', status: 'completed', title: 'Implement the merge endpoint', taskClass: 'work', workers: [{ prUrl: 'https://github.com/org/repo/pull/10' }] },
    { id: 't2', status: 'completed', title: 'Mission: merge endpoint planner', taskClass: 'bookkeeping', mode: 'planning', workers: [] },
  ];

  it('counts 1 work task (not 2)', () => {
    const { totalTasks } = computeMissionProgress(tasks);
    expect(totalTasks).toBe(1);
  });

  it('PRS ≤ TASKS', () => {
    assertPrsLeTasksInvariant(tasks);
  });

  it('reaches 100% when work task completes', () => {
    const { progress } = computeMissionProgress(tasks);
    expect(progress).toBe(100);
  });
});

describe('regression: 83e86c15 mission shape (3 work + 4 attempts + 2 bookkeeping)', () => {
  const tasks: TaskFixture[] = [
    { id: 'w1', status: 'completed', title: 'Build endpoint A', taskClass: 'work', workers: [{ prUrl: 'https://github.com/org/repo/pull/11' }] },
    { id: 'w2', status: 'completed', title: 'Build endpoint B', taskClass: 'work', workers: [{ prUrl: 'https://github.com/org/repo/pull/12' }] },
    { id: 'w3', status: 'in_progress', title: 'Build endpoint C', taskClass: 'work', workers: [{ prUrl: null }] },
    { id: 'a1', status: 'failed', title: '[CI Retry #1] Build endpoint A', taskClass: 'attempt', parentTaskId: 'w1', workers: [{ prUrl: null }] },
    { id: 'a2', status: 'failed', title: '[CI Retry #2] Build endpoint A', taskClass: 'attempt', parentTaskId: 'w1', workers: [{ prUrl: null }] },
    { id: 'a3', status: 'failed', title: '[reviewer] Build endpoint B', taskClass: 'attempt', parentTaskId: 'w2', workers: [{ prUrl: null }] },
    { id: 'a4', status: 'failed', title: '[reviewer retry #1] Build endpoint B', taskClass: 'attempt', parentTaskId: 'w2', workers: [{ prUrl: null }] },
    { id: 'b1', status: 'completed', title: 'Aggregate results: sprint', taskClass: 'bookkeeping', workers: [] },
    { id: 'b2', status: 'completed', title: 'Mission: planning slot', taskClass: 'bookkeeping', mode: 'planning', workers: [] },
  ];

  it('counts 3 work tasks (not 9)', () => {
    const { totalTasks } = computeMissionProgress(tasks);
    expect(totalTasks).toBe(3);
  });

  it('counts 2 completed work tasks', () => {
    const { completedTasks } = computeMissionProgress(tasks);
    expect(completedTasks).toBe(2);
  });

  it('reports ~67% progress', () => {
    const { progress } = computeMissionProgress(tasks);
    expect(progress).toBe(67);
  });

  it('PRS ≤ TASKS', () => {
    assertPrsLeTasksInvariant(tasks);
  });
});

// ── Selector unit tests ──────────────────────────────────────────────────────

describe('isWork / isBookkeeping / isAttempt selectors', () => {
  it('isWork returns true for taskClass=work', () => {
    expect(isWork({ taskClass: 'work' })).toBe(true);
    expect(isWork({ taskClass: 'attempt' })).toBe(false);
    expect(isWork({ taskClass: 'bookkeeping' })).toBe(false);
    expect(isWork({ taskClass: null })).toBe(false);
    expect(isWork({})).toBe(false);
  });

  it('isBookkeeping returns true for taskClass=bookkeeping', () => {
    expect(isBookkeeping({ taskClass: 'bookkeeping' })).toBe(true);
    expect(isBookkeeping({ taskClass: 'work' })).toBe(false);
    expect(isBookkeeping({ taskClass: null })).toBe(false);
  });

  it('isAttempt returns true for taskClass=attempt', () => {
    expect(isAttempt({ taskClass: 'attempt' })).toBe(true);
    expect(isAttempt({ taskClass: 'work' })).toBe(false);
    expect(isAttempt({ taskClass: null })).toBe(false);
  });
});

describe('attachAttempts', () => {
  it('groups attempt tasks by parentTaskId', () => {
    const tasks = [
      { id: 'root', taskClass: 'work', parentTaskId: null },
      { id: 'a1', taskClass: 'attempt', parentTaskId: 'root' },
      { id: 'a2', taskClass: 'attempt', parentTaskId: 'root' },
    ];
    const map = attachAttempts(tasks);
    expect(map.get('root')).toHaveLength(2);
    expect(map.has('root')).toBe(true);
  });

  it('ignores non-attempt tasks', () => {
    const tasks = [
      { id: 'root', taskClass: 'work', parentTaskId: null },
      { id: 'bk', taskClass: 'bookkeeping', parentTaskId: 'root' },
    ];
    const map = attachAttempts(tasks);
    expect(map.size).toBe(0);
  });

  it('returns empty map for empty input', () => {
    expect(attachAttempts([]).size).toBe(0);
  });

  it('ignores attempt tasks without parentTaskId', () => {
    const tasks = [
      { id: 'orphan', taskClass: 'attempt', parentTaskId: null },
    ];
    const map = attachAttempts(tasks);
    expect(map.size).toBe(0);
  });
});
