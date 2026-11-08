/** The agent invocation, kept pure so a test can pin it: same prompt, budgets and context policy for every model. */
import type { RunPolicy } from '../../packages/core/local-eval';

export interface AgentInvocation { cmd: string; args: string[]; env: Record<string, string> }

/**
 * Claude Code against a local Ollama (Anthropic-compatible `/v1/messages`).
 * Follows docs/local-ollama-runner.md: a placeholder auth token so no real
 * credential reaches the server, tool search off, compaction at the declared
 * window, and a model override so Claude Code accepts the Ollama tag.
 * `configDir` is empty and per run, so the operator's own settings, memory and
 * login are not read.
 */
export function claudeInvocation(opts: { origin: string; tag: string; contextTokens: number; prompt: string; policy: Pick<RunPolicy, 'maxTurns'>; configDir: string; baseEnv: Record<string, string | undefined> }): AgentInvocation {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'BUN_INSTALL'];
  const env: Record<string, string> = {};
  for (const k of keep) { const v = opts.baseEnv[k]; if (v) env[k] = v; }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: opts.configDir,
    ANTHROPIC_BASE_URL: opts.origin,
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: opts.tag,
    ANTHROPIC_DEFAULT_SONNET_MODEL: opts.tag,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opts.tag,
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(opts.contextTokens),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  });
  return {
    cmd: 'claude',
    args: [
      '-p', opts.prompt,
      '--model', opts.tag,
      '--max-turns', String(opts.policy.maxTurns),
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash',
      '--settings', JSON.stringify({ modelOverrides: { 'claude-sonnet-4-6': opts.tag } }),
    ],
    env,
  };
}

export interface AgentUsage { inputTokens: number | null; outputTokens: number | null; turns: number | null }

/** Tolerant: any field the output does not state is null, never 0. */
export function parseClaudeJson(stdout: string): AgentUsage {
  const none: AgentUsage = { inputTokens: null, outputTokens: null, turns: null };
  let o: any;
  try { o = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { return none; }
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const u = o?.usage ?? {};
  const input = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(n);
  return {
    inputTokens: input.some((x) => x !== null) ? input.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
    outputTokens: n(u.output_tokens),
    turns: n(o?.num_turns),
  };
}
