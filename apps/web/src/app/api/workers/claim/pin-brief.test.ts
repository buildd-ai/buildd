/**
 * The claimed task's Living Spec brief and the one approval ask
 * (living-specs.md §20, R-82, R-83; lib/specs/task-handoff.ts).
 */
import { describe, expect, it, mock } from 'bun:test';

const emitted: unknown[] = [];
mock.module('@/lib/core-emit', () => ({ emit: async (e: unknown) => { emitted.push(e); } }));
import { attachSpecPinBriefs, type ApprovalAsk, type SpecPinAtClaim } from './pin-brief';

const worker = (taskId: string) => ({ id: `w-${taskId}`, taskId, branch: 'b', task: { id: taskId, context: {} } }) as any;

describe('attachSpecPinBriefs', () => {
  it('appends the brief to the claimed worker and asks the approvers once', async () => {
    const blocks: Array<[string, string]> = [];
    const asks: ApprovalAsk[] = [];
    const pins = new Map<string, SpecPinAtClaim>([
      ['t1', { brief: '## Living Spec\nbuild it', ask: { specId: 's1', revision: 2, title: 'Checkout' }, workspaceId: 'ws' }],
    ]);
    attachSpecPinBriefs([worker('t1')], pins, (cw, b) => blocks.push([cw.taskId, b]), async (a) => { asks.push(a); });
    expect(blocks).toEqual([['t1', '## Living Spec\nbuild it']]);
    expect(asks).toEqual([{ workspaceId: 'ws', specId: 's1', revision: 2, title: 'Checkout' }]);
  });

  it('a task whose claim did not stand gets nothing, and nobody is asked', () => {
    const asks: ApprovalAsk[] = [];
    const pins = new Map<string, SpecPinAtClaim>([['lost', { brief: 'x', ask: { specId: 's1', revision: 2, title: 'T' }, workspaceId: 'ws' }]]);
    attachSpecPinBriefs([worker('t2')], pins, () => { throw new Error('no block expected'); }, async (a) => { asks.push(a); });
    expect(asks).toEqual([]);
  });

  it('an approved pin carries a brief and asks nobody', () => {
    const asks: ApprovalAsk[] = [];
    const blocks: string[] = [];
    attachSpecPinBriefs([worker('t1')], new Map([['t1', { brief: 'approved', ask: null, workspaceId: 'ws' }]]), (_cw, b) => blocks.push(b), async (a) => { asks.push(a); });
    expect(blocks).toEqual(['approved']);
    expect(asks).toEqual([]);
  });

  it('a failed ask never fails the claim', async () => {
    attachSpecPinBriefs([worker('t1')], new Map([['t1', { brief: null, ask: { specId: 's', revision: 1, title: 'T' }, workspaceId: 'ws' }]]), () => {}, async () => { throw new Error('push down'); });
    await new Promise((r) => setTimeout(r, 0));
  });

  it('the default ask no longer emits spec.approval_requested: approvers are asked when the revision is written', async () => {
    attachSpecPinBriefs([worker('t1')], new Map([['t1', { brief: 'b', ask: { specId: 's', revision: 1, title: 'T' }, workspaceId: 'ws' }]]), () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toEqual([]);
  });
});
