/**
 * Unit tests: get_pr's PR-body preview cap (routed through the shared
 * `truncate()` helper, not a bespoke bare slice), the `fullBody` opt-in, and
 * the `includeComments` opt-in's rendering of the already-ranked comments
 * payload `GET /api/github/pr` returns (ranking itself is covered by
 * apps/web/src/lib/pr-comments.test.ts — this file only checks that get_pr
 * forwards the flag and renders what comes back).
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

function apiCapturing(response: unknown, onCall?: (path: string) => void): ApiFn {
  return (async (path: string) => {
    onCall?.(path);
    return response;
  }) as unknown as ApiFn;
}

const CI_AND_REVIEWS = {
  checks: { total: 0, passed: 0, failed: 0, pending: 0, state: 'none' },
  reviews: { approved: 0, changesRequested: 0, pending: 0 },
};

function basePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'Some PR',
    body: null,
    state: 'open',
    url: 'https://github.com/buildd-ai/buildd/pull/1',
    mergeable: true,
    mergeableState: 'clean',
    headSha: 'sha1',
    baseRef: 'dev',
    additions: null,
    deletions: null,
    changedFiles: null,
    generatedAdditions: 0,
    generatedDeletions: 0,
    generatedFiles: 0,
    mergedAt: null,
    mergeCommitSha: null,
    mergedBy: null,
    mergedVia: null,
    closedAt: null,
    ...overrides,
  };
}

async function getOutput(api: ApiFn, params: Record<string, unknown>) {
  const result = await handleBuilddAction(api, 'get_pr', params, context());
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe('get_pr body preview cap', () => {
  it('returns a body under the cap whole, with no truncation marker', async () => {
    const body = 'Short summary of what changed and why.';
    const api = apiCapturing({ ok: true, pr: basePr({ body }), ...CI_AND_REVIEWS });

    const output = await getOutput(api, { prNumber: 1 });

    expect(output).toContain(body);
    expect(output).not.toContain('truncated');
  });

  it('truncates a body over the cap through the shared helper, reporting the exact elided count', async () => {
    const body = 'x'.repeat(2500);
    const api = apiCapturing({ ok: true, pr: basePr({ body }), ...CI_AND_REVIEWS });

    const output = await getOutput(api, { prNumber: 1 });

    // GET_PR_BODY_PREVIEW_CHARS = 2000 -> 500 chars elided
    expect(output).toContain('…[truncated 500 chars]');
    expect(output).not.toContain('x'.repeat(2500));
  });

  it('fullBody:true returns the complete text with no marker', async () => {
    const body = 'x'.repeat(2500);
    const api = apiCapturing({ ok: true, pr: basePr({ body }), ...CI_AND_REVIEWS });

    const output = await getOutput(api, { prNumber: 1, fullBody: true });

    expect(output).toContain(body);
    expect(output).not.toContain('truncated');
  });

  it('no body and no comments requested produces no empty sections and does not crash', async () => {
    const api = apiCapturing({ ok: true, pr: basePr({ body: null }), ...CI_AND_REVIEWS });

    const output = await getOutput(api, { prNumber: 1 });

    expect(output).not.toContain('Agent summary');
    expect(output).not.toContain('Comments');
    expect(output.trim().length).toBeGreaterThan(0);
  });

  it('does not request comments by default (includeComments omitted from the query)', async () => {
    let calledPath = '';
    const api = apiCapturing({ ok: true, pr: basePr(), ...CI_AND_REVIEWS }, (path) => { calledPath = path; });

    await getOutput(api, { prNumber: 1 });

    expect(calledPath).not.toContain('includeComments');
  });

  it('pins the default payload size budget for a large body (no regression toward a raw dump)', async () => {
    const body = 'x'.repeat(50_000);
    const api = apiCapturing({ ok: true, pr: basePr({ body, additions: 10, deletions: 2, changedFiles: 1 }), ...CI_AND_REVIEWS });

    const output = await getOutput(api, { prNumber: 1 });

    // Body preview itself is capped at 2000 chars + a short truncation marker;
    // the whole response (header lines + preview) must stay well under a
    // budget that would let a future change quietly reintroduce a full dump.
    expect(output.length).toBeLessThan(2600);
  });
});

describe('get_pr includeComments', () => {
  it('requests comments only when includeComments:true is passed, and renders the ranked payload', async () => {
    let calledPath = '';
    const api = apiCapturing(
      {
        ok: true,
        pr: basePr(),
        ...CI_AND_REVIEWS,
        comments: {
          items: [
            { author: 'buildd[bot]', kind: 'buildd', at: '2026-01-01T00:00:00Z', body: 'Reviewer approved these changes.', url: null },
            { author: 'alice', kind: 'human', at: '2026-01-02T00:00:00Z', body: 'thanks!', url: null },
          ],
          total: 5,
          omitted: 3,
        },
      },
      (path) => { calledPath = path; },
    );

    const output = await getOutput(api, { prNumber: 1, includeComments: true });

    expect(calledPath).toContain('includeComments=true');
    expect(output).toContain('Comments');
    expect(output).toContain('buildd[bot]');
    expect(output).toContain('Reviewer approved these changes.');
    expect(output).toContain('3 more omitted');
    // buildd-authored entry renders before the human one
    expect(output.indexOf('buildd[bot]')).toBeLessThan(output.indexOf('alice'));
  });

  it('reports "Comments: none" rather than an empty section when there are no comments', async () => {
    const api = apiCapturing({
      ok: true,
      pr: basePr(),
      ...CI_AND_REVIEWS,
      comments: { items: [], total: 0, omitted: 0 },
    });

    const output = await getOutput(api, { prNumber: 1, includeComments: true });

    expect(output).toContain('Comments: none');
  });

  it('does not duplicate get_pr_review\'s verdict payload — no verdict/confidence fields rendered here', async () => {
    const api = apiCapturing({
      ok: true,
      pr: basePr(),
      ...CI_AND_REVIEWS,
      comments: {
        items: [{ author: 'buildd[bot]', kind: 'buildd', at: null, body: 'Reviewer approved these changes.', url: null }],
        total: 1,
        omitted: 0,
      },
    });

    const output = await getOutput(api, { prNumber: 1, includeComments: true });

    expect(output).not.toContain('Verdict:');
    expect(output).not.toContain('confidence');
  });
});
