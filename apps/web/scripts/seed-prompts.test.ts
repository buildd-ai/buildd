import { describe, expect, it } from 'bun:test';
import { sha256Hex, type ExistingPromptRow, type PromptFileReader, type PromptSeedAction, type PromptSeedMarker } from '@buildd/core/prompt-seed';
import { validateTextPrompt, type RegisteredPrompt } from '@buildd/core/prompts';
import { reportPromptSeed, runPromptSeed, type SeedDeps } from './seed-prompts';
import { buildDefaultsExport } from './export-prompt-defaults';
import { listPromptCatalog } from '../src/lib/prompt-catalog';

const CATALOG: RegisteredPrompt[] = [{ id: 'test.a', format: 'text', publicDefault: 'public a', validate: validateTextPrompt }];

function reader(files: Record<string, string>): PromptFileReader {
  return { read: async p => (p in files ? files[p] : Promise.reject(new Error('not found'))) };
}

function deps(over: Partial<SeedDeps> & { files?: Record<string, string> } = {}) {
  const applied: PromptSeedAction[][] = [];
  const markers: PromptSeedMarker[] = [];
  const files = over.files ?? {
    'manifest.json': JSON.stringify({ prompts: [{ id: 'test.a', version: 1, file: 'a.md', sha256: sha256Hex('private a') }] }),
    'a.md': 'private a',
  };
  const fetchCalls: string[] = [];
  const d: SeedDeps = {
    env: { DATABASE_URL: 'postgres://x', PROMPTS_REPO: 'org/prompts' },
    catalog: () => CATALOG,
    appToken: async () => null,
    readRows: async (): Promise<ExistingPromptRow[]> => [],
    apply: async a => void applied.push([...a]),
    writeMarker: async m => void markers.push(m),
    fetchImpl: (async (url: string) => {
      fetchCalls.push(url);
      const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
      return path in files ? new Response(files[path]) : new Response('', { status: 404 });
    }) as unknown as typeof fetch,
    now: () => new Date('2026-01-02T03:04:05Z'),
    ...over,
  };
  return { d, applied, markers, fetchCalls };
}

describe('runPromptSeed', () => {
  it('skips, writing nothing, when no prompts repo is configured', async () => {
    const { d, applied } = deps({ env: { DATABASE_URL: 'postgres://x' } });
    expect(await runPromptSeed(d)).toEqual({ status: 'skipped', reason: expect.stringContaining('PROMPTS_REPO is not set') });
    expect(applied).toEqual([]);
  });

  it('skips when there is no database', async () => {
    const { d } = deps({ env: { PROMPTS_REPO: 'org/prompts', PROMPTS_REPO_TOKEN: 't' } });
    expect((await runPromptSeed(d)).status).toBe('skipped');
  });

  it('skips when there is neither a token nor a GitHub App that can read the repo', async () => {
    const { d, fetchCalls } = deps();
    const out = await runPromptSeed(d);
    expect(out).toEqual({ status: 'skipped', reason: expect.stringContaining('no PROMPTS_REPO_TOKEN') });
    expect(fetchCalls).toEqual([]);
  });

  it('seeds with the GitHub App token when no PROMPTS_REPO_TOKEN is set, and records the seeded ids', async () => {
    const { d, applied, markers, fetchCalls } = deps({ appToken: async repo => (repo === 'org/prompts' ? 'app-token' : null) });
    const out = await runPromptSeed(d);
    expect(out).toEqual({ status: 'seeded', summary: '1 new version(s), 0 reactivated, 0 unchanged, 0 deactivated', ids: ['test.a'] });
    expect(applied[0].map(a => a.type)).toEqual(['insert', 'activate']);
    expect(markers).toEqual([{ seededAt: '2026-01-02T03:04:05.000Z', ids: ['test.a'] }]);
    expect(fetchCalls[0]).toContain('/repos/org/prompts/contents/manifest.json?ref=main');
  });

  it('prefers PROMPTS_REPO_TOKEN and honours PROMPTS_REPO_REF', async () => {
    let asked = false;
    const { d, fetchCalls } = deps({
      env: { DATABASE_URL: 'x', PROMPTS_REPO: 'org/prompts', PROMPTS_REPO_TOKEN: 'tok', PROMPTS_REPO_REF: 'v2' },
      appToken: async () => ((asked = true), 'app'),
    });
    expect((await runPromptSeed(d)).status).toBe('seeded');
    expect(asked).toBe(false);
    expect(fetchCalls[0]).toContain('ref=v2');
  });

  it('refuses, writing nothing and no marker, when the seed names an unknown id', async () => {
    const { d, applied, markers } = deps({
      env: { DATABASE_URL: 'x', PROMPTS_REPO: 'org/prompts', PROMPTS_REPO_TOKEN: 't' },
      files: {
        'manifest.json': JSON.stringify({ prompts: [{ id: 'test.nope', version: 1, file: 'n.md', sha256: sha256Hex('n') }] }),
        'n.md': 'n',
      },
    });
    expect(await runPromptSeed(d)).toEqual({ status: 'refused', problems: ['"test.nope": not a registered prompt id'] });
    expect(applied).toEqual([]);
    expect(markers).toEqual([]);
  });

  it('fails soft when the repo cannot be read', async () => {
    const { d } = deps({ env: { DATABASE_URL: 'x', PROMPTS_REPO: 'org/prompts', PROMPTS_REPO_TOKEN: 't' }, files: {} });
    expect(await runPromptSeed(d)).toEqual({ status: 'failed', reason: 'GitHub 404' });
  });

  it('rejects a malformed PROMPTS_REPO before any request', async () => {
    const { d, fetchCalls } = deps({ env: { DATABASE_URL: 'x', PROMPTS_REPO: 'https://example.com/x', PROMPTS_REPO_TOKEN: 't' } });
    expect((await runPromptSeed(d)).status).toBe('failed');
    expect(fetchCalls).toEqual([]);
  });

  it('a second run over the rows the first wrote is a no-op', async () => {
    const { d, applied } = deps({
      env: { DATABASE_URL: 'x', PROMPTS_REPO: 'org/prompts', PROMPTS_REPO_TOKEN: 't' },
      readRows: async () => [{ id: 'test.a', version: 1, contentHash: sha256Hex('private a'), active: true }],
    });
    expect(await runPromptSeed(d)).toMatchObject({ status: 'seeded', summary: '0 new version(s), 0 reactivated, 1 unchanged, 0 deactivated' });
    expect(applied[0]).toEqual([{ type: 'unchanged', id: 'test.a', version: 1 }]);
  });

  it('round-trips the exported public defaults of the real catalog', async () => {
    const catalog = listPromptCatalog();
    const { files, manifest } = buildDefaultsExport(catalog, 1);
    const { d } = deps({
      dir: '/unused',
      dirReader: () => reader({ ...files, 'manifest.json': JSON.stringify({ prompts: manifest }) }),
      catalog: () => catalog,
    });
    const out = await runPromptSeed(d);
    expect(out.status).toBe('seeded');
    if (out.status === 'seeded') expect(out.ids.sort()).toEqual(catalog.map(c => c.id).sort());
  });
});

describe('reportPromptSeed', () => {
  it('never fails the deploy unless strict, and never logs text', () => {
    const lines: string[] = [];
    const refused = { status: 'refused' as const, problems: ['"x": rejected (question names differ from the default)'] };
    expect(reportPromptSeed(refused, false, l => lines.push(l))).toBe(0);
    expect(reportPromptSeed(refused, true, () => {})).toBe(1);
    expect(reportPromptSeed({ status: 'failed', reason: 'GitHub 401' }, false, () => {})).toBe(0);
    expect(reportPromptSeed({ status: 'skipped', reason: 'r' }, true, () => {})).toBe(0);
    expect(lines.join('\n')).toContain('REFUSED');
  });
});
