import { describe, expect, it } from 'bun:test';
import type { BuilddObjectRef } from './chat-contract';
import { INITIAL_PANE, paneReducer, parsePaneSide, popOutHref } from './pane-state';

const mission: BuilddObjectRef = { kind: 'mission', id: 'm1', workspaceId: 'ws', fallbackText: 'M' };

describe('paneReducer', () => {
  it('defaults to the object on the left, open, following the conversation', () => {
    expect(INITIAL_PANE).toEqual({ side: 'left', closed: false, pinned: null });
  });
  it('opening an object pins it and reopens a closed pane', () => {
    const closed = paneReducer(INITIAL_PANE, { type: 'close' });
    expect(closed.closed).toBe(true);
    expect(paneReducer(closed, { type: 'open', ref: mission })).toEqual({ side: 'left', closed: false, pinned: mission });
  });
  it('swap flips sides; unpin goes back to following', () => {
    expect(paneReducer(INITIAL_PANE, { type: 'swap' }).side).toBe('right');
    expect(paneReducer({ ...INITIAL_PANE, pinned: mission }, { type: 'unpin' }).pinned).toBeNull();
  });
  it('a stored side is read defensively', () => {
    expect(parsePaneSide('right')).toBe('right');
    expect(parsePaneSide('bogus')).toBe('left');
    expect(parsePaneSide(null)).toBe('left');
  });
});

describe('popOutHref', () => {
  it('opens each object on its own page', () => {
    expect(popOutHref(mission)).toBe('/app/missions/m1');
    expect(popOutHref({ kind: 'question', id: 'w1', taskId: 't1', workspaceId: 'ws', fallbackText: 'q' })).toBe('/app/tasks/t1/respond');
    expect(popOutHref({ kind: 'pr', id: 'o/r#1', repo: 'o/r', prNumber: 1, url: 'https://github.com/o/r/pull/1', workspaceId: 'ws', fallbackText: '#1' }))
      .toBe('https://github.com/o/r/pull/1');
    expect(popOutHref({ kind: 'task', id: 't1', workspaceId: 'ws', fallbackText: 't' })).toBe('/app/tasks/t1');
    expect(popOutHref({ kind: 'directive', id: 'd', workspaceId: 'ws', fallbackText: 'd' })).toBeNull();
  });
});
