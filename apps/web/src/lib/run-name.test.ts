import { describe, expect, it } from 'bun:test';
import { readableRunName } from './run-name';

describe('readableRunName', () => {
  it('keeps a short label that is already words', () => {
    expect(readableRunName({ label: 'home and nav', title: 'refactor(home): one needs-you source' })).toBe('home and nav');
  });

  it('a machine identifier label falls back to the title, in words', () => {
    expect(readableRunName({ label: 'open_pr_outp', title: '[friction] open_pr_outpaced_by_base: pull_request 4191' }))
      .toBe('Open PR outpaced by base: PR #4191');
  });

  it('a label with no label at all uses the display title', () => {
    expect(readableRunName({ label: null, title: 'fix(api): retry the claim' })).toBe('Retry the claim');
  });

  it('a refresh task reads as bringing the mission up to date', () => {
    expect(readableRunName({ label: 'merge', title: 'chore(mission): merge dev into the Task estimates integration branch' }))
      .toBe('Bring Task estimates up to date with dev');
  });

  it('a label with no words (a bare PR number) falls back to the title', () => {
    expect(readableRunName({ label: '#4066', title: '[builder · after CI #1] fix(sentinel): page once per incident' })).toBe('Page once per incident');
  });

  it('a review of a PR reads as "Review: <what the PR does>", not "PR #N: [friction] …"', () => {
    expect(readableRunName({ label: null, title: '[reviewer] PR #4268: [friction] CI jobs pull from Docker Hub anonymously' }))
      .toBe('Review: CI jobs pull from Docker Hub anonymously');
    expect(readableRunName({ label: null, title: 'PR #4272: feat(coding-policy): hard restrict allowed coding providers' }))
      .toBe('Hard restrict allowed coding providers');
  });

  it('a label that is a copy of the raw title reads as the title would', () => {
    expect(readableRunName({ label: 'PR #4268: [friction] CI jobs pull from Docker Hub', title: '[reviewer] PR #4268: [friction] CI jobs pull from Docker Hub' }))
      .toBe('Review: CI jobs pull from Docker Hub');
  });
});
