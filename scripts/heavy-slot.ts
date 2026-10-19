#!/usr/bin/env bun
/**
 * Host-wide admission for heavyweight local checks (unit suite, `next build`,
 * type-check). The unit runner's load-average gate cannot see a build that has
 * not started chewing CPU yet, so several worktrees that start together all see
 * a quiet host and then fight each other. A slot is a lock directory under the
 * OS temp dir holding the owner pid; a dead owner's slot is reclaimed.
 *
 *   bun scripts/heavy-slot.ts -- <command> [args...]
 *
 * Slots default to floor(cpus / 4), minimum 1. `BUILDD_HEAVY_SLOTS=0` or `CI`
 * disables the gate; a child that already holds a slot (env marker) does not
 * ask for a second one. Waiting is bounded: after BUILDD_HEAVY_SLOT_WAIT_MS
 * (default 10 minutes) the command runs anyway, so the gate can delay but
 * never wedge a check.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { cpus, tmpdir } from 'os';
import { join } from 'path';

export const HELD_ENV = 'BUILDD_HEAVY_SLOT_HELD';

export function slotCount(configured: string | undefined, cpuCount: number): number {
  if (configured !== undefined && configured !== '' && Number.isFinite(Number(configured))) {
    return Math.max(0, Math.floor(Number(configured)));
  }
  return Math.max(1, Math.floor(cpuCount / 4));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Try each slot in turn; reclaim ones whose owner died. Returns a release fn or null. */
export function tryAcquire(dir: string, slots: number, pid = process.pid): (() => void) | null {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < slots; i++) {
    const lock = join(dir, `slot-${i}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(lock);
        writeFileSync(join(lock, 'pid'), String(pid));
        return () => rmSync(lock, { recursive: true, force: true });
      } catch {
        let owner = NaN;
        try { owner = Number(readFileSync(join(lock, 'pid'), 'utf8')); } catch { /* owner mid-write */ }
        if (Number.isFinite(owner) && owner > 0 && !pidAlive(owner)) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
        break;
      }
    }
  }
  return null;
}

export async function acquire(
  dir: string,
  slots: number,
  maxWaitMs: number,
  log?: (m: string) => void,
  pollMs = 2_000,
): Promise<(() => void) | null> {
  let waited = 0;
  for (;;) {
    const release = tryAcquire(dir, slots);
    if (release) return release;
    if (waited >= maxWaitMs) {
      log?.(`[heavy-slot] waited ${Math.round(waited / 1000)}s with no free slot; running anyway`);
      return null;
    }
    if (waited === 0) log?.(`[heavy-slot] ${slots} heavy check(s) already running on this host; waiting for a slot`);
    await new Promise(r => setTimeout(r, pollMs));
    waited += pollMs;
  }
}

async function main(): Promise<number> {
  // Bun consumes a leading `--`, so accept the command with or without it.
  const cmd = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  if (cmd.length === 0) {
    console.error('usage: bun scripts/heavy-slot.ts -- <command> [args...]');
    return 2;
  }
  const slots = slotCount(process.env.BUILDD_HEAVY_SLOTS, cpus().length);
  let release: (() => void) | null = null;
  if (slots > 0 && !process.env.CI && !process.env[HELD_ENV]) {
    const wait = Number(process.env.BUILDD_HEAVY_SLOT_WAIT_MS);
    release = await acquire(
      join(tmpdir(), 'buildd-heavy-slots'),
      slots,
      Number.isFinite(wait) && wait >= 0 && process.env.BUILDD_HEAVY_SLOT_WAIT_MS ? wait : 600_000,
      m => console.error(m),
    );
  }
  const proc = Bun.spawn(cmd, {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, [HELD_ENV]: '1' },
  });
  const forward = (sig: NodeJS.Signals) => () => proc.kill(sig);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  const code = await proc.exited;
  release?.();
  return code;
}

if (import.meta.main) {
  main().then(code => process.exit(code));
}
