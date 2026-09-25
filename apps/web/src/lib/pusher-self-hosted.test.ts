import { describe, it, expect, beforeAll, mock } from 'bun:test';

/**
 * PUSHER_HOST / NEXT_PUBLIC_PUSHER_HOST point both Pusher clients at a
 * self-hosted Pusher-protocol server (soketi in scripts/demo). Unset, the
 * options must be exactly the hosted-cluster ones they always were.
 */

const clientOpts: unknown[] = [];
const serverOpts: unknown[] = [];

mock.module('pusher-js', () => ({
  default: class {
    static logToConsole = false;
    connection = { bind: () => {} };
    constructor(_key: string, opts: unknown) { clientOpts.push(opts); }
  },
}));
mock.module('pusher', () => ({
  default: class {
    constructor(opts: unknown) { serverOpts.push(opts); }
    trigger() { return Promise.resolve(); }
  },
}));

beforeAll(() => {
  (globalThis as any).window = globalThis;
});

describe('self-hosted Pusher endpoint', () => {
  it('client: hosted cluster only when NEXT_PUBLIC_PUSHER_HOST is unset', async () => {
    process.env.NEXT_PUBLIC_PUSHER_KEY = 'k';
    process.env.NEXT_PUBLIC_PUSHER_CLUSTER = 'mt1';
    delete process.env.NEXT_PUBLIC_PUSHER_HOST;
    const { getPusherClient } = await import('./pusher-client?hosted');
    getPusherClient();
    expect(clientOpts.at(-1)).toEqual({ cluster: 'mt1' });
  });

  it('client: ws to the given host/port without TLS when NEXT_PUBLIC_PUSHER_HOST is set', async () => {
    process.env.NEXT_PUBLIC_PUSHER_HOST = '127.0.0.1';
    process.env.NEXT_PUBLIC_PUSHER_PORT = '56001';
    const { getPusherClient } = await import('./pusher-client?self');
    getPusherClient();
    expect(clientOpts.at(-1)).toMatchObject({ cluster: 'mt1', wsHost: '127.0.0.1', wsPort: 56001, forceTLS: false });
  });

  it('server: TLS to the hosted cluster when PUSHER_HOST is unset; host/port without TLS when set', async () => {
    Object.assign(process.env, { PUSHER_APP_ID: 'a', PUSHER_KEY: 'k', PUSHER_SECRET: 's', PUSHER_CLUSTER: 'mt1' });
    delete process.env.PUSHER_HOST;
    const hosted = await import('./pusher?hosted');
    await hosted.triggerEvent('c', 'e', {});
    expect(serverOpts.at(-1)).toEqual({ appId: 'a', key: 'k', secret: 's', cluster: 'mt1', useTLS: true });

    process.env.PUSHER_HOST = '127.0.0.1';
    process.env.PUSHER_PORT = '56001';
    const self = await import('./pusher?self');
    await self.triggerEvent('c', 'e', {});
    expect(serverOpts.at(-1)).toMatchObject({ host: '127.0.0.1', port: '56001', useTLS: false });
  });
});
