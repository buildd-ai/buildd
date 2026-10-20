/**
 * `buildd login` opened its sign-in page with macOS's `open`, so on Windows
 * and Linux it crashed before printing anything the person could use.
 *
 * Run: cd apps/runner && bun test __tests__/unit/open-url.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { browserOpenCommand, openInBrowser } from '../../src/open-url';

const url = 'https://buildd.dev/api/auth/cli?callback=http%3A%2F%2Flocalhost%3A1234&client=cli';

describe('browserOpenCommand', () => {
  test('macOS uses open', () => {
    expect(browserOpenCommand(url, 'darwin')).toEqual(['open', url]);
  });

  test('Linux uses xdg-open', () => {
    expect(browserOpenCommand(url, 'linux')).toEqual(['xdg-open', url]);
  });

  test('Windows hands the URL to the shell handler without cmd, which would split it at &', () => {
    const cmd = browserOpenCommand(url, 'win32');
    expect(cmd[0]).not.toBe('cmd');
    expect(cmd).toEqual(['rundll32', 'url.dll,FileProtocolHandler', url]);
  });
});

describe('openInBrowser', () => {
  test('reports false instead of throwing when the opener is missing', async () => {
    const spawn = () => { throw new Error('Executable not found in $PATH: "open"'); };
    expect(await openInBrowser(url, 'darwin', spawn)).toBe(false);
  });

  test('reports false when the opener exits non-zero', async () => {
    const spawn = () => ({ exited: Promise.resolve(1) });
    expect(await openInBrowser(url, 'linux', spawn)).toBe(false);
  });

  test('reports true and passes the platform command when it opens', async () => {
    let seen: string[] = [];
    const spawn = (cmd: string[]) => { seen = cmd; return { exited: Promise.resolve(0) }; };
    expect(await openInBrowser(url, 'win32', spawn)).toBe(true);
    expect(seen).toEqual(browserOpenCommand(url, 'win32'));
  });
});
