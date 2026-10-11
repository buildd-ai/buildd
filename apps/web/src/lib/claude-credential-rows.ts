/**
 * Which stored rows are a team's Claude credential: the seat token
 * (`oauth_token`), and the Anthropic API key in either storage agent runs read
 * (canonical `inference_key` + label `anthropic`, legacy `anthropic_api_key`).
 * Shared by the status surfaces (Health credential rows, auth-failure
 * attribution, the liveness ping) so each sees the rows agent runs use.
 *
 * Pure: no DB. `inference_key` also holds other providers' keys and personal
 * keys, so a read by purpose is narrowed with `isTeamClaudeCredential`.
 */
import { agentKeyPurposes, agentKeyStorageIndex } from '@buildd/core/providers/agent-keys';

export const CLAUDE_CREDENTIAL_PURPOSES = ['oauth_token', ...agentKeyPurposes('anthropic')] as const;

/** Is this row a team Claude credential (seat token, or Anthropic API key in either storage)? */
export function isTeamClaudeCredential(row: { purpose: string; label?: string | null; userId?: string | null }): boolean {
  if (row.userId) return false;
  return row.purpose === 'oauth_token' || agentKeyStorageIndex(row, 'anthropic') >= 0;
}

/** 0 seat token, then the Anthropic key's storages canonical first; -1 not a Claude credential. */
export function claudeCredentialRank(row: { purpose: string; label?: string | null; userId?: string | null }): number {
  if (!isTeamClaudeCredential(row)) return -1;
  return row.purpose === 'oauth_token' ? 0 : 1 + agentKeyStorageIndex(row, 'anthropic');
}

/** A row the Health page lists as a backend credential: a team Claude credential, or a Codex credential. */
export function isBackendHealthRow(row: { purpose: string; label?: string | null; userId?: string | null }): boolean {
  return row.purpose === 'codex_credential' || isTeamClaudeCredential(row);
}

/** How the status surfaces name a backend credential row. */
export function backendCredentialLabel(purpose: string): string {
  if (purpose === 'oauth_token') return 'Claude OAuth token';
  // `inference_key` reaches a status surface only as the team Anthropic key (isBackendHealthRow).
  if (purpose === 'anthropic_api_key' || purpose === 'inference_key') return 'Anthropic API key';
  if (purpose === 'codex_credential') return 'Codex credential';
  return purpose;
}
