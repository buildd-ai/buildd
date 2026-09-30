/**
 * net/public-address: which addresses an outbound verification may reach.
 * DNS is always injected; nothing here touches the network.
 */
import { describe, expect, it, mock } from 'bun:test';
import { isPublicAddress, checkPublicHost, fetchPublicNoRedirect, NonPublicAddressError, RedirectRefusedError } from '../net/public-address';

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.8.8.8',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '100.127.255.255', '192.0.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:192.168.0.1', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1',
    'FE80::1', 'fe80::1%eth0',
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1',
    '169.253.255.255', '192.167.1.1', '11.0.0.1', '2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8',
  ])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it('anything that is not an IP address is not public', () => {
    for (const s of ['', 'localhost', 'example.com', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '::g', '1::2::3']) {
      expect(isPublicAddress(s)).toBe(false);
    }
  });
});

describe('checkPublicHost', () => {
  const lookup = (addrs: string[]) => mock(async () => addrs.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('a host whose addresses are all public passes', async () => {
    expect(await checkPublicHost('llm.example.com', { lookup: lookup(['93.184.216.34', '2606:4700::1111']) })).toBeNull();
  });

  it('refuses a host when any resolved address is not public', async () => {
    for (const addrs of [['10.0.0.5'], ['93.184.216.34', '169.254.169.254'], ['::1'], ['::ffff:127.0.0.1'], []]) {
      expect(await checkPublicHost('llm.example.com', { lookup: lookup(addrs) })).toMatch(/public address/);
    }
  });

  it('refuses when resolution fails, without echoing the resolver error', async () => {
    const r = await checkPublicHost('llm.example.com', { lookup: async () => { throw new Error('getaddrinfo ENOTFOUND internal-name'); } });
    expect(r).toBe('the endpoint host could not be resolved');
  });

  it('an IP literal is judged directly, not resolved', async () => {
    const l = lookup(['93.184.216.34']);
    expect(await checkPublicHost('169.254.169.254', { lookup: l })).toMatch(/public address/);
    expect(await checkPublicHost('[::1]', { lookup: l })).toMatch(/public address/);
    expect(await checkPublicHost('93.184.216.34', { lookup: l })).toBeNull();
    expect(l).not.toHaveBeenCalled();
  });

  it('local hosts are allowed only when allowLocal is set', async () => {
    const l = lookup(['127.0.0.1']);
    expect(await checkPublicHost('localhost', { lookup: l })).toMatch(/public address/);
    expect(await checkPublicHost('localhost', { lookup: l, allowLocal: true })).toBeNull();
    expect(await checkPublicHost('127.0.0.1', { lookup: l, allowLocal: true })).toBeNull();
    expect(await checkPublicHost('[::1]', { lookup: l, allowLocal: true })).toBeNull();
    // allowLocal covers the loopback names only, not other private space.
    expect(await checkPublicHost('10.0.0.1', { lookup: l, allowLocal: true })).toMatch(/public address/);
  });
});

describe('fetchPublicNoRedirect', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('fetches a public host with redirect: manual', async () => {
    let init: RequestInit | undefined;
    const res = await fetchPublicNoRedirect('https://llm.example.com/v1/messages', { method: 'POST' }, {
      lookup: publicLookup,
      fetcher: async (_u, i) => { init = i; return new Response('{}'); },
    });
    expect(res.status).toBe(200);
    expect(init?.redirect).toBe('manual');
    expect(init?.method).toBe('POST');
  });

  it('never fetches a non-public host', async () => {
    const fetcher = mock(async () => new Response('{}'));
    await expect(fetchPublicNoRedirect('https://llm.example.com/x', {}, {
      lookup: async () => [{ address: '169.254.169.254', family: 4 }], fetcher,
    })).rejects.toBeInstanceOf(NonPublicAddressError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a 3xx is refused and its target is never fetched', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const fetcher = mock(async () => new Response(null, { status, headers: { location: 'http://169.254.169.254/' } }));
      await expect(fetchPublicNoRedirect('https://llm.example.com/x', {}, { lookup: publicLookup, fetcher }))
        .rejects.toBeInstanceOf(RedirectRefusedError);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('an opaque redirect (status 0) is refused too', async () => {
    const opaque = { status: 0, type: 'opaqueredirect', ok: false } as unknown as Response;
    await expect(fetchPublicNoRedirect('https://llm.example.com/x', {}, { lookup: publicLookup, fetcher: async () => opaque }))
      .rejects.toBeInstanceOf(RedirectRefusedError);
  });
});
