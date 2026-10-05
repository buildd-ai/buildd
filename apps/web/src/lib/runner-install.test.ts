/**
 * The runner install instruction is written once (lib/runner-install.ts) and
 * must say what the installer itself says. A fresh user followed three
 * different instructions on three screens (`buildd`, `buildd run`, and an MCP
 * call pasted into UI copy); this pins the one that works and keeps the
 * others from coming back.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RUNNER_INSTALL_COMMANDS, RUNNER_LOCAL_UI_URL } from './runner-install';

const REPO = join(import.meta.dir, '../../../..');
const installer = readFileSync(join(REPO, 'apps/runner/install.sh'), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('runner install instruction', () => {
  it('is the one-liner, a shell reload, then bare buildd', () => {
    expect([...RUNNER_INSTALL_COMMANDS]).toEqual([
      'curl -fsSL https://buildd.dev/install.sh | bash',
      'exec $SHELL',
      'buildd',
    ]);
  });

  it('ends where the installer says it ends', () => {
    // install.sh closes with "Run buildd to start:  buildd" and the local UI URL.
    expect(installer).toContain('echo "  buildd"');
    expect(installer).toContain(`open ${RUNNER_LOCAL_UI_URL}`);
  });

  it('points at the short URL the proxy serves', () => {
    const proxy = readFileSync(join(REPO, 'apps/web/src/proxy.ts'), 'utf8');
    expect(proxy).toContain('/install.sh');
  });

  it('no screen tells people to run a command that does not exist', () => {
    const offenders: string[] = [];
    // Screens, plus API error hints the screens print verbatim.
    for (const file of [...walk(join(REPO, 'apps/web/src/app')), ...walk(join(REPO, 'apps/web/src/components'))]) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(REPO, file);
      if (/\bbuildd run\b/.test(src)) offenders.push(`${rel}: buildd run`);
      if (src.includes('manage_workspaces action=update')) offenders.push(`${rel}: manage_workspaces action=update`);
      if (src.includes('raw.githubusercontent.com/buildd-ai/buildd/main/apps/runner/install.sh')) {
        offenders.push(`${rel}: long installer URL (use ${RUNNER_INSTALL_COMMANDS[0]})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
