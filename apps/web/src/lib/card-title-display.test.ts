import { describe, expect, it } from 'bun:test';
import { actionCardTitle } from './card-title-display';

describe('actionCardTitle', () => {
  it('shortens a mission refresh title', () => {
    expect(actionCardTitle('chore(mission): merge dev into the Widget Polish integration branch'))
      .toBe('Refresh Widget Polish from dev');
  });

  it('names the trunk the refresh merges from', () => {
    expect(actionCardTitle('chore(mission): merge main into the Widget Polish integration branch'))
      .toBe('Refresh Widget Polish from main');
  });

  it('keeps a mission title that itself contains a colon', () => {
    expect(actionCardTitle('chore(mission): merge dev into the Sentinel: page once integration branch'))
      .toBe('Refresh Sentinel: page once from dev');
  });

  it('shortens a mission ship title', () => {
    expect(actionCardTitle('Ship mission: Widget Polish')).toBe('Ship Widget Polish');
  });

  it('shortens a ship title behind a retry wrap, keeping the wrap', () => {
    expect(actionCardTitle('[builder · after review #2] Ship mission: Widget Polish'))
      .toBe('[builder · after review #2] Ship Widget Polish');
  });

  it('leaves conventional-commit titles alone: the type is information', () => {
    expect(actionCardTitle('fix(deps): pin the widget parser')).toBe('fix(deps): pin the widget parser');
    expect(actionCardTitle('chore(mission): merge dev')).toBe('chore(mission): merge dev');
  });

  it('passes empty input through', () => {
    expect(actionCardTitle(undefined)).toBe('');
    expect(actionCardTitle(null)).toBe('');
    expect(actionCardTitle('')).toBe('');
  });
});
