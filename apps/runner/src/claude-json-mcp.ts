import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { SECRET_FILE_MODE } from './secure-file';

/**
 * `buildd login`: put the new key into the buildd MCP entries that already
 * exist (the user-wide one if `--everywhere` made it, and the per-folder ones
 * `buildd install --global` wrote), and nothing else. It never adds a
 * user-wide entry, so logging in again keeps install's workspace-folder scope.
 * OAuth entries (no Authorization header) carry no key and are left alone.
 * Returns how many entries were re-keyed; 0 writes nothing.
 */
export function refreshBuilddMcpEntries(claudeJsonPath: string, apiKey: string, server: string): number {
  if (!existsSync(claudeJsonPath)) return 0;
  const config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as Record<string, any>;
  const isKeyEntry = (e: any) => typeof e?.url === 'string' && /\/api\/mcp(\?.*)?$/.test(e.url)
    && typeof e?.headers?.Authorization === 'string' && e.headers.Authorization.startsWith('Bearer ');
  const fresh = (e: any) => ({ ...e, url: `${server}/api/mcp${e.url.includes('?') ? e.url.slice(e.url.indexOf('?')) : ''}`, headers: { ...e.headers, Authorization: `Bearer ${apiKey}` } });
  let n = 0;
  if (isKeyEntry(config.mcpServers?.buildd)) { config.mcpServers.buildd = fresh(config.mcpServers.buildd); n++; }
  for (const project of Object.values(config.projects ?? {}) as any[]) {
    if (isKeyEntry(project?.mcpServers?.buildd)) { project.mcpServers.buildd = fresh(project.mcpServers.buildd); n++; }
  }
  if (n === 0) return 0;
  writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  chmodSync(claudeJsonPath, SECRET_FILE_MODE);
  return n;
}
