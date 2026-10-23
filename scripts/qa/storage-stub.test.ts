import { afterAll, describe, expect, test } from 'bun:test';
import { startStorageStub, stubDesignHtml, STUB_SCREENS } from './storage-stub';

describe('storage stub', () => {
  const server = startStorageStub(0);
  afterAll(() => server.stop(true));

  test('serves the fixture for any key', async () => {
    const res = await fetch(`http://localhost:${server.port}/bucket/any/key.html?X-Amz-Signature=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(stubDesignHtml());
  });

  test('lists every screen with a viewport', () => {
    const html = stubDesignHtml();
    for (const s of STUB_SCREENS) expect(html).toContain(`data-screen="${s.id}" data-viewport="${s.width}x${s.height}"`);
  });

  test('rejects writes', async () => {
    const res = await fetch(`http://localhost:${server.port}/k`, { method: 'PUT', body: 'x' });
    expect(res.status).toBe(405);
  });
});
