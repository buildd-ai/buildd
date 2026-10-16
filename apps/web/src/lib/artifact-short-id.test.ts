import { describe, it, expect, mock } from 'bun:test';

let rows: Array<{ id: string }> = [];
let queried = 0;
mock.module('@buildd/core/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (queried++, rows) }) }) }) },
}));

import { resolveArtifactShortId } from './artifact-short-id';

const yes = async () => true;

describe('resolveArtifactShortId', () => {
  it('is none for anything but 8 hex, without querying', async () => {
    queried = 0;
    expect(await resolveArtifactShortId('1234567', yes)).toEqual({ state: 'none' });
    expect(await resolveArtifactShortId('zzzzzzzz', yes)).toEqual({ state: 'none' });
    expect(queried).toBe(0);
  });

  it('is one for a single readable match', async () => {
    rows = [{ id: 'a' }];
    expect(await resolveArtifactShortId('ABCDEF12', yes)).toEqual({ state: 'one', id: 'a' });
  });

  it('is ambiguous only when two or more readable ids match', async () => {
    rows = [{ id: 'a' }, { id: 'b' }];
    expect(await resolveArtifactShortId('abcdef12', yes)).toEqual({ state: 'ambiguous' });
    expect(await resolveArtifactShortId('abcdef12', async (id) => id === 'a')).toEqual({ state: 'one', id: 'a' });
  });

  it('is none when no match is readable', async () => {
    rows = [{ id: 'a' }, { id: 'b' }];
    expect(await resolveArtifactShortId('abcdef12', async () => false)).toEqual({ state: 'none' });
  });
});
