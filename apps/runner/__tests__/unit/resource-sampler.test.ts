import { describe, expect, test } from 'bun:test';
import {
  ResourceTracker,
  parseMeminfo,
  parseMemoryStatInactiveFile,
  readResourceSample,
  startResourceSampler,
  type ResourceFs,
} from '../../src/resource-sampler';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function fakeFs(files: Record<string, string>, disk: { bavail: number; blocks: number; bsize: number } | null = { bavail: 5 * GIB / 4096, blocks: 8 * GIB / 4096, bsize: 4096 }): ResourceFs {
  return {
    readFile: (p) => { if (p in files) return files[p]!; throw new Error(`ENOENT ${p}`); },
    statfs: () => { if (!disk) throw new Error('ENOSYS'); return disk; },
  };
}

const MEMINFO = `MemTotal:        4194304 kB\nMemFree:          100000 kB\nMemAvailable:     1048576 kB\n`;

describe('parsers', () => {
  test('meminfo: total and available in bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ totalBytes: 4 * GIB, availableBytes: 1 * GIB });
    expect(parseMeminfo('garbage')).toBeNull();
  });

  test('memory.stat: inactive_file', () => {
    expect(parseMemoryStatInactiveFile('anon 100\ninactive_file 4096\nactive_file 5\n')).toBe(4096);
    expect(parseMemoryStatInactiveFile('anon 100\n')).toBe(0);
  });
});

describe('readResourceSample', () => {
  test('cgroup v2: working set is usage minus inactive file cache, against memory.max', () => {
    const s = readResourceSample(fakeFs({
      '/sys/fs/cgroup/memory.current': `${3 * GIB}\n`,
      '/sys/fs/cgroup/memory.max': `${4 * GIB}\n`,
      '/sys/fs/cgroup/memory.stat': `inactive_file ${512 * MIB}\n`,
      '/proc/meminfo': MEMINFO,
    }), '/data');
    expect(s).toEqual({ memUsedBytes: 3 * GIB - 512 * MIB, memLimitBytes: 4 * GIB, diskFreeBytes: 5 * GIB, diskTotalBytes: 8 * GIB });
  });

  test('an unlimited cgroup is measured against the machine (a VM-per-container platform)', () => {
    const s = readResourceSample(fakeFs({
      '/sys/fs/cgroup/memory.current': `${2 * GIB}\n`,
      '/sys/fs/cgroup/memory.max': 'max\n',
      '/proc/meminfo': MEMINFO,
    }), '/data');
    expect(s.memLimitBytes).toBe(4 * GIB);
    expect(s.memUsedBytes).toBe(2 * GIB);
  });

  test('no cgroup at all: used is total minus available', () => {
    const s = readResourceSample(fakeFs({ '/proc/meminfo': MEMINFO }), '/data');
    expect(s).toMatchObject({ memUsedBytes: 3 * GIB, memLimitBytes: 4 * GIB });
  });

  test('nothing readable: nulls, never a throw', () => {
    expect(readResourceSample(fakeFs({}, null), '/data')).toEqual({ memUsedBytes: null, memLimitBytes: null, diskFreeBytes: null, diskTotalBytes: null });
  });
});

describe('ResourceTracker: the lines it prints', () => {
  const sample = (usedGiB: number, freeGiB: number) => ({ memUsedBytes: usedGiB * GIB, memLimitBytes: 4 * GIB, diskFreeBytes: freeGiB * GIB, diskTotalBytes: 8 * GIB });

  test('the first sample prints everything', () => {
    expect(new ResourceTracker().observe(sample(1, 5))).toEqual([
      ['mem_limit_bytes', 4 * GIB], ['disk_total_bytes', 8 * GIB], ['mem_peak_bytes', 1 * GIB], ['disk_free_min_bytes', 5 * GIB],
    ]);
  });

  test('only a new peak or a new low prints, and only past a step (no line per tick)', () => {
    const t = new ResourceTracker();
    t.observe(sample(1, 5));
    expect(t.observe(sample(0.5, 6))).toEqual([]);           // lower usage, more free disk: nothing new
    expect(t.observe(sample(1 + 1 / 1024, 5))).toEqual([]);  // +1 MiB: under the step
    expect(t.observe(sample(2, 3))).toEqual([['mem_peak_bytes', 2 * GIB], ['disk_free_min_bytes', 3 * GIB]]);
  });

  test('flush prints the exact extremes not yet printed', () => {
    const t = new ResourceTracker();
    t.observe(sample(1, 5));
    t.observe(sample(1 + 1 / 1024, 5));
    expect(t.flush()).toEqual([['mem_peak_bytes', 1 * GIB + 1 * MIB]]);
    expect(t.flush()).toEqual([]);
  });
});

describe('startResourceSampler', () => {
  test('samples now and on each tick, prints through emit, and a final flush on stop', () => {
    const ticks: Array<() => void> = [];
    let used = 1 * GIB;
    const emitted: Array<[string, number]> = [];
    const s = startResourceSampler({
      read: () => ({ memUsedBytes: used, memLimitBytes: 4 * GIB, diskFreeBytes: 5 * GIB, diskTotalBytes: 8 * GIB }),
      emit: (name, value) => emitted.push([name, value]),
      setInterval: (fn) => { ticks.push(fn); return 1; },
      clearInterval: () => { ticks.length = 0; },
    });
    expect(emitted.map(e => e[0])).toContain('mem_peak_bytes');
    used = 3.9 * GIB;
    ticks[0]!();
    expect(emitted.at(-1)).toEqual(['mem_peak_bytes', 3.9 * GIB]);
    used = 3.9 * GIB + 1;
    s.stop();
    expect(emitted.at(-1)).toEqual(['mem_peak_bytes', 3.9 * GIB + 1]);
    expect(ticks).toHaveLength(0);
  });

  test('a read that throws never escapes', () => {
    const s = startResourceSampler({ read: () => { throw new Error('boom'); }, emit: () => {}, setInterval: () => 1, clearInterval: () => {} });
    expect(() => s.stop()).not.toThrow();
  });
});
