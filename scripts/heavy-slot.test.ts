import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquire, slotCount, tryAcquire } from './heavy-slot';

const fresh = () => mkdtempSync(join(tmpdir(), 'heavy-slot-test-'));

describe('slotCount', () => {
  it('defaults to a quarter of the CPUs, at least one', () => {
    expect(slotCount(undefined, 4)).toBe(1);
    expect(slotCount(undefined, 2)).toBe(1);
    expect(slotCount(undefined, 16)).toBe(4);
  });
  it('honours an explicit value, 0 disables', () => {
    expect(slotCount('3', 4)).toBe(3);
    expect(slotCount('0', 4)).toBe(0);
  });
});

describe('tryAcquire', () => {
  it('admits up to the slot count and frees on release', () => {
    const dir = fresh();
    const a = tryAcquire(dir, 1);
    expect(a).not.toBeNull();
    expect(tryAcquire(dir, 1)).toBeNull();
    a!();
    expect(tryAcquire(dir, 1)).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it('reclaims a slot whose owner is dead', () => {
    const dir = fresh();
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(join(dir, 'slot-0', 'pid'), '2147483646');
    expect(tryAcquire(dir, 1)).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it('does not reclaim a live owner', () => {
    const dir = fresh();
    mkdirSync(join(dir, 'slot-0'));
    writeFileSync(join(dir, 'slot-0', 'pid'), String(process.ppid));
    expect(tryAcquire(dir, 1)).toBeNull();
    expect(existsSync(join(dir, 'slot-0'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('acquire', () => {
  it('gives up waiting after the cap and returns null', async () => {
    const dir = fresh();
    const held = tryAcquire(dir, 1);
    const msgs: string[] = [];
    expect(await acquire(dir, 1, 30, m => msgs.push(m), 10)).toBeNull();
    expect(msgs.length).toBe(2);
    held!();
    rmSync(dir, { recursive: true, force: true });
  });
});
