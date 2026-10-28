import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import {
  DOUBLE_RUN_FILES,
  dbShardFiles,
  discoverDbTests,
  parseDbTestArgs,
  readDbDurationHints,
  runsFor,
} from './run-db-tests';

const SHARDS = 4;
const shard = (index: number, count = SHARDS) => ({ index, count });

describe('test:db --shard parsing', () => {
  it('accepts i/n in either form and keeps named files', () => {
    expect(parseDbTestArgs(['--shard', '2/4'])).toEqual({ files: [], shard: { index: 2, count: 4 } });
    expect(parseDbTestArgs(['--shard=4/4', 'a.test.ts'])).toEqual({ files: ['a.test.ts'], shard: { index: 4, count: 4 } });
    expect(parseDbTestArgs(['a.test.ts']).shard).toBeNull();
  });

  it('rejects a malformed or out-of-range shard instead of running some other slice', () => {
    for (const bad of [['--shard', '0/4'], ['--shard', '5/4'], ['--shard=x/4'], ['--shard']]) {
      expect(() => parseDbTestArgs(bad)).toThrow();
    }
  });
});

describe('the real suite split four ways', () => {
  const files = discoverDbTests();
  const hints = readDbDurationHints();
  const slices = [1, 2, 3, 4].map(i => dbShardFiles(files, hints, shard(i)));

  it('discovers the suite', () => {
    expect(files.length).toBeGreaterThan(SHARDS);
  });

  it('puts every file in exactly one shard', () => {
    const all = slices.flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...files].sort());
  });

  it('gives every shard at least one file', () => {
    for (const s of slices) expect(s.length).toBeGreaterThan(0);
  });

  it('is deterministic, whatever order the files are listed in', () => {
    const again = [1, 2, 3, 4].map(i => dbShardFiles([...files].reverse(), hints, shard(i)));
    expect(again).toEqual(slices);
  });

  it('runs each shard in path order', () => {
    for (const s of slices) expect(s).toEqual([...s].sort());
  });

  it('still double-runs workflow-matrix, in whichever shard holds it', () => {
    for (const f of DOUBLE_RUN_FILES) {
      const holders = slices.filter(s => s.some(file => file === `apps/web/${f}`));
      expect(holders.length).toBe(1);
      expect(runsFor(`apps/web/${f}`, true)).toBe(2);
      expect(runsFor(`apps/web/${f}`, false)).toBe(1);
    }
    expect(runsFor(files.find(f => !DOUBLE_RUN_FILES.has(f.slice('apps/web/'.length)))!, true)).toBe(1);
  });

  it('qa-scrub-prod-ahead gets a shard to itself, so it never scrubs the budget tests\' rows', () => {
    const holder = slices.find(s => s.includes('apps/web/tests/db/qa-scrub-prod-ahead.test.ts'));
    expect(holder).toEqual(['apps/web/tests/db/qa-scrub-prod-ahead.test.ts']);
  });

  it('every duration hint names a real DB test file', () => {
    for (const key of Object.keys(hints)) expect(files).toContain(key);
  });
});

describe('dbShardFiles edge cases', () => {
  it('fewer files than shards leaves some shards empty, without error', () => {
    const files = ['a.test.ts', 'b.test.ts'];
    const slices = [1, 2, 3, 4].map(i => dbShardFiles(files, {}, shard(i)));
    expect(slices.flat().sort()).toEqual(files);
    expect(slices.filter(s => s.length === 0).length).toBe(2);
  });

  it('balances by the hints: a slow file gets a shard to itself', () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.test.ts`);
    const slices = [1, 2, 3, 4].map(i => dbShardFiles(files, { 'f05.test.ts': 600_000 }, shard(i)));
    expect(slices.find(s => s.includes('f05.test.ts'))).toEqual(['f05.test.ts']);
  });
});

describe('build.yml runs the shards this script expects', () => {
  const wf: any = Bun.YAML.parse(readFileSync('.github/workflows/build.yml', 'utf8'));
  const job = wf.jobs['db-architecture-shards'];

  it('a matrix of four shards, one runner each, none cancelling the others', () => {
    expect(job.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    expect(job.strategy['fail-fast']).toBe(false);
    const run = job.steps.find((s: any) => s.name === 'Run DB architecture tests').run;
    expect(run).toContain('--shard "${{ matrix.shard }}/4"');
  });
});
