/**
 * S6: a mission task's feed lists mission-scoped questions, and those are
 * announced on the mission channel — so the feed must listen there too, or a
 * question asked while the page is open never appears until a reload.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskQuestionFeed, { questionFeedChannels, partitionQuestionNotes } from './TaskQuestionFeed';

describe('partitionQuestionNotes', () => {
  const notes = [
    { id: 'a', type: 'question', status: 'open' },
    { id: 'b', type: 'question', status: 'answered' },
    { id: 'c', type: 'decision', status: 'open' },
    { id: 'd', type: 'question', status: 'open' },
  ] as any[];

  it('puts the retained open question of a completed task into history', () => {
    const stale = [{ id: 'old', type: 'question', status: 'open', workerId: 'ended' }] as any[];
    const result = partitionQuestionNotes(stale, null, { taskStatus: 'completed', activeWorkerId: 'ended', activeWorkerStatus: 'waiting_input' });
    expect(result.open).toEqual([]);
    expect(result.answered.map(n => n.id)).toEqual(['old']);
  });

  it('does not revive an earlier worker question while a newer worker waits', () => {
    const stale = [{ id: 'old', type: 'question', status: 'open', workerId: 'ended' }] as any[];
    expect(partitionQuestionNotes(stale, null, { taskStatus: 'running', activeWorkerId: 'new', activeWorkerStatus: 'waiting_input' }).open).toEqual([]);
  });

  it('skips the question the live worker view already shows (one question, one surface)', () => {
    const { open, answered } = partitionQuestionNotes(notes, 'a', { taskStatus: 'running', activeWorkerId: 'w', activeWorkerStatus: 'waiting_input' });
    expect(open.map(n => n.id)).toEqual(['d']);
    expect(answered.map(n => n.id)).toEqual(['b']);
  });

  it('shows every open question when nothing is linked', () => {
    expect(partitionQuestionNotes(notes, null, { taskStatus: 'running', activeWorkerId: 'w', activeWorkerStatus: 'waiting_input' }).open.map(n => n.id)).toEqual(['a', 'd']);
  });
});

describe('questionFeedChannels', () => {
  it('listens on the task channel alone for a non-mission task', () => {
    expect(questionFeedChannels('t1', null, 'p-')).toEqual(['p-task-t1']);
  });

  it('also listens on the mission channel for a mission task', () => {
    expect(questionFeedChannels('t1', 'm1', 'p-')).toEqual(['p-task-t1', 'p-mission-m1']);
  });
});


describe('past question rendering', () => {
  it('collapses stale questions with the recorded answer or Not answered, without answer controls', () => {
    const html = renderToStaticMarkup(<TaskQuestionFeed taskId="t" taskStatus="completed"
      activeWorkerId={null} activeWorkerStatus={null}
      initialNotes={[
        { id: 'q', type: 'question', status: 'open', title: 'Which approach?', createdAt: new Date(0) },
        { id: 'a', type: 'reply', replyTo: 'q', title: 'Use the existing path', createdAt: new Date(0) },
        { id: 'unanswered', type: 'question', status: 'open', title: 'Anything else?', createdAt: new Date(0) },
      ] as any} />);
    expect(html).toContain('Past questions');
    expect(html).toContain('Use the existing path');
    expect(html).toContain('Not answered');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Recommended by the agent');
  });
});
