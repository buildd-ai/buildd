import { describe, expect, it } from 'bun:test';
import { isDirty, formSnapshot } from './form-dirty';

describe('isDirty', () => {
  it('is clean for identical snapshots', () => {
    expect(isDirty({ name: 'Builder', maxTurns: null }, { name: 'Builder', maxTurns: null })).toBe(false);
  });

  it('is dirty when a scalar changes', () => {
    expect(isDirty({ name: 'Builder' }, { name: 'Builders' })).toBe(true);
    expect(isDirty({ background: false }, { background: true })).toBe(true);
    expect(isDirty({ maxTurns: null }, { maxTurns: 10 })).toBe(true);
  });

  it('treats whitespace-only edits as dirty: save persists text verbatim', () => {
    expect(isDirty({ content: 'You build.' }, { content: 'You build.\n' })).toBe(true);
    expect(isDirty({ name: 'Builder' }, { name: ' Builder' })).toBe(true);
  });

  it('ignores object key order', () => {
    expect(isDirty({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  });

  it('treats an undefined key as absent', () => {
    expect(isDirty({ a: 1 } as Record<string, unknown>, { a: 1, b: undefined })).toBe(false);
  });

  it('compares ordered arrays positionally, including nested ones', () => {
    expect(isDirty({ args: [['-y', 'pkg'], ['x']] }, { args: [['-y', 'pkg'], ['x']] })).toBe(false);
    expect(isDirty({ args: [['-y', 'pkg']] }, { args: [['pkg', '-y']] })).toBe(true);
    expect(isDirty({ args: ['a', 'b'] }, { args: ['b', 'a'] })).toBe(true);
  });

  it('compares declared unordered keys as sets', () => {
    const opts = { unordered: ['allowedTools'] as const };
    expect(isDirty({ allowedTools: ['Read', 'Bash'] }, { allowedTools: ['Bash', 'Read'] }, opts)).toBe(false);
    expect(isDirty({ allowedTools: ['Read'] }, { allowedTools: ['Read', 'Bash'] }, opts)).toBe(true);
    expect(isDirty({ allowedTools: [] as string[] }, { allowedTools: ['Read'] }, opts)).toBe(true);
  });

  it('toggling a set member off and on again is clean', () => {
    const opts = { unordered: ['canDelegateTo'] as const };
    const saved = { canDelegateTo: ['builder', 'researcher'] };
    // toggle builder off → ['researcher'], on → ['researcher', 'builder']
    expect(isDirty(saved, { canDelegateTo: ['researcher', 'builder'] }, opts)).toBe(false);
  });

  it('unordered sets of objects compare by content, not position', () => {
    const opts = { unordered: ['items'] as const };
    expect(isDirty(
      { items: [{ id: 'a', tags: ['x'] }, { id: 'b', tags: [] }] },
      { items: [{ tags: [], id: 'b' }, { id: 'a', tags: ['x'] }] },
      opts,
    )).toBe(false);
    expect(isDirty(
      { items: [{ id: 'a', tags: ['x'] }] },
      { items: [{ id: 'a', tags: ['y'] }] },
      opts,
    )).toBe(true);
  });

  it('keys not listed as unordered stay order-sensitive', () => {
    expect(isDirty({ allowedTools: ['Read', 'Bash'] }, { allowedTools: ['Bash', 'Read'] })).toBe(true);
  });

  it('does not treat a duplicate as the same set', () => {
    const opts = { unordered: ['ids'] as const };
    expect(isDirty({ ids: ['a'] }, { ids: ['a', 'a'] }, opts)).toBe(true);
  });
});

describe('formSnapshot', () => {
  it('is a stable, comparable string equal for equivalent state', () => {
    const opts = { unordered: ['tools'] as const };
    expect(formSnapshot({ tools: ['b', 'a'], n: 1 }, opts)).toBe(formSnapshot({ n: 1, tools: ['a', 'b'] }, opts));
  });
});
