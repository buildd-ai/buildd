/**
 * What a cloud run used of its container: the working-set peak (and the
 * memory it is measured against) and the lowest free disk (and the disk's
 * size). Printed as `BUILDD_METRIC=` lines (phase-lines.ts) for the cloud
 * runner's run report, which buildd reads to pick the workspace's container
 * size (apps/web/src/lib/runner-size.ts).
 *
 * Lines are printed as the extremes move, past a step, not once per tick: the
 * supervisor keeps the last value of each metric, so a run the container
 * dies under (OOM) still reports what it had reached.
 *
 * Linux only; anything it cannot read is null, never a throw.
 */
import type { RunMetric } from './phase-lines';

export interface ResourceSample {
  /** Working set: cgroup usage minus inactive file cache, or total minus available. */
  memUsedBytes: number | null;
  /** cgroup memory.max, or the machine's MemTotal when the cgroup is unlimited. */
  memLimitBytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
}

export interface ResourceFs {
  readFile(path: string): string;
  statfs(path: string): { bavail: number; blocks: number; bsize: number };
}

const CGROUP = '/sys/fs/cgroup';

function tryRead(fs: ResourceFs, path: string): string | null {
  try { return fs.readFile(path); } catch { return null; }
}

function int(text: string | null): number | null {
  if (text === null) return null;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  return total !== null && available !== null ? { totalBytes: total, availableBytes: available } : null;
}

export function parseMemoryStatInactiveFile(text: string): number {
  const m = /^inactive_file (\d+)$/m.exec(text);
  return m ? Number(m[1]) : 0;
}

export function readResourceSample(fs: ResourceFs, diskPath: string): ResourceSample {
  const meminfoText = tryRead(fs, '/proc/meminfo');
  const meminfo = meminfoText ? parseMeminfo(meminfoText) : null;

  let memUsedBytes: number | null = null;
  let memLimitBytes: number | null = null;
  const current = int(tryRead(fs, `${CGROUP}/memory.current`));
  if (current !== null) {
    const stat = tryRead(fs, `${CGROUP}/memory.stat`);
    memUsedBytes = Math.max(0, current - (stat ? parseMemoryStatInactiveFile(stat) : 0));
    // `max` (unlimited) does not parse: the machine is the limit then.
    memLimitBytes = int(tryRead(fs, `${CGROUP}/memory.max`)) ?? meminfo?.totalBytes ?? null;
  } else if (meminfo) {
    memUsedBytes = meminfo.totalBytes - meminfo.availableBytes;
    memLimitBytes = meminfo.totalBytes;
  }

  let diskFreeBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const s = fs.statfs(diskPath);
    diskFreeBytes = s.bavail * s.bsize;
    diskTotalBytes = s.blocks * s.bsize;
  } catch { /* no statfs: no disk numbers */ }

  return { memUsedBytes, memLimitBytes, diskFreeBytes, diskTotalBytes };
}

/** A new peak or low is printed once it moves this far past the last printed value. */
const MEM_STEP_BYTES = 64 * 1024 ** 2;
const DISK_STEP_BYTES = 128 * 1024 ** 2;

export type MetricLine = [RunMetric, number];

/** Keeps the extremes and decides which metric lines are due. */
export class ResourceTracker {
  private peak: number | null = null;
  private minFree: number | null = null;
  private printed: Partial<Record<RunMetric, number>> = {};

  observe(s: ResourceSample): MetricLine[] {
    if (s.memUsedBytes !== null) this.peak = Math.max(this.peak ?? 0, s.memUsedBytes);
    if (s.diskFreeBytes !== null) this.minFree = Math.min(this.minFree ?? Number.MAX_SAFE_INTEGER, s.diskFreeBytes);
    const out: MetricLine[] = [];
    const fixed = (name: RunMetric, v: number | null) => {
      if (v !== null && this.printed[name] !== v) out.push([name, v]);
    };
    fixed('mem_limit_bytes', s.memLimitBytes);
    fixed('disk_total_bytes', s.diskTotalBytes);
    const last = this.printed;
    if (this.peak !== null && (last.mem_peak_bytes === undefined || this.peak - last.mem_peak_bytes >= MEM_STEP_BYTES)) {
      out.push(['mem_peak_bytes', this.peak]);
    }
    if (this.minFree !== null && (last.disk_free_min_bytes === undefined || last.disk_free_min_bytes - this.minFree >= DISK_STEP_BYTES)) {
      out.push(['disk_free_min_bytes', this.minFree]);
    }
    for (const [k, v] of out) this.printed[k] = v;
    return out;
  }

  /** The exact extremes, where they moved less than a step since last printed. */
  flush(): MetricLine[] {
    const out: MetricLine[] = [];
    if (this.peak !== null && this.printed.mem_peak_bytes !== this.peak) out.push(['mem_peak_bytes', this.peak]);
    if (this.minFree !== null && this.printed.disk_free_min_bytes !== this.minFree) out.push(['disk_free_min_bytes', this.minFree]);
    for (const [k, v] of out) this.printed[k] = v;
    return out;
  }
}

export const RESOURCE_SAMPLE_INTERVAL_MS = 10_000;

/**
 * Sample now and every `intervalMs`, printing through `emit`. `stop()` takes
 * one last sample and prints the exact extremes. Never throws.
 */
export function startResourceSampler(d: {
  read(): ResourceSample;
  emit(name: RunMetric, value: number): void;
  intervalMs?: number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}): { stop(): void } {
  const tracker = new ResourceTracker();
  const tick = (final = false) => {
    try {
      const lines = tracker.observe(d.read());
      for (const [name, value] of final ? [...lines, ...tracker.flush()] : lines) d.emit(name, value);
    } catch { /* sampling is best effort */ }
  };
  tick();
  const handle = d.setInterval(() => tick(), d.intervalMs ?? RESOURCE_SAMPLE_INTERVAL_MS);
  return {
    stop() {
      d.clearInterval(handle);
      tick(true);
    },
  };
}

/** The sampler on the real container: /proc, /sys/fs/cgroup and statfs of `diskPath`. */
export async function startContainerResourceSampler(diskPath: string, emit: (name: RunMetric, value: number) => void): Promise<{ stop(): void }> {
  const { readFileSync, statfsSync } = await import('fs');
  const fs: ResourceFs = {
    readFile: (p) => readFileSync(p, 'utf8'),
    statfs: (p) => {
      const s = statfsSync(p);
      return { bavail: Number(s.bavail), blocks: Number(s.blocks), bsize: Number(s.bsize) };
    },
  };
  return startResourceSampler({
    read: () => readResourceSample(fs, diskPath),
    emit,
    // Never what keeps the process alive.
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); (h as { unref?: () => void }).unref?.(); return h; },
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  });
}
