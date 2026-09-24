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

/**
 * Strips line and block comments so prose about confirm() does not trip the
 * guard. Walks the source so a `//` or `/*` inside a string literal ('a//b',
 * "http://x", `a//b`) is kept; a backslash outside a string (regex literals
 * like /https?:\/\//) escapes the next character. Quote strings end at a
 * newline, so a stray apostrophe in JSX text cannot swallow the file.
 */
function stripComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\' && next !== undefined) out += src[++i];
      else if (c === quote || (c === '\n' && quote !== '`')) quote = null;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      if (i < src.length) out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end === -1 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, ''); // keep line numbers stable
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      out += c + next;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
  }
  return out;
}

/**
 * `useConfirm()` returns an async function conventionally named `confirm` that
 * takes an options object; native `confirm` takes a string. Exempt only the
 * awaited object-argument form.
 */
const isUseConfirmCall = (line: string) => /\bawait\s+confirm\s*\(\s*\{/.test(line);

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

  it('stripComments keeps code after a `//` inside a string literal', () => {
    expect(stripComments("const u = 'a//b'; alert('x');")).toContain("alert('x')");
    expect(stripComments('const u = "http://x"; confirm("y");')).toContain('confirm("y")');
    expect(stripComments('const u = `a//b`; alert(1);')).toContain('alert(1)');
    expect(stripComments('const re = /^https?:\\/\\//; alert(1);')).toContain('alert(1)');
    expect(stripComments("foo(); // alert('x')")).not.toContain('alert');
    expect(stripComments("foo(); /* confirm('x') */ bar();")).not.toContain('confirm');
    expect(stripComments("const s = '/* not a comment */'; alert(1);")).toContain('alert(1)');
  });

  it('only the useConfirm call shape (an options object) is exempt', () => {
    expect(isUseConfirmCall("if (!(await confirm({ title: 'x' }))) return;")).toBe(true);
    expect(isUseConfirmCall("await confirm('Delete?')")).toBe(false);
    expect(isUseConfirmCall('await confirm(msg)')).toBe(false);
  });

  it('no native confirm()/alert() in apps/web/src', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      src.split('\n').forEach((line, i) => {
        if (!NATIVE_DIALOG.test(line)) return;
        // Allow the useConfirm call shape only where the file uses the hook.
        if (isUseConfirmCall(line) && /\buseConfirm\b/.test(src)) return;
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
