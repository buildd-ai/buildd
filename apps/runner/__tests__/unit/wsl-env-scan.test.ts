/**
 * Environment scanning for WSL runners: verify that WSL runners report
 * distinct hostnames to avoid pin collisions with Windows runners on the
 * same machine (R-22, spec a0b82b5d "Windows runner through WSL2", part 4).
 */
import { describe, test, expect } from 'bun:test';
import { runnerHostName } from '../../src/runner-host';

describe('runnerHostName in environment scanning (R-22)', () => {
  test('a Windows runner reports the hostname unchanged', () => {
    expect(runnerHostName({ hostname: 'DESKTOP-ABC', platform: 'windows' })).toBe('DESKTOP-ABC');
  });

  test('a WSL runner reports the hostname with -wsl suffix', () => {
    expect(runnerHostName({ hostname: 'DESKTOP-ABC', platform: 'linux-wsl' })).toBe('DESKTOP-ABC-wsl');
  });

  test('a WSL hostname that already ends in -wsl is not suffixed twice', () => {
    expect(runnerHostName({ hostname: 'desk-wsl', platform: 'linux-wsl' })).toBe('desk-wsl');
  });

  test('other host platforms report the hostname unchanged', () => {
    for (const platform of ['linux', 'darwin', 'linux-container'] as const) {
      expect(runnerHostName({ hostname: 'DESKTOP-ABC', platform })).toBe('DESKTOP-ABC');
    }
  });

  test('case-insensitive check for -wsl suffix', () => {
    expect(runnerHostName({ hostname: 'desk-WSL', platform: 'linux-wsl' })).toBe('desk-WSL');
    expect(runnerHostName({ hostname: 'desk-WsL', platform: 'linux-wsl' })).toBe('desk-WsL');
  });
});
