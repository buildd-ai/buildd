import { describe, it, expect } from 'bun:test';
import { builddServerInfo } from './mcp-server-info';
import { iconFromServerInfo } from './connector-icon';
import pkg from '../../package.json';

describe('builddServerInfo', () => {
  it('advertises absolute https icons and a websiteUrl', () => {
    const info = builddServerInfo('https://buildd.dev/');
    expect(info.websiteUrl).toBe('https://buildd.dev');
    expect(info.icons.map(i => i.src)).toEqual(['https://buildd.dev/icon.png', 'https://buildd.dev/apple-icon.png']);
  });

  it('reports the deployed release as its version, so a client can tell a stale schema', () => {
    expect(builddServerInfo('https://buildd.dev').version).toBe(pkg.version);
    expect(builddServerInfo('https://buildd.dev').version).not.toBe('0.1.0');
  });

  it('is what our own icon resolver would pick from', () => {
    expect(iconFromServerInfo(builddServerInfo('https://buildd.dev'), 'https://buildd.dev/api/mcp')).toBe('https://buildd.dev/icon.png');
  });
});
