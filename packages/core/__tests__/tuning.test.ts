import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import {
  createTuningLoader,
  clampedInt,
  clampedNumber,
  markdownPrompt,
  parseTuningSource,
  type TuningFetcher,
  type TuningFiles,
} from '../tuning';

const SOURCE = 'example-org/example-private@main:tuning';

function harness(opts: { source?: string; files?: TuningFiles; version?: string } = {}) {
  let nowMs = 1_000_000;
  const warnings: string[] = [];
  let calls = 0;
  let mode: 'ok' | 'fail' = 'ok';
  let current = { version: opts.version ?? 'abc123def456', files: opts.files ?? {} };
  const fetcher: TuningFetcher = async () => {
    calls++;
    if (mode === 'fail') throw new Error('network down');
    return current;
  };
  const loader = createTuningLoader({
    source: 'source' in opts ? opts.source : SOURCE,
    fetcher,
    now: () => nowMs,
    warn: (m) => warnings.push(m),
  });
  return {
    loader,
    warnings,
    calls: () => calls,
    advance: (ms: number) => { nowMs += ms; },
    fail: () => { mode = 'fail'; },
    heal: () => { mode = 'ok'; },
    set: (files: TuningFiles, version = 'next0000sha1') => { current = { version, files }; },
  };
}

describe('parseTuningSource', () => {
  it('parses owner/repo@ref:path', () => {
    expect(parseTuningSource(SOURCE)).toEqual({
      owner: 'example-org', repo: 'example-private', ref: 'main', path: 'tuning',
    });
  });

  it('accepts nested paths and slashed refs', () => {
    expect(parseTuningSource('example-org/example-private@release/v1:a/b/')).toEqual({
      owner: 'example-org', repo: 'example-private', ref: 'release/v1', path: 'a/b',
    });
  });

  it.each(['', 'example-org/example-private', 'example-org/example-private@main', 'x@main:p', 'a/b@main:../etc', 'a/b@:p'])(
    'rejects malformed %p',
    (raw) => {
      expect(parseTuningSource(raw)).toBeNull();
    },
  );
});

describe('getTuning', () => {
  const fallback = { retries: 2 };
  const schema = z.object({ retries: clampedInt(0, 5) });

  it('returns the public default when no source is configured, without fetching', async () => {
    const h = harness({ source: undefined });
    expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toBe(fallback);
    expect(h.calls()).toBe(0);
    expect(h.warnings).toEqual([]);
  });

  it('returns the public default when the source string is malformed', async () => {
    const h = harness({ source: 'not a source' });
    expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toBe(fallback);
    expect(h.calls()).toBe(0);
  });

  it('returns the private value when present and valid', async () => {
    const h = harness({ files: { 'policy.ci-retry.json': '{"retries":4}' } });
    expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toEqual({ retries: 4 });
  });

  it('returns markdown entries as strings', async () => {
    const h = harness({ files: { 'role.builder.md': '# Private builder prompt' } });
    expect(await h.loader.getTuning('role:builder', 'public prompt', markdownPrompt())).toBe('# Private builder prompt');
  });

  it('returns the default silently when the bundle does not carry the key', async () => {
    const h = harness({ files: {} });
    expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toBe(fallback);
    expect(h.warnings).toEqual([]);
  });

  it('returns the default and does not throw when the fetch fails', async () => {
    const h = harness();
    h.fail();
    expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toBe(fallback);
  });

  it('returns the default when the JSON is malformed', async () => {
    const h = harness({ files: { 'policy.ci-retry.json': '{not json' } });
    expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toBe(fallback);
  });

  it('returns the default when validation fails', async () => {
    const h = harness({ files: { 'policy.ci-retry.json': '{"retries":"lots"}' } });
    expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toBe(fallback);
  });

  it('accepts a plain validator function and falls back when it throws', async () => {
    const h = harness({ files: { 'policy.x.json': '7' } });
    const validate = (v: unknown) => {
      if (typeof v !== 'number' || v > 5) throw new Error('bad');
      return v;
    };
    expect(await h.loader.getTuning('policy:x', 1, validate)).toBe(1);
  });

  it('warns once per key per process, without leaking values or the source', async () => {
    const h = harness({ files: { 'policy.ci-retry.json': '{"retries":"SECRET-VALUE"}' } });
    await h.loader.getTuning('policy:ci-retry', fallback, schema);
    await h.loader.getTuning('policy:ci-retry', fallback, schema);
    await h.loader.getTuning('policy:ci-retry', fallback, schema);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('policy:ci-retry');
    expect(h.warnings[0]).not.toContain('SECRET-VALUE');
    expect(h.warnings[0]).not.toContain('example-private');

    const f = harness();
    f.fail();
    await f.loader.getTuning('policy:a', 1, z.number());
    await f.loader.getTuning('policy:b', 1, z.number());
    await f.loader.getTuning('policy:a', 1, z.number());
    expect(f.warnings).toHaveLength(2);
    expect(f.warnings.join('\n')).not.toContain('network down');
  });

  describe('clamps', () => {
    it('clamps an out-of-range integer into range', async () => {
      const hi = harness({ files: { 'policy.ci-retry.json': '{"retries":10000}' } });
      expect(await hi.loader.getTuning('policy:ci-retry', fallback, schema)).toEqual({ retries: 5 });
      const lo = harness({ files: { 'policy.ci-retry.json': '{"retries":-3}' } });
      expect(await lo.loader.getTuning('policy:ci-retry', fallback, schema)).toEqual({ retries: 0 });
    });

    it('rounds a fractional integer and rejects non-finite numbers', () => {
      expect(clampedInt(0, 5).parse(2.6)).toBe(3);
      expect(clampedInt(0, 5).safeParse(Number.NaN).success).toBe(false);
      expect(clampedInt(0, 5).safeParse('3').success).toBe(false);
    });

    it('clamps a float', () => {
      expect(clampedNumber(0.1, 0.9).parse(4)).toBe(0.9);
      expect(clampedNumber(0.1, 0.9).parse(0)).toBe(0.1);
    });

    it('rejects empty or oversized markdown', () => {
      expect(markdownPrompt().safeParse('   ').success).toBe(false);
      expect(markdownPrompt({ maxLength: 10 }).safeParse('x'.repeat(11)).success).toBe(false);
    });
  });

  describe('cache', () => {
    it('serves from cache inside the TTL', async () => {
      const h = harness({ files: { 'policy.ci-retry.json': '{"retries":4}' } });
      await h.loader.getTuning('policy:ci-retry', fallback, schema);
      h.advance(4 * 60_000);
      await h.loader.getTuning('policy:ci-retry', fallback, schema);
      expect(h.calls()).toBe(1);
    });

    it('refetches after the TTL and picks up new values', async () => {
      const h = harness({ files: { 'policy.ci-retry.json': '{"retries":4}' } });
      await h.loader.getTuning('policy:ci-retry', fallback, schema);
      h.set({ 'policy.ci-retry.json': '{"retries":1}' });
      h.advance(5 * 60_000 + 1);
      expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toEqual({ retries: 1 });
      expect(h.calls()).toBe(2);
    });

    it('serves the stale bundle when a refresh fails', async () => {
      const h = harness({ files: { 'policy.ci-retry.json': '{"retries":4}' } });
      await h.loader.getTuning('policy:ci-retry', fallback, schema);
      h.fail();
      h.advance(10 * 60_000);
      expect(await h.loader.getTuning('policy:ci-retry', fallback, schema)).toEqual({ retries: 4 });
    });

    it('does not hammer a failing source: retries only after a backoff', async () => {
      const h = harness();
      h.fail();
      await h.loader.getTuning('policy:a', 1, z.number());
      await h.loader.getTuning('policy:a', 1, z.number());
      expect(h.calls()).toBe(1);
      h.advance(60_000);
      await h.loader.getTuning('policy:a', 1, z.number());
      expect(h.calls()).toBe(2);
    });

    it('recovers once the source heals', async () => {
      const h = harness({ files: { 'policy.a.json': '3' } });
      h.fail();
      expect(await h.loader.getTuning('policy:a', 1, z.number())).toBe(1);
      h.heal();
      h.advance(60_000);
      expect(await h.loader.getTuning('policy:a', 1, z.number())).toBe(3);
    });

    it('shares one in-flight fetch between concurrent callers', async () => {
      const h = harness({ files: { 'policy.a.json': '3', 'policy.b.json': '4' } });
      const [a, b] = await Promise.all([
        h.loader.getTuning('policy:a', 1, z.number()),
        h.loader.getTuning('policy:b', 1, z.number()),
      ]);
      expect([a, b]).toEqual([3, 4]);
      expect(h.calls()).toBe(1);
    });
  });
});

describe('loadTuningBundle + diagnostics', () => {
  it('returns null when unset', async () => {
    const h = harness({ source: undefined });
    expect(await h.loader.loadTuningBundle()).toBeNull();
  });

  it('maps filenames to keys, parsing json and keeping markdown', async () => {
    const h = harness({
      files: {
        'role.builder.md': 'prompt',
        'policy.ci-retry.json': '{"retries":3}',
        'README.md': 'ignored',
        'policy.bad.json': '{oops',
      },
    });
    const bundle = await h.loader.loadTuningBundle();
    expect(bundle?.version).toBe('abc123def456');
    expect(bundle?.entries.get('role:builder')).toBe('prompt');
    expect(bundle?.entries.get('policy:ci-retry')).toEqual({ retries: 3 });
    expect([...(bundle?.entries.keys() ?? [])].sort()).toEqual(['policy:ci-retry', 'role:builder']);
  });

  it('exposes only version and counts as diagnostics, never values or the source', async () => {
    const h = harness({ files: { 'role.builder.md': 'TOP-SECRET-PROMPT' } });
    expect(h.loader.getTuningDiagnostics()).toEqual({
      configured: true, loaded: false, version: null, keyCount: 0, loadedAt: null, stale: false,
    });
    await h.loader.loadTuningBundle();
    const d = h.loader.getTuningDiagnostics();
    expect(d).toMatchObject({ configured: true, loaded: true, version: 'abc123def456', keyCount: 1, stale: false });
    const text = JSON.stringify(d);
    expect(text).not.toContain('TOP-SECRET-PROMPT');
    expect(text).not.toContain('example-private');
  });

  it('marks diagnostics stale after a failed refresh', async () => {
    const h = harness({ files: { 'role.builder.md': 'p' } });
    await h.loader.loadTuningBundle();
    h.fail();
    h.advance(10 * 60_000);
    await h.loader.loadTuningBundle();
    expect(h.loader.getTuningDiagnostics()).toMatchObject({ loaded: true, stale: true, version: 'abc123def456' });
  });

  it('reports unconfigured diagnostics when unset', () => {
    const h = harness({ source: undefined });
    expect(h.loader.getTuningDiagnostics().configured).toBe(false);
  });
});
