import { describe, it, expect } from 'bun:test';
import { builddServerInfo } from './mcp-server-info';
import { iconFromServerInfo } from './connector-icon';

describe('builddServerInfo', () => {
  it('advertises absolute https icons and a websiteUrl', () => {
    const info = builddServerInfo('https://buildd.dev/');
    expect(info.websiteUrl).toBe('https://buildd.dev');
    expect(info.icons.map(i => i.src)).toEqual(['https://buildd.dev/icon.png', 'https://buildd.dev/apple-icon.png']);
  });

  it('is what our own icon resolver would pick from', () => {
    expect(iconFromServerInfo(builddServerInfo('https://buildd.dev'), 'https://buildd.dev/api/mcp')).toBe('https://buildd.dev/icon.png');
  });
});
