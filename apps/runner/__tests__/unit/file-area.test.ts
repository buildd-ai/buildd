import { describe, it, expect } from 'bun:test';
import { fileAreaOf, recordFileArea, FILE_AREA_TOOLS, MAX_AREAS_PER_TOOL, OUTSIDE_AREA, ROOT_AREA, OVERFLOW_AREA, filePathInput } from '../../src/file-area';
import { canonicalToolName } from '@buildd/shared';

const ROOT = '/home/coder/project/buildd/.buildd-worktrees/buildd_abc';

describe('fileAreaOf', () => {
  it('top-level directory for a file inside the worktree', () => {
    expect(fileAreaOf(`${ROOT}/docs/specs/x.md`, ROOT)).toBe('docs');
    expect(fileAreaOf(`${ROOT}/scripts/run.ts`, ROOT)).toBe('scripts');
  });

  it('two levels for monorepo containers (apps, packages)', () => {
    expect(fileAreaOf(`${ROOT}/apps/web/src/lib/a.ts`, ROOT)).toBe('apps/web');
    expect(fileAreaOf(`${ROOT}/packages/core/db/schema.ts`, ROOT)).toBe('packages/core');
  });

  it('a file directly in the repo root, or a container with no second level', () => {
    expect(fileAreaOf(`${ROOT}/package.json`, ROOT)).toBe(ROOT_AREA);
    expect(fileAreaOf(`${ROOT}/apps/README.md`, ROOT)).toBe('apps');
  });

  it('relative paths resolve against the root', () => {
    expect(fileAreaOf('apps/runner/src/workers.ts', ROOT)).toBe('apps/runner');
    expect(fileAreaOf('./docs/a.md', ROOT)).toBe('docs');
  });

  it('anything outside the worktree is one area, never its path', () => {
    expect(fileAreaOf('/tmp/scratch/notes.txt', ROOT)).toBe(OUTSIDE_AREA);
    expect(fileAreaOf('/home/coder/.claude/settings.json', ROOT)).toBe(OUTSIDE_AREA);
    expect(fileAreaOf(`${ROOT}-other/apps/web/x.ts`, ROOT)).toBe(OUTSIDE_AREA);
  });

  it('no root: absolute paths are outside, relative paths still classify', () => {
    expect(fileAreaOf('/x/y.ts', undefined)).toBe(OUTSIDE_AREA);
    expect(fileAreaOf('docs/a.md', undefined)).toBe('docs');
  });

  it('missing or malformed input records nothing', () => {
    expect(fileAreaOf(undefined, ROOT)).toBeNull();
    expect(fileAreaOf('', ROOT)).toBeNull();
    expect(fileAreaOf(42, ROOT)).toBeNull();
  });

  it('a parent-escaping relative path is outside', () => {
    expect(fileAreaOf('../elsewhere/a.ts', ROOT)).toBe(OUTSIDE_AREA);
  });
});

describe('recordFileArea', () => {
  it('counts per tool and area', () => {
    const into: Record<string, Record<string, number>> = {};
    recordFileArea(into, 'Read', 'docs');
    recordFileArea(into, 'Read', 'docs');
    recordFileArea(into, 'Edit', 'apps/web');
    expect(into).toEqual({ Read: { docs: 2 }, Edit: { 'apps/web': 1 } });
  });

  it('caps distinct areas per tool and folds the rest into overflow', () => {
    const into: Record<string, Record<string, number>> = {};
    for (let i = 0; i < MAX_AREAS_PER_TOOL + 5; i++) recordFileArea(into, 'Read', `area${i}`);
    recordFileArea(into, 'Read', 'area0');
    const areas = Object.keys(into.Read);
    expect(areas.length).toBe(MAX_AREAS_PER_TOOL + 1);
    expect(into.Read[OVERFLOW_AREA]).toBe(5);
    expect(into.Read.area0).toBe(2);
  });
});

describe('filePathInput', () => {
  it('reads the path field each file tool uses', () => {
    expect(filePathInput('Read', { file_path: 'a.ts' })).toBe('a.ts');
    expect(filePathInput('NotebookEdit', { notebook_path: 'n.ipynb' })).toBe('n.ipynb');
    expect(filePathInput('Bash', { command: 'cat a' })).toBeUndefined();
  });

  it('covers Read, Edit, Write, MultiEdit and NotebookEdit', () => {
    expect([...FILE_AREA_TOOLS].sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Write']);
  });
});

describe('canonicalToolName (shared, used at capture)', () => {
  it('folds case variants of built-ins', () => {
    expect(canonicalToolName('bash')).toBe('Bash');
    expect(canonicalToolName('Bash')).toBe('Bash');
    expect(canonicalToolName('Agent')).toBe('Agent');
  });

  it('maps Codex re-exposed MCP tools to their own server', () => {
    expect(canonicalToolName('mcp__codex_apps__buildd.buildd')).toBe('mcp__buildd__buildd');
    expect(canonicalToolName('mcp__codex_apps__buildd.recall')).toBe('mcp__buildd__recall');
    expect(canonicalToolName('mcp__codex_apps__nodot')).toBe('mcp__codex_apps__nodot');
  });

  it('leaves ordinary MCP names alone', () => {
    expect(canonicalToolName('mcp__buildd__learn')).toBe('mcp__buildd__learn');
    expect(canonicalToolName('mcp__codebase-memory__search_graph')).toBe('mcp__codebase-memory__search_graph');
  });
});
