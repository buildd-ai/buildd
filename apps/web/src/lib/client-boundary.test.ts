import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { Glob } from 'bun';

/**
 * Guard for the React server/client boundary.
 *
 * A module marked `'use client'` is compiled to a set of client references. Its
 * *components* can be rendered from a server component, but its plain function
 * exports cannot be called there — in a production build the call throws
 * "Attempted to call deriveStage() from the server but deriveStage is on the
 * client", which reaches the user as the generic error boundary and is invisible
 * to `next build` and to `next dev`.
 *
 * That is exactly how /app/home broke in production (digest 2365501010): the
 * page imported `deriveStage` from `@/components/StageChip`. Shared derivation
 * logic belongs in a plain module (e.g. `@/lib/stage`) that both sides import.
 */

const SRC = resolvePath(import.meta.dir, '..');

function isClientModule(file: string): boolean {
  try {
    return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(['"])use client\1/.test(
      readFileSync(file, 'utf8').slice(0, 400),
    );
  } catch {
    return false;
  }
}

/** Resolve an `@/…` specifier to a file inside apps/web/src. */
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith('@/')) return null;
  const base = join(SRC, spec.slice(2));
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

const IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](@\/[^'"]+)['"]/g;

/** Named value imports whose local name starts lowercase — i.e. not components. */
function nonComponentValueImports(clause: string): string[] {
  return clause
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith('type '))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .filter((name) => /^[a-z_]/.test(name));
}

function findViolations(): string[] {
  const violations: string[] = [];
  const files = [...new Glob('**/*.{ts,tsx}').scanSync(SRC)]
    .map((f) => join(SRC, f))
    .filter((f) => !f.includes('.test.'))
    .filter((f) => !isClientModule(f));

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(IMPORT_RE)) {
      if (match[1]) continue; // `import type { … }`
      const target = resolveAlias(match[3]);
      if (!target || !isClientModule(target)) continue;
      const names = nonComponentValueImports(match[2]);
      if (names.length > 0) {
        violations.push(
          `${file.slice(SRC.length + 1)} imports { ${names.join(', ')} } from '${match[3]}' ('use client')`,
        );
      }
    }
  }
  return violations.sort();
}

describe('server/client module boundary', () => {
  it('no server module calls a function exported from a "use client" module', () => {
    expect(findViolations()).toEqual([]);
  });

  it('detects the /app/home regression shape', () => {
    // Self-check on the detector: a lowercase named import from a client module
    // is a violation, a component import from the same module is not.
    expect(nonComponentValueImports('StageChip, deriveStage')).toEqual(['deriveStage']);
    expect(nonComponentValueImports('StageChip, type Stage')).toEqual([]);
  });

  it('treats deriveStage as server-safe', () => {
    const stageModule = resolveAlias('@/lib/stage');
    expect(stageModule).not.toBeNull();
    expect(isClientModule(stageModule!)).toBe(false);
    expect(readFileSync(stageModule!, 'utf8')).toContain('export function deriveStage');
  });
});
