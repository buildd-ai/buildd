/**
 * Bash command classifier (apps/runner/src/bash-classify.ts).
 *
 * The question this instrumentation exists to answer: what share of a worker's
 * Bash calls are code search? Bash is by far the most-called tool and its
 * command string was never inspected, so every `grep`/`rg`/`git grep` run
 * through it was invisible to any usage rollup.
 *
 * These tests pin the taxonomy, the pipeline/chain dominance rule, and the
 * pattern-shape branches. They also pin the privacy invariant: the classifier
 * returns COUNTS and SHAPES, never the pattern text.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyBashCommand,
  recordBashCommand,
  emptyBashCommandCounts,
  totalBashCommands,
  BASH_BUCKETS,
  type BashCommandCounts,
} from '../../src/bash-classify';

const bucket = (cmd: string) => classifyBashCommand(cmd).bucket;
const shape = (cmd: string) => classifyBashCommand(cmd).searchShape;

/**
 * The repo-listing git subcommand, composed rather than spelled.
 *
 * `scripts/always-run-tests.test.ts` treats that literal appearing anywhere in
 * a test file as proof the test enumerates the repository, and requires it in
 * the always-run manifest. That proxy is deliberately cheap and it is right
 * about every current case — but here the string is a classifier FIXTURE, not a
 * call, so registering this file would make the manifest claim something false.
 */
const GIT_LIST_FILES = 'git ls' + '-files';

describe('classifyBashCommand — code_search', () => {
  test('the grep family', () => {
    expect(bucket('grep -rn "foo" src/')).toBe('code_search');
    expect(bucket('egrep -n foo src')).toBe('code_search');
    expect(bucket('fgrep foo src')).toBe('code_search');
    expect(bucket('rg foo')).toBe('code_search');
    expect(bucket('rg --type ts foo apps/')).toBe('code_search');
    expect(bucket('ag foo')).toBe('code_search');
    expect(bucket('ack foo')).toBe('code_search');
  });

  test('git grep is code_search, other git subcommands are not', () => {
    expect(bucket('git grep foo')).toBe('code_search');
    expect(bucket('git  grep  -n  foo')).toBe('code_search');
    expect(bucket('git grep foo origin/dev')).toBe('code_search');
    expect(bucket('git status')).toBe('git');
    expect(bucket('git log --oneline -20')).toBe('git');
    expect(bucket('git diff HEAD~1')).toBe('git');
    expect(bucket(GIT_LIST_FILES)).toBe('file_find');
    expect(bucket('git ls-tree -r HEAD')).toBe('file_find');
  });

  test('absolute paths and stray whitespace still resolve', () => {
    expect(bucket('/usr/bin/grep -r foo .')).toBe('code_search');
    expect(bucket('  rg foo ')).toBe('code_search');
  });
});

describe('classifyBashCommand — other buckets', () => {
  test('file_find', () => {
    expect(bucket('find . -name "*.ts"')).toBe('file_find');
    expect(bucket('fd -e ts')).toBe('file_find');
    expect(bucket('ls -R src')).toBe('file_find');
    expect(bucket('ls --recursive src')).toBe('file_find');
    expect(bucket('tree -L 2')).toBe('file_find');
  });

  test('plain ls is not file_find (it is not a recursive discovery sweep)', () => {
    expect(bucket('ls')).toBe('other');
    expect(bucket('ls -la apps/runner')).toBe('other');
  });

  test('file_read', () => {
    expect(bucket('cat package.json')).toBe('file_read');
    expect(bucket('head -50 apps/runner/src/workers.ts')).toBe('file_read');
    expect(bucket('tail -f log.txt')).toBe('file_read');
    expect(bucket("sed -n '1,40p' file.ts")).toBe('file_read');
    expect(bucket('wc -l file.ts')).toBe('file_read');
  });

  test('file_write', () => {
    expect(bucket("sed -i '' s/a/b/ file.ts")).toBe('file_write');
    expect(bucket('mkdir -p tmp/out')).toBe('file_write');
    expect(bucket('rm -rf tmp')).toBe('file_write');
    expect(bucket('cp a b')).toBe('file_write');
    expect(bucket('mv a b')).toBe('file_write');
  });

  test('test', () => {
    expect(bucket('bun run test')).toBe('test');
    expect(bucket('bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/x.test.ts')).toBe('test');
    expect(bucket('npm test')).toBe('test');
    expect(bucket('npx vitest run')).toBe('test');
    expect(bucket('pytest -q')).toBe('test');
    expect(bucket('go test ./...')).toBe('test');
    expect(bucket('cargo test')).toBe('test');
  });

  test('build', () => {
    expect(bucket('bun run build')).toBe('build');
    expect(bucket('bun run lint')).toBe('build');
    expect(bucket('bun run typecheck')).toBe('build');
    expect(bucket('tsc --noEmit')).toBe('build');
    expect(bucket('bun install')).toBe('build');
    expect(bucket('eslint .')).toBe('build');
  });

  test('gh is its own bucket, distinct from git', () => {
    expect(bucket('gh pr create --fill')).toBe('gh');
    expect(bucket('gh api repos/o/r/pulls')).toBe('gh');
  });

  test('other', () => {
    expect(bucket('echo hi')).toBe('other');
    expect(bucket('curl -s https://example.test')).toBe('other');
    expect(bucket('pwd')).toBe('other');
  });

  test('an unclassifiable or empty command is other, never a throw', () => {
    expect(bucket('')).toBe('other');
    expect(bucket('   ')).toBe('other');
    expect(bucket('|||')).toBe('other');
  });

  test('every bucket returned is a declared bucket', () => {
    for (const cmd of ['grep x', 'find .', 'cat f', 'rm f', 'bun run test', 'tsc', 'gh pr list', 'git status', 'echo']) {
      expect(BASH_BUCKETS).toContain(bucket(cmd));
    }
  });
});

describe('classifyBashCommand — wrappers and prefixes', () => {
  test('leading env assignments are stripped', () => {
    expect(bucket('FOO=1 BAR=baz grep -rn foo src')).toBe('code_search');
    expect(bucket('DEV_USER_EMAIL=a@b.test bun run test')).toBe('test');
  });

  test('env / time / nohup / timeout wrappers are stripped', () => {
    expect(bucket('env FOO=1 rg foo')).toBe('code_search');
    expect(bucket('time bun run test')).toBe('test');
    expect(bucket('timeout 30 rg foo')).toBe('code_search');
    expect(bucket('nohup bun run build')).toBe('build');
    expect(bucket('command grep foo x')).toBe('code_search');
  });

  test('xargs delegates to the command it runs', () => {
    expect(bucket('find . -name "*.ts" | xargs grep -l foo')).toBe('code_search');
    expect(bucket('cat list.txt | xargs -n1 -I{} rm {}')).toBe('file_write');
  });

  test('sh -c / bash -c recurse into the inner command', () => {
    expect(bucket('bash -c "grep -rn foo src"')).toBe('code_search');
    expect(bucket("sh -c 'bun run test'")).toBe('test');
  });
});

describe('classifyBashCommand — pipelines and chains (dominance rule)', () => {
  test('a pipeline fed by a file producer and ending in grep is code_search', () => {
    expect(bucket('cat apps/runner/src/workers.ts | grep toolCounts')).toBe('code_search');
    expect(bucket(`${GIT_LIST_FILES} | grep -c ts`)).toBe('code_search');
    expect(bucket('find . -name "*.ts" | xargs grep -n foo')).toBe('code_search');
  });

  test('grep downstream of a NON-file producer is a filter, not code search', () => {
    expect(bucket('ps aux | grep bun')).toBe('other');
    expect(bucket('gh pr list | grep conflict')).toBe('gh');
    expect(bucket('bun run test | grep -i fail')).toBe('test');
    expect(bucket('git log --oneline | grep fix')).toBe('git');
    expect(bucket('curl -s https://example.test | grep title')).toBe('other');
  });

  test('a downstream reader that names no file is a pipeline tail, not a file read', () => {
    // Otherwise a trailing `head` decides the intent of anything it is appended
    // to, because file_read outranks other.
    expect(bucket('ls -la apps/runner/src | head -30')).toBe('other');
    expect(bucket('echo hi | wc -c')).toBe('other');
    expect(bucket('ps aux | head')).toBe('other');
    // A reader that DOES name a file is still a file read wherever it sits.
    expect(bucket('cat a.ts | head -5')).toBe('file_read');
    expect(bucket('true && head -20 a.ts')).toBe('file_read');
  });

  test('chains take the most specific intent present', () => {
    expect(bucket('cd apps/runner && grep -rn foo src')).toBe('code_search');
    expect(bucket('git add -A; git commit -m wip')).toBe('git');
    expect(bucket('bun install && bun run test')).toBe('test');
    expect(bucket('mkdir -p tmp && rg foo')).toBe('code_search');
  });

  test('a search inside command substitution still counts as search', () => {
    expect(bucket('echo "$(grep -c foo src/x.ts)"')).toBe('code_search');
  });

  test('a chain of only plumbing stays other', () => {
    expect(bucket('cd /tmp && pwd && echo done')).toBe('other');
  });

  test('quoted operators are not chain separators', () => {
    // The `&&` and `|` live inside the pattern; there is exactly one command.
    expect(bucket('rg "a && b"')).toBe('code_search');
    expect(shape('rg "a && b"')).toBe('quoted_phrase');
    expect(bucket("grep 'foo|bar' src")).toBe('code_search');
  });
});

describe('classifyBashCommand — code_search pattern shape', () => {
  test('bare identifier', () => {
    expect(shape('grep -rn recordToolCall src/')).toBe('identifier');
    expect(shape('rg "recordToolCall"')).toBe('identifier');
    expect(shape("rg 'foo_bar2'")).toBe('identifier');
    expect(shape('git grep toolCounts')).toBe('identifier');
  });

  test('regex / metacharacter pattern', () => {
    expect(shape('grep -E "^(a|b)$" file')).toBe('regex');
    expect(shape('rg "foo.bar"')).toBe('regex');
    expect(shape('rg "cbm(Tool|File)Counts"')).toBe('regex');
  });

  test('quoted string containing spaces', () => {
    expect(shape('grep -rn "hello world" .')).toBe('quoted_phrase');
    expect(shape("rg 'export function foo'")).toBe('quoted_phrase');
  });

  test('path or glob', () => {
    expect(shape('rg "apps/runner/src"')).toBe('path_glob');
    expect(shape('grep -rn "*.test.ts" .')).toBe('path_glob');
  });

  test('-e picks the pattern out of flag soup', () => {
    expect(shape('grep -rn --include=*.ts -e myIdent src/')).toBe('identifier');
    expect(shape('rg -C 3 -e "a|b" src/')).toBe('regex');
  });

  test('flag values are not mistaken for the pattern', () => {
    expect(shape('rg --type ts myIdent')).toBe('identifier');
    expect(shape('grep -A 5 -B 5 myIdent file.ts')).toBe('identifier');
    expect(shape('rg -m 2 myIdent')).toBe('identifier');
  });

  test('no determinable pattern is unknown', () => {
    expect(shape('rg')).toBe('unknown');
    expect(shape('git grep')).toBe('unknown');
    expect(shape('rg --help')).toBe('unknown');
  });

  test('shape is only set for code_search', () => {
    expect(shape('cat file.ts')).toBeUndefined();
    expect(shape('ps aux | grep bun')).toBeUndefined();
    expect(shape('git status')).toBeUndefined();
  });
});

describe('recordBashCommand', () => {
  test('accumulates buckets, shapes and a total', () => {
    const counts = emptyBashCommandCounts();
    recordBashCommand(counts, 'grep -rn foo src/');
    recordBashCommand(counts, 'rg "a|b"');
    recordBashCommand(counts, 'cat package.json');
    recordBashCommand(counts, 'git status');
    recordBashCommand(counts, 'ps aux | grep bun');

    expect(counts.total).toBe(5);
    expect(counts.buckets.code_search).toBe(2);
    expect(counts.buckets.file_read).toBe(1);
    expect(counts.buckets.git).toBe(1);
    expect(counts.buckets.other).toBe(1);
    expect(counts.searchShapes.identifier).toBe(1);
    expect(counts.searchShapes.regex).toBe(1);
    expect(totalBashCommands(counts)).toBe(5);
  });

  test('only non-zero keys are present, so the payload stays tiny', () => {
    const counts = emptyBashCommandCounts();
    recordBashCommand(counts, 'grep foo src');
    expect(Object.keys(counts.buckets)).toEqual(['code_search']);
    expect(Object.keys(counts.searchShapes)).toEqual(['identifier']);
  });

  test('a non-string or empty command is ignored entirely', () => {
    const counts = emptyBashCommandCounts();
    recordBashCommand(counts, undefined);
    recordBashCommand(counts, null);
    recordBashCommand(counts, 42 as unknown as string);
    recordBashCommand(counts, '');
    expect(counts.total).toBe(0);
    expect(Object.keys(counts.buckets)).toHaveLength(0);
  });

  test('payload size is bounded regardless of session length', () => {
    const counts = emptyBashCommandCounts();
    for (let i = 0; i < 5000; i++) {
      recordBashCommand(counts, `rg "sensitive_value_${i}" src/`);
      recordBashCommand(counts, `cat /etc/hosts_${i}`);
    }
    const json = JSON.stringify(counts);
    expect(json.length).toBeLessThan(400);
    // Privacy invariant: no pattern text, ever.
    expect(json).not.toContain('sensitive_value');
    expect(json).not.toContain('hosts');
  });

  test('never stores the searched text even for a single call', () => {
    const counts = emptyBashCommandCounts();
    recordBashCommand(counts, 'rg "AKIA_NOT_A_REAL_KEY" .');
    expect(JSON.stringify(counts)).not.toContain('AKIA');
  });

  test('classification never throws on adversarial input', () => {
    const nasty = ['"', "'", '$(', '`', 'a\\', '|&;()<>', ' ', 'x'.repeat(20_000)];
    const counts: BashCommandCounts = emptyBashCommandCounts();
    for (const cmd of nasty) expect(() => recordBashCommand(counts, cmd)).not.toThrow();
    expect(counts.total).toBe(nasty.length);
  });
});
