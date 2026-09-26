/**
 * Structured action milestones (apps/runner/src/tool-milestones.ts).
 *
 * The web task page reads `tool`/`path`/`add`/`rem`/`cmd`/`count` off action
 * milestones to render the tool-call tape and the "Touched files" diff bars.
 * These tests pin that field contract, the unchanged `label` text, and the
 * cap/compaction policy that decides which milestones survive a long session.
 */

import { describe, test, expect } from 'bun:test';
import {
  lineDiff,
  countLines,
  relativizePath,
  isNotableBash,
  truncateCmd,
  toolActionMilestone,
  appendMilestone,
  MILESTONE_CAP,
} from '../../src/tool-milestones';
import type { Milestone } from '../../src/types';

const ROOT = '/work/wt-123';

describe('lineDiff / countLines', () => {
  test('counts lines, ignoring a trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines(undefined)).toBe(0);
  });

  test('shared lines are neither added nor removed', () => {
    expect(lineDiff('a\nb\nc', 'a\nX\nc')).toEqual({ add: 1, rem: 1 });
  });

  test('pure insertion', () => {
    expect(lineDiff('a\nb', 'a\nnew1\nnew2\nb')).toEqual({ add: 2, rem: 0 });
  });

  test('pure deletion', () => {
    expect(lineDiff('a\nb\nc', 'a')).toEqual({ add: 0, rem: 2 });
  });

  test('multiset: duplicate lines are matched once each', () => {
    expect(lineDiff('x\nx', 'x\nx\nx')).toEqual({ add: 1, rem: 0 });
  });
});

describe('relativizePath', () => {
  test('strips the root prefix and leading slash', () => {
    expect(relativizePath(`${ROOT}/apps/runner/src/a.ts`, ROOT)).toBe('apps/runner/src/a.ts');
    expect(relativizePath(`${ROOT}/a.ts`, `${ROOT}/`)).toBe('a.ts');
  });

  test('keeps paths outside the root unchanged', () => {
    expect(relativizePath('/etc/hosts', ROOT)).toBe('/etc/hosts');
    // prefix match must be on a path boundary
    expect(relativizePath(`${ROOT}-other/a.ts`, ROOT)).toBe(`${ROOT}-other/a.ts`);
    expect(relativizePath('rel/a.ts', ROOT)).toBe('rel/a.ts');
  });

  test('no root → unchanged', () => {
    expect(relativizePath('/x/a.ts', undefined)).toBe('/x/a.ts');
  });
});

describe('toolActionMilestone', () => {
  test('Edit: label unchanged, tool/path/add/rem from a line diff', () => {
    const m = toolActionMilestone('Edit', {
      file_path: `${ROOT}/src/foo.ts`,
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 1;\nconst b = 3;\nconst c = 4;',
    }, ROOT, 42);
    expect(m).toEqual({ type: 'action', label: 'Edited foo.ts', ts: 42, tool: 'Edit', path: 'src/foo.ts', add: 2, rem: 1 });
  });

  test('Write: add = content lines, rem = 0', () => {
    const m = toolActionMilestone('Write', { file_path: `${ROOT}/new.md`, content: 'a\nb\nc\n' }, ROOT, 1);
    expect(m).toEqual({ type: 'action', label: 'Wrote new.md', ts: 1, tool: 'Write', path: 'new.md', add: 3, rem: 0 });
  });

  test('MultiEdit: now emits, summing counts over edits', () => {
    const m = toolActionMilestone('MultiEdit', {
      file_path: `${ROOT}/x/y.ts`,
      edits: [
        { old_string: 'a', new_string: 'a\nb' },
        { old_string: 'c\nd', new_string: 'e' },
      ],
    }, ROOT, 1);
    expect(m).toEqual({ type: 'action', label: 'Edited y.ts', ts: 1, tool: 'MultiEdit', path: 'x/y.ts', add: 2, rem: 2 });
  });

  test('MultiEdit with malformed edits does not throw', () => {
    const m = toolActionMilestone('MultiEdit', { file_path: '/a.ts', edits: 'nope' }, ROOT, 1);
    expect(m).toMatchObject({ tool: 'MultiEdit', add: 0, rem: 0, path: '/a.ts' });
  });

  test('Read: emits with count 1', () => {
    const m = toolActionMilestone('Read', { file_path: `${ROOT}/README.md` }, ROOT, 1);
    expect(m).toEqual({ type: 'action', label: 'Read README.md', ts: 1, tool: 'Read', path: 'README.md', count: 1 });
  });

  test('Bash notable: legacy label, cmd truncated to 80 chars', () => {
    const long = 'bun run scripts/run-unit-tests.ts ' + 'apps/runner/__tests__/unit/x.test.ts '.repeat(5);
    const m = toolActionMilestone('Bash', { command: long }, ROOT, 1)!;
    expect(m.label).toBe(`Ran: ${long.slice(0, 50)}`);
    expect(m).toMatchObject({ tool: 'Bash' });
    if (m.type !== 'action') throw new Error('expected action');
    expect(m.cmd!.length).toBeLessThanOrEqual(81);
    expect(m.cmd!.endsWith('…')).toBe(true);
    expect(m.path).toBeUndefined();
  });

  test('Bash short command is not suffixed', () => {
    expect(truncateCmd('  bun test  ')).toBe('bun test');
  });

  test('Bash non-notable: skipped', () => {
    for (const cmd of ['ls -la', 'cat foo.ts', 'grep -rn foo src', 'cd /tmp && pwd', 'echo hi']) {
      expect(toolActionMilestone('Bash', { command: cmd }, ROOT, 1)).toBeNull();
    }
  });

  test('other tools: null', () => {
    expect(toolActionMilestone('Glob', { pattern: '*' }, ROOT, 1)).toBeNull();
    expect(toolActionMilestone('Grep', { pattern: 'x' }, ROOT, 1)).toBeNull();
  });
});

describe('isNotableBash', () => {
  test('legacy substrings still notable', () => {
    for (const c of ['git commit -m "x"', 'npm i', 'bun install', 'run-test', 'docker build .']) {
      expect(isNotableBash(c)).toBe(true);
    }
  });

  test('broadened toolchain commands are notable', () => {
    for (const c of ['pnpm install', 'yarn lint', 'pytest -q', 'cargo check', 'go vet ./...', 'make', 'cd a && make all',
      'tsc --noEmit', 'npx vitest run', 'jest', 'git push origin HEAD', 'gh pr create --fill']) {
      expect(isNotableBash(c)).toBe(true);
    }
  });

  test('word-boundary: substrings of other words do not match', () => {
    expect(isNotableBash('cat makefile.bak')).toBe(false);
    expect(isNotableBash('ls cargoship')).toBe(false);
    expect(isNotableBash('')).toBe(false);
  });
});

describe('appendMilestone', () => {
  const read = (path: string, ts = 1): Milestone => ({ type: 'action', label: `Read ${path}`, ts, tool: 'Read', path, count: 1 });
  const edit = (path: string, ts = 1): Milestone => ({ type: 'action', label: `Edited ${path}`, ts, tool: 'Edit', path, add: 1, rem: 0 });
  const status = (label: string, ts = 1): Milestone => ({ type: 'status', label, ts });

  test('consecutive Read of the same path folds into one with count', () => {
    const list: Milestone[] = [];
    expect(appendMilestone(list, read('a.ts', 1)).folded).toBe(false);
    expect(appendMilestone(list, read('a.ts', 2)).folded).toBe(true);
    expect(appendMilestone(list, read('a.ts', 3)).folded).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tool: 'Read', path: 'a.ts', count: 3, ts: 3 });
  });

  test('Reads of different paths stay separate', () => {
    const list: Milestone[] = [];
    appendMilestone(list, read('a.ts'));
    appendMilestone(list, read('b.ts'));
    expect(list).toHaveLength(2);
  });

  test('an intervening milestone breaks the fold', () => {
    const list: Milestone[] = [];
    appendMilestone(list, read('a.ts'));
    appendMilestone(list, edit('a.ts'));
    appendMilestone(list, read('a.ts'));
    expect(list).toHaveLength(3);
  });

  test('cap is 100', () => {
    expect(MILESTONE_CAP).toBe(100);
    const list: Milestone[] = [];
    for (let i = 0; i < 150; i++) appendMilestone(list, status(`s${i}`, i));
    expect(list).toHaveLength(100);
    expect((list[0] as any).label).toBe('s50');
  });

  test('trim order: oldest Read first, then other actions, then anything', () => {
    const list: Milestone[] = [];
    appendMilestone(list, status('s0'), 4);
    appendMilestone(list, edit('e1'), 4);
    appendMilestone(list, read('r1'), 4);
    appendMilestone(list, read('r2'), 4);
    // over cap → oldest Read (r1) goes
    appendMilestone(list, status('s1'), 4);
    expect(list.map(m => m.label)).toEqual(['s0', 'Edited e1', 'Read r2', 's1']);
    // next → remaining Read (r2) goes
    appendMilestone(list, status('s2'), 4);
    expect(list.map(m => m.label)).toEqual(['s0', 'Edited e1', 's1', 's2']);
    // no Reads left → oldest other action (e1)
    appendMilestone(list, status('s3'), 4);
    expect(list.map(m => m.label)).toEqual(['s0', 's1', 's2', 's3']);
    // no actions left → shift
    appendMilestone(list, status('s4'), 4);
    expect(list.map(m => m.label)).toEqual(['s1', 's2', 's3', 's4']);
  });
});
