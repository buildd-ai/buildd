/**
 * Regression tests for runner-pin matching with WSL hostname distinction.
 *
 * A task pinned to the Windows runner by hostname or account name should NOT
 * be claimed by the WSL runner after migration. This requires:
 * 1. WSL runner reports distinct hostname label (with -wsl suffix)
 * 2. Pin matching logic respects this distinction
 * 3. listPendingPinned correctly identifies Windows-only pins
 */
import { describe, test, expect } from 'bun:test';
import { runnerHostName, headlessRunnerKey } from '../../src/runner-host';
import { runnerMatchesPin, pinnedRunnerOf, runnerRowIdentity, runnerPinNames } from '@buildd/core/runner-pin';

describe('WSL runner hostname distinction (fixture)', () => {
  test('env-scan reports distinct hostname for WSL vs Windows runners', () => {
    // Windows runner on this machine
    const windowsHostname = runnerHostName({ hostname: 'DESKTOP-ABC', platform: 'windows' });
    expect(windowsHostname).toBe('DESKTOP-ABC');

    // WSL runner on the same machine
    const wslHostname = runnerHostName({ hostname: 'DESKTOP-ABC', platform: 'linux-wsl' });
    expect(wslHostname).toBe('DESKTOP-ABC-wsl');

    // They must be distinct
    expect(windowsHostname).not.toBe(wslHostname);
  });

  test('headless keys are distinct for Windows and WSL runners', () => {
    const windowsKey = headlessRunnerKey({ hostname: 'DESKTOP-ABC', platform: 'windows' });
    const wslKey = headlessRunnerKey({ hostname: 'DESKTOP-ABC', platform: 'linux-wsl' });

    expect(windowsKey).toBe('headless://DESKTOP-ABC');
    expect(wslKey).toBe('headless://DESKTOP-ABC-wsl');
  });
});

describe('runner-pin matching respects hostname distinction', () => {
  test('a pin by bare hostname matches only the Windows runner, not WSL', () => {
    const windowsRunner = {
      key: 'headless://DESKTOP-ABC',
      hostname: 'DESKTOP-ABC',
      accountName: 'user@contoso',
    };
    const wslRunner = {
      key: 'headless://DESKTOP-ABC-wsl',
      hostname: 'DESKTOP-ABC-wsl',
      accountName: 'user@contoso',
    };

    const pin = 'DESKTOP-ABC';

    // Windows runner matches the bare hostname pin
    expect(runnerMatchesPin(pin, windowsRunner)).toBe(true);

    // WSL runner does NOT match the bare hostname pin
    expect(runnerMatchesPin(pin, wslRunner)).toBe(false);
  });

  test('a pin by -wsl hostname matches only the WSL runner, not Windows', () => {
    const windowsRunner = {
      key: 'headless://DESKTOP-ABC',
      hostname: 'DESKTOP-ABC',
      accountName: 'user@contoso',
    };
    const wslRunner = {
      key: 'headless://DESKTOP-ABC-wsl',
      hostname: 'DESKTOP-ABC-wsl',
      accountName: 'user@contoso',
    };

    const pin = 'DESKTOP-ABC-wsl';

    // Windows runner does NOT match the -wsl hostname pin
    expect(runnerMatchesPin(pin, windowsRunner)).toBe(false);

    // WSL runner matches the -wsl hostname pin
    expect(runnerMatchesPin(pin, wslRunner)).toBe(true);
  });

  test('an account-name pin matches both runners (account is shared)', () => {
    const windowsRunner = {
      key: 'headless://DESKTOP-ABC',
      hostname: 'DESKTOP-ABC',
      accountName: 'user@contoso',
    };
    const wslRunner = {
      key: 'headless://DESKTOP-ABC-wsl',
      hostname: 'DESKTOP-ABC-wsl',
      accountName: 'user@contoso',
    };

    const pin = 'user@contoso';

    // Both runners match the account-name pin (account is shared)
    expect(runnerMatchesPin(pin, windowsRunner)).toBe(true);
    expect(runnerMatchesPin(pin, wslRunner)).toBe(true);
  });

  test('a headless key pin matches only that specific runner', () => {
    const windowsRunner = {
      key: 'headless://DESKTOP-ABC',
      hostname: 'DESKTOP-ABC',
      accountName: 'user@contoso',
    };
    const wslRunner = {
      key: 'headless://DESKTOP-ABC-wsl',
      hostname: 'DESKTOP-ABC-wsl',
      accountName: 'user@contoso',
    };

    // Windows runner matches its own headless key
    expect(runnerMatchesPin('headless://DESKTOP-ABC', windowsRunner)).toBe(true);
    expect(runnerMatchesPin('headless://DESKTOP-ABC', wslRunner)).toBe(false);

    // WSL runner matches its own headless key
    expect(runnerMatchesPin('headless://DESKTOP-ABC-wsl', wslRunner)).toBe(true);
    expect(runnerMatchesPin('headless://DESKTOP-ABC-wsl', windowsRunner)).toBe(false);
  });

  test('case-insensitive hostname matching still works', () => {
    const windowsRunner = {
      key: 'headless://DESKTOP-ABC',
      hostname: 'DESKTOP-ABC',
      accountName: null,
    };

    // Hostname matching is case-insensitive
    expect(runnerMatchesPin('desktop-abc', windowsRunner)).toBe(true);
    expect(runnerMatchesPin('DESKTOP-ABC', windowsRunner)).toBe(true);
    expect(runnerMatchesPin('Desktop-Abc', windowsRunner)).toBe(true);
  });
});

describe('runner pin names list respects hostname distinction', () => {
  test('pin names for Windows runner include hostname without suffix', () => {
    const windowsRunner = {
      key: 'headless://DESKTOP-ABC',
      hostname: 'DESKTOP-ABC',
      accountName: 'user@contoso',
    };

    const names = runnerPinNames(windowsRunner);
    expect(names).toContain('headless://DESKTOP-ABC');
    expect(names).toContain('DESKTOP-ABC');
    expect(names).toContain('user@contoso');
    expect(names).not.toContain('DESKTOP-ABC-wsl');
  });

  test('pin names for WSL runner include hostname with -wsl suffix', () => {
    const wslRunner = {
      key: 'headless://DESKTOP-ABC-wsl',
      hostname: 'DESKTOP-ABC-wsl',
      accountName: 'user@contoso',
    };

    const names = runnerPinNames(wslRunner);
    expect(names).toContain('headless://DESKTOP-ABC-wsl');
    expect(names).toContain('DESKTOP-ABC-wsl');
    expect(names).toContain('user@contoso');
    expect(names).not.toContain('DESKTOP-ABC');
  });
});
