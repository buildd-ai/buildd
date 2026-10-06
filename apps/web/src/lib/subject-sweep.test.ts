import { describe, it, expect, mock } from 'bun:test';

// The sweep is now the `close_reconciles_subject` rule of the supersession
// table; its decisions (binding anchors only, unstarted work only, no live
// successor) are tested in supersession.test.ts and its liveness read in
// supersession-store.test.ts. Here: the wrapper's event and its result shape.
const mockReconcileSubjectEvent = mock(async (..._args: any[]): Promise<any> => ({
  cancelled: [{ taskId: 'a', rule: 'close_reconciles_subject' }],
  lostRace: [],
  decisions: [{}, {}, {}],
}));
mock.module('./supersession', () => ({ reconcileSubjectEvent: mockReconcileSubjectEvent }));

import { sweepSubjectAnchoredTasks } from './subject-sweep';

describe('sweepSubjectAnchoredTasks', () => {
  it('runs only close_reconciles_subject, as a subject_check event for the PR', async () => {
    const result = await sweepSubjectAnchoredTasks('ws-1', 42);
    const [event, opts] = mockReconcileSubjectEvent.mock.calls[0] as any[];
    expect(event).toMatchObject({ kind: 'subject_check', workspaceId: 'ws-1', prNumber: 42 });
    expect(opts).toEqual({ rules: ['close_reconciles_subject'] });
    expect(result).toEqual({ anchored: 3, reconciled: 1, cancelled: 1 });
  });
});
