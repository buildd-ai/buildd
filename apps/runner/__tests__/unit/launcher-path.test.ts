/**
 * Verifies the launcher script template in install.sh sets PATH
 * so that bun is findable in non-interactive shells (Docker CMD, nohup, systemd).
 *
 * Run: cd apps/runner && bun test __tests__/unit/launcher-path.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';

// Use Bun.file (not fs.readFileSync) so the read isn't intercepted by
// other tests' `mock.module('fs', ...)` calls — which Bun applies process-wide
// at collection time, regardless of file order under a directory glob.
const installScript = await Bun.file(
  join(import.meta.dir, '../../install.sh'),
).text();

// Extract the launcher script between the LAUNCHER heredoc markers
const launcherMatch = installScript.match(
  /cat > "\$BIN_DIR\/buildd" << 'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/,
);
const launcher = launcherMatch?.[1] ?? '';

describe('launcher script PATH', () => {
  test('launcher heredoc is found in install.sh', () => {
    expect(launcher.length).toBeGreaterThan(0);
  });

  test('adds $HOME/.bun/bin to PATH before any bun invocation', () => {
    const pathExportIndex = launcher.indexOf('export PATH="$HOME/.bun/bin');
    const firstBunCallIndex = launcher.indexOf('bun --no-env-file run --preload');
    expect(pathExportIndex).toBeGreaterThan(-1);
    expect(firstBunCallIndex).toBeGreaterThan(-1);
    expect(pathExportIndex).toBeLessThan(firstBunCallIndex);
  });

  test('adds $HOME/.local/bin to PATH', () => {
    expect(launcher).toContain('$HOME/.local/bin');
  });

  test('restart loop invokes bun after PATH is set', () => {
    const lines = launcher.split('\n');
    let pathSet = false;
    let bunAfterPath = false;
    for (const line of lines) {
      if (line.includes('export PATH=') && line.includes('.bun/bin')) {
        pathSet = true;
      }
      if (pathSet && line.includes('bun --no-env-file run --preload') && line.includes('index.ts')) {
        bunAfterPath = true;
        break;
      }
    }
    expect(bunAfterPath).toBe(true);
  });

  test('dispatches `service` subcommands to service.ts', () => {
    expect(launcher).toContain('service)');
    expect(launcher).toContain('bun --no-env-file run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/service.ts" "$@"');
  });

  test('every advertised subcommand resolves to an existing file', async () => {
    // Extract all .ts file paths from the launcher that are executed via bun run
    const filePathRegex = /\$HOME\/\.buildd\/apps\/runner\/src\/([a-z-]+\.ts)/g;
    const matches = Array.from(launcher.matchAll(filePathRegex));
    expect(matches.length).toBeGreaterThan(0);

    const srcDir = join(import.meta.dir, '../../src');
    const referencedFiles = new Set<string>();

    for (const match of matches) {
      const fileName = match[1];
      referencedFiles.add(fileName);
    }

    for (const fileName of referencedFiles) {
      const filePath = join(srcDir, fileName);
      const file = Bun.file(filePath);
      const exists = await file.exists();
      expect(exists).toBe(
        true,
        `Launcher references ${fileName}, but ${filePath} does not exist`,
      );
    }
  });
});

describe('launcher never reads a .env from the current folder', () => {
  test('every bun invocation passes --no-env-file', () => {
    const calls = launcher.match(/\bbun (?:run|-e)\b|\bbun --no-env-file (?:run|-e)\b/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain('--no-env-file');
  });

  test('help, -h and --help are answered without starting the runner loop', () => {
    const help = launcher.indexOf('help|-h|--help)');
    const loop = launcher.indexOf('while true; do');
    expect(help).toBeGreaterThan(-1);
    expect(help).toBeLessThan(loop);
    const branch = launcher.slice(help, launcher.indexOf(';;', help));
    expect(branch).toContain('exec bun --no-env-file run');
    expect(branch).toContain('--help');
  });
});

describe('install.ps1 launcher never reads a .env from the current folder', () => {
  test('every bun run passes --no-env-file', async () => {
    const ps1 = await Bun.file(join(import.meta.dir, '../../install.ps1')).text();
    const runs = ps1.match(/^\s*bun (?:--no-env-file )?run .*$/gm) ?? [];
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r).toContain('--no-env-file');
  });
});
