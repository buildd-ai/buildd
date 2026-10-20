/**
 * install.ps1 must stay pure ASCII. Windows PowerShell 5.1 reads a BOM-less
 * script run with `-File` as ANSI, so a single em dash broke parsing with
 * "The string is missing the terminator" before any line ran.
 *
 * Run: cd apps/runner && bun test __tests__/unit/install-ps1-encoding.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';

// Bun.file, not fs, so other tests' mock.module('fs') can't intercept the read.
const bytes = new Uint8Array(
  await Bun.file(join(import.meta.dir, '../../install.ps1')).arrayBuffer(),
);
const text = new TextDecoder().decode(bytes);

describe('install.ps1 encoding', () => {
  test('contains only ASCII characters', () => {
    const offending = text
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /[^\x00-\x7F]/.test(text));
    expect(offending).toEqual([]);
  });
});

describe('install.ps1 bun bootstrap', () => {
  test('restores the PATH it had before running the bun installer', () => {
    const save = text.indexOf('$SavedPath = $env:Path');
    const bunInstall = text.indexOf('irm bun.sh/install.ps1 | iex');
    const restore = text.indexOf('$env:Path = "$env:USERPROFILE\\.bun\\bin;$SavedPath"');
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(bunInstall);
    expect(restore).toBeGreaterThan(bunInstall);
  });
});
