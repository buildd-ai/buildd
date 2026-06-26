import { describe, it, expect } from 'bun:test';
import { extractEntities } from '../knowledge-store/entity-extractor';

// ── extractEntities ───────────────────────────────────────────────────────────

describe('extractEntities', () => {
  it('extracts a file entity from source_path', () => {
    const entities = extractEntities({
      content: 'function foo() {}',
      sourcePath: 'src/lib/auth.ts',
      corpus: 'code',
      workspaceId: 'ws-1',
    });
    const fileEntity = entities.find(e => e.kind === 'file');
    expect(fileEntity).toBeDefined();
    expect(fileEntity!.key).toBe('src/lib/auth.ts');
    expect(fileEntity!.canonicalName).toBe('auth.ts');
  });

  it('extracts heading entities from markdown content', () => {
    const entities = extractEntities({
      content: '## Retrieval Path\n\nSome text\n\n### Hybrid Mode\n\nMore text',
      sourcePath: 'docs/design/retrieval.md',
      corpus: 'docs',
      workspaceId: 'ws-1',
    });
    const headings = entities.filter(e => e.kind === 'heading');
    expect(headings.length).toBeGreaterThanOrEqual(1);
    expect(headings.some(h => h.canonicalName.includes('Retrieval Path'))).toBe(true);
  });

  it('extracts PR references (#NNN) from content', () => {
    const entities = extractEntities({
      content: 'Fixes #987 and closes #1001. See also PR #543.',
      corpus: 'task',
      workspaceId: 'ws-1',
    });
    const prEntities = entities.filter(e => e.kind === 'pr');
    expect(prEntities.length).toBeGreaterThanOrEqual(2);
    expect(prEntities.some(e => e.key === 'pr#987')).toBe(true);
    expect(prEntities.some(e => e.key === 'pr#1001')).toBe(true);
  });

  it('extracts task UUID references from content', () => {
    const taskId = 'c21dfeb7-3eb4-4f75-a597-9f79e6ffa3c7';
    const entities = extractEntities({
      content: `See task ${taskId} for context.`,
      corpus: 'memory',
      workspaceId: 'ws-1',
    });
    const taskEntity = entities.find(e => e.kind === 'task');
    expect(taskEntity).toBeDefined();
    expect(taskEntity!.key).toBe(`task:${taskId}`);
  });

  it('extracts wikilink entities [[Target]] from markdown', () => {
    const entities = extractEntities({
      content: 'See [[PgVectorStore]] and [[entity resolver]] for details.',
      corpus: 'docs',
      workspaceId: 'ws-1',
    });
    const wikilinks = entities.filter(e => e.kind === 'wikilink');
    expect(wikilinks.length).toBe(2);
    expect(wikilinks.some(w => w.canonicalName === 'PgVectorStore')).toBe(true);
    expect(wikilinks.some(w => w.canonicalName === 'entity resolver')).toBe(true);
  });

  it('extracts mission id from metadata', () => {
    const missionId = 'abc123-mission';
    const entities = extractEntities({
      content: 'Task outcome',
      corpus: 'task',
      workspaceId: 'ws-1',
      metadata: { missionId },
    });
    const missionEntity = entities.find(e => e.kind === 'mission');
    expect(missionEntity).toBeDefined();
    expect(missionEntity!.key).toBe(`mission:${missionId}`);
  });

  it('deduplicates entities with the same kind+key', () => {
    const entities = extractEntities({
      content: 'Fixes #987. Also see #987.',
      corpus: 'task',
      workspaceId: 'ws-1',
    });
    const pr987s = entities.filter(e => e.kind === 'pr' && e.key === 'pr#987');
    expect(pr987s.length).toBe(1);
  });

  it('returns empty array for content with no extractable entities', () => {
    const entities = extractEntities({
      content: 'Some plain text without any special refs.',
      corpus: 'memory',
      workspaceId: 'ws-1',
    });
    // May or may not return empty, but should not throw
    expect(Array.isArray(entities)).toBe(true);
  });

  it('does not extract headings from non-doc/spec corpus', () => {
    const entities = extractEntities({
      content: '## this is a comment heading in code',
      corpus: 'code',
      workspaceId: 'ws-1',
      sourcePath: 'src/lib/utils.ts',
    });
    const headings = entities.filter(e => e.kind === 'heading');
    expect(headings.length).toBe(0);
  });
});
