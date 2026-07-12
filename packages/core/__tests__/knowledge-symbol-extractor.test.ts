import { describe, it, expect, afterEach } from 'bun:test';
import {
  extractSymbols,
  extractImports,
  resolveRelativeImport,
  langForPath,
  isSymbolExtractionAvailable,
  __setAstGrepLoaderForTests,
} from '../knowledge-store/symbol-extractor';

afterEach(() => {
  __setAstGrepLoaderForTests(null);
});

// ── availability ─────────────────────────────────────────────────────────────

describe('isSymbolExtractionAvailable', () => {
  it('is available in the test environment (native binary present)', async () => {
    // @ast-grep/napi ships prebuilt binaries for macOS/Linux — if this fails,
    // the platform genuinely lacks a binary or the install is broken.
    expect(await isSymbolExtractionAvailable()).toBe(true);
  });

  it('reports unavailable when the dynamic import fails', async () => {
    __setAstGrepLoaderForTests(() => Promise.reject(new Error('no native binary')));
    expect(await isSymbolExtractionAvailable()).toBe(false);
  });
});

// ── langForPath ──────────────────────────────────────────────────────────────

describe('langForPath', () => {
  it('maps supported extensions', () => {
    expect(langForPath('src/a.ts')).toBe('ts');
    expect(langForPath('src/a.tsx')).toBe('tsx');
    expect(langForPath('src/a.js')).toBe('js');
    expect(langForPath('src/a.jsx')).toBe('jsx');
  });

  it('returns null for unsupported extensions', () => {
    expect(langForPath('src/a.py')).toBeNull();
    expect(langForPath('src/a.md')).toBeNull();
    expect(langForPath('src/a.d.css')).toBeNull();
    expect(langForPath('Makefile')).toBeNull();
  });
});

// ── extractSymbols ───────────────────────────────────────────────────────────

const TS_FIXTURE = `import { a } from './a';
import type { B } from '../b';
import def from 'some-pkg';

export function foo(x: number) {
  return x + 1;
}

export const bar = (y: string) => y.trim();

function hiddenFn() {
  return 2;
}

export class Widget {
  render() {
    return null;
  }
}

export interface Props {
  name: string;
}

export type Alias = string | number;

export enum Color {
  Red,
  Green,
}
`;

describe('extractSymbols', () => {
  it('extracts top-level declarations with kinds, export flags, and line ranges', async () => {
    const symbols = await extractSymbols(TS_FIXTURE, 'ts');
    expect(symbols).not.toBeNull();
    const byName = new Map(symbols!.map(s => [s.name, s]));

    const foo = byName.get('foo')!;
    expect(foo.kind).toBe('function');
    expect(foo.exported).toBe(true);
    expect(foo.startLine).toBe(5);
    expect(foo.endLine).toBe(7);

    const bar = byName.get('bar')!;
    expect(bar.kind).toBe('const');
    expect(bar.exported).toBe(true);
    expect(bar.startLine).toBe(9);

    const hidden = byName.get('hiddenFn')!;
    expect(hidden.kind).toBe('function');
    expect(hidden.exported).toBe(false);
    expect(hidden.startLine).toBe(11);
    expect(hidden.endLine).toBe(13);

    expect(byName.get('Widget')!.kind).toBe('class');
    expect(byName.get('Widget')!.exported).toBe(true);
    expect(byName.get('Props')!.kind).toBe('interface');
    expect(byName.get('Alias')!.kind).toBe('type');
    expect(byName.get('Color')!.kind).toBe('enum');
  });

  it('handles tsx and default exports', async () => {
    const src = `export default function App() {\n  return <div />;\n}\n\nexport abstract class Base {}\n`;
    const symbols = await extractSymbols(src, 'tsx');
    expect(symbols).not.toBeNull();
    const app = symbols!.find(s => s.name === 'App');
    expect(app).toBeDefined();
    expect(app!.kind).toBe('function');
    expect(app!.exported).toBe(true);
    const base = symbols!.find(s => s.name === 'Base');
    expect(base).toBeDefined();
    expect(base!.kind).toBe('class');
  });

  it('returns an empty array for a file without top-level declarations', async () => {
    const symbols = await extractSymbols(`console.log('hello');\n`, 'js');
    expect(symbols).toEqual([]);
  });

  it('returns null when ast-grep is unavailable', async () => {
    __setAstGrepLoaderForTests(() => Promise.reject(new Error('no native binary')));
    expect(await extractSymbols(TS_FIXTURE, 'ts')).toBeNull();
  });
});

// ── extractImports ───────────────────────────────────────────────────────────

describe('extractImports', () => {
  it('extracts default, named, type-only, relative, and package imports', async () => {
    const imports = await extractImports(TS_FIXTURE, 'ts', 'src/a/b.ts');
    expect(imports).toHaveLength(3);

    const relative = imports.find(i => i.specifier === './a')!;
    expect(relative.resolvedPath).toBe('src/a/a');

    const parent = imports.find(i => i.specifier === '../b')!;
    expect(parent.resolvedPath).toBe('src/b');

    const pkg = imports.find(i => i.specifier === 'some-pkg')!;
    expect(pkg.resolvedPath).toBeNull();
  });

  it('returns [] when ast-grep is unavailable', async () => {
    __setAstGrepLoaderForTests(() => Promise.reject(new Error('no native binary')));
    expect(await extractImports(TS_FIXTURE, 'ts', 'src/a/b.ts')).toEqual([]);
  });
});

// ── resolveRelativeImport (pure) ─────────────────────────────────────────────

describe('resolveRelativeImport', () => {
  it('resolves ../ against the importing file directory', () => {
    expect(resolveRelativeImport('../foo', 'src/a/b.ts')).toBe('src/foo');
  });

  it('resolves ./ siblings', () => {
    expect(resolveRelativeImport('./util', 'src/a/b.ts')).toBe('src/a/util');
  });

  it('strips js/ts extensions from the specifier (ESM ./x.js style)', () => {
    expect(resolveRelativeImport('./util.js', 'src/a/b.ts')).toBe('src/a/util');
    expect(resolveRelativeImport('./util.ts', 'src/a/b.ts')).toBe('src/a/util');
  });

  it('returns null for bare package specifiers', () => {
    expect(resolveRelativeImport('react', 'src/a/b.ts')).toBeNull();
    expect(resolveRelativeImport('@buildd/shared', 'src/a/b.ts')).toBeNull();
  });

  it('returns null when the path escapes the repo root', () => {
    expect(resolveRelativeImport('../../../x', 'src/a.ts')).toBeNull();
  });
});
