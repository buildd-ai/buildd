import { describe, expect, it } from 'bun:test';
import { integrationTarget } from './mission-integration-target';
import { foldMissionSpec, type MissionVerdictRow } from './mission-outcome-fold';

const REPO = { installationId: 1, fullName: 'acme/app' };
const BRANCH = 'mission/example-0000aaaa';
const OLD_HEAD = '1111111111111111111111111111111111111111';
const MERGE = '2222222222222222222222222222222222222222';
const TRUNK = '3333333333333333333333333333333333333333';

type Route = (path: string) => unknown;
function fakeApi(route: Route) {
  return async (_id: number, path: string) => {
    const out = route(path);
    if (out instanceof Error) throw out;
    return out;
  };
}
const notFound = () => new Error('GitHub API 404: Not Found');

describe('the integrated target of a mission-branch mission', () => {
  it('is the integration branch head while the branch exists', async () => {
    const api = fakeApi((p) => (p.includes('/git/ref/heads/') ? { object: { sha: OLD_HEAD } } : notFound()));
    expect(await integrationTarget(REPO, BRANCH, [OLD_HEAD], api)).toEqual({ kind: 'integration', headSha: OLD_HEAD, branch: BRANCH });
  });

  it('after the mission PR merged and the branch was deleted, is a trunk commit holding that merge', async () => {
    const api = fakeApi((p) => {
      if (p.includes('/git/ref/heads/')) return notFound();
      if (p.startsWith('/repos/acme/app/pulls?')) {
        expect(p).toContain(`head=${encodeURIComponent(`acme:${BRANCH}`)}`);
        return [{ number: 7, merged_at: '2026-10-18T11:18:00Z', merge_commit_sha: MERGE }];
      }
      if (p === `/repos/acme/app/compare/${MERGE}...${TRUNK}`) return { status: 'ahead' };
      if (p === `/repos/acme/app/compare/${MERGE}...${OLD_HEAD}`) return { status: 'behind' };
      return notFound();
    });
    const target = await integrationTarget(REPO, BRANCH, [OLD_HEAD, TRUNK], api);
    expect(target.kind).toBe('direct');
    if (target.kind !== 'direct') return;
    expect(target.mergeShas).toEqual([MERGE]);
    expect([...target.validHeads]).toEqual([TRUNK]);
  });

  it('a closed-unmerged mission PR leaves the target unknown', async () => {
    const api = fakeApi((p) => {
      if (p.includes('/git/ref/heads/')) return notFound();
      if (p.startsWith('/repos/acme/app/pulls?')) return [{ number: 7, merged_at: null, merge_commit_sha: 'ffff000' }];
      return notFound();
    });
    const target = await integrationTarget(REPO, BRANCH, [OLD_HEAD], api);
    expect(target.kind).toBe('unknown');
  });

  it('a fail recorded on the integration branch before the merge reads stale, so it is checked again', async () => {
    const api = fakeApi((p) => {
      if (p.includes('/git/ref/heads/')) return notFound();
      if (p.startsWith('/repos/acme/app/pulls?')) return [{ number: 7, merged_at: '2026-10-18T11:18:00Z', merge_commit_sha: MERGE }];
      if (p === `/repos/acme/app/compare/${MERGE}...${OLD_HEAD}`) return { status: 'behind' };
      return notFound();
    });
    const target = await integrationTarget(REPO, BRANCH, [OLD_HEAD], api);
    const rows: MissionVerdictRow[] = [{ id: 'v1', criterionId: 'R-1', verdict: 'fail', headSha: OLD_HEAD, at: '2026-10-18T05:00:00Z' }];
    const fold = foldMissionSpec({ scope: ['R-1'], waived: [], rows, target });
    expect(fold.standings[0].standing).toBe('stale');
    expect(fold.verdict).not.toBe('fail');
  });
});
