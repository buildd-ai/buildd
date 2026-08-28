import { describe, test, expect } from 'bun:test';
import { computeIsTerminalLeaf } from './TaskAutoRefresh';

describe('computeIsTerminalLeaf', () => {
  test('failed task is always terminal', () => {
    expect(computeIsTerminalLeaf('failed', 'normal', false, false)).toBe(true);
    expect(computeIsTerminalLeaf('failed', 'planning', true, true)).toBe(true);
  });

  test('completed non-planning leaf with no open PR is terminal', () => {
    expect(computeIsTerminalLeaf('completed', 'normal', false, false)).toBe(true);
  });

  test('completed task with open PR is NOT terminal — stays subscribed for CI updates', () => {
    expect(computeIsTerminalLeaf('completed', 'normal', false, true)).toBe(false);
  });

  test('completed planning task is NOT terminal (planning can have subtasks)', () => {
    expect(computeIsTerminalLeaf('completed', 'planning', false, false)).toBe(false);
  });

  test('completed task with subtasks is NOT terminal', () => {
    expect(computeIsTerminalLeaf('completed', 'normal', true, false)).toBe(false);
  });

  test('completed task with subtasks AND open PR is NOT terminal', () => {
    expect(computeIsTerminalLeaf('completed', 'normal', true, true)).toBe(false);
  });

  test('pending task is NOT terminal', () => {
    expect(computeIsTerminalLeaf('pending', 'normal', false, false)).toBe(false);
  });

  test('running task is NOT terminal', () => {
    expect(computeIsTerminalLeaf('running', 'normal', false, false)).toBe(false);
  });
});
