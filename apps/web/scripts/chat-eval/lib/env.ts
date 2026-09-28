/**
 * Paths, the buildd key, and the OAuth-only guard for the chat eval.
 *
 * Everything the harness writes lives under `.eval-data/chat-eval/` at the repo
 * root (gitignored): questions and transcripts are real workspace text, and
 * this repo is public.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir, '../../../../..');
export const DATA_DIR = process.env.CHAT_EVAL_DIR ?? join(REPO_ROOT, '.eval-data', 'chat-eval');

export function dataPath(...p: string[]): string {
  const full = join(DATA_DIR, ...p);
  mkdirSync(join(full, '..'), { recursive: true });
  return full;
}

export const BUILDD_MCP_URL = process.env.CHAT_EVAL_MCP_URL ?? 'https://buildd.dev/api/mcp';

/**
 * The buildd key the tools read with: `CHAT_EVAL_BUILDD_KEY`, else the bearer on
 * the `buildd` MCP server in ~/.claude.json (what this machine's Claude Code
 * uses). Not BUILDD_API_KEY: Bun auto-loads apps/web/.env, which sets one for
 * other purposes.
 * A buildd key is platform auth, not model spend. Never printed.
 */
export function builddKey(): { key: string; url: string } {
  if (process.env.CHAT_EVAL_BUILDD_KEY) return { key: process.env.CHAT_EVAL_BUILDD_KEY, url: BUILDD_MCP_URL };
  const cfgPath = join(homedir(), '.claude.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const srv = cfg.mcpServers?.buildd ?? cfg.projects?.[REPO_ROOT]?.mcpServers?.buildd;
    const auth: string | undefined = srv?.headers?.Authorization ?? srv?.headers?.authorization;
    if (auth?.startsWith('Bearer ')) return { key: auth.slice(7), url: process.env.CHAT_EVAL_MCP_URL ?? srv.url ?? BUILDD_MCP_URL };
  }
  throw new Error('No buildd key: set CHAT_EVAL_BUILDD_KEY or configure the buildd MCP server in ~/.claude.json');
}

/**
 * The environment for every `claude` child: no Anthropic API credentials, so
 * the CLI can only use this machine's OAuth login. `runClaude` also checks the
 * init message's apiKeySource and aborts on anything but 'none'.
 */
export function oauthOnlyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/.test(k) || k === 'CLAUDE_CODE_USE_BEDROCK' || k === 'CLAUDE_CODE_USE_VERTEX') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export const flag = (argv: string[], name: string) => argv.includes(`--${name}`);

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
}

/** Rough Claude token estimate for text we never send (≈3.6 chars/token on JSON + prose). */
export const estTokens = (s: string) => Math.ceil(s.length / 3.6);
