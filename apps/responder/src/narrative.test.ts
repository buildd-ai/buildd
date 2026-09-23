import { describe, expect, test } from 'bun:test';
import { buildPrompt, modelNarrator, narrateWithinBudget, noNarrator } from './narrative';
import { pushoverNotifier, truncateMessage } from './notify';
import type { Verdict } from './types';

const verdict: Verdict = {
  detector: 'dispatch-stall',
  state: 'firing',
  conditionKey: 'dispatch-stall',
  summary: 'Dispatch stall since 2026-01-02T10:00:00.000Z',
  onsetAt: '2026-01-02T10:00:00.000Z',
  facts: { alarmStreak: 3 },
};

const ctx = { verdicts: [verdict], appVersion: null, runnerVersion: null };

describe('the narrative is optional by construction', () => {
  test('noNarrator returns null and never throws', async () => {
    expect(await noNarrator(ctx)).toBeNull();
  });

  test('a dead credential degrades to null, not to an exception', async () => {
    // Pointed at a closed local port rather than the real API: the test must
    // not depend on the network, and the contract under test is "whatever
    // goes wrong -- 401, connection refused, an SDK that will not import --
    // the result is one value and nothing throws".
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    try {
      const narrate = modelNarrator(
        { kind: 'oauth', token: 'illustrative-dead-token' },
        { model: 'claude-opus-5', timeoutMs: 1_000 },
      );
      expect(await narrate(ctx)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
  });

  test('narrateWithinBudget resolves null when the narrator hangs', async () => {
    const started = Date.now();
    const result = await narrateWithinBudget(() => new Promise(() => {}), ctx, 25);
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('narrateWithinBudget swallows a throwing narrator', async () => {
    expect(
      await narrateWithinBudget(async () => {
        throw new Error('credential expired');
      }, ctx, 1_000),
    ).toBeNull();
  });

  test('the prompt carries the deterministic facts and nothing invented', () => {
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain('dispatch-stall');
    expect(prompt).toContain('2026-01-02T10:00:00.000Z');
    expect(JSON.parse(prompt)).toHaveProperty('firing');
  });
});

describe('notification does not depend on the model credential', () => {
  test('the notifier is built from Pushover env alone', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const notify = pushoverNotifier(
      { user: 'illustrative-user', token: 'illustrative-token' },
      {
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen.push({ url, body: JSON.parse(String(init.body)) });
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
      },
    );

    const result = await notify({ title: 'T', message: 'M', priority: 1 });
    expect(result.ok).toBe(true);
    expect(seen[0]!.url).toContain('api.pushover.net');
    expect(seen[0]!.body).toMatchObject({
      user: 'illustrative-user',
      token: 'illustrative-token',
      priority: 1,
    });
  });

  test('a transport failure is returned, not thrown or swallowed', async () => {
    // lib/pushover.ts fires and forgets, which is right for a serverless
    // route. Here a page that silently failed to send is indistinguishable
    // from nothing to report, which is the exact defect this app addresses.
    const notify = pushoverNotifier(
      { user: 'u', token: 't' },
      {
        fetchImpl: (async () => {
          throw new Error('ENOTFOUND api.pushover.net');
        }) as unknown as typeof fetch,
      },
    );
    const result = await notify({ title: 'T', message: 'M', priority: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
  });

  test('a non-2xx from the notifier is a failure', async () => {
    const notify = pushoverNotifier(
      { user: 'u', token: 't' },
      { fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch },
    );
    expect(await notify({ title: 'T', message: 'M', priority: 1 })).toMatchObject({
      ok: false,
      status: 429,
    });
  });

  test('long bodies are truncated on our side so the tail is ours', () => {
    const long = 'x'.repeat(2_000);
    expect(truncateMessage(long).length).toBe(1_000);
    expect(truncateMessage(long).endsWith('...')).toBe(true);
    expect(truncateMessage('short')).toBe('short');
  });
});
