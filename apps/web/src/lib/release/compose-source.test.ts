import { describe, expect, it } from 'bun:test';
import { firstParentPrs, latestRefusal, latestReviews, summarizeRuns, toCandidateChecks, type CompareCommit } from './compose-source';
// The engine writes the refusal comment; pinned so the page can always read it.
import { renderRefusedComment } from '../../../../../scripts/release-candidate';

const c = (sha: string, message: string, parents: string[]): CompareCommit => ({ sha, commit: { message }, parents: parents.map((p) => ({ sha: p })) });

describe('firstParentPrs', () => {
  it('a mission PR merge stands for the mission; task PRs merged into its branch are not separate changes', () => {
    const commits = [
      c('base1', 'Merge branch main into dev', ['x', 'y']),
      c('t1', 'Merge pull request #20 from o/buildd/task-a\n\nfeat: task a', ['m0']),
      c('m0', 'start mission', ['base1']),
      c('sq', 'fix: typo (#11)', ['base1']),
      c('mm', 'Merge pull request #30 from o/mission/search\n\nfeat(search): Ship mission Search', ['sq', 't1']),
      c('rl', 'Re-land on dev: "feat: billing (#12)" from v1.2.4', ['mm']),
    ];
    expect(firstParentPrs(commits, 'rl')).toEqual([
      { number: 12, title: 'Re-land on dev: "feat: billing (#12)" from v1.2.4', sha: 'rl' },
      { number: 30, title: 'feat(search): Ship mission Search', sha: 'mm' },
      { number: 11, title: 'fix: typo', sha: 'sq' },
    ]);
  });
});

describe('toCandidateChecks', () => {
  it('keeps the newest run per name; only success passes; a skipped required check fails', () => {
    const runs = [
      { name: 'build', head_sha: 's', status: 'completed', conclusion: 'failure', completed_at: '2026-01-01T00:00:00Z' },
      { name: 'build', head_sha: 's', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T01:00:00Z', html_url: 'b' },
      { name: 'release candidate verified', head_sha: 's', status: 'completed', conclusion: 'skipped' },
      { name: 'hotfix integration', head_sha: 's', status: 'completed', conclusion: 'skipped' },
      { name: 'lint', head_sha: 's', status: 'in_progress', conclusion: null },
    ];
    expect(toCandidateChecks(runs, ['build', 'release candidate verified'])).toEqual([
      { name: 'build', sha: 's', state: 'passing', url: 'b' },
      { name: 'release candidate verified', sha: 's', state: 'failing', url: null },
      { name: 'lint', sha: 's', state: 'pending', url: null },
    ]);
    expect(summarizeRuns(runs)).toBe('pending');
    expect(summarizeRuns([])).toBe('none');
  });
});

describe('latestReviews', () => {
  it('keeps each reviewer’s latest decision and the SHA it was given on', () => {
    expect(
      latestReviews([
        { user: { login: 'a' }, state: 'APPROVED', commit_id: 'old' },
        { user: { login: 'a' }, state: 'COMMENTED', commit_id: 'new' },
        { user: { login: 'a' }, state: 'DISMISSED', commit_id: 'old' },
        { user: { login: 'b' }, state: 'APPROVED', commit_id: 'new' },
      ]),
    ).toEqual([
      { author: 'a', state: 'DISMISSED', sha: 'old' },
      { author: 'b', state: 'APPROVED', sha: 'new' },
    ]);
  });
});

describe('latestRefusal', () => {
  it('reads the files a refused exclusion named, from the comment the engine writes', () => {
    const body = renderRefusedComment({ sha: 'a'.repeat(40), subject: 'feat: x (#1)', files: ['src/a.ts', 'src/b.ts'] }, 'c'.repeat(40), '2026-10-12T00:00:00Z');
    expect(latestRefusal([{ body: 'hello' }, { body }])).toEqual({ sha: 'a'.repeat(40), files: ['src/a.ts', 'src/b.ts'], candidateSha: 'c'.repeat(40), at: '2026-10-12T00:00:00Z' });
    expect(latestRefusal([{ body: 'nothing' }])).toBeNull();
  });
});
