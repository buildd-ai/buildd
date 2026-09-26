import { describe, expect, it } from 'bun:test';
import type { ChatToolPart } from './chat-contract';
import { encodeApprovalPreview } from '@buildd/shared';
import { approvalDraft, approvalVerb, firstParagraph } from './approval-draft';

const part = (input: Record<string, unknown>, name = 'manage_missions'): ChatToolPart => ({
  type: `tool-${name}`, toolCallId: 'c1', state: 'approval-requested', input, approval: { id: 'ap-1' },
});

describe('approvalDraft', () => {
  it('reads a mission draft: title, goal, criteria with their mechanical hint, constraints, plan', () => {
    const d = approvalDraft(part({
      action: 'create', workspaceId: 'ws', title: 'Multi-currency invoices',
      description: 'Let customers pay in their own currency.\n\nConstraints:\n- API changes are additive.',
      goalCriteria: [
        { type: 'all_prs_merged', label: 'every task PR merged' },
        { type: 'command', command: 'pnpm test -- currency', label: 'currency suite green' },
        { type: 'artifact_exists', key: 'fx-rounding-decision', label: 'rounding policy recorded' },
        { nonsense: true },
      ],
    }));
    expect(d.kind).toBe('mission');
    if (d.kind !== 'mission') return;
    expect(d.title).toBe('Multi-currency invoices');
    expect(d.goal).toBe('Let customers pay in their own currency.');
    expect(d.criteria).toEqual([
      { label: 'every task PR merged', hint: null },
      { label: 'currency suite green', hint: 'pnpm test -- currency' },
      { label: 'rounding policy recorded', hint: 'artifact · fx-rounding-decision' },
    ]);
    expect(d.constraints).toBe('API changes are additive.');
    expect(d.plan).toBe('Plan first · starts now · no schedule');
    expect(d.workspaceId).toBe('ws');
  });

  it('never invents: a held, scheduled draft says so, and a missing title reads as untitled', () => {
    const d = approvalDraft(part({ action: 'create', startMode: 'held', cronExpression: '0 9 * * *' }));
    expect(d.kind === 'mission' && d.title).toBe('Untitled mission');
    expect(d.kind === 'mission' && d.plan).toBe('Plan first · held until you arm it · schedule 0 9 * * *');
    expect(d.kind === 'mission' && d.criteria).toEqual([]);
  });

  it('any other write renders its fields, without the action or workspace id', () => {
    const d = approvalDraft(part({ action: 'update', missionId: 'm1', title: 'x' }));
    expect(d).toEqual({ kind: 'generic', fields: [{ key: 'missionId', value: 'm1' }, { key: 'title', value: 'x' }], workspaceId: null });
  });

  it('names the tool as the verb', () => {
    expect(approvalVerb(part({ action: 'create' }))).toBe('manage_missions · create');
    expect(approvalVerb(part({}, 'create_task'))).toBe('create_task');
  });

  it('firstParagraph strips markdown', () => {
    expect(firstParagraph('## Goal **now**\n\nmore')).toBe('Goal now');
    expect(firstParagraph(null)).toBeNull();
  });
});

describe('approvalDraft — a write on an existing object shows the server\'s before → after', () => {
  const withPreview = (name: string, input: Record<string, unknown>, preview: Record<string, unknown>): ChatToolPart => ({
    ...part(input, name), approval: { id: 'ap-1', requestReason: encodeApprovalPreview(preview as any) },
  });

  it('hold: headline names the task and where it runs; one change line', () => {
    const d = approvalDraft(withPreview('hold_task', { taskId: 'checkout' }, {
      v: 1, verb: 'Hold task', fingerprint: 'f',
      target: { kind: 'task', id: 't', label: 'checkout · Stripe in currency', detail: 'running on dune', workspaceId: 'ws' },
      changes: [{ label: 'Claims', before: 'open', after: 'held' }],
      note: 'The agent running on dune is told to stop at a safe point and wait.',
    }));
    expect(d.kind).toBe('preview');
    if (d.kind !== 'preview') return;
    expect(d.headline).toBe('Hold task: checkout · Stripe in currency (running on dune)');
    expect(d.changes.map(c => c.line)).toEqual(['Claims: open → held']);
    expect(d.note).toContain('safe point');
    expect(d.workspaceId).toBe('ws');
    expect(d.confirmText).toBeNull();
  });

  it('criteria diff reads as + / −, and an admin card carries the name to type', () => {
    const d = approvalDraft(withPreview('manage_missions', { action: 'update' }, {
      v: 1, verb: 'Edit mission', fingerprint: 'f', confirmText: 'Multi-currency checkout',
      target: { kind: 'mission', id: 'm', label: 'Multi-currency checkout' },
      changes: [{ label: 'Goal criteria', before: null, after: 'JPY e2e passes' }, { label: 'Goal criteria', before: 'admin guide published', after: null }],
    }));
    if (d.kind !== 'preview') throw new Error('preview expected');
    expect(d.changes.map(c => c.line)).toEqual(['Goal criteria: + JPY e2e passes', 'Goal criteria: − admin guide published']);
    expect(d.confirmText).toBe('Multi-currency checkout');
  });

  it('mission filing keeps its own draft card; a garbled reason falls back to the field list', () => {
    expect(approvalDraft(part({ action: 'create', title: 'X' })).kind).toBe('mission');
    const garbled: ChatToolPart = { ...part({ taskId: 't' }, 'update_task'), approval: { id: 'ap', requestReason: 'buildd-preview:{nope' } };
    expect(approvalDraft(garbled).kind).toBe('generic');
  });
});
