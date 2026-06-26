import { describe, it, expect } from 'bun:test';
import { extractEntities, toEntityRefs, extractFromScipSymbols } from '../knowledge-store/entity-extractor';
import type { ScipSymbol } from '../knowledge-store/entity-extractor';

// ── extractEntities ────────────────────────────────────────────────────────────

describe('extractEntities — file entity', () => {
  it('extracts a file entity from source_path', () => {
    const result = extractEntities({
      content: 'some content',
      sourcePath: 'apps/web/src/app/api/mcp/route.ts',
    });
    const file = result.find(e => e.kind === 'file');
    expect(file).toBeDefined();
    expect(file?.key).toBe('apps/web/src/app/api/mcp/route.ts');
    expect(file?.role).toBe('defines');
    expect(file?.canonicalName).toBe('route.ts');
  });

  it('does not extract file entity when source_path is absent', () => {
    const result = extractEntities({ content: 'hello' });
    expect(result.filter(e => e.kind === 'file')).toHaveLength(0);
  });
});

describe('extractEntities — PR references', () => {
  it('extracts PR number from #N references in content', () => {
    const result = extractEntities({ content: 'Fixes #123 and closes #456' });
    const prs = result.filter(e => e.kind === 'pr');
    expect(prs.length).toBeGreaterThanOrEqual(2);
    const keys = prs.map(p => p.key);
    expect(keys).toContain('pr#123');
    expect(keys).toContain('pr#456');
  });

  it('extracts PR entity from metadata.prNumber', () => {
    const result = extractEntities({
      content: 'PR body',
      metadata: { prNumber: '42' },
    });
    const pr = result.find(e => e.kind === 'pr' && e.key === 'pr#42');
    expect(pr).toBeDefined();
    expect(pr?.role).toBe('defines');
  });
});

describe('extractEntities — task / mission from metadata', () => {
  it('extracts task entity from metadata.taskId', () => {
    const tid = 'c21dfeb7-3eb4-4f75-a597-9f79e6ffa3c7';
    const result = extractEntities({ content: 'done', metadata: { taskId: tid } });
    const task = result.find(e => e.kind === 'task');
    expect(task?.key).toBe(`task:${tid}`);
    expect(task?.role).toBe('defines');
  });

  it('extracts mission entity from metadata.missionId', () => {
    const mid = 'abc12345-0000-0000-0000-000000000000';
    const result = extractEntities({ content: 'done', metadata: { missionId: mid } });
    const mission = result.find(e => e.kind === 'mission');
    expect(mission?.key).toBe(`mission:${mid}`);
  });
});

describe('extractEntities — headings', () => {
  it('extracts headings from docs corpus', () => {
    const content = '# Top\n\n## Section A\n\nsome text\n\n### Sub\n\nmore';
    const result = extractEntities({ content, sourcePath: 'docs/foo.md', corpus: 'docs' });
    const headings = result.filter(e => e.kind === 'heading');
    expect(headings.length).toBeGreaterThanOrEqual(2);
    const keys = headings.map(h => h.key);
    expect(keys.some(k => k.includes('Section A'))).toBe(true);
  });

  it('does NOT extract headings for code corpus', () => {
    const content = '## Not a heading here';
    const result = extractEntities({ content, sourcePath: 'src/foo.ts', corpus: 'code' });
    expect(result.filter(e => e.kind === 'heading')).toHaveLength(0);
  });
});

describe('extractEntities — wikilinks', () => {
  it('extracts wikilinks', () => {
    const result = extractEntities({ content: 'See [[KnowledgeStore]] and [[Pg Vector Store|PgVectorStore]]' });
    const wikilinks = result.filter(e => e.kind === 'wikilink');
    expect(wikilinks.length).toBeGreaterThanOrEqual(1);
    expect(wikilinks.some(w => w.canonicalName === 'KnowledgeStore')).toBe(true);
  });
});

describe('extractEntities — relative links', () => {
  it('extracts relative file references from markdown links', () => {
    const result = extractEntities({
      content: 'See [guide](./guide.md) and [other](../docs/ref.md)',
      sourcePath: 'docs/design/spec.md',
      corpus: 'docs',
    });
    const files = result.filter(e => e.kind === 'file' && e.role === 'references');
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extractEntities — deduplication', () => {
  it('deduplicates identical entity kinds', () => {
    // Same PR referenced twice
    const result = extractEntities({ content: 'see #42 and also #42 again' });
    const prs = result.filter(e => e.kind === 'pr' && e.key === 'pr#42');
    expect(prs).toHaveLength(1);
  });
});

// ── toEntityRefs ───────────────────────────────────────────────────────────────

describe('toEntityRefs', () => {
  it('maps extracted entities to EntityRef shape', () => {
    const extracted = extractEntities({
      content: 'text',
      sourcePath: 'src/foo.ts',
      metadata: { prNumber: '7' },
    });
    const refs = toEntityRefs(extracted);
    expect(refs.every(r => r.kind && r.ref && r.role)).toBe(true);
    expect(refs.some(r => r.kind === 'file')).toBe(true);
    expect(refs.some(r => r.kind === 'pr')).toBe(true);
  });
});

// ── extractFromScipSymbols ─────────────────────────────────────────────────────

describe('extractFromScipSymbols', () => {
  it('extracts only definition occurrences as symbol entities', () => {
    const symbols: ScipSymbol[] = [
      { moniker: 'npm/foo 1.0.0/bar#MyClass.', name: 'MyClass', filePath: 'src/bar.ts', kind: 'definition', startLine: 5 },
      { moniker: 'npm/foo 1.0.0/bar#MyClass.', name: 'MyClass', filePath: 'src/other.ts', kind: 'reference', startLine: 12 },
      { moniker: 'npm/foo 1.0.0/baz#myFn.', name: 'myFn', filePath: 'src/baz.ts', kind: 'definition', startLine: 1 },
    ];
    const result = extractFromScipSymbols(symbols);
    expect(result.length).toBe(2); // 2 definitions, 1 reference (skipped)
    expect(result.every(e => e.kind === 'symbol')).toBe(true);
    expect(result.every(e => e.role === 'defines')).toBe(true);
    const names = result.map(e => e.canonicalName);
    expect(names).toContain('MyClass');
    expect(names).toContain('myFn');
  });

  it('deduplicates same moniker across files', () => {
    const symbols: ScipSymbol[] = [
      { moniker: 'npm/foo/bar#X.', name: 'X', filePath: 'a.ts', kind: 'definition', startLine: 0 },
      { moniker: 'npm/foo/bar#X.', name: 'X', filePath: 'b.ts', kind: 'definition', startLine: 0 },
    ];
    const result = extractFromScipSymbols(symbols);
    expect(result.length).toBe(1);
  });

  it('returns empty for all-reference input', () => {
    const symbols: ScipSymbol[] = [
      { moniker: 'npm/foo/bar#X.', name: 'X', filePath: 'a.ts', kind: 'reference', startLine: 0 },
    ];
    expect(extractFromScipSymbols(symbols)).toHaveLength(0);
  });
});
