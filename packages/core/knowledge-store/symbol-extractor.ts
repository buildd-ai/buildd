// ast-grep-backed symbol + import extraction for the code corpus (spec §4, B1).
//
// @ast-grep/napi is a native napi binary: fine under Bun (runners, scripts, CI)
// but potentially absent from serverless bundles (Vercel diff-ingest path). It
// is therefore loaded ONLY via a memoized dynamic import inside try/catch —
// when unavailable every extractor degrades to null/[] and callers fall back
// to the dependency-free line-window chunker. Never a hard dependency.
//
// This module itself has no static native imports, and must only be reached
// via dynamic import from ingest paths (not re-exported from index.ts).

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum';

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive; includes the `export` keyword line for exported decls. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  exported: boolean;
}

export interface ExtractedImport {
  /** Raw import specifier as written (quotes stripped). */
  specifier: string;
  /**
   * Repo-relative, extensionless module path for relative specifiers
   * (e.g. '../foo' from 'src/a/b.ts' → 'src/foo'). Textual resolution only —
   * no fs access, no extension checking. Null for bare/package specifiers.
   */
  resolvedPath: string | null;
}

export type SupportedLang = 'ts' | 'tsx' | 'js' | 'jsx';

const EXT_TO_LANG: Record<string, SupportedLang> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
};

/** Map a file path to a supported ast-grep language, or null when unsupported. */
export function langForPath(path: string): SupportedLang | null {
  const m = path.toLowerCase().match(/\.[^./]+$/);
  if (!m) return null;
  // .d.ts declaration files are still TypeScript — fine to parse.
  return EXT_TO_LANG[m[0]] ?? null;
}

// ── Memoized dynamic loader ───────────────────────────────────────────────────

type AstGrepModule = typeof import('@ast-grep/napi');

let loaderOverride: (() => Promise<unknown>) | null = null;
let cachedModule: Promise<AstGrepModule | null> | null = null;

async function loadAstGrep(): Promise<AstGrepModule | null> {
  if (cachedModule) return cachedModule;
  cachedModule = (async () => {
    try {
      const load = loaderOverride ?? (() => import('@ast-grep/napi'));
      return (await load()) as AstGrepModule;
    } catch {
      // Native binary missing for this platform / bundle — degrade gracefully.
      return null;
    }
  })();
  return cachedModule;
}

/**
 * Test hook: override (or reset with null) the dynamic @ast-grep/napi loader.
 * Also clears the memoized module so availability is re-evaluated.
 */
export function __setAstGrepLoaderForTests(loader: (() => Promise<unknown>) | null): void {
  loaderOverride = loader;
  cachedModule = null;
}

/** True when the @ast-grep/napi native binary loaded successfully. */
export async function isSymbolExtractionAvailable(): Promise<boolean> {
  return (await loadAstGrep()) !== null;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

// Minimal structural types for the ast-grep nodes we touch (avoids leaking the
// library's types into our public surface).
interface SgNode {
  kind(): string;
  text(): string;
  range(): { start: { line: number }; end: { line: number } };
  children(): SgNode[];
  field(name: string): SgNode | null;
}

const SG_LANG: Record<SupportedLang, 'TypeScript' | 'Tsx' | 'JavaScript'> = {
  ts: 'TypeScript',
  tsx: 'Tsx',
  js: 'JavaScript',
  jsx: 'JavaScript', // tree-sitter-javascript parses JSX natively
};

const DECL_KIND: Record<string, SymbolKind> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  lexical_declaration: 'const',
  variable_declaration: 'const',
};

async function parseRoot(content: string, lang: SupportedLang): Promise<SgNode | null> {
  const sg = await loadAstGrep();
  if (!sg) return null;
  try {
    const ast = sg.parse(sg.Lang[SG_LANG[lang]], content);
    return ast.root() as unknown as SgNode;
  } catch {
    return null;
  }
}

/** Emit symbols for one declaration node, using `span` for line attribution. */
function symbolsFromDeclaration(
  decl: SgNode,
  span: SgNode,
  exported: boolean,
  out: ExtractedSymbol[],
): void {
  const kind = DECL_KIND[decl.kind()];
  if (!kind) return;
  const startLine = span.range().start.line + 1;
  const endLine = span.range().end.line + 1;

  if (kind === 'const') {
    // const/let/var can declare several names: one symbol per declarator.
    for (const child of decl.children()) {
      if (child.kind() !== 'variable_declarator') continue;
      const nameNode = child.field('name');
      // Skip destructuring patterns — only plain identifiers become symbols.
      if (!nameNode || nameNode.kind() !== 'identifier') continue;
      out.push({ name: nameNode.text(), kind, startLine, endLine, exported });
    }
    return;
  }

  const nameNode = decl.field('name');
  if (!nameNode) return; // anonymous (e.g. `export default function () {}`)
  out.push({ name: nameNode.text(), kind, startLine, endLine, exported });
}

/**
 * Extract top-level declarations (function/class/interface/type/const/enum)
 * with export flags and 1-based line ranges.
 * Returns null when ast-grep is unavailable — callers must degrade gracefully.
 */
export async function extractSymbols(
  content: string,
  lang: SupportedLang,
): Promise<ExtractedSymbol[] | null> {
  const root = await parseRoot(content, lang);
  if (!root) return null;

  const symbols: ExtractedSymbol[] = [];
  for (const node of root.children()) {
    const kind = node.kind();
    if (kind === 'export_statement') {
      // `export [default] <declaration>` — find the wrapped declaration; bare
      // re-exports (`export { x }`, `export * from`) carry no declaration.
      for (const child of node.children()) {
        if (DECL_KIND[child.kind()]) {
          symbolsFromDeclaration(child, node, true, symbols);
          break;
        }
      }
    } else if (DECL_KIND[kind]) {
      symbolsFromDeclaration(node, node, false, symbols);
    }
  }
  return symbols;
}

/**
 * Extract import specifiers from top-level `import` statements, resolving
 * relative specifiers textually against `filePath`.
 * Returns [] when ast-grep is unavailable.
 */
export async function extractImports(
  content: string,
  lang: SupportedLang,
  filePath: string,
): Promise<ExtractedImport[]> {
  const root = await parseRoot(content, lang);
  if (!root) return [];

  const imports: ExtractedImport[] = [];
  const seen = new Set<string>();
  for (const node of root.children()) {
    if (node.kind() !== 'import_statement') continue;
    const sourceNode = node.field('source');
    if (!sourceNode) continue;
    const specifier = sourceNode.text().replace(/^['"`]|['"`]$/g, '');
    if (!specifier || seen.has(specifier)) continue;
    seen.add(specifier);
    imports.push({ specifier, resolvedPath: resolveRelativeImport(specifier, filePath) });
  }
  return imports;
}

/**
 * Pure textual resolution of a relative import specifier against the importing
 * file's path. No fs access: returns the normalized, extensionless candidate
 * path (e.g. '../foo' from 'src/a/b.ts' → 'src/foo'); extension probing
 * (.ts/.tsx/index.ts) is the caller's concern. Returns null for bare package
 * specifiers and for paths that escape the repo root.
 */
export function resolveRelativeImport(specifier: string, filePath: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;

  // TS ESM style imports often write './x.js' for './x.ts' — strip JS/TS
  // extensions so the candidate is a stable extensionless module path.
  const spec = specifier.replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i, '');

  const dir = filePath.split('/').slice(0, -1).filter(Boolean);
  const segments = [...dir];
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null; // escapes the repo root
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.length > 0 ? segments.join('/') : null;
}
