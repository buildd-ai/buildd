/**
 * Unit test: get_pr's diff-size line reports reviewable and generated totals
 * separately, sourced from the GET /api/github/pr response's split fields.
 *
 * This is the surface an agent (or a human reading its output) reads first
 * when deciding whether a PR's diff is reasonable — see
 * packages/shared/src/generated-paths.ts for why that number must exclude
 * tooling-generated files like Drizzle snapshots.
 */

import { describe, expect, it } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

function context(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workerId: 'worker-1',
    getWorkspaceId: async () => 'workspace-1',
    getLevel: async () => 'worker',
    ...overrides,
  };
}

function apiReturning(response: unknown): ApiFn {
  return (async () => response) as unknown as ApiFn;
}

const CI_AND_REVIEWS = {
  checks: { total: 0, passed: 0, failed: 0, pending: 0, state: 'none' },
  reviews: { approved: 0, changesRequested: 0, pending: 0 },
};

describe('get_pr diff-size line', () => {
  it('reports both reviewable and generated totals when a generated file inflated the diff', async () => {
    const api = apiReturning({
      ok: true,
      pr: {
        number: 2297,
        title: 'Fix a heartbeat upsert bug plus a one-column migration',
        body: null,
        state: 'open',
        url: 'https://github.com/buildd-ai/buildd/pull/2297',
        mergeable: true,
        mergeableState: 'clean',
        headSha: 'sha2297',
        baseRef: 'dev',
        additions: 355,
        deletions: 13,
        changedFiles: 14,
        generatedAdditions: 10664,
        generatedDeletions: 0,
        generatedFiles: 2,
        mergedAt: null,
        mergeCommitSha: null,
        mergedBy: null,
        mergedVia: null,
        closedAt: null,
      },
      ...CI_AND_REVIEWS,
    });

    const result = await handleBuilddAction(api, 'get_pr', { prNumber: 2297 }, context());
    const output = (result as { content: Array<{ text: string }> }).content[0]!.text;

    expect(output).toContain('Diff: +355/-13 across 14 file(s) reviewable (+10664 generated across 2 file(s), excluded)');
  });

  it('omits the generated clause when nothing was excluded', async () => {
    const api = apiReturning({
      ok: true,
      pr: {
        number: 1,
        title: 'Small fix',
        body: null,
        state: 'open',
        url: 'https://github.com/buildd-ai/buildd/pull/1',
        mergeable: true,
        mergeableState: 'clean',
        headSha: 'sha1',
        baseRef: 'dev',
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        generatedAdditions: 0,
        generatedDeletions: 0,
        generatedFiles: 0,
        mergedAt: null,
        mergeCommitSha: null,
        mergedBy: null,
        mergedVia: null,
        closedAt: null,
      },
      ...CI_AND_REVIEWS,
    });

    const result = await handleBuilddAction(api, 'get_pr', { prNumber: 1 }, context());
    const output = (result as { content: Array<{ text: string }> }).content[0]!.text;

    expect(output).toContain('Diff: +12/-3 across 2 file(s) reviewable');
    expect(output).not.toContain('generated');
  });
});
