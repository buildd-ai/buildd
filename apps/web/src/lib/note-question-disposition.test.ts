/**
 * post_note type=question: an agent's question note carries a Needs You
 * disposition before it renders, and a recoverable blocker routes to repair.
 */
import { describe, expect, it } from 'bun:test';
import { admitsNoteToNeedsYou } from '@buildd/core/needs-you';
import { disposeQuestionNote, gatedNoteResponse, type QuestionNoteContext, type QuestionNoteInput } from './note-question-disposition';

const CTX: QuestionNoteContext = { teamId: 'team-1', dataClass: null, gitConfig: null, task: { title: 'Visual QA', pathManifest: ['apps/web/src/lib/x.ts'], missionId: 'm-1' } };
const BASE: QuestionNoteInput = {
  type: 'question', authorType: 'agent', title: 'Should I wait?', bodyText: null, defaultChoice: 'Wait',
  workspaceId: 'ws-1', missionId: 'm-1', taskId: 'task-1', workerId: 'worker-1',
};
const REPAIR = 'abcdef12-0000-0000-0000-000000000000';
const noFile = async () => { throw new Error('must not file'); };

describe('disposeQuestionNote', () => {
  it('a real question is disposed ask, and only then admitted', async () => {
    const d = await disposeQuestionNote({ ...BASE, title: 'Should the export use CSV or JSON?' }, { loadContext: async () => CTX, fileRepair: noFile });
    expect(d).toEqual({ disposition: 'ask' });
    expect(admitsNoteToNeedsYou({ type: 'question', authorType: 'agent', disposition: d.disposition })).toBe(true);
  });

  it('a recoverable blocker files a repair, is disposed recovered and never admitted', async () => {
    const filed: any[] = [];
    const d = await disposeQuestionNote(
      { ...BASE, title: 'Base CI is red', bodyText: 'CI is already failing on dev, unrelated to this change. Should I wait?' },
      { loadContext: async () => CTX, fileRepair: async (i) => { filed.push(i); return { id: REPAIR, reused: false }; }, record: async () => null },
    );
    expect(d).toMatchObject({ disposition: 'recovered', repairTaskId: REPAIR });
    expect(d.reason).toContain('abcdef12');
    expect(filed[0]).toMatchObject({ workspaceId: 'ws-1', missionId: 'm-1', blockedTaskId: 'task-1' });
    expect(admitsNoteToNeedsYou({ type: 'question', authorType: 'agent', disposition: d.disposition })).toBe(false);
    expect(gatedNoteResponse({ id: 'n' }, d)).toMatchObject({ id: 'n', gate: { disposition: 'recovered', repairTaskId: REPAIR } });
  });

  it('a hard rail still asks, whatever the text describes', async () => {
    const d = await disposeQuestionNote(
      { ...BASE, bodyText: 'CI is already failing on dev, unrelated to this change.' },
      { loadContext: async () => ({ ...CTX, task: { ...CTX.task!, pathManifest: ['.github/workflows/build.yml'] } }), fileRepair: noFile },
    );
    expect(d).toEqual({ disposition: 'ask', rail: 'ci_deploy' });
  });

  it('a person or the system needs no disposition', async () => {
    expect(await disposeQuestionNote({ ...BASE, authorType: 'user' }, { loadContext: async () => { throw new Error('no'); } })).toEqual({ disposition: null });
    expect(await disposeQuestionNote({ ...BASE, type: 'warning' })).toEqual({ disposition: null });
  });

  it('fails open to ask', async () => {
    expect(await disposeQuestionNote(BASE, { loadContext: async () => { throw new Error('db down'); } })).toEqual({ disposition: 'ask' });
    expect(await disposeQuestionNote({ ...BASE, taskId: null }, { loadContext: async () => CTX })).toEqual({ disposition: 'ask' });
  });
});
