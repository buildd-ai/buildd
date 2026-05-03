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
    const firstBunCallIndex = launcher.indexOf('bun run');
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
      if (pathSet && line.includes('bun run') && line.includes('index.ts')) {
        bunAfterPath = true;
        break;
      }
    }
    expect(bunAfterPath).toBe(true);
  });
});
