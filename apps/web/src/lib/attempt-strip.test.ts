import { describe, it, expect } from 'bun:test';
import { attachAttempts } from '@buildd/core/mission-helpers';
import { deriveTaskOrigin } from './task-origin';
import {
  buildAttemptStrips,
  partitionBookkeeping,
  repoFullNameFromPrUrl,
  type AttemptSourceTask,
} from './attempt-strip';

/**
 * U8 — attempts move from the bookkeeping footer onto their parent task's row.
 *
 * Every fact in a strip comes from an existing canonical source: grouping from
 * `attachAttempts`, the per-attempt reason from `deriveTaskOrigin`, the class
 * from `taskClass`. These tests pin that provenance — a title-parsing shortcut
 * or a local re-grouping would break them.
 */

function task(over: Partial<AttemptSourceTask> & { id: string }): AttemptSourceTask {
  return {
    status: 'completed',
    taskClass: 'work',
    parentTaskId: null,
    updatedAt: '2025-01-01T00:00:00Z',
    ...over,
  } as AttemptSourceTask;
}

/** One work task with two CI retries (both settled) and one live reviewer retry. */
const MISSION: AttemptSourceTask[] = [
  task({ id: 'w1', title: 'Implement the merge endpoint', taskClass: 'work' }),
  task({
    id: 'a1',
    title: '[CI Retry #1] Implement the merge endpoint',
    taskClass: 'attempt',
    parentTaskId: 'w1',
    status: 'failed',
    ciRetryPrNumber: 1204,
    context: { iteration: 1, maxIterations: 3, failureContext: { errorType: 'ci_failure' } },
    updatedAt: '2025-01-01T01:00:00Z',
  }),
  task({
    id: 'a2',
    title: '[CI Retry #2] Implement the merge endpoint',
    taskClass: 'attempt',
    parentTaskId: 'w1',
    status: 'failed',
    ciRetryPrNumber: 1204,
    context: { iteration: 2, maxIterations: 3, failureContext: { errorType: 'ci_failure' } },
    updatedAt: '2025-01-01T02:00:00Z',
  }),
  task({
    id: 'a3',
    title: '[reviewer retry #1] Implement the merge endpoint',
    taskClass: 'attempt',
    parentTaskId: 'w1',
    status: 'in_progress',
    reviewerRetryPrNumber: 1204,
    context: { iteration: 1, maxIterations: 2, failureContext: { errorType: 'reviewer_request_changes' } },
    updatedAt: '2025-01-01T03:00:00Z',
  }),
  task({ id: 'b1', title: 'Mission: planning slot', taskClass: 'bookkeeping', mode: 'planning' }),
];

describe('buildAttemptStrips — summary line', () => {
  const strips = buildAttemptStrips(MISSION);

  it('keys strips by parent task id, exactly as attachAttempts groups them', () => {
    expect([...strips.keys()]).toEqual([...attachAttempts(MISSION).keys()]);
    expect(strips.get('w1')!.total).toBe(3);
  });

  it('renders the design summary: 3 attempts · CI ×2 · reviewer ×1', () => {
    expect(strips.get('w1')!.summary).toBe('3 attempts · CI ×2 · reviewer ×1');
  });

  it('renders one dot per attempt, open for the one still running', () => {
    expect(strips.get('w1')!.dots).toBe('●●○');
  });

  it('singularises a lone attempt and omits zero-count kinds', () => {
    const solo = buildAttemptStrips([
      task({ id: 'w2', taskClass: 'work' }),
      task({
        id: 'c1', taskClass: 'attempt', parentTaskId: 'w2', status: 'completed',
        conflictRetryPrNumber: 77, context: { conflictIteration: 1, maxConflictIterations: 2 },
      }),
    ]);
    expect(solo.get('w2')!.summary).toBe('1 attempt · conflict ×1');
    expect(solo.get('w2')!.dots).toBe('●');
  });

  it('emits no strip for a task with no attempts', () => {
    expect(buildAttemptStrips([task({ id: 'lonely' })]).size).toBe(0);
  });

  it('counts only taskClass=attempt children, never every child with a parentTaskId', () => {
    // A spawned execution child and a bookkeeping child both carry parentTaskId
    // and are NOT attempts. `attachAttempts` knows that; a local regroup on
    // parentTaskId does not — which is the whole reason to call the shared one.
    const mixedChildren: AttemptSourceTask[] = [
      task({ id: 'p1', taskClass: 'work' }),
      task({ id: 'child-work', taskClass: 'work', parentTaskId: 'p1', mode: 'execution' }),
      task({ id: 'child-bk', taskClass: 'bookkeeping', parentTaskId: 'p1', mode: 'planning' }),
      task({
        id: 'child-attempt', taskClass: 'attempt', parentTaskId: 'p1', status: 'failed',
        ciRetryPrNumber: 5, context: { iteration: 1, maxIterations: 3 },
      }),
    ];
    const strip = buildAttemptStrips(mixedChildren).get('p1')!;
    expect(strip.total).toBe(1);
    expect(strip.attempts.map(a => a.id)).toEqual(['child-attempt']);
    expect(strip.summary).toBe('1 attempt · CI ×1');
  });

  it('ignores an attempt with no parent — nothing to attach it to', () => {
    expect(buildAttemptStrips([task({ id: 'orphan', taskClass: 'attempt', parentTaskId: null })]).size).toBe(0);
  });
});

describe('buildAttemptStrips — per-attempt reason comes from deriveTaskOrigin', () => {
  const strip = buildAttemptStrips(MISSION).get('w1')!;

  it('states why each attempt exists, byte-identical to deriveTaskOrigin', () => {
    const source = MISSION.find(t => t.id === 'a1')!;
    const expected = deriveTaskOrigin(source).parts.join(' · ');
    expect(expected.length).toBeGreaterThan(0);
    expect(strip.attempts[0].reason).toBe(expected);
    expect(strip.attempts[0].reason).toBe('CI retry #1 of 3 · PR #1204 check_suite failed');
  });

  it('distinguishes the reviewer retry from the CI retries', () => {
    expect(strip.attempts[2].reason).toBe('Reviewer retry #1 of 2 · PR #1204 reviewer requested changes');
    expect(strip.attempts.map(a => a.kind)).toEqual(['ci', 'ci', 'reviewer']);
  });

  it('orders attempts oldest first so the dots read left to right in time', () => {
    expect(strip.attempts.map(a => a.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('links each attempt to its own task page and its PR when the repo is known', () => {
    const withRepo = buildAttemptStrips(MISSION, { repoFullName: 'buildd-ai/buildd' }).get('w1')!;
    expect(withRepo.attempts[0].href).toBe('/app/tasks/a1');
    expect(withRepo.attempts[0].prLink).toEqual({
      key: 'pr',
      label: 'PR #1204',
      href: 'https://github.com/buildd-ai/buildd/pull/1204',
    });
  });

  it('omits the PR link rather than inventing a URL when no repo is known', () => {
    expect(strip.attempts[0].prLink).toBeNull();
  });

  it('falls back to the taskClass reason when the retry columns were never populated', () => {
    const bare = buildAttemptStrips([
      task({ id: 'w3' }),
      task({ id: 'x1', taskClass: 'attempt', parentTaskId: 'w3', status: 'failed' }),
    ]).get('w3')!;
    expect(bare.attempts[0].reason).toBe('retry attempt');
    expect(bare.summary).toBe('1 attempt');
  });
});

describe('names the role that ran the attempt', () => {
  const withRole: AttemptSourceTask[] = [
    task({ id: 'w4' }),
    task({
      id: 'r1', taskClass: 'attempt', parentTaskId: 'w4', status: 'failed',
      roleSlug: 'builder', ciRetryPrNumber: 9, context: { iteration: 1 },
    }),
  ];

  it('prefers the runner role over the creator, because that is who did the work', () => {
    const strip = buildAttemptStrips(withRole, {
      roleNameBySlug: new Map([['builder', 'Builder']]),
    }).get('w4')!;
    expect(strip.attempts[0].actor).toBe('Builder');
  });

  it('falls back to the slug when the role has no display name loaded', () => {
    expect(buildAttemptStrips(withRole).get('w4')!.attempts[0].actor).toBe('builder');
  });

  it('leaves the actor null when nothing names a runner or a creator', () => {
    const anon = buildAttemptStrips([
      task({ id: 'w5' }),
      task({ id: 'n1', taskClass: 'attempt', parentTaskId: 'w5', status: 'failed' }),
    ]).get('w5')!;
    expect(anon.attempts[0].actor).toBeNull();
  });
});

describe('repoFullNameFromPrUrl', () => {
  it('reads owner/repo out of a GitHub PR url', () => {
    expect(repoFullNameFromPrUrl('https://github.com/buildd-ai/buildd/pull/1204')).toBe('buildd-ai/buildd');
  });

  it('returns null for a non-PR url rather than guessing', () => {
    expect(repoFullNameFromPrUrl('https://github.com/buildd-ai/buildd')).toBeNull();
    expect(repoFullNameFromPrUrl('https://example.com/x/y/pull/1')).toBeNull();
    expect(repoFullNameFromPrUrl(null)).toBeNull();
    expect(repoFullNameFromPrUrl('')).toBeNull();
  });
});

describe('partitionBookkeeping — the footer keeps only genuine housekeeping', () => {
  it('moves attempts onto rendered rows and leaves bookkeeping in the footer', () => {
    const { footer } = partitionBookkeeping(MISSION, new Set(['w1']));
    expect(footer.map(t => t.id)).toEqual(['b1']);
  });

  it('keeps an attempt in the footer when its parent row is not rendered', () => {
    // Losing the row entirely would delete the only published trace of the run.
    const { footer } = partitionBookkeeping(MISSION, new Set());
    expect(footer.map(t => t.id).sort()).toEqual(['a1', 'a2', 'a3', 'b1']);
  });

  it('never puts a work task in the footer', () => {
    const { footer } = partitionBookkeeping(MISSION, new Set(['w1']));
    expect(footer.some(t => t.taskClass === 'work')).toBe(false);
  });
});
