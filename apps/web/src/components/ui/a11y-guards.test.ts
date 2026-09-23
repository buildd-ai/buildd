/**
 * Static guards that keep the dialog/switch primitives the only way to build
 * these controls in the web app.
 *
 * - Native `confirm()` / `alert()` are unstyled, block the main thread and
 *   cannot be themed or tested; use `useConfirm` / `ConfirmDialog` and inline
 *   error text (`role="alert"`) instead.
 * - Hand-rolled `role="switch"` buttons kept shipping without an accessible
 *   name; `components/ui/Switch` makes the name a required prop.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB_SRC = join(import.meta.dir, '..', '..');

function sourceFiles(): string[] {
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  return [...glob.scanSync({ cwd: WEB_SRC })]
    .filter(p => !/\.test\.tsx?$/.test(p))
    .map(p => join(WEB_SRC, p));
}

/** Strips line and block comments so prose about confirm() does not trip the guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NATIVE_DIALOG = /(?<![\w.$])(?:window\.)?(confirm|alert)\s*\(/;

describe('a11y guards', () => {
  it('scans a non-empty file set', () => {
    // A guard over an empty set passes vacuously — make sure it can fail.
    expect(sourceFiles().length).toBeGreaterThan(100);
    expect(NATIVE_DIALOG.test("if (!confirm('x')) return;")).toBe(true);
    expect(NATIVE_DIALOG.test("window.alert('x')")).toBe(true);
    expect(NATIVE_DIALOG.test('const ok = await confirm({ title })')).toBe(true);
    expect(NATIVE_DIALOG.test('handleConfirm()')).toBe(false);
    expect(NATIVE_DIALOG.test('onConfirm()')).toBe(false);
  });

  it('no native confirm()/alert() in apps/web/src', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      src.split('\n').forEach((line, i) => {
        if (!NATIVE_DIALOG.test(line)) return;
        // `useConfirm()` returns an async function conventionally named
        // `confirm`; allow the awaited form only where the file imports the hook.
        if (/\bawait\s+confirm\s*\(/.test(line) && /\buseConfirm\b/.test(src)) return;
        offenders.push(`${relative(WEB_SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('role="switch" only appears inside components/ui/Switch.tsx', () => {
    const offenders = sourceFiles()
      .filter(f => !f.endsWith(join('components', 'ui', 'Switch.tsx')))
      .filter(f => /role=["']switch["']/.test(readFileSync(f, 'utf8')))
      .map(f => relative(WEB_SRC, f));
    expect(offenders).toEqual([]);
  });
});
