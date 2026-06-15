export type { AgentBackend, RunStreamedOpts, BackendEvent } from './types.js';
export { ClaudeBackend } from './claude-backend.js';
export type { ClaudeBackendConfig } from './claude-backend.js';
export { CodexBackend } from './codex-backend.js';
export type { CodexBackendConfig } from './codex-backend.js';

import { ClaudeBackend, type ClaudeBackendConfig } from './claude-backend.js';
import { CodexBackend, type CodexBackendConfig } from './codex-backend.js';
import type { AgentBackend } from './types.js';

export type BackendConfig = ClaudeBackendConfig | CodexBackendConfig;

export function createBackend(backend: 'claude' | 'codex', config: BackendConfig): AgentBackend {
  if (backend === 'codex') {
    return new CodexBackend(config as CodexBackendConfig);
  }
  return new ClaudeBackend(config as ClaudeBackendConfig);
}

/**
 * Infer sandboxMode from task.kind when not explicitly set.
 * Research/analysis tasks get read-only; engineering/writing/design get workspace-write.
 */
export function inferSandboxMode(
  kind?: string | null,
): 'read-only' | 'workspace-write' {
  if (kind === 'research' || kind === 'analysis' || kind === 'observation') {
    return 'read-only';
  }
  return 'workspace-write';
}
