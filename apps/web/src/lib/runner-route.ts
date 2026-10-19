/**
 * The effective route a runner reports for model access (credential type, never
 * the credential). One of three independent dimensions Health shows apart:
 * runner owner type (runner-ownership.ts), the accountable task/session
 * principal (per-slot `mine`), and this. A route says nothing about who owns
 * the runner or whose work it runs.
 */
export type ClaudeAuthSource = 'machine_token' | 'machine_login' | 'api_key' | 'none';
export type CodexAuthSource = 'machine_login' | 'api_key' | 'none';

export interface RunnerRoute {
  claude: string;
  codex: string;
}

const CLAUDE: Record<ClaudeAuthSource, string> = {
  machine_token: 'local plan token',
  machine_login: 'local plan login',
  api_key: 'API key',
  none: 'no login',
};
const CODEX: Record<CodexAuthSource, string> = {
  machine_login: 'local plan login',
  api_key: 'API key',
  none: 'no login',
};

/** A source the runner never reported is "not reported", not "no login". */
export function describeRunnerRoute(src: {
  modelAuthSource?: ClaudeAuthSource | null;
  codexAuthSource?: CodexAuthSource | null;
}): RunnerRoute {
  return {
    claude: (src.modelAuthSource && CLAUDE[src.modelAuthSource]) || 'not reported',
    codex: (src.codexAuthSource && CODEX[src.codexAuthSource]) || 'not reported',
  };
}
