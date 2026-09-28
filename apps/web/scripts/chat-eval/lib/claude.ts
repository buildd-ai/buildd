/**
 * One `claude -p` run on this machine's OAuth login, parsed from stream-json.
 *
 * OAuth only: the child env has no Anthropic API credentials (oauthOnlyEnv),
 * and a run whose init message reports any apiKeySource but 'none' throws
 * before its numbers are used. Cost the CLI reports is virtual on OAuth.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oauthOnlyEnv } from './env';

export interface StepUsage { input: number; cacheWrite: number; cacheRead: number; output: number }
export interface ToolUse { id: string; name: string; input: Record<string, unknown>; resultChars?: number; isError?: boolean }

export interface ClaudeRun {
  ok: boolean;
  error?: string;
  model: string;
  answer: string;
  steps: StepUsage[];
  toolUses: ToolUse[];
  /** Σ over steps of everything the model read (fresh + cache). */
  totalInput: number;
  totalOutput: number;
  /** First step's full prompt: system + tools + messages before any tool output. */
  firstStepInput: number;
  numTurns: number;
  durationMs: number;
  virtualCostUsd: number;
}

/** A run cwd outside the repo, so no CLAUDE.md or project memory is discovered. */
function runDir(): string {
  const base = join(tmpdir(), 'buildd-chat-eval');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'run-'));
}

export async function runClaude(opts: {
  prompt: string;
  systemPrompt: string;
  model: string;
  /** mcpServers entry for the eval proxy; absent = no tools at all. */
  mcpServer?: { command: string; args: string[]; env: Record<string, string> };
  maxTurns?: number;
  timeoutMs?: number;
}): Promise<ClaudeRun> {
  const cwd = runDir();
  const args = [
    '-p', opts.prompt,
    '--model', opts.model,
    '--system-prompt', opts.systemPrompt,
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(opts.maxTurns ?? 8),
  ];
  if (opts.mcpServer) {
    const cfg = join(cwd, 'mcp.json');
    writeFileSync(cfg, JSON.stringify({ mcpServers: { eval: { type: 'stdio', ...opts.mcpServer } } }));
    args.push('--mcp-config', cfg, '--allowedTools', 'mcp__eval');
  }

  const started = Date.now();
  const proc = Bun.spawn(['claude', ...args], { cwd, env: oauthOnlyEnv(), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 240_000);
  const out = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  clearTimeout(timer);

  const run: ClaudeRun = {
    ok: false, model: opts.model, answer: '', steps: [], toolUses: [], totalInput: 0, totalOutput: 0,
    firstStepInput: 0, numTurns: 0, durationMs: Date.now() - started, virtualCostUsd: 0,
  };
  const seen = new Map<string, StepUsage>();
  const uses = new Map<string, ToolUse>();
  let apiKeySource: string | undefined;
  let resultOutput: number | undefined;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      apiKeySource = ev.apiKeySource;
      run.model = ev.model ?? run.model;
    } else if (ev.type === 'assistant') {
      const m = ev.message;
      const u = m.usage ?? {};
      // One API call streams as several events sharing a message id.
      const prev = seen.get(m.id);
      seen.set(m.id, {
        input: Math.max(prev?.input ?? 0, u.input_tokens ?? 0),
        cacheWrite: Math.max(prev?.cacheWrite ?? 0, u.cache_creation_input_tokens ?? 0),
        cacheRead: Math.max(prev?.cacheRead ?? 0, u.cache_read_input_tokens ?? 0),
        output: Math.max(prev?.output ?? 0, u.output_tokens ?? 0),
      });
      for (const c of m.content ?? []) {
        if (c.type === 'tool_use') uses.set(c.id, { id: c.id, name: String(c.name).replace(/^mcp__eval__/, ''), input: c.input ?? {} });
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const u = uses.get(c.tool_use_id);
        if (!u) continue;
        const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x.text ?? '').join('');
        u.resultChars = text.length;
        u.isError = c.is_error === true;
      }
    } else if (ev.type === 'result') {
      run.answer = ev.result ?? '';
      run.numTurns = ev.num_turns ?? 0;
      run.virtualCostUsd = ev.total_cost_usd ?? 0;
      resultOutput = ev.usage?.output_tokens;
      run.ok = ev.subtype === 'success' && !ev.is_error;
      if (!run.ok) run.error = ev.subtype ?? 'error';
    }
  }
  if (apiKeySource !== 'none') {
    throw new Error(`claude reported apiKeySource=${apiKeySource ?? 'unknown'}; refusing (this eval is OAuth-only). stderr: ${stderr.slice(0, 300)}`);
  }
  run.steps = [...seen.values()];
  run.toolUses = [...uses.values()];
  run.totalInput = run.steps.reduce((s, x) => s + x.input + x.cacheWrite + x.cacheRead, 0);
  run.totalOutput = Math.max(resultOutput ?? 0, run.steps.reduce((s, x) => s + x.output, 0));
  const first = run.steps[0];
  run.firstStepInput = first ? first.input + first.cacheWrite + first.cacheRead : 0;
  if (!run.ok && !run.error) run.error = stderr.slice(0, 300) || 'no result event';
  return run;
}
