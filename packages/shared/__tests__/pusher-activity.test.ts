import { describe, it, expect } from 'bun:test';
import {
  channelForEvent,
  pusherChannelKind,
  workerActivityChannelName,
  workspaceActivityChannelName,
} from '../src/pusher-activity';

describe('activity channel names', () => {
  it('twins the worker and workspace channels', () => {
    expect(workerActivityChannelName('w1')).toBe('worker-w1-activity');
    expect(workspaceActivityChannelName('ws1')).toBe('workspace-ws1-activity');
  });
});

describe('channelForEvent', () => {
  it('sends worker:progress to the activity twin of a worker or workspace channel', () => {
    expect(channelForEvent('workspace-ws1', 'worker:progress')).toBe('workspace-ws1-activity');
    expect(channelForEvent('worker-w1', 'worker:progress')).toBe('worker-w1-activity');
  });

  it('keeps the prefix', () => {
    expect(channelForEvent('preview-workspace-ws1', 'worker:progress', 'preview-')).toBe('preview-workspace-ws1-activity');
  });

  it('leaves the events runners need on the base channel', () => {
    for (const ev of ['worker:completed', 'worker:failed', 'worker:command', 'task:created', 'task:assigned', 'task:updated']) {
      expect(channelForEvent('workspace-ws1', ev)).toBe('workspace-ws1');
      expect(channelForEvent('worker-w1', ev)).toBe('worker-w1');
    }
  });

  it('leaves channels with no twin alone', () => {
    expect(channelForEvent('task-t1', 'worker:progress')).toBe('task-t1');
    expect(channelForEvent('mission-m1', 'worker:progress')).toBe('mission-m1');
  });

  it('does not twin an activity channel twice', () => {
    expect(channelForEvent('worker-w1-activity', 'worker:progress')).toBe('worker-w1-activity');
  });
});

describe('pusherChannelKind', () => {
  it('names the channel kind without its id', () => {
    expect(pusherChannelKind('workspace-ws1')).toBe('workspace');
    expect(pusherChannelKind('workspace-ws1-activity')).toBe('workspace-activity');
    expect(pusherChannelKind('worker-0a1b-2c3d-activity')).toBe('worker-activity');
    expect(pusherChannelKind('task-t1')).toBe('task');
    expect(pusherChannelKind('preview-worker-w1', 'preview-')).toBe('worker');
    expect(pusherChannelKind('???')).toBe('other');
  });
});
