import { it, expect, mock } from 'bun:test';
import { registerLocalPr } from './register-local-pr';
it('adopts a supported out-of-band PR by exact branch and repo without a runner filter', async () => {
  let seen: unknown;
  await registerLocalPr({ branch: 'buildd/abcd1234-change', repo: 'example/project', headRepo: 'example/project', number: 7, url: 'https://github.com/example/project/pull/7', headSha: 'head', baseRef: 'dev', draft: false }, async input => { seen = input; });
  expect(seen).toMatchObject({ branch: 'buildd/abcd1234-change', repo: 'example/project', headRepo: 'example/project', number: 7 });
});
it('ignores a missing branch identity', async () => {
  let called = false;
  await registerLocalPr({ branch: '', repo: 'example/project', headRepo: 'example/project', number: 7, url: 'https://github.com/example/project/pull/7', headSha: 'head', baseRef: 'dev', draft: false }, async () => { called = true; });
  expect(called).toBe(false);
});

it('registration is scoped to repository and branch and cannot overwrite a PR', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./register-local-pr.ts', import.meta.url), 'utf8');
  expect(source).toContain('eq(workers.branch, input.branch)');
  expect(source).toContain('workspaceRepoMatches(input.repo)');
  expect(source).toContain('isNull(workers.prUrl)');
  expect(source).not.toMatch(/workers\.(runner|executor)/);
});

it.each(['example/fork', null])('does not register a fork or unknown head repository (%s)', async headRepo => {
  let called = false;
  await registerLocalPr({ branch: 'buildd/abcd1234-change', repo: 'example/project', headRepo, number: 7, url: 'https://github.com/example/project/pull/7', headSha: 'head', baseRef: 'dev', draft: false }, async () => { called = true; });
  expect(called).toBe(false);
});

// The default writer: binds the PR, then hands the PR's state to the fact
// funnel (terminal-wins proven on real Postgres in tests/db/pr-facts.test.ts).
// Its imports are dynamic, so these mocks only reach the default writer.
let boundRows: Array<{ id: string }> = [];
const setPayloads: Array<Record<string, unknown>> = [];
const recordedFacts: Array<{ target: unknown; fact: unknown; opts?: unknown }> = [];
const selectChain: any = { from: () => selectChain, where: () => selectChain };
mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        setPayloads.push(v);
        return { where: () => ({ returning: async () => boundRows }) };
      },
    }),
    select: () => selectChain,
  },
}));
mock.module('@buildd/core/pr-facts', () => ({
  recordPrFact: async (target: unknown, fact: unknown, opts?: unknown) => {
    recordedFacts.push({ target, fact, opts });
    return [];
  },
  recordPrFactSql: () => null,
  prFactApplies: () => true,
}));

const LOCAL_PR = { branch: 'buildd/abcd1234-change', repo: 'example/project', headRepo: 'example/project', number: 7, url: 'https://github.com/example/project/pull/7', headSha: 'head', baseRef: 'dev', draft: false };

it('records an open fact for every row it bound, and never writes the status column itself', async () => {
  boundRows = [{ id: 'w1' }, { id: 'w2' }];
  setPayloads.length = 0; recordedFacts.length = 0;
  await registerLocalPr(LOCAL_PR);
  expect(setPayloads).toHaveLength(1);
  expect(setPayloads[0]).toMatchObject({ prUrl: LOCAL_PR.url, prNumber: 7 });
  expect(setPayloads[0]).not.toHaveProperty('prLifecycleStatus');
  expect(recordedFacts).toEqual([{ target: { workerIds: ['w1', 'w2'] }, fact: { kind: 'open' }, opts: undefined }]);
});

it('records no fact when no row was bound', async () => {
  boundRows = [];
  setPayloads.length = 0; recordedFacts.length = 0;
  await registerLocalPr(LOCAL_PR);
  expect(setPayloads).toHaveLength(1);
  expect(recordedFacts).toEqual([]);
});
