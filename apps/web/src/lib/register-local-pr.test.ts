import { it, expect } from 'bun:test';
import { registerLocalPr } from './register-local-pr';
it('adopts a supported out-of-band PR by exact branch and repo without a runner filter', async () => {
  let seen: unknown;
  await registerLocalPr({ branch: 'buildd/abcd1234-change', repo: 'example/project', number: 7, url: 'https://github.com/example/project/pull/7', headSha: 'head', baseRef: 'dev', draft: false }, async input => { seen = input; });
  expect(seen).toMatchObject({ branch: 'buildd/abcd1234-change', repo: 'example/project', number: 7 });
});
it('ignores a missing branch identity', async () => {
  let called = false;
  await registerLocalPr({ branch: '', repo: 'example/project', number: 7, url: 'https://github.com/example/project/pull/7', headSha: 'head', baseRef: 'dev', draft: false }, async () => { called = true; });
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
