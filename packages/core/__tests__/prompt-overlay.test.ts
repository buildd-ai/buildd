import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  activePromptFingerprints,
  installPrompts,
  promptFallbackCounts,
  resetPrompts,
  resolvePrompt,
  type ActivePrompt,
} from '../prompts';
import { withPromptOverlay } from '../prompt-overlay';
import { promptContentHash } from '../prompts-source';

const row = (id: string, version: number, body: string): ActivePrompt => ({ id, version, body, contentHash: promptContentHash(body) });

afterEach(() => resetPrompts());

describe('withPromptOverlay', () => {
  it('resolves the overlay inside the scope and the live snapshot outside it', async () => {
    installPrompts([row('p.a', 1, 'live A')]);
    const inside = await withPromptOverlay([row('p.a', 7, 'eval A'), row('p.b', 2, 'eval B')], async () => {
      await new Promise(r => setTimeout(r, 1));
      return [resolvePrompt('p.a', 'default A'), resolvePrompt('p.b', 'default B')];
    });
    expect(inside).toEqual(['eval A', 'eval B']);
    expect(resolvePrompt('p.a', 'default A')).toBe('live A');
    expect(resolvePrompt('p.b', 'default B')).toBe('default B');
  });

  it('replaces the snapshot wholesale: a live row absent from the overlay resolves to its default', async () => {
    installPrompts([row('p.a', 1, 'live A')]);
    const got = await withPromptOverlay([], async () => resolvePrompt('p.a', 'default A'));
    expect(got).toBe('default A');
  });

  it('does not leak into concurrent work outside the scope', async () => {
    installPrompts([row('p.a', 1, 'live A')]);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const scoped = withPromptOverlay([row('p.a', 9, 'eval A')], async () => {
      await gate;
      return resolvePrompt('p.a', 'default A');
    });
    // A "live request" running while the overlay scope is open.
    expect(resolvePrompt('p.a', 'default A')).toBe('live A');
    release();
    expect(await scoped).toBe('eval A');
  });

  it('reports overlay fingerprints inside the scope', async () => {
    installPrompts([row('p.a', 1, 'live A')]);
    const fps = await withPromptOverlay([row('p.z', 4, 'eval Z')], async () => activePromptFingerprints());
    expect(fps).toEqual([{ id: 'p.z', version: 4, contentHash: promptContentHash('eval Z') }]);
    expect(activePromptFingerprints().map(f => f.id)).toEqual(['p.a']);
  });

  it('never counts a fallback from inside the scope against the live deployment', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    await withPromptOverlay([], async () => resolvePrompt('p.q', 'default Q'));
    expect(promptFallbackCounts()['p.q']).toBeUndefined();
    resolvePrompt('p.q', 'default Q');
    expect(promptFallbackCounts()['p.q']).toEqual({ missing: 1, invalid: 0 });
    warn.mockRestore();
  });
});
