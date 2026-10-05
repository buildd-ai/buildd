import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { SECRET_FILE_MODE } from './secure-file';

/**
 * Add (or replace) the `buildd` MCP entry in a Claude Code config file
 * (`~/.claude.json`), for the human's own interactive Claude Code sessions.
 *
 * The entry carries the key itself: an interactive session has no
 * BUILDD_API_KEY in its env to expand. Runner agent sessions do not use it —
 * the runner passes its own `buildd` entry (the per-task token), which
 * shadows a same-named user entry.
 *
 * The file is chmod 0600 after the write, like every other credential file the
 * runner writes. Only the file: its directory is the user's home. No `mode` on
 * writeFileSync (see secure-file.ts for the Bun bug).
 */
export function writeBuilddMcpEntry(claudeJsonPath: string, apiKey: string, server: string): void {
  let config: Record<string, unknown> = {};
  if (existsSync(claudeJsonPath)) {
    config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  (config.mcpServers as Record<string, unknown>).buildd = {
    type: 'http',
    url: `${server}/api/mcp`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  chmodSync(claudeJsonPath, SECRET_FILE_MODE);
}
