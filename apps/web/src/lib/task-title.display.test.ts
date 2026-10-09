import { describe, expect, it } from 'bun:test';
import { displayTaskTitle, taskShortName } from './task-title';

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

  it('shortens a ship title behind a retry wrap, dropping the wrap', () => {
    expect(displayTaskTitle('[builder · after review #2] Ship mission: Widget Polish'))
      .toBe('Ship Widget Polish');
  });

  it.each([
    ['feat(estimates): one estimator that blends neighbours', 'One estimator that blends neighbours'],
    ['fix(deps): pin the widget parser', 'Pin the widget parser'],
    ['refactor(core)!: drop the old queue', 'Drop the old queue'],
    ['feat: onboarding checklist', 'Onboarding checklist'],
    ['polish(mission-detail): compact phone header', 'Compact phone header'],
    ['[builder · after CI #1] fix(timeline): keep rows disjoint', 'Keep rows disjoint'],
    ['[surface audit] fix(home): needs-you card', 'Needs-you card'],
    ['[reviewer] PR #12: feat(settings): clear maximum model tier', 'Clear maximum model tier'],
    ['Fix the thing: carefully', 'Fix the thing: carefully'],
    ['already plain title', 'Already plain title'],
    ['chore(mission): merge dev', 'Merge dev'],
    ['feat: add invoices', 'Add invoices'],
    ['refactor(ui)!: drop the old board', 'Drop the old board'],
    ['polish(home): tighten the rail', 'Tighten the rail'],
    ['design: revise the card', 'Revise the card'],
    ['[builder · after CI #1] feat(invoices): render invoices', 'Render invoices'],
    ['Investigate the flaky login test', 'Investigate the flaky login test'],
    ['fix:', 'fix:'],
    ['Note: the parser is slow', 'Note: the parser is slow'],
  ])('%s -> %s', (input, out) => {
    expect(displayTaskTitle(input)).toBe(out);
  });

  it('passes empty input through', () => {
    expect(displayTaskTitle(undefined)).toBe('');
    expect(displayTaskTitle(null)).toBe('');
    expect(displayTaskTitle('')).toBe('');
  });
});

describe('taskShortName', () => {
  it('prefers the label alone, never label plus title', () => {
    expect(taskShortName({ title: 'polish(mission-detail): compact header', label: 'polish' })).toBe('Polish');
  });
  it('falls back to the cleaned title when there is no label', () => {
    expect(taskShortName({ title: 'feat(x): activity accurate now', label: null })).toBe('Activity accurate now');
    expect(taskShortName({ title: 'fix: y', label: 'untitled' })).toBe('Y');
  });
  it('cuts at a word boundary with no dangling punctuation', () => {
    const n = taskShortName({ title: "interactive- don't release live local sessions while the runner restarts in place" });
    expect(n.length).toBeLessThanOrEqual(40);
    expect(n).not.toMatch(/[(\-\s]$/);
    expect(n.startsWith('Interactive')).toBe(true);
  });
  it('is empty for nothing', () => {
    expect(taskShortName({ title: '' })).toBe('');
  });
});
