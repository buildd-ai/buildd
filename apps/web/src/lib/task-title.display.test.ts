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

  it('strips a conventional-commit type and scope, and capitalises the subject', () => {
    expect(displayTaskTitle('fix(deps): pin the widget parser')).toBe('Pin the widget parser');
    expect(displayTaskTitle('chore(mission): merge dev')).toBe('Merge dev');
    expect(displayTaskTitle('feat: add invoices')).toBe('Add invoices');
    expect(displayTaskTitle('refactor(ui)!: drop the old board')).toBe('Drop the old board');
    expect(displayTaskTitle('polish(home): tighten the rail')).toBe('Tighten the rail');
  });

  it('strips the type behind a retry wrap, keeping the wrap', () => {
    expect(displayTaskTitle('[builder · after CI #1] feat(invoices): render invoices'))
      .toBe('[builder · after CI #1] Render invoices');
  });

  it('leaves a plain title and a bare prefix alone', () => {
    expect(displayTaskTitle('Investigate the flaky login test')).toBe('Investigate the flaky login test');
    expect(displayTaskTitle('fix:')).toBe('fix:');
    expect(displayTaskTitle('Note: the parser is slow')).toBe('Note: the parser is slow');
  });

  it('passes empty input through', () => {
    expect(displayTaskTitle(undefined)).toBe('');
    expect(displayTaskTitle(null)).toBe('');
    expect(displayTaskTitle('')).toBe('');
  });
});

it('strips research prefixes, scopes and retry wraps through the shared prefix pattern', () => {
  expect(displayTaskTitle('research: compare providers')).toBe('Compare providers');
  expect(displayTaskTitle('[retry] RESEARCH(api): compare providers')).toBe('[retry] Compare providers');
});
