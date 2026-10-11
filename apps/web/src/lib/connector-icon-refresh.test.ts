import { describe, it, expect } from 'bun:test';
import { needsIconRefresh, nextIconValue, ICON_RECHECK_MS } from './connector-icon-refresh';

const row = (over: Partial<Parameters<typeof needsIconRefresh>[0]> = {}) => ({
  id: 'c1', url: 'https://mcp.x.dev/mcp', transport: 'http', iconUrl: null, iconCheckedAt: null, ...over,
});

describe('needsIconRefresh', () => {
  const now = Date.now();
  it('refreshes a never-checked http row without an icon', () => {
    expect(needsIconRefresh(row(), now)).toBe(true);
  });
  it('refreshes a row that still hotlinks a remote icon', () => {
    expect(needsIconRefresh(row({ iconUrl: 'https://x.dev/i.png' }), now)).toBe(true);
  });
  it('leaves an inlined icon alone', () => {
    expect(needsIconRefresh(row({ iconUrl: 'data:image/png;base64,AA' }), now)).toBe(false);
  });
  it('waits out the TTL after a failed attempt', () => {
    expect(needsIconRefresh(row({ iconCheckedAt: new Date(now - 60_000) }), now)).toBe(false);
    expect(needsIconRefresh(row({ iconCheckedAt: new Date(now - ICON_RECHECK_MS - 1) }), now)).toBe(true);
  });
  it('skips stdio connectors', () => {
    expect(needsIconRefresh(row({ transport: 'stdio', url: '' }), now)).toBe(false);
  });
});

describe('nextIconValue', () => {
  it('stores a newly found icon', () => {
    expect(nextIconValue(null, 'data:image/png;base64,AA')).toBe('data:image/png;base64,AA');
  });
  it('writes nothing when the icon is unchanged', () => {
    expect(nextIconValue('data:image/png;base64,AA', 'data:image/png;base64,AA')).toBeUndefined();
  });
  it('keeps an inlined icon when a forced lookup finds nothing', () => {
    expect(nextIconValue('data:image/png;base64,AA', null)).toBeUndefined();
  });
  it('drops a remote icon that would not download instead of hotlinking it', () => {
    expect(nextIconValue('https://x.dev/i.png', null)).toBeNull();
  });
});
