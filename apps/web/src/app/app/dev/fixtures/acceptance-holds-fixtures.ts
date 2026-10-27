import { createHash } from 'crypto';
import type { AcceptanceHold } from '@/lib/acceptance-edit-holds';

function fileHashAnchor(path: string): string {
  const hash = createHash('sha256').update(path).digest('hex');
  return `#diff-${hash}`;
}

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

export const expectedAnchorForQueue = fileHashAnchor('tests/acceptance/queue.test.ts');
export const expectedAnchorForSlots = fileHashAnchor('tests/acceptance/slots.test.ts');
export const expectedAnchorForLimits = fileHashAnchor('tests/acceptance/limits.test.ts');
