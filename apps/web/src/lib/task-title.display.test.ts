import { describe, expect, it } from 'bun:test';
import { displayTaskTitle } from './task-title';

describe('displayTaskTitle', () => {
  it('shortens a mission refresh title', () => {
    expect(displayTaskTitle('chore(mission): merge dev into the Widget Polish integration branch'))
      .toBe('Refresh Widget Polish from dev');
  });

  it('names the trunk the refresh merges from', () => {
    expect(displayTaskTitle('chore(mission): merge main into the Widget Polish integration branch'))
      .toBe('Refresh Widget Polish from main');
  });

  it('keeps a mission title that itself contains a colon', () => {
    expect(displayTaskTitle('chore(mission): merge dev into the Sentinel: page once integration branch'))
      .toBe('Refresh Sentinel: page once from dev');
  });

  it('shortens a mission ship title', () => {
    expect(displayTaskTitle('Ship mission: Widget Polish')).toBe('Ship Widget Polish');
  });

  it('shortens a ship title behind a retry wrap, keeping the wrap', () => {
    expect(displayTaskTitle('[builder · after review #2] Ship mission: Widget Polish'))
      .toBe('[builder · after review #2] Ship Widget Polish');
  });

  it('leaves conventional-commit titles alone: the type is information', () => {
    expect(displayTaskTitle('fix(deps): pin the widget parser')).toBe('fix(deps): pin the widget parser');
    expect(displayTaskTitle('chore(mission): merge dev')).toBe('chore(mission): merge dev');
  });

  it('passes empty input through', () => {
    expect(displayTaskTitle(undefined)).toBe('');
    expect(displayTaskTitle(null)).toBe('');
    expect(displayTaskTitle('')).toBe('');
  });
});
