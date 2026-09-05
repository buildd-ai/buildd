import { describe, it, expect } from 'bun:test';
import { plural, countOf } from './plural';

describe('plural', () => {
  it('keeps the singular at exactly one', () => {
    expect(plural(1, 'task')).toBe('task');
  });

  it('pluralises everything else, including zero', () => {
    expect(plural(0, 'task')).toBe('tasks');
    expect(plural(2, 'task')).toBe('tasks');
    expect(plural(11, 'run')).toBe('runs');
  });

  it('takes an explicit plural for irregular nouns', () => {
    expect(plural(1, 'criterion', 'criteria')).toBe('criterion');
    expect(plural(3, 'criterion', 'criteria')).toBe('criteria');
    expect(plural(1, 'dependency', 'dependencies')).toBe('dependency');
    expect(plural(0, 'dependency', 'dependencies')).toBe('dependencies');
  });

  // A negative count is a bug upstream, but rendering "-1 task" reads better
  // than crashing a whole panel over it.
  it('treats a negative count as plural', () => {
    expect(plural(-1, 'task')).toBe('tasks');
  });
});

describe('countOf', () => {
  it('joins the count to the right noun form', () => {
    expect(countOf(1, 'task')).toBe('1 task');
    expect(countOf(4, 'task')).toBe('4 tasks');
    expect(countOf(1, 'session')).toBe('1 session');
    expect(countOf(0, 'session')).toBe('0 sessions');
  });

  it('carries the irregular plural through', () => {
    expect(countOf(1, 'criterion', 'criteria')).toBe('1 criterion');
    expect(countOf(2, 'criterion', 'criteria')).toBe('2 criteria');
  });

  // The four sites this helper was written for. Each rendered "1 tasks",
  // "1 runs" or "1 changes requested" before, because each was gated on
  // `count > 0` and then hardcoded the plural noun.
  it('fixes the counts that used to read as 1 tasks', () => {
    expect(countOf(1, 'task')).toBe('1 task');
    expect(countOf(1, 'run')).toBe('1 run');
    expect(countOf(1, 'change')).toBe('1 change');
  });
});
