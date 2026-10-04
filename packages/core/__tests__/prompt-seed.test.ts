import { describe, expect, it } from 'bun:test';
import {
  PromptSeedError,
  expectedPromptFallbacks,
  githubPromptReader,
  loadPromptSeed,
  parsePromptManifest,
  parsePromptSeedMarker,
  planPromptSeed,
  sha256Hex,
  summarizePromptSeed,
  type ExistingPromptRow,
  type PromptFileReader,
  type PromptSeedEntry,
} from '../prompt-seed';
import { listRegisteredPrompts, validateTextPrompt, type RegisteredPrompt } from '../prompts';
import { promptContentHash } from '../prompts-source';
import '../prompt-catalog';
import { QUESTION_GATE_QUESTIONS } from '../question-gate-decision';

const TEXT: RegisteredPrompt = { id: 'test.text', format: 'text', publicDefault: 'hello', validate: validateTextPrompt };
const registered = (): RegisteredPrompt[] => [TEXT, ...listRegisteredPrompts()];

function dirReader(files: Record<string, string>): PromptFileReader {
  return {
    async read(path) {
      if (!(path in files)) throw new Error('not found');
      return files[path];
    },
  };
}

function seedDir(entries: Array<{ id: string; version?: number; file?: string; body: string; sha256?: string }>) {
  const files: Record<string, string> = {};
  const manifest = entries.map(e => {
    const file = e.file ?? `${e.id}.txt`;
    files[file] = e.body;
    return { id: e.id, version: e.version ?? 1, file, sha256: e.sha256 ?? sha256Hex(e.body) };
  });
  files['manifest.json'] = JSON.stringify({ prompts: manifest });
  return dirReader(files);
}

async function refusal(p: Promise<unknown>): Promise<string[]> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PromptSeedError) return err.problems;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('parsePromptManifest', () => {
  it('accepts a well-formed manifest', () => {
    const sha = sha256Hex('x');
    expect(parsePromptManifest(JSON.stringify({ prompts: [{ id: 'a', version: 2, file: 'p/a.json', sha256: sha }] }))).toEqual([
      { id: 'a', version: 2, file: 'p/a.json', sha256: sha },
    ]);
  });

  it('refuses non-JSON and a missing prompts array', () => {
    expect(() => parsePromptManifest('{')).toThrow(PromptSeedError);
    expect(() => parsePromptManifest('{"x":[]}')).toThrow('"prompts" array');
  });

  it('collects every bad entry: duplicate id, bad version, escaping path, bad hash', () => {
    const sha = sha256Hex('x');
    try {
      parsePromptManifest(
        JSON.stringify({
          prompts: [
            { id: 'a', version: 1, file: 'a', sha256: sha },
            { id: 'a', version: 2, file: 'a', sha256: sha },
            { id: 'b', version: 0, file: 'b', sha256: sha },
            { id: 'c', version: 1, file: '../c', sha256: sha },
            { id: 'd', version: 1, file: '/etc/d', sha256: sha },
            { id: 'e', version: 1, file: 'e', sha256: 'ABC' },
            { version: 1 },
          ],
        }),
      );
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PromptSeedError);
      const problems = (err as PromptSeedError).problems;
      expect(problems).toHaveLength(6);
      expect(problems.join('\n')).toContain('"a": listed twice');
      expect(problems.join('\n')).toContain('"b": version');
      expect(problems.join('\n')).toContain('"c": file');
      expect(problems.join('\n')).toContain('"d": file');
      expect(problems.join('\n')).toContain('"e": sha256');
      expect(problems.join('\n')).toContain('entry 6: no id');
    }
  });
});

describe('loadPromptSeed', () => {
  it('loads a text prompt and a decision whose questions keep the default shape', async () => {
    const reg = registered().find(r => r.id === 'buildd.question_gate')!;
    const entries = await loadPromptSeed(
      seedDir([
        { id: 'test.text', body: 'private text' },
        { id: 'buildd.question_gate', version: 3, body: reg.publicDefault },
      ]),
      registered(),
    );
    expect(entries.map(e => [e.id, e.version])).toEqual([['test.text', 1], ['buildd.question_gate', 3]]);
    // The row hash the loader checks is the same hash the manifest carries.
    expect(entries[0].contentHash).toBe(promptContentHash('private text'));
  });

  it('refuses an id nothing registers, before reading anything else', async () => {
    const problems = await refusal(loadPromptSeed(seedDir([{ id: 'buildd.not_a_prompt', body: 'x' }]), registered()));
    expect(problems).toEqual(['"buildd.not_a_prompt": not a registered prompt id']);
  });

  it('refuses a decision whose questions change shape, naming the reason but not the text', async () => {
    const changed = { ...QUESTION_GATE_QUESTIONS, extra: { type: 'noul', instructions: 'secret words' } };
    const problems = await refusal(
      loadPromptSeed(seedDir([{ id: 'buildd.question_gate', body: JSON.stringify(changed) }]), registered()),
    );
    expect(problems).toEqual(['"buildd.question_gate": rejected (question names differ from the default)']);
    expect(problems.join(' ')).not.toContain('secret words');
  });

  it('refuses a file that does not hash to its manifest entry, and an empty text body', async () => {
    const problems = await refusal(
      loadPromptSeed(
        seedDir([
          { id: 'test.text', body: 'a', sha256: sha256Hex('b') },
          { id: 'buildd.orchestration_manifest_pick', body: '{"instructions":"x"}' },
        ]),
        registered(),
      ),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('does not hash');
    expect(problems[1]).toContain('"done"');
  });

  it('every registered public default is itself a valid seed body', () => {
    const all = listRegisteredPrompts();
    expect(all.length).toBeGreaterThan(10);
    for (const r of all) expect([r.id, r.validate(r.publicDefault)]).toEqual([r.id, null]);
  });
});

describe('planPromptSeed', () => {
  const entry = (id: string, version: number, body: string): PromptSeedEntry => ({ id, version, body, contentHash: sha256Hex(body) });
  const row = (id: string, version: number, body: string, active: boolean): ExistingPromptRow => ({
    id,
    version,
    contentHash: sha256Hex(body),
    active,
  });

  it('inserts and activates a new version on an empty table', () => {
    const e = entry('a', 1, 'x');
    expect(planPromptSeed([e], [])).toEqual([
      { type: 'insert', entry: e },
      { type: 'activate', id: 'a', version: 1 },
    ]);
  });

  it('is a no-op when the active row already carries the seeded version', () => {
    const actions = planPromptSeed([entry('a', 1, 'x')], [row('a', 1, 'x', true)]);
    expect(actions).toEqual([{ type: 'unchanged', id: 'a', version: 1 }]);
    expect(summarizePromptSeed(actions)).toBe('0 new version(s), 0 reactivated, 1 unchanged, 0 deactivated');
  });

  it('inserts a new version when the content changes, and the activation replaces the old one', () => {
    const e = entry('a', 2, 'y');
    expect(planPromptSeed([e], [row('a', 1, 'x', true)])).toEqual([
      { type: 'insert', entry: e },
      { type: 'activate', id: 'a', version: 2 },
    ]);
  });

  it('reactivates an existing version without rewriting it (a rollback)', () => {
    expect(planPromptSeed([entry('a', 1, 'x')], [row('a', 1, 'x', false), row('a', 2, 'y', true)])).toEqual([
      { type: 'activate', id: 'a', version: 1 },
    ]);
  });

  it('refuses a version reused with different content', () => {
    expect(() => planPromptSeed([entry('a', 1, 'changed')], [row('a', 1, 'x', true)])).toThrow('bump its version');
  });

  it('deactivates an active id the seed no longer lists', () => {
    expect(planPromptSeed([], [row('gone', 1, 'x', true), row('gone', 0, 'w', false)])).toEqual([{ type: 'deactivate', id: 'gone' }]);
  });
});

describe('expectedPromptFallbacks', () => {
  const reg = (): RegisteredPrompt[] => registered();

  it('expects nothing when the deployment was never seeded', () => {
    expect(expectedPromptFallbacks(null, new Map(), reg())).toEqual([]);
  });

  it('names seeded ids with no active row, and active rows the reader now rejects', () => {
    const marker = { seededAt: '2026-01-01T00:00:00Z', ids: ['test.text', 'buildd.question_gate', 'buildd.memory_use'] };
    const memoryUse = reg().find(r => r.id === 'buildd.memory_use')!;
    const active = new Map([
      ['buildd.memory_use', { body: memoryUse.publicDefault }],
      ['buildd.question_gate', { body: '{"only":{"type":"noul","instructions":"x"}}' }],
    ]);
    expect(expectedPromptFallbacks(marker, active, reg())).toEqual([
      { id: 'buildd.question_gate', reason: 'invalid' },
      { id: 'test.text', reason: 'missing' },
    ]);
  });

  it('parses only a well-formed marker', () => {
    expect(parsePromptSeedMarker(null)).toBeNull();
    expect(parsePromptSeedMarker({ seededAt: 'x', ids: [] })).toBeNull();
    expect(parsePromptSeedMarker({ seededAt: 'x', ids: ['a', 3] })).toEqual({ seededAt: 'x', ids: ['a'] });
  });
});

describe('githubPromptReader', () => {
  it('reads raw contents at the ref with the token, and throws on a non-2xx', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return url.includes('missing') ? new Response('', { status: 404 }) : new Response('body');
    }) as unknown as typeof fetch;
    const reader = githubPromptReader({ repo: 'o/r', ref: 'main', token: 't0k', fetchImpl });
    expect(await reader.read('dir/a b.json')).toBe('body');
    expect(calls[0]).toEqual({ url: 'https://api.github.com/repos/o/r/contents/dir/a%20b.json?ref=main', auth: 'Bearer t0k' });
    await expect(reader.read('missing.json')).rejects.toThrow('GitHub 404');
  });
});
