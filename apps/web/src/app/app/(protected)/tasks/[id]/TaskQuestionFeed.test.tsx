/**
 * S6: a mission task's feed lists mission-scoped questions, and those are
 * announced on the mission channel — so the feed must listen there too, or a
 * question asked while the page is open never appears until a reload.
 */
import { describe, expect, it } from 'bun:test';
import { questionFeedChannels } from './TaskQuestionFeed';

describe('questionFeedChannels', () => {
  it('listens on the task channel alone for a non-mission task', () => {
    expect(questionFeedChannels('t1', null, 'p-')).toEqual(['p-task-t1']);
  });

  it('also listens on the mission channel for a mission task', () => {
    expect(questionFeedChannels('t1', 'm1', 'p-')).toEqual(['p-task-t1', 'p-mission-m1']);
  });
});
