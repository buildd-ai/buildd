/**
 * Build a git fixture once per test file, then hand every test a fresh byte
 * copy of it.
 *
 * Why the copy lands at the SAME absolute path every time: a clone records its
 * origin as an absolute path, and a worktree's `.git` file points back at its
 * base clone absolutely. A copy anywhere else would still talk to the
 * template. Tests inside one file run one after another, so a single fixed
 * path is safe; separate files get separate `mkdtemp` roots.
 *
 * A copy costs a few milliseconds. The `git init` / clone / commit / push it
 * replaces cost several hundred per test, and that was most of the runtime of
 * the slowest files in the unit suite.
 *
 * Each test still gets its own copy: anything it mutates is thrown away in
 * `teardown()` and the next test starts from the pristine template.
 */
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type TemplateDir = {
  /** Where each test's copy lives. Stable for the life of the file. */
  readonly dir: string;
  /** Fresh copy of the template at `dir`; builds the template on first call. */
  setup(): string;
  /** Remove this test's copy. */
  teardown(): void;
  /** Remove the template too (afterAll). */
  dispose(): void;
};

export function templateDir(prefix: string, build: (dir: string) => void): TemplateDir {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(root, 'work');
  const template = join(root, 'template');
  return {
    dir,
    setup() {
      rmSync(dir, { recursive: true, force: true });
      if (!existsSync(template)) {
        // Built AT `dir` so every absolute path inside it names `dir`, then
        // parked; the copy below puts it back.
        build(dir);
        renameSync(dir, template);
      }
      cpSync(template, dir, { recursive: true });
      return dir;
    },
    teardown() {
      rmSync(dir, { recursive: true, force: true });
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
