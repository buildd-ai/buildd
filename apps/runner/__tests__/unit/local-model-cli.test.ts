/**
 * The bundled Claude Code and Codex CLIs, run as a local-model worker runs
 * them, against an in-process fake of the local model server (Anthropic
 * /v1/messages + OpenAI /v1/responses).
 *
 * Regression for the local Ollama smoke run: Claude Code flagged the Ollama
 * tag `[claude-code:unrecognized_model]` (first during title generation) and
 * the runner reported that as the session's death; Codex emitted "Model
 * metadata ... not found" as an `error` item before the first turn, which the
 * Codex backend treats as the end of the session.
 *
 * Both binaries are optional, per-platform dependencies: a test whose binary is
 * not installed on this machine is skipped, not failed. Skipped on Windows,
 * where these spawn-and-clean-up tests are a known source of EBUSY flakes and
 * the Codex sandbox path differs; the config they check is the same there.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { applyModelEnv } from '../../src/agent-model-env';
import { writeCodexMcpConfig } from '../../src/codex-auth';
import { claudeLocalModelSettings, resolveLocalModelEndpoint, LOCAL_CODEX_CATALOG_FILE } from '../../src/local-model-endpoint';
import { CodexBackend } from '../../src/backends/codex-backend';

const MODEL = 'mistral-nemo:buildd-local';

interface Seen { path: string; model?: string; tools: string[]; toolTypes: string[]; auth: string | null; json: boolean }

/** Directory of a package's package.json, resolved from `fromDir`; null when absent. */
function pkgDir(spec: string, fromDir: string): string | null {
  try { return dirname(Bun.resolveSync(`${spec}/package.json`, fromDir)); } catch { return null; }
}

/** The platform's Claude Code binary, the way the agent SDK finds it. */
function claudeBinaryInstalled(): boolean {
  const sdk = pkgDir('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  if (!sdk) return false;
  const arch = process.arch;
  return [`linux-${arch}`, `linux-${arch}-musl`, `darwin-${arch}`].some((suffix) => {
    const dir = pkgDir(`@anthropic-ai/claude-agent-sdk-${suffix}`, sdk);
    return !!dir && existsSync(join(dir, 'claude'));
  });
}

/** The platform's Codex binary, the way @openai/codex-sdk finds it. */
function codexBinaryInstalled(): boolean {
  const sdk = pkgDir('@openai/codex-sdk', import.meta.dir);
  const cli = sdk && pkgDir('@openai/codex', sdk);
  if (!cli) return false;
  const platform = pkgDir(`@openai/codex-${process.platform}-${process.arch}`, cli);
  return !!platform && existsSync(join(platform, 'vendor'));
}

const onWindows = process.platform === 'win32';
const canClaude = !onWindows && claudeBinaryInstalled();
const canCodex = !onWindows && codexBinaryInstalled();

let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Seen[] = [];
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'local-model-cli-'));
  const sse = (ev: string, d: unknown) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body: any = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
      seen.push({
        path: url.pathname,
        model: body.model,
        tools: tools.map((t) => t.name ?? t.type),
        toolTypes: tools.map((t) => t.type ?? 'custom'),
        auth: req.headers.get('authorization'),
        json: !!(body.output_config?.format || body.output_format),
      });
      // One answer for every request: valid JSON, so a structured-output
      // call (the session title) parses too.
      const text = '{"title":"Local title"}';
      if (url.pathname.endsWith('/messages')) {
        if (!body.stream) {
          return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } });
        }
        return new Response([
          sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
          sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
          sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
          sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
          sse('message_stop', { type: 'message_stop' }),
        ].join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.pathname.endsWith('/responses')) {
        const item = { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
        return new Response([
          sse('response.created', { type: 'response.created', response: { id: 'r1' } }),
          sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }),
          sse('response.completed', { type: 'response.completed', response: { id: 'r1', output: [item], usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 6 } } }),
        ].join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function localEndpoint(ctx = '65536') {
  return resolveLocalModelEndpoint({ BUILDD_LOCAL_MODEL_URL: `http://127.0.0.1:${server!.port}`, BUILDD_LOCAL_MODEL: MODEL, BUILDD_LOCAL_MODEL_CONTEXT: ctx })!;
}

describe('Claude Code on a local model', () => {
  test.skipIf(!canClaude)('starts and generates a session title with no unrecognized_model, tools sent to the local endpoint', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const local = localEndpoint();
    const home = mkdtempSync(join(root, 'home-'));
    const cwd = mkdtempSync(join(root, 'cwd-'));
    // What the runner hands the agent: a machine with a real key and seat,
    // replaced by the local route.
    const { env } = applyModelEnv(
      { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_API_KEY: 'sk-real', CLAUDE_CODE_OAUTH_TOKEN: 'seat' },
      { isCodexTask: false, localModel: local, serverApiKey: 'server-key' },
    );
    let stderr = '';
    seen = [];
    const q = query({
      prompt: 'say hi',
      options: {
        model: local.model,
        cwd,
        env,
        settingSources: [],
        settings: { ...claudeLocalModelSettings(local) },
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        stderr: (s: string) => { stderr += s; },
      },
    });
    let result: any;
    let title: string | undefined;
    for await (const m of q as AsyncIterable<any>) {
      if (m.type === 'system' && m.subtype === 'init') {
        // The smoke run's first unrecognized_model came from title generation.
        title = await (q as any).generateSessionTitle('Fix the failing date parsing tests in the billing module');
      }
      if (m.type === 'result') result = m;
    }

    expect(stderr).not.toContain('unrecognized_model');
    expect(result?.subtype).toBe('success');
    expect(title).toBe('Local title');

    const messages = seen.filter((s) => s.path.endsWith('/v1/messages'));
    expect(messages.length).toBeGreaterThanOrEqual(2);
    // The Ollama tag, not the reference model, goes over the wire, with the
    // placeholder token and no real credential.
    for (const s of messages) {
      expect(s.model).toBe(MODEL);
      expect(s.auth).toBe('Bearer ollama');
    }
    expect(messages.some((s) => s.json)).toBe(true);
    // Tools are sent whole: no deferred loading a local model cannot follow.
    const main = messages.find((s) => s.tools.includes('Bash'));
    expect(main).toBeDefined();
    expect(main!.tools).not.toContain('ToolSearch');
  }, 90_000);

  test.skipIf(!canClaude)('without the override the same CLI does flag the tag (the check is live)', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const local = localEndpoint();
    const home = mkdtempSync(join(root, 'home-'));
    const { env } = applyModelEnv(
      { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      { isCodexTask: false, localModel: local },
    );
    let stderr = '';
    const q = query({ prompt: 'say hi', options: { model: local.model, cwd: mkdtempSync(join(root, 'cwd-')), env, settingSources: [], maxTurns: 1, permissionMode: 'bypassPermissions', stderr: (s: string) => { stderr += s; } } });
    for await (const _ of q as AsyncIterable<unknown>) { /* drain */ }
    expect(stderr).toContain('[claude-code:unrecognized_model]');
  }, 90_000);
});

describe('Codex on a local model', () => {
  test.skipIf(!canCodex)('runs a turn on the local provider with catalog metadata: no fallback-metadata error, tools sent', async () => {
    const local = localEndpoint();
    const codexHome = mkdtempSync(join(root, 'codex-'));
    const cwd = mkdtempSync(join(root, 'cwd-'));
    writeCodexMcpConfig(codexHome, {
      builddServer: `http://127.0.0.1:${server!.port}`,
      workspaceId: 'w',
      workerId: 'k',
      bearerTokenEnvVar: 'BUILDD_MCP_BEARER_TOKEN',
      localModel: local,
    });
    const catalog = JSON.parse(readFileSync(join(codexHome, LOCAL_CODEX_CATALOG_FILE), 'utf-8'));
    expect(catalog.models[0]).toMatchObject({ slug: MODEL, context_window: 65536 });

    const { env } = applyModelEnv(
      { PATH: process.env.PATH ?? '', HOME: codexHome, OPENAI_API_KEY: 'sk-real-openai', OPENAI_BASE_URL: 'https://api.openai.com/v1', BUILDD_MCP_BEARER_TOKEN: 'x' },
      { isCodexTask: true, localModel: local },
    );
    seen = [];
    const events: any[] = [];
    const progress: any[] = [];
    for await (const ev of new CodexBackend({ codexHome }).runStreamed({
      prompt: 'say hi',
      sessionId: 's',
      cwd,
      model: local.model,
      env: { ...env, CODEX_HOME: codexHome },
      sandboxMode: 'workspace-write',
      onProgress: (m) => { progress.push(m); },
    })) {
      events.push(ev);
    }

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toEqual([]);
    expect(JSON.stringify(progress)).not.toContain('fallback metadata');
    expect(events.some((e) => e.type === 'complete')).toBe(true);

    const responses = seen.filter((s) => s.path === '/v1/responses');
    expect(responses.length).toBeGreaterThanOrEqual(1);
    expect(responses[0].model).toBe(MODEL);
    // The placeholder key, never the machine's real OpenAI key.
    expect(responses[0].auth === null || responses[0].auth === 'Bearer ollama').toBe(true);
    // A shell tool as a plain function tool; no hosted web search.
    expect(responses[0].tools).toContain('exec_command');
    expect(responses[0].toolTypes).not.toContain('web_search');
  }, 90_000);
});
