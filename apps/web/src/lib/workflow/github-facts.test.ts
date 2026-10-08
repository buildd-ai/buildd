/**
 * The kernel's live GitHub reads: only GitHub's own answer is a fact; an
 * unreadable answer is unknown, never the convenient value.
 */
import { describe, expect, test } from 'bun:test';
import { githubReader } from './github-facts';

describe('branchExists (close cause, §4)', () => {
  const reader = (answer: () => unknown) => githubReader(1, (async () => answer()) as never);

  test('a branch GitHub returns exists; a 404 is deleted; any other failure is unknown', async () => {
    const asked: string[] = [];
    const ok = githubReader(1, (async (_i: number, path: string) => { asked.push(path); return { name: 'mission/x' }; }) as never);
    expect(await ok.branchExists!('acme/widgets', 'mission/x')).toBe(true);
    expect(asked).toEqual(['/repos/acme/widgets/branches/mission/x']);
    expect(await reader(() => { throw new Error('GitHub API error: 404 {"message":"Branch not found"}'); }).branchExists!('acme/widgets', 'gone')).toBe(false);
    expect(await reader(() => { throw new Error('GitHub API error: 502 Bad Gateway'); }).branchExists!('acme/widgets', 'x')).toBeNull();
    expect(await reader(() => null).branchExists!('acme/widgets', 'x')).toBeNull();
  });
});
