import { describe, expect, it } from 'bun:test';
import type { ChatToolPart } from './chat-contract';
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

  it('reads a task draft: title, the description\'s first paragraph, and only the facts the input states', () => {
    const d = approvalDraft(part({
      title: 'Add a currency column', description: 'Add invoices.currency, defaulting to USD.\n\nMore detail.',
      kind: 'engineering', priority: 7, workspaceId: 'ws',
    }, 'create_task'));
    expect(d).toEqual({
      kind: 'task',
      title: 'Add a currency column',
      goal: 'Add invoices.currency, defaulting to USD.',
      facts: [
        { label: 'Kind', value: 'engineering' },
        { label: 'Priority', value: '7' },
        { label: 'Mission', value: 'none, a lone task' },
      ],
      workspaceId: 'ws',
    });
  });

  it('a task that joins a mission says so without inventing its name', () => {
    const d = approvalDraft(part({ missionId: 'm1' }, 'create_task'));
    expect(d.kind === 'task' && d.title).toBe('Untitled task');
    expect(d.kind === 'task' && d.facts).toEqual([{ label: 'Mission', value: 'adds to an existing mission' }]);
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
