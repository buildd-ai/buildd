import { it, expect } from 'bun:test';
import { readGithubApproval } from './github-approval';
it('reads required approval separately from bots and stale human reviews', async () => {
  const api = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: 'REVIEW_REQUIRED', reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'bot', __typename: 'Bot' }, commit: { oid: 'new' } },
    { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'old' } },
  ] } } } } });
  expect(await readGithubApproval(1, 'example/project', 7, api)).toEqual({ reviewDecision: 'REVIEW_REQUIRED', humanApproved: false });
});
it('a later dismissal or change request supersedes an approval', async () => {
  const api = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: null, reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
    { state: 'CHANGES_REQUESTED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
  ] } } } } });
  expect((await readGithubApproval(1, 'example/project', 7, api)).humanApproved).toBe(false);
});
it('accepts an effective human approval of the current head', async () => {
  const api = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: 'APPROVED', reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
  ] } } } } });
  expect((await readGithubApproval(1, 'example/project', 7, api)).humanApproved).toBe(true);
});
// workflow-kernel-library.md §4: a COMMENTED review is never an approval. #4686
// was merged over two COMMENTED reviews that said "changes requested".
it('a COMMENTED review of the current head is not an approval, and does not undo a change request', async () => {
  const lone = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: null, reviews: { nodes: [
    { state: 'COMMENTED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
  ] } } } } });
  expect(await readGithubApproval(1, 'example/project', 7, lone)).toEqual({ reviewDecision: null, humanApproved: false });
  const afterChanges = async () => ({ data: { repository: { pullRequest: { headRefOid: 'new', reviewDecision: 'CHANGES_REQUESTED', reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'old' } },
    { state: 'CHANGES_REQUESTED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
    { state: 'COMMENTED', author: { login: 'person', __typename: 'User' }, commit: { oid: 'new' } },
  ] } } } } });
  expect((await readGithubApproval(1, 'example/project', 7, afterChanges)).humanApproved).toBe(false);
});
it('never treats a failed GitHub query as satisfied approval', async () => {
  await expect(readGithubApproval(1, 'example/project', 7, async () => ({ errors: [{ message: 'Unavailable' }] }))).rejects.toThrow();
});
