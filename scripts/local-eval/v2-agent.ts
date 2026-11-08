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

export interface InvocationContext { prompt: string; caseId: string; configDir: string; maxTurns: number; toolCalling: boolean }

export interface AdapterV2 extends ModelAdapter {
  harness: 'claude-code' | 'fixture';
  /** False: no model is loaded and no GPU guard applies. */
  startsModel: boolean;
  invocation(ctx: InvocationContext): AgentInvocation;
}

const KEEP_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'BUN_INSTALL', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];

function cleanEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of KEEP_ENV) { const v = base[k]; if (v) env[k] = v; }
  return env;
}

export function claudeInvocationV2(o: { origin: string; tag: string; contextTokens: number; maxTurns: number; configDir: string; toolCalling: boolean; baseEnv: Record<string, string | undefined>; cmd?: string }): AgentInvocation {
  const t = HARNESS_TREATMENT_V2;
  const env = cleanEnv(o.baseEnv);
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
    invocation: (c) => claudeInvocationV2({ origin: o.origin, tag: o.tag, contextTokens: o.contextTokens, maxTurns: c.maxTurns, configDir: c.configDir, toolCalling: c.toolCalling, baseEnv: o.baseEnv, cmd: o.cmd }),
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
      env: { ...cleanEnv(o.baseEnv), FIXTURE_DIR: join(resolve(o.fixtureDir), c.caseId), FIXTURE_MAX_TURNS: String(c.maxTurns) },
    }),
  };
}
