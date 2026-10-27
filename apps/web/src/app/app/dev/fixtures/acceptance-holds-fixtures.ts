import type { AcceptanceHold } from '@/lib/acceptance-edit-holds';

/** A mission with two builder PRs that each edited acceptance tests nobody has accepted yet. */
export const twoFlaggedEdits: AcceptanceHold[] = [
  {
    taskId: 'task-flagged-1',
    prNumber: 5708,
    diffUrl: 'https://github.com/example/repo/pull/5708/files',
    paths: ['tests/acceptance/queue.test.ts'],
  },
  {
    taskId: 'task-flagged-2',
    prNumber: 5709,
    diffUrl: 'https://github.com/example/repo/pull/5709/files',
    paths: ['tests/acceptance/slots.test.ts', 'tests/acceptance/limits.test.ts'],
  },
];
