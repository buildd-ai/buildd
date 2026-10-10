/**
 * The cost basis a runner reports with usage (docs/specs/real-and-virtual-cost.md):
 * `real` when the agent's model calls were charged per token, `virtual` when
 * they drew on a subscription login, `unknown` when nothing determines it.
 * Derived from the credential the runner actually gave the agent, never from
 * the account. The server combines reports into `mixed` itself.
 *
 * Pure: no I/O. The caller reads auth.json and the env.
 */
import type { ModelEnvResult } from './agent-model-env';

export type RunnerCostBasis = 'real' | 'virtual' | 'unknown';

/**
 * Set on a cloud run's container by its supervisor (apps/cloud-runner): the
 * model route the run's egress takes, `owner_seat` or `metered`. The container
 * itself only ever holds a placeholder key, so its env cannot tell.
 */
export const CLOUD_MODEL_AUTH_ENV = 'BUILDD_CLOUD_MODEL_AUTH';

const CLOUD_PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const;

const set = (v: string | undefined) => typeof v === 'string' && v.length > 0;

/**
 * A Claude run. Precedence mirrors Claude Code's own: an API key or auth token
 * in the env beats a subscription token, so it decides first.
 */
export function claudeCostBasis(
  modelEnv: Pick<ModelEnvResult, 'env' | 'endpoint' | 'hostSeatUsed'>,
  opts: { claudeCredentialUsed: boolean },
): RunnerCostBasis {
  const env = modelEnv.env;
  // A team endpoint or a per-machine provider is per-token traffic.
  if (modelEnv.endpoint === 'team' || modelEnv.endpoint === 'custom') return 'real';
  if (CLOUD_PROVIDER_SWITCHES.some(k => set(env[k]) && env[k] !== '0')) return 'real';
  if (set(env.ANTHROPIC_AUTH_TOKEN) || set(env.ANTHROPIC_API_KEY)) return 'real';
  if (set(env.CLAUDE_CODE_OAUTH_TOKEN) || modelEnv.hostSeatUsed || opts.claudeCredentialUsed) return 'virtual';
  return 'unknown';
}

/** A Codex run, in the order the Codex backend resolves auth (codex-backend.ts `resolveAuth`). */
export function codexCostBasis(input: {
  teamEndpoint: boolean;
  /** Parsed `$CODEX_HOME/auth.json`, or null when there is none. */
  authJson: Record<string, unknown> | null;
  envApiKey?: string;
}): RunnerCostBasis {
  if (input.teamEndpoint) return 'real';
  const auth = input.authJson;
  if (auth) {
    const tokens = (auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : auth) as Record<string, unknown>;
    if (set(tokens.api_key as string) || set(tokens.apiKey as string)) return 'real';
    if (set(tokens.access_token as string)) return 'virtual';
    if (set(auth.api_key as string) || set(auth.apiKey as string) || set(auth.OPENAI_API_KEY as string)) return 'real';
  }
  if (set(input.envApiKey)) return 'real';
  return 'unknown';
}

/** The cloud runner's run-report `modelAuth`, as a basis. */
export function costBasisForModelAuth(modelAuth: 'owner_seat' | 'metered'): RunnerCostBasis {
  return modelAuth === 'owner_seat' ? 'virtual' : 'real';
}

/** A cloud run's basis from its supervisor's hint; null when this is not a cloud verdict. */
export function cloudCostBasis(env: Record<string, string | undefined>): RunnerCostBasis | null {
  const v = env[CLOUD_MODEL_AUTH_ENV];
  return v === 'owner_seat' || v === 'metered' ? costBasisForModelAuth(v) : null;
}
