#!/usr/bin/env bun
/**
 * `buildd status`, `buildd logout` and `buildd init <workspace-id>`.
 *
 * Both launchers hand these here: install.sh's bash launcher and install.ps1's
 * buildd.cmd. They used to live inline in the bash launcher only, so on Windows
 * they fell through to the runner (index.ts), which rejects them with
 * "Unknown argument" although its help lists them.
 *
 * Run: bun launcher-commands.ts status | logout | init <workspace-id>
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { writeSecretJsonFile } from './secure-file';

const DEFAULT_SERVER = 'https://buildd.dev';
/** sysexits EX_USAGE, as cli-args.ts uses. Not imported: install.sh --client checks out only what this file loads. */
const EXIT_USAGE = 64;

export interface LauncherContext {
  home: string;
  cwd: string;
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
}

const configPath = (home: string) => join(home, '.buildd', 'config.json');

function readConfig(home: string): Record<string, unknown> | null {
  const file = configPath(home);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}

/** `buildd status`: whether this machine is signed in, with the key masked. */
export async function runStatus(ctx: LauncherContext, modelLogins?: () => string[]): Promise<number> {
  const config = readConfig(ctx.home);
  const key = typeof config?.apiKey === 'string' ? config.apiKey : '';
  if (key) {
    ctx.log('Status: logged in');
    ctx.log('API key: ' + key.slice(0, 10) + '...' + key.slice(-4));
    ctx.log('Server:  ' + (config?.builddServer || DEFAULT_SERVER));
  } else {
    ctx.log('Status: not logged in');
    ctx.log('Run "buildd login" to authenticate.');
  }
  // One line per agent backend, from the runner's detector. Absent in client mode, which has no runner.
  for (const line of modelLogins?.() ?? []) ctx.log(line);
  return 0;
}

/**
 * `buildd logout`: revoke the session presence token server-side (best effort),
 * then drop both credentials from the config and keep everything else.
 */
export async function runLogout(ctx: LauncherContext): Promise<number> {
  const file = configPath(ctx.home);
  const config = readConfig(ctx.home);
  if (!config) {
    ctx.log('Not logged in (no config file found)');
    return 0;
  }
  const token = config.presenceToken;
  if (typeof token === 'string' && token.startsWith('bldp_')) {
    const server = String(config.builddServer || DEFAULT_SERVER).replace(/\/+$/, '');
    await ctx.fetch(server + '/api/auth/presence-token', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
  delete config.apiKey;
  delete config.presenceToken;
  writeSecretJsonFile(file, config);
  ctx.log(`Logged out. API key and session presence token removed from ${file}`);
  return 0;
}

/** `buildd init <workspace-id>`: write .mcp.json for this repo, pointing at the workspace. */
export async function runInit(ctx: LauncherContext, workspaceId: string | undefined): Promise<number> {
  if (!existsSync(join(ctx.cwd, '.git'))) {
    ctx.error("Error: not in a git repository. Run 'buildd init' from a repo root.");
    return 1;
  }
  if (!workspaceId) {
    ctx.log('Usage: buildd init <workspace-id>');
    ctx.log('');
    ctx.log('Find your workspace ID in the buildd dashboard.');
    return 1;
  }
  const config = readConfig(ctx.home);
  const key = typeof config?.apiKey === 'string' ? config.apiKey : '';
  if (!key) {
    ctx.error("Error: not logged in. Run 'buildd login' first.");
    return 1;
  }
  const server = String(config?.builddServer || DEFAULT_SERVER);

  const mcp = {
    mcpServers: {
      buildd: {
        type: 'http',
        url: `${server}/api/mcp?workspace=${workspaceId}`,
        headers: { Authorization: `Bearer ${key}` },
      },
    },
  };
  writeFileSync(join(ctx.cwd, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');

  // .mcp.json carries the key: keep it out of git.
  const gitignore = join(ctx.cwd, '.gitignore');
  if (existsSync(gitignore)) {
    const text = readFileSync(gitignore, 'utf-8');
    if (!text.split(/\r?\n/).includes('.mcp.json')) {
      appendFileSync(gitignore, (text === '' || text.endsWith('\n') ? '' : '\n') + '.mcp.json\n');
      ctx.log('Added .mcp.json to .gitignore');
    }
  } else {
    writeFileSync(gitignore, '.mcp.json\n');
    ctx.log('Created .gitignore with .mcp.json');
  }

  // Claude Code only loads a project's .mcp.json once project MCP servers are allowed.
  // An explicit setting either way is the user's and is left alone.
  const settingsFile = join(ctx.home, '.claude', 'settings.json');
  if (existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
      if (!('enableAllProjectMcpServers' in settings)) {
        settings.enableAllProjectMcpServers = true;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
        ctx.log('Enabled project MCP servers in Claude Code settings');
      }
    } catch { /* unreadable settings: leave them to the user */ }
  } else {
    mkdirSync(join(ctx.home, '.claude'), { recursive: true });
    writeFileSync(settingsFile, '{ "enableAllProjectMcpServers": true }\n');
    ctx.log('Created Claude Code settings with project MCP servers enabled');
  }

  ctx.log(`Created .mcp.json for workspace ${workspaceId}`);
  ctx.log('Claude Code will now auto-detect the buildd MCP server in this repo.');
  return 0;
}

if (import.meta.main) {
  const [cmd, ...args] = Bun.argv.slice(2);
  const ctx: LauncherContext = {
    home: homedir(),
    cwd: process.cwd(),
    fetch,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
  let code: number;
  if (cmd === 'status') {
    // Not a static import: install.sh --client checks out only this file's imports, and a client has no runner.
    const reportPath = './model-login-report';
    const modelLogins = await import(reportPath).then(
      (m: { backendLoginLines: () => { text: string }[] }) => () => m.backendLoginLines().map((l) => l.text),
      () => undefined,
    );
    code = await runStatus(ctx, modelLogins);
  }
  else if (cmd === 'logout') code = await runLogout(ctx);
  else if (cmd === 'init') code = await runInit(ctx, args[0]);
  else {
    console.error(`Unknown command: ${cmd ?? '(none)'}. Usage: launcher-commands.ts status | logout | init <workspace-id>`);
    code = EXIT_USAGE;
  }
  process.exit(code);
}
