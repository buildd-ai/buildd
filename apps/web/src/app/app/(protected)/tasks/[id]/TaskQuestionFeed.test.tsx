/**
 * S6: a mission task's feed lists mission-scoped questions, and those are
 * announced on the mission channel — so the feed must listen there too, or a
 * question asked while the page is open never appears until a reload.
 */
import { describe, expect, it } from 'bun:test';
import { questionFeedChannels, partitionQuestionNotes } from './TaskQuestionFeed';

describe('partitionQuestionNotes', () => {
  const notes = [
    { id: 'a', type: 'question', status: 'open' },
    { id: 'b', type: 'question', status: 'answered' },
    { id: 'c', type: 'decision', status: 'open' },
    { id: 'd', type: 'question', status: 'open' },
  ] as any[];

  it('skips the question the live worker view already shows (one question, one surface)', () => {
    const { open, answered } = partitionQuestionNotes(notes, 'a');
    expect(open.map(n => n.id)).toEqual(['d']);
    expect(answered.map(n => n.id)).toEqual(['b']);
  });

  it('shows every open question when nothing is linked', () => {
    expect(partitionQuestionNotes(notes, null).open.map(n => n.id)).toEqual(['a', 'd']);
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
