/**
 * A refused `c` claim in words (spec c7410e76 R-55, AC-38): the socket sends the
 * refusal's fields, top says why without the task's title or a raw code.
 */
import { describe, expect, test } from 'bun:test';
import { claimRefusalBody, claimRefusalWords } from '../../src/top/claim-refusal';
import { actionResultText } from '../../src/top/keys';

const claim = { type: 'claim' as const, taskId: 't', title: 'feat(runner): buildd try <pr> runs a PR\'s runner on this machine before it ships' };
const said = (body: unknown, status = 400) => actionResultText(claim, { status, body }).text;

describe('the socket adds the refusal fields', () => {
  test('a claim the server answered with nothing claimed: its reason and the gate', () => {
    const err = Object.assign(new Error('Server rejected claim for task "T" — reason: race_lost'), { claimError: 'server_rejected', claimReason: 'race_lost', claimTaskExclusionCode: undefined });
    expect(claimRefusalBody(err)).toEqual({ error: err.message, claimReason: 'race_lost' });
  });

  test('the account limit: status, code and the counts from the refusal body', () => {
    const err = Object.assign(new Error('Max concurrent workers limit reached'), {
      status: 429,
      raw: JSON.stringify({ error: 'Max concurrent workers limit reached', code: 'max_concurrent_workers', limit: 3, current: 3 }),
    });
    expect(claimRefusalBody(err)).toEqual({ error: 'Max concurrent workers limit reached', serverStatus: 429, code: 'max_concurrent_workers', limit: 3, current: 3 });
  });
});

describe('top says why, short', () => {
  test('another runner took it first', () => {
    expect(said({ error: 'Server rejected claim for task "x" — reason: race_lost', claimReason: 'race_lost' })).toBe('Not claimed: another runner took it first.');
  });

  test('the account limit names the number', () => {
    expect(said({ error: 'Max concurrent workers limit reached', serverStatus: 429, code: 'max_concurrent_workers', limit: 3, current: 3 })).toBe('Not claimed: your account allows 3 at once and all 3 are busy.');
    expect(said({ error: 'x', serverStatus: 429 })).toBe("Not claimed: the account's worker limit is reached.");
  });

  test('a paused runner reads paused', () => {
    expect(said({ error: 'x', claimReason: 'runner_held' })).toBe('Not claimed: this runner is paused.');
  });

  test('a gate in its words; a local session\'s mission says so', () => {
    expect(said({ error: 'x', claimReason: 'all_candidates_deferred', exclusion: 'soft_overlap' })).toBe('Not claimed: waits for work on the same files.');
    expect(said({ error: 'x', exclusion: 'mission_local' })).toBe('Not claimed: its mission is managed from a local session.');
  });

  test('an older runner\'s prose loses the title and the raw code', () => {
    const t = said({ error: `Server rejected claim for task "${claim.title}" — reason: race_lost` });
    expect(t).toBe('Not claimed: another runner took it first.');
    expect(t).not.toContain(claim.title);
    expect(said({ error: 'Server rejected claim for task "x" — task is no longer available (may already be claimed or completed)' }))
      .toBe('Not claimed: task is no longer available (may already be claimed or completed).');
  });

  test('a paused account context, and a bare status', () => {
    expect(said({ error: 'Cannot claim task "x" right now — account context is temporarily paused (rate limit). Try again shortly.' }))
      .toBe('Not claimed: claims pause briefly after a rate limit; try again shortly.');
    expect(said(null, 502)).toBe('Not claimed: HTTP 502.');
  });

  test('a claim that worked still says so', () => {
    expect(actionResultText(claim, { status: 200, body: {} })).toEqual({ text: `Claimed "${claim.title}" onto this runner.`, tone: 'ok' });
  });
});
