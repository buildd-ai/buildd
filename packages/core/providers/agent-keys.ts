/**
 * The team's API key for an agent backend, wherever it is stored.
 *
 * An Anthropic key (Claude runs) and an OpenAI key (Codex runs) each have one
 * canonical storage, `inference_key` with the provider's label, which chat
 * reads too; and a legacy alias (`anthropic_api_key`, `openai_api_key`) that
 * agent runs have always read. Both are read until the legacy rows are
 * consolidated, and within one scope the canonical row wins. A more specific
 * scope still beats a broader one whichever storage either sits in, exactly as
 * before.
 *
 * Every list here derives from the provider registry's `api_key` shape, so a
 * storage added there is read by every agent reader with no change here.
 *
 * Pure: registry imports only. The pick (`pickTeamAgentApiKey`) is in
 * ../secrets/team-scope, beside the precedence rule it extends.
 */
import { providerDescriptor, type CredentialStorage, type ModelCredentialPurpose } from './registry';

/** Providers whose API key an agent backend runs on: Claude Code on Anthropic, the Codex CLI on OpenAI. */
export type AgentKeyProvider = 'anthropic' | 'openai';

/** The provider's `api_key` storages, canonical first, then its legacy aliases. */
export function agentKeyStorages(provider: AgentKeyProvider): readonly CredentialStorage[] {
  const shape = providerDescriptor(provider).shapes.find(s => s.id === 'api_key');
  return shape ? [shape.storage, ...shape.legacy] : [];
}

/** `secrets.purpose` values that may hold the provider's agent key, canonical first. */
export function agentKeyPurposes(provider: AgentKeyProvider): ModelCredentialPurpose[] {
  return [...new Set(agentKeyStorages(provider).map(s => s.purpose))];
}

/**
 * Which of the provider's storages a row is in: 0 canonical, 1+ a legacy
 * alias, -1 not this provider's key at all (another provider's `inference_key`,
 * a seat, an MCP secret).
 */
export function agentKeyStorageIndex(row: { purpose: string; label?: string | null }, provider: AgentKeyProvider): number {
  const label = (row.label ?? '').toLowerCase();
  return agentKeyStorages(provider).findIndex(s =>
    s.purpose === row.purpose && (s.label === undefined || s.label === label));
}

export function isAgentKeyRow(row: { purpose: string; label?: string | null }, provider: AgentKeyProvider): boolean {
  return agentKeyStorageIndex(row, provider) >= 0;
}
