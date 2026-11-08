/**
 * v2 agent adapters. `agent.ts` (v1) is left as it is; v2 has its own,
 * versioned harness treatment (`HARNESS_TREATMENT_V2`).
 *
 * - `claude-code`: Claude Code against a loopback Ollama (Anthropic-compatible
 *   `/v1/messages`), with the system prompt replaced, exactly six tools, no MCP
 *   servers and no settings sources, so the harness itself fits a 16K window.
 *   The prompt goes on stdin: a 32K-token evidence prompt is longer than one
 *   command-line argument may be.
 * - `fixture`: a deterministic stand-in that starts no model. It copies files
 *   an operator authored under `--fixture-dir <dir>/<caseId>/` into the agent
 *   tree. It exists to exercise the candidate -> hidden grading path end to end;
 *   its records are labelled `harness: fixture` and `ingest` refuses them.
 */
import { join, resolve } from 'node:path';
import { HARNESS_TREATMENT_V2 } from '../../packages/core/local-eval-v2-exec';
import type { ModelAdapter } from '../../packages/core/local-eval-v2';

export interface AgentInvocation { cmd: string; args: string[]; env: Record<string, string> }

export interface InvocationContext {
  prompt: string; caseId: string; maxTurns: number; toolCalling: boolean;
  /** Empty per-run Claude config dir, outside the agent tree. */
  configDir: string;
  /** Empty per-run home dir: the operator's ~/.claude, ~/.ssh and dotfiles are not reachable through HOME. */
  homeDir: string;
}

export interface AdapterV2 extends ModelAdapter {
  harness: 'claude-code' | 'fixture';
  /** False: no model is loaded and no GPU guard applies. */
  startsModel: boolean;
  invocation(ctx: InvocationContext): AgentInvocation;
}

/** Variables a subprocess needs to start at all, on Linux, macOS and Windows. Nothing that carries a credential. */
const KEEP_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'BUN_INSTALL'];

export function cleanEnv(base: Record<string, string | undefined>, homeDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of KEEP_ENV) { const v = base[k]; if (v) env[k] = v; }
  const home = homeDir ?? base.HOME ?? base.USERPROFILE;
  if (home) { env.HOME = home; if (process.platform === 'win32') { env.USERPROFILE = home; env.APPDATA = join(home, 'AppData', 'Roaming'); env.LOCALAPPDATA = join(home, 'AppData', 'Local'); } }
  return env;
}

/**
 * The Claude Code binary to start. `LOCAL_EVAL_CLAUDE_BIN` wins. On Windows a
 * bare `claude` usually resolves to `claude.cmd`, which cannot be started
 * without a shell (and a shell would re-split the system prompt), so an
 * explicit `.exe` is required there; a `.cmd` is refused with that reason.
 */
export function resolveClaudeBin(env: Record<string, string | undefined> = process.env, which: (c: string) => string | null = (c) => Bun.which(c)): { cmd: string | null; reason: string | null } {
  const explicit = env.LOCAL_EVAL_CLAUDE_BIN;
  const cmd = explicit || which('claude');
  if (!cmd) return { cmd: null, reason: 'claude not found on PATH (set LOCAL_EVAL_CLAUDE_BIN)' };
  if (/\.(cmd|bat)$/i.test(cmd)) return { cmd: null, reason: `${cmd} is a shell script; set LOCAL_EVAL_CLAUDE_BIN to the claude executable (claude.exe) so arguments reach it unchanged` };
  return { cmd, reason: null };
}

export function claudeInvocationV2(o: { origin: string; tag: string; contextTokens: number; maxTurns: number; configDir: string; homeDir: string; toolCalling: boolean; baseEnv: Record<string, string | undefined>; cmd?: string }): AgentInvocation {
  const t = HARNESS_TREATMENT_V2;
  const env = cleanEnv(o.baseEnv, o.homeDir);
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: o.configDir,
    ANTHROPIC_BASE_URL: o.origin,
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: o.tag,
    ANTHROPIC_DEFAULT_SONNET_MODEL: o.tag,
    ANTHROPIC_DEFAULT_OPUS_MODEL: o.tag,
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(o.contextTokens),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    MAX_THINKING_TOKENS: '0',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(t.maxOutputTokens),
  });
  const tools = o.toolCalling ? t.tools.join(',') : '';
  return {
    cmd: o.cmd ?? 'claude',
    args: [
      '-p',
      '--model', o.tag,
      '--max-turns', String(o.maxTurns),
      '--system-prompt', t.systemPrompt,
      '--tools', tools,
      ...(o.toolCalling ? ['--allowedTools', tools] : []),
      ...t.flags,
      '--settings', JSON.stringify({ modelOverrides: { 'claude-sonnet-4-6': o.tag } }),
    ],
    env,
  };
}

export function claudeAdapter(o: { origin: string; tag: string; contextTokens: number; toolCalling: boolean; systemPrompt: boolean; structuredOutput: boolean; baseEnv: Record<string, string | undefined>; cmd?: string }): AdapterV2 {
  return {
    id: `claude-code:${o.tag}`, harness: 'claude-code', startsModel: true,
    capabilities: { toolCalling: o.toolCalling, systemPrompt: o.systemPrompt, structuredOutput: o.structuredOutput, contextTokens: o.contextTokens },
    invocation: (c) => claudeInvocationV2({ origin: o.origin, tag: o.tag, contextTokens: o.contextTokens, maxTurns: c.maxTurns, configDir: c.configDir, homeDir: c.homeDir, toolCalling: c.toolCalling, baseEnv: o.baseEnv, cmd: o.cmd }),
  };
}

export const FIXTURE_AGENT = resolve(import.meta.dir, 'fixture-agent.ts');

export function fixtureAdapter(o: { fixtureDir: string; contextTokens: number; toolCalling: boolean; baseEnv: Record<string, string | undefined> }): AdapterV2 {
  return {
    id: `fixture:${o.fixtureDir}`, harness: 'fixture', startsModel: false,
    capabilities: { toolCalling: o.toolCalling, systemPrompt: true, structuredOutput: true, contextTokens: o.contextTokens },
    invocation: (c) => ({
      cmd: process.execPath,
      args: ['run', FIXTURE_AGENT],
      env: { ...cleanEnv(o.baseEnv, c.homeDir), FIXTURE_DIR: join(resolve(o.fixtureDir), c.caseId), FIXTURE_MAX_TURNS: String(c.maxTurns) },
    }),
  };
}
