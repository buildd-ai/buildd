import { join } from 'path';

/** Returns the per-workspace isolated clone path: <isolationRoot>/<safe_workspaceId>/ */
export function isolatedWorkspacePath(workspaceId: string, isolationRoot: string): string {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(isolationRoot, safe);
}

/** Returns the per-workspace+worker isolated Codex home: <isolationRoot>/<workspaceId>/codex/<workerId>/ */
export function stableCodexHomeIsolatedPath(workspaceId: string, workerId: string, isolationRoot: string): string {
  const safeWs = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeWorker = workerId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(isolationRoot, safeWs, 'codex', safeWorker);
}

/** Returns the per-workspace+worker isolated Claude config dir: <isolationRoot>/<workspaceId>/claude/<workerId>/ */
export function isolatedClaudeConfigDirPath(workspaceId: string, workerId: string, isolationRoot: string): string {
  const safeWs = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeWorker = workerId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(isolationRoot, safeWs, 'claude', safeWorker);
}
