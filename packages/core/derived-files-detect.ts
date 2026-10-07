/**
 * Propose `gitConfig.derivedFiles` from a repo's file list (action=init), the
 * same way risk-class paths are detected: from the tree, never typed. The owner
 * confirms by applying the proposal.
 *
 * Lockfiles only. A generated index (e.g. buildd's docs/specs/INDEX.md) has a
 * repo-specific generator a file list cannot reveal, so the owner adds those.
 * Migration chains are never derived (see the runner's merge-drivers.ts).
 */

import type { DerivedFileRule } from '@buildd/shared';

/** Lockfile name → the command that rewrites it from the manifest, changing as little as possible. */
const LOCKFILES: ReadonlyArray<[string, string]> = [
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
  ['package-lock.json', 'npm install --package-lock-only'],
  ['pnpm-lock.yaml', 'pnpm install --lockfile-only'],
  ['yarn.lock', 'yarn install'],
  ['Cargo.lock', 'cargo update --workspace'],
  ['poetry.lock', 'poetry lock'],
  ['uv.lock', 'uv lock'],
  ['go.sum', 'go mod tidy'],
  ['Gemfile.lock', 'bundle lock'],
  ['composer.lock', 'composer update --lock'],
];

const SKIP_DIR = /(^|\/)(node_modules|vendor|third_party|\.git)\//;
const MAX_PROPOSALS = 10;

export function detectDerivedFiles(files: string[]): DerivedFileRule[] {
  const out: DerivedFileRule[] = [];
  for (const [name, command] of LOCKFILES) {
    for (const path of files) {
      if (path !== name && !path.endsWith(`/${name}`)) continue;
      if (SKIP_DIR.test(path) || /['"\\\s]/.test(path)) continue;
      const dir = path.slice(0, path.length - name.length).replace(/\/$/, '');
      out.push(dir
        ? { glob: path, regenerate: `cd '${dir}' && ${command}` }
        // A bare name in gitattributes matches at any depth; anchor the root one.
        : { glob: `/${name}`, regenerate: command });
      if (out.length >= MAX_PROPOSALS) return out;
    }
  }
  return out;
}
