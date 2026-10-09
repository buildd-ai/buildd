/**
 * A failed task whose agent could not sign in to its model provider, said in
 * plain words with a link to the setting that fixes it.
 *
 * The raw text is whatever the agent CLI printed (the Claude CLI's terminal
 * hint "Not logged in · Please run /login", a 401, an expired OAuth token). A
 * web user cannot run /login, so the task page shows this instead and keeps the
 * raw text behind "Show raw output".
 *
 * Recognition is the shared auth classifier (@buildd/core/auth-error-classifier),
 * the same list the runner's claim breaker and credential health use, so a
 * phrase added there is explained here too. Pure.
 */
import { classifyAuthErrorSeverity } from '@buildd/core/auth-error-classifier';

/**
 * Settings → Models → Runner sign-ins, opened on the model key field (the Claude
 * row's API key input; AgentBackendsSection opens and focuses it for this hash).
 */
export const AGENT_CREDENTIAL_HREF = '/app/settings/models#agent-key';

/** Settings → Models → Runner sign-ins, where the Codex sign-in and OpenAI key rows are. */
export const CODEX_CREDENTIAL_HREF = '/app/settings/models#sign-ins';

export interface ProviderAuthFailure {
  /** One plain sentence: what went wrong and what to do. */
  message: string;
  href: string;
  linkLabel: string;
}

export function explainProviderAuthFailure(
  error: string | null | undefined,
  backend: 'claude' | 'codex' | null,
): ProviderAuthFailure | null {
  const text = error?.trim();
  if (!text) return null;
  const severity = classifyAuthErrorSeverity(text);
  if (severity === 'none') return null;

  if (backend === 'codex') {
    return {
      message: severity === 'revoked'
        ? 'Codex sign-in was revoked. Sign in to Codex again or add an OpenAI API key, then retry.'
        : 'The agent could not sign in to Codex. Sign in to Codex or add an OpenAI API key, then retry.',
      href: CODEX_CREDENTIAL_HREF,
      linkLabel: 'Set up Codex',
    };
  }
  return {
    message: severity === 'revoked'
      ? 'The agent\'s model key was revoked. Add a new key (Anthropic, OpenRouter or a LiteLLM gateway), then retry.'
      : 'The agent has no working model key. Add your own (Anthropic, OpenRouter or a LiteLLM gateway), then retry.',
    href: AGENT_CREDENTIAL_HREF,
    linkLabel: 'Add an agent key',
  };
}

/**
 * A worker's stored error as one Worker history row shows it: the plain
 * sentence for a provider sign-in failure (the raw CLI text stays available on
 * hover), anything else unchanged.
 */
export function plainWorkerError(
  error: string | null | undefined,
  backend: 'claude' | 'codex' | null,
): { text: string; raw: string; plain: boolean } | null {
  const raw = error?.trim();
  if (!raw) return null;
  const auth = explainProviderAuthFailure(raw, backend);
  return auth ? { text: auth.message, raw, plain: true } : { text: raw, raw, plain: false };
}
