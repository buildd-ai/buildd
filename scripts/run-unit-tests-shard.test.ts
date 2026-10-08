import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import {
  SHARD_COUNT,
  SHARD_MIN_TOTAL_MS,
  UNHINTED_ESTIMATE_MS,
  assignShards,
  isUnitTestFile,
  parseRunnerArgs,
  parseShard,
  readDurationHints,
  shardFiles,
} from './run-unit-tests';

const trackedUnitTests = (): string[] =>
  (spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '')
    .split('\0')
    .filter(isUnitTestFile)
    .sort();

describe('--shard parsing', () => {
  it('accepts i/n in either form and leaves the named list alone', () => {
    expect(parseRunnerArgs(['--shard', '2/3', 'ALL'])).toEqual({ named: ['ALL'], updateDurations: false, shard: { index: 2, count: 3 } });
    expect(parseRunnerArgs(['--shard=1/3'])).toEqual({ named: [], updateDurations: false, shard: { index: 1, count: 3 } });
    expect(parseRunnerArgs(['ALL']).shard).toBeNull();
  });

  it('rejects a malformed or out-of-range shard instead of running some other slice', () => {
    for (const bad of ['0/3', '4/3', '1/0', 'x/3', '1-3', '']) {
      expect(() => parseShard(bad)).toThrow();
    }
    expect(() => parseRunnerArgs(['--shard'])).toThrow();
  });
});

describe('shard assignment', () => {
  it('is greedy longest-first: the slow files spread out before the fast ones fill gaps', () => {
    const hints = { 'a.test.ts': 30_000, 'b.test.ts': 20_000, 'c.test.ts': 10_000, 'd.test.ts': 10_000 };
    const shards = assignShards(Object.keys(hints), hints, 2);
    // a→1, b→2, c→2 (20 < 30), then d ties 30/30 and goes to the lower index.
    expect(shards).toEqual([['a.test.ts', 'd.test.ts'], ['b.test.ts', 'c.test.ts']]);
  });

  it('is deterministic whatever order the files arrive in', () => {
    const files = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.test.ts`);
    const hints = { 'f03.test.ts': 9_000, 'f17.test.ts': 9_000, 'f20.test.ts': 4_000 };
    const forward = assignShards(files, hints, 3);
    const reversed = assignShards([...files].reverse(), hints, 3);
    expect(reversed).toEqual(forward);
  });

  it('a small selection stays on shard 1, so the other shards have nothing to run', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts'];
    expect(shardFiles(files, {}, 1, 3)).toEqual(files);
    expect(shardFiles(files, {}, 2, 3)).toEqual([]);
    expect(shardFiles(files, {}, 3, 3)).toEqual([]);
  });

  it('shards past the threshold', () => {
    const files = Array.from({ length: 3 }, (_, i) => `slow${i}.test.ts`);
    const hints = Object.fromEntries(files.map(f => [f, SHARD_MIN_TOTAL_MS]));
    expect([1, 2, 3].map(i => shardFiles(files, hints, i, 3).length)).toEqual([1, 1, 1]);
  });

  it('the union of every shard of the full collected set is exactly that set, with no file twice', () => {
    const all = trackedUnitTests();
    expect(all.length).toBeGreaterThan(400);
    const hints = readDurationHints();
    const shards = Array.from({ length: SHARD_COUNT }, (_, i) => shardFiles(all, hints, i + 1, SHARD_COUNT));
    const flat = shards.flat();
    expect(flat.length).toBe(all.length);
    expect([...new Set(flat)].sort()).toEqual(all);
    for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
  });

  it('the full set splits into shards of roughly equal estimated work', () => {
    const all = trackedUnitTests();
    const hints = readDurationHints();
    const load = (files: string[]) => files.reduce((sum, f) => sum + (hints[f] ?? UNHINTED_ESTIMATE_MS), 0);
    const loads = assignShards(all, hints, SHARD_COUNT).map(load);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...Object.values(hints)));
  });

  it('build.yml runs exactly SHARD_COUNT shards, each passing its own index', () => {
    const wf: any = Bun.YAML.parse(readFileSync('.github/workflows/build.yml', 'utf8'));
    const job = wf.jobs['build-unit-tests'];
    expect(job.strategy.matrix.shard).toEqual(Array.from({ length: SHARD_COUNT }, (_, i) => i + 1));
    const run = job.steps.find((s: any) => s.name === 'Run tests').run as string;
    expect(run).toContain(`--shard "\${{ matrix.shard }}/${SHARD_COUNT}"`);
  });
});
