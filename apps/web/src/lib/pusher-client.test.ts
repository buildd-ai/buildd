import { describe, it, expect, beforeAll, mock } from 'bun:test';

/**
 * Four separate consumers (EscalationProvider, NeedsInputProvider,
 * ConnectorReconnectProvider, HomeAutoRefresh) subscribe to the *same*
 * `workspace-<id>` channel for every workspace the user can see. Two
 * consequences this suite pins:
 *   - one Pusher subscription per channel, not one per consumer;
 *   - the channel survives until the LAST consumer unmounts. Without ref
 *     counting the first unmount called client.unsubscribe() and silently
 *     killed realtime for the other three.
 */

type FakeChannel = {
  name: string;
  binds: Array<[string, unknown]>;
  bind: (event: string, handler: unknown) => void;
  unbind: (event: string, handler: unknown) => void;
};

const calls = {
  subscribe: [] as string[],
  unsubscribe: [] as string[],
  constructed: 0,
};

const channels = new Map<string, FakeChannel>();

class FakePusher {
  connection = { bind: () => {} };
  constructor(_key: string, _opts: unknown) {
    calls.constructed++;
  }
  subscribe(name: string): FakeChannel {
    calls.subscribe.push(name);
    let ch = channels.get(name);
    if (!ch) {
      ch = {
        name,
        binds: [],
        bind(event, handler) { ch!.binds.push([event, handler]); },
        unbind(event, handler) {
          const i = ch!.binds.findIndex(([e, h]) => e === event && h === handler);
          if (i >= 0) ch!.binds.splice(i, 1);
        },
      };
      channels.set(name, ch);
    }
    return ch;
  }
  unsubscribe(name: string) {
    calls.unsubscribe.push(name);
    channels.delete(name);
  }
  static logToConsole = false;
}

mock.module('pusher-js', () => ({ default: FakePusher }));

let subscribeToChannel: typeof import('./pusher-client').subscribeToChannel;
let unsubscribeFromChannel: typeof import('./pusher-client').unsubscribeFromChannel;
let shouldLogPusherDebug: typeof import('./pusher-client').shouldLogPusherDebug;
let getSubscribedChannel: typeof import('./pusher-client').getSubscribedChannel;

beforeAll(async () => {
  (globalThis as any).window = globalThis;
  process.env.NEXT_PUBLIC_PUSHER_KEY = 'test-key';
  process.env.NEXT_PUBLIC_PUSHER_CLUSTER = 'test-cluster';
  const mod = await import('./pusher-client');
  subscribeToChannel = mod.subscribeToChannel;
  unsubscribeFromChannel = mod.unsubscribeFromChannel;
  shouldLogPusherDebug = mod.shouldLogPusherDebug;
  getSubscribedChannel = mod.getSubscribedChannel;
});

describe('subscribeToChannel — shared, ref-counted channels', () => {
  it('subscribes once no matter how many consumers ask', () => {
    const a = subscribeToChannel('workspace-1');
    const b = subscribeToChannel('workspace-1');
    const c = subscribeToChannel('workspace-1');

    expect(calls.subscribe.filter((n) => n === 'workspace-1')).toHaveLength(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('binds the pusher lifecycle handlers once per channel, not once per consumer', () => {
    const ch = channels.get('workspace-1')!;
    const lifecycle = ch.binds.filter(
      ([event]) => event === 'pusher:subscription_succeeded' || event === 'pusher:subscription_error',
    );
    expect(lifecycle).toHaveLength(2);
  });

  it('hands back the live channel without taking a hold', () => {
    const held = getSubscribedChannel('workspace-1');
    expect(held).toBe(channels.get('workspace-1'));
    expect(calls.subscribe.filter((n) => n === 'workspace-1')).toHaveLength(1);
    expect(getSubscribedChannel('workspace-absent')).toBeNull();
  });

  it('keeps the channel alive until the last consumer unsubscribes', () => {
    unsubscribeFromChannel('workspace-1');
    unsubscribeFromChannel('workspace-1');
    expect(calls.unsubscribe).toEqual([]);

    unsubscribeFromChannel('workspace-1');
    expect(calls.unsubscribe).toEqual(['workspace-1']);
  });

  it('ignores an unsubscribe for a channel it never handed out', () => {
    unsubscribeFromChannel('workspace-never');
    expect(calls.unsubscribe).toEqual(['workspace-1']);
  });

  it('re-subscribes after a full teardown', () => {
    subscribeToChannel('workspace-1');
    expect(calls.subscribe.filter((n) => n === 'workspace-1')).toHaveLength(2);
    unsubscribeFromChannel('workspace-1');
  });

  it('reuses one Pusher connection across channels', () => {
    subscribeToChannel('workspace-2');
    subscribeToChannel('workspace-3');
    expect(calls.constructed).toBe(1);
    unsubscribeFromChannel('workspace-2');
    unsubscribeFromChannel('workspace-3');
  });
});

describe('shouldLogPusherDebug', () => {
  it('is silent in production', () => {
    expect(shouldLogPusherDebug('production', null)).toBe(false);
  });

  it('is on in development', () => {
    expect(shouldLogPusherDebug('development', null)).toBe(true);
  });

  it('can be opted into in production with the debug flag', () => {
    expect(shouldLogPusherDebug('production', '1')).toBe(true);
  });
});

describe('every consumer unbinds what it binds', () => {
  /**
   * Channels are shared, so a consumer that binds a handler and relies on
   * unsubscribe to drop it now leaks that handler past unmount — it keeps
   * firing (re-fetching, refreshing the router) for a component that is gone.
   * Static invariant: a file with `.bind(` sites has as many `.unbind(` sites.
   */
  it('pairs every bind site with an unbind site', async () => {
    const { Glob } = await import('bun');
    const { readFileSync } = await import('fs');
    const { join, resolve } = await import('path');

    const src = resolve(import.meta.dir, '..');
    const offenders: string[] = [];

    for (const rel of new Glob('**/*.tsx').scanSync(src)) {
      const file = join(src, rel);
      const text = readFileSync(file, 'utf8');
      if (!text.includes('subscribeToChannel')) continue;

      const binds = text.match(/\??\.bind\(/g)?.length ?? 0;
      const unbinds = text.match(/\??\.unbind\(/g)?.length ?? 0;
      if (binds !== unbinds) offenders.push(`${rel}: ${binds} bind(s), ${unbinds} unbind(s)`);
    }

    expect(offenders).toEqual([]);
  });
});
