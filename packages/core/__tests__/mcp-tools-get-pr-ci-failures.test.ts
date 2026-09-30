/**
 * get_pr `includeCiFailures`: forwards the flag and renders, per failing
 * check, the job, the failing step and the log excerpt the route returns.
 * Trimming, escape stripping and redaction are covered where they happen
 * (apps/web/src/lib/ci-failure-excerpts.test.ts).
 */

import { describe, expect, it } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const ctx: ActionContext = { workerId: 'worker-1', getWorkspaceId: async () => 'workspace-1', getLevel: async () => 'worker' };

const RED = {
  total: 2, passed: 1, failed: 1, pending: 0, state: 'failure',
  failedChecks: [{ name: 'build', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1/job/9' }],
};

function pr() {
  return {
    number: 7, title: 'A PR', body: null, state: 'open', url: 'https://github.com/o/r/pull/7',
    mergeable: true, mergeableState: 'clean', headSha: 's', baseRef: 'dev',
    additions: null, deletions: null, changedFiles: null, generatedAdditions: 0, generatedDeletions: 0, generatedFiles: 0,
  };
}

async function run(response: unknown, params: Record<string, unknown>) {
  let path = '';
  const api = (async (p: string) => { path = p; return response; }) as unknown as ApiFn;
  const out = await handleBuilddAction(api, 'get_pr', params, ctx);
  return { path, text: (out as { content: Array<{ text: string }> }).content[0]!.text };
}

describe('get_pr includeCiFailures', () => {
  it('does not ask for log excerpts by default', async () => {
    const { path } = await run({ ok: true, pr: pr(), checks: RED, reviews: { approved: 0, changesRequested: 0, pending: 0 } }, { prNumber: 7 });
    expect(path).not.toContain('includeCiFailures');
  });

  it('asks for them with includeCiFailures:true and renders job, step and excerpt', async () => {
    const { path, text } = await run({
      ok: true, pr: pr(), checks: RED, reviews: { approved: 0, changesRequested: 0, pending: 0 },
      ciFailures: [{
        name: 'build', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1/job/9',
        step: 'Type check', excerpt: 'src/a.ts(3,1): error TS2322: Type string is not assignable to type number',
      }],
    }, { prNumber: 7, includeCiFailures: true });

    expect(path).toContain('includeCiFailures=true');
    expect(text).toContain('CI failure: build');
    expect(text).toContain('Type check');
    expect(text).toContain('error TS2322');
    expect(text).toContain('https://github.com/o/r/actions/runs/1/job/9');
  });

  it('a job with no log degrades to name plus URL, with no empty code block', async () => {
    const { text } = await run({
      ok: true, pr: pr(), checks: RED, reviews: { approved: 0, changesRequested: 0, pending: 0 },
      ciFailures: [{ name: 'build', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1/job/9', step: null, excerpt: null }],
    }, { prNumber: 7, includeCiFailures: true });

    expect(text).toContain('CI failure: build');
    expect(text).toContain('https://github.com/o/r/actions/runs/1/job/9');
    expect(text).toContain('no log available');
    expect(text).not.toContain('```\n```');
  });

  it('says so when CI is not failing rather than rendering an empty section', async () => {
    const { text } = await run({
      ok: true, pr: pr(), checks: { total: 1, passed: 1, failed: 0, pending: 0, state: 'success', failedChecks: [] },
      reviews: { approved: 0, changesRequested: 0, pending: 0 }, ciFailures: [],
    }, { prNumber: 7, includeCiFailures: true });

    expect(text).toContain('No failing checks');
  });
});
