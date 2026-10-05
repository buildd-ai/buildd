import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { validateTextPrompt, type ActivePrompt, type RegisteredPrompt } from '@buildd/core/prompts';
import { promptContentHash } from '@buildd/core/prompts-source';
import { checkPromptFallbacks, type PromptFallbackDeps } from './prompt-fallback-alert';

const CATALOG: RegisteredPrompt[] = [
  { id: 'test.a', format: 'text', publicDefault: 'a', validate: validateTextPrompt },
  { id: 'test.b', format: 'json', publicDefault: '{}', validate: b => (b.startsWith('{') ? null : 'body is not JSON') },
];
const row = (id: string, body: string): ActivePrompt => ({ id, version: 1, body, contentHash: promptContentHash(body) });

function deps(over: Partial<PromptFallbackDeps> & { active?: ActivePrompt[]; last?: string | null } = {}) {
  const notes: Array<{ title: string; message: string }> = [];
  let last = over.last ?? null;
  const writes: string[] = [];
  const d: PromptFallbackDeps = {
    env: { VERCEL_ENV: 'production' },
    readMarker: async () => ({ seededAt: '2026-01-01T00:00:00Z', ids: ['test.a', 'test.b'] }),
    readActive: async () => new Map((over.active ?? [row('test.a', 'private a'), row('test.b', '{"x":1}')]).map(r => [r.id, r])),
    catalog: () => CATALOG,
    readLastSignature: async () => last,
    writeLastSignature: async s => void (writes.push(s), (last = s)),
    notify: (title, message) => void notes.push({ title, message }),
    ...over,
  };
  return { d, notes, writes };
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('checkPromptFallbacks', () => {
  it('does nothing outside production', async () => {
    const { d, notes } = deps({ env: { VERCEL_ENV: 'preview' }, active: [] });
    expect(await checkPromptFallbacks(d)).toEqual({ status: 'skipped', reason: 'not production' });
    expect(notes).toEqual([]);
  });

  it('does nothing when no seed ever ran: public defaults are expected', async () => {
    const { d, notes } = deps({ readMarker: async () => null, active: [] });
    expect((await checkPromptFallbacks(d)).status).toBe('skipped');
    expect(notes).toEqual([]);
  });

  it('is quiet when every seeded id has a valid active row', async () => {
    const { d, notes } = deps();
    expect(await checkPromptFallbacks(d)).toEqual({ status: 'ok', seeded: 2 });
    expect(notes).toEqual([]);
  });

  it('pages once when seeded ids would resolve to public defaults, naming ids and reasons, not text', async () => {
    const { d, notes, writes } = deps({ active: [row('test.b', 'not json private words')] });
    const out = await checkPromptFallbacks(d);
    expect(out).toMatchObject({
      status: 'falling_back',
      alerted: true,
      fallbacks: [
        { id: 'test.a', reason: 'missing' },
        { id: 'test.b', reason: 'invalid' },
      ],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('[buildd] 2 prompt(s) running on public defaults');
    expect(notes[0].message).toContain('test.a (no active row)');
    expect(notes[0].message).not.toContain('private words');
    expect(writes).toEqual(['test.a:missing,test.b:invalid']);

    // Same set on the next tick: no second page.
    expect(await checkPromptFallbacks(d)).toMatchObject({ status: 'falling_back', alerted: false });
    expect(notes).toHaveLength(1);
  });

  it('re-arms after the fallbacks clear', async () => {
    const { d, writes } = deps({ last: 'test.a:missing' });
    expect((await checkPromptFallbacks(d)).status).toBe('ok');
    expect(writes).toEqual(['']);
  });

  it('a failed read is reported, never paged as a fallback', async () => {
    const { d, notes } = deps({ readActive: async () => Promise.reject(new Error('db down')) });
    expect(await checkPromptFallbacks(d)).toEqual({ status: 'error', reason: 'db down' });
    expect(notes).toEqual([]);
  });
});
