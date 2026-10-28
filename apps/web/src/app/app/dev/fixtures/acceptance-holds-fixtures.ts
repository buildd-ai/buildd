import type { AcceptanceHold } from '@/lib/acceptance-edit-holds';

/** A mission with two builder PRs that each edited acceptance tests nobody has accepted yet. */
export const twoFlaggedEdits: AcceptanceHold[] = [
  {
    taskId: 'task-flagged-1',
    prNumber: 5708,
    diffUrl: 'https://github.com/example/repo/pull/5708/files',
    paths: ['tests/acceptance/queue.test.ts'],
    weakened: [{ path: 'tests/acceptance/queue.test.ts', text: 'In "queues a task": the check on `res.status` got looser (was exact, now partial)' }],
  },
  {
    taskId: 'task-flagged-2',
    prNumber: 5709,
    diffUrl: 'https://github.com/example/repo/pull/5709/files',
    paths: ['tests/acceptance/slots.test.ts', 'tests/acceptance/limits.test.ts'],
    weakened: [
      { path: 'tests/acceptance/slots.test.ts', text: 'The test "frees a slot" was removed' },
      { path: 'tests/acceptance/limits.test.ts', text: 'Could not read this file, so it was not checked.' },
    ],
  },
];
