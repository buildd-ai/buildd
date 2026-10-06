/**
 * Guard: decision definitions are server-only.
 *
 * A decision definition is a module that calls `defineDecision` (or one of its
 * kind wrappers) with a literal config — the questions and rubric text the
 * server's decision model is asked. The runner is distributed separately from
 * the server, so it must import only the wire contract (types, parsing,
 * constants) and never pull a definition in, directly or transitively through
 * `packages/core`.
 *
 * This walks the real import graph: every source file under apps/runner/src,
 * following `@buildd/core/*` specifiers and relative imports inside
 * packages/core (type-only imports included — a contract module should own
 * the types the runner needs).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '../../../..');
const RUNNER_SRC = join(REPO, 'apps/runner/src');
const CORE = join(REPO, 'packages/core');

/** A call with a literal object config is a definition; the generic wrapper that forwards `config` is not. */
const DEFINITION_RE = /\b(?:defineDecision|definePromptedDecision|defineDecisionKind|defineBuilddDecisionKind)\s*(?:<[^>]*>)?\s*\(\s*\{/;
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function resolveFile(base: string): string | null {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const coreExports: Record<string, string> = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')).exports ?? {};

function resolveCoreSubpath(sub: string): string | null {
  const key = sub ? `./${sub}` : '.';
  if (typeof coreExports[key] === 'string') return resolveFile(join(CORE, coreExports[key]));
  for (const [pattern, target] of Object.entries(coreExports)) {
    if (!pattern.includes('*') || typeof target !== 'string') continue;
    const [pre, post] = pattern.split('*');
    if (key.startsWith(pre) && key.endsWith(post)) {
      const mid = key.slice(pre.length, key.length - post.length);
      return resolveFile(join(CORE, target.replace('*', mid)));
    }
  }
  return resolveFile(join(CORE, sub));
}

/** Resolve a specifier to a packages/core file, or null if it leaves packages/core. */
function resolveSpec(spec: string, fromFile: string): string | null {
  if (spec === '@buildd/core' || spec.startsWith('@buildd/core/')) {
    return resolveCoreSubpath(spec.slice('@buildd/core/'.length).replace(/^@buildd\/core$/, ''));
  }
  if (spec.startsWith('.') && fromFile.startsWith(CORE)) {
    const p = resolveFile(resolve(dirname(fromFile), spec));
    return p && p.startsWith(CORE) ? p : null;
  }
  return null;
}

function specifiers(file: string): string[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  return [...src.matchAll(SPEC_RE)].map(m => m[1]);
}

function findViolations(): string[] {
  const violations: string[] = [];
  const seen = new Map<string, string[]>(); // core file -> import chain
  const queue: Array<{ file: string; chain: string[] }> = [];

  for (const file of walk(RUNNER_SRC)) {
    for (const spec of specifiers(file)) {
      const target = resolveSpec(spec, file);
      if (target && !seen.has(target)) {
        const chain = [relative(REPO, file), relative(REPO, target)];
        seen.set(target, chain);
        queue.push({ file: target, chain });
      }
    }
  }

  while (queue.length) {
    const { file, chain } = queue.shift()!;
    if (DEFINITION_RE.test(stripComments(readFileSync(file, 'utf8')))) {
      violations.push(chain.join(' -> '));
    }
    for (const spec of specifiers(file)) {
      const target = resolveSpec(spec, file);
      if (target && !seen.has(target)) {
        const next = [...chain, relative(REPO, target)];
        seen.set(target, next);
        queue.push({ file: target, chain: next });
      }
    }
  }
  return violations.sort();
}

describe('runner imports no decision definitions', () => {
  test('the detector recognises a definition module', () => {
    // Can-fail check: a known server-side definition module must match, or the guard measures nothing.
    const known = readFileSync(join(CORE, 'task-size-bucket-decision.ts'), 'utf8');
    expect(DEFINITION_RE.test(stripComments(known))).toBe(true);
  });

  test('no apps/runner source reaches a defineDecision definition through packages/core', () => {
    expect(findViolations()).toEqual([]);
  });
});
