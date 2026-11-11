import { describe, test, expect } from 'bun:test';
import { UpdateDrain, pollAfterBootRelease } from '../../src/update-drain';

const quiet = { log() {}, warn() {} };
const drain = () => new UpdateDrain({ windowMs: 600_000, bootHoldMs: 90_000 }, quiet);

describe('pollAfterBootRelease', () => {
  test('polls once after the boot hold is lifted with no update waiting', async () => {
    const d = drain(); d.holdForBoot(Date.now());
    let polls = 0;
    await pollAfterBootRelease(d.releaseBootHold('known'), false, async () => { polls++; return []; });
    expect(polls).toBe(1);
  });

  test('a repeated setLatestCommit (hold already gone) does not poll again', async () => {
    const d = drain(); d.holdForBoot(Date.now());
    let polls = 0;
    const poll = async () => { polls++; return []; };
    await pollAfterBootRelease(d.releaseBootHold('a'), false, poll);
    await pollAfterBootRelease(d.releaseBootHold('b'), false, poll);
    expect(polls).toBe(1);
  });

  test('no poll while an update is waiting', async () => {
    const d = drain(); d.holdForBoot(Date.now());
    let polls = 0;
    await pollAfterBootRelease(d.releaseBootHold('update'), true, async () => { polls++; });
    expect(polls).toBe(0);
  });

  test('no poll when no hold was active', async () => {
    let polls = 0;
    await pollAfterBootRelease(drain().releaseBootHold('x'), false, async () => { polls++; });
    expect(polls).toBe(0);
  });

  test('does not double an in-flight poll, survives a failing poll', async () => {
    let polls = 0; let finish!: () => void;
    const first = pollAfterBootRelease(true, false, () => { polls++; return new Promise<void>(r => { finish = r; }); });
    await pollAfterBootRelease(true, false, async () => { polls++; });
    expect(polls).toBe(1);
    finish(); await first;
    await pollAfterBootRelease(true, false, async () => { polls++; throw new Error('x'); });
    expect(polls).toBe(2);
  });
});
