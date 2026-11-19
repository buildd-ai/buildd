/**
 * Local model server detection and inference client
 * (docs/specs/local-runner-provider.md §6.1, §6.2, M9): a fake Ollama and a
 * fake OpenAI-compatible server on loopback, as local-model-cli.test.ts does.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { parseLocalModelsAdvert } from '@buildd/shared';
import { LocalModelError, LocalModelServer, resolveLocalModelServer, DEFAULT_LOCAL_MODEL_SERVER_URL } from '../../src/local-model-server';

type Handler = (req: Request, url: URL) => Response | Promise<Response>;
const servers: Array<{ stop: (force?: boolean) => void }> = [];

function serve(handler: Handler): { origin: string; calls: string[] } {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);
      return handler(req, url);
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, calls };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake Ollama with one embedding model and one chat model. */
function fakeOllama(overrides: Partial<Record<string, Handler>> = {}) {
  return serve(async (req, url) => {
    const override = overrides[url.pathname];
    if (override) return override(req, url);
    if (url.pathname === '/api/version') return json({ version: '0.12.3' });
    if (url.pathname === '/api/tags') {
      return json({ models: [
        { name: 'nomic-embed-text:latest', digest: 'aaa', details: { family: 'nomic-bert', parameter_size: '137M' } },
        { name: 'llama3.2:3b', digest: 'bbb', details: { family: 'llama', parameter_size: '3.2B' } },
      ] });
    }
    if (url.pathname === '/api/show') {
      const { model } = await req.json() as { model: string };
      if (model.startsWith('nomic')) {
        return json({ capabilities: ['embedding'], details: { family: 'nomic-bert', parameter_size: '137M' },
          model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.embedding_length': 768, 'nomic-bert.context_length': 2048 } });
      }
      return json({ capabilities: ['completion', 'tools'], details: { family: 'llama', parameter_size: '3.2B' },
        model_info: { 'general.architecture': 'llama', 'llama.embedding_length': 3072, 'llama.context_length': 131072 } });
    }
    return json({ error: 'not found' }, 404);
  });
}

describe('resolveLocalModelServer', () => {
  it('defaults to loopback Ollama and takes a configured loopback URL', () => {
    expect(resolveLocalModelServer({})).toEqual({ origin: DEFAULT_LOCAL_MODEL_SERVER_URL });
    expect(resolveLocalModelServer({ BUILDD_LOCAL_MODEL_URL: 'http://localhost:1234/v1' })).toEqual({ origin: 'http://localhost:1234' });
  });

  it('is off when opted out, and for a URL that is not loopback', () => {
    expect(resolveLocalModelServer({ BUILDD_LOCAL_MODEL_RELAY: '0' })).toBeNull();
    expect(resolveLocalModelServer({ BUILDD_LOCAL_MODEL_URL: 'http://models.example.com:11434' })).toBeNull();
    expect(resolveLocalModelServer({ BUILDD_LOCAL_MODEL_URL: 'not a url' })).toBeNull();
  });
});

describe('LocalModelServer.probe', () => {
  it('lists an Ollama server\'s models with capabilities and sizes, and no URL anywhere (AC-19)', async () => {
    const { origin } = fakeOllama();
    const server = new LocalModelServer({ origin });
    expect(await server.probe()).toBe(true);
    const advert = server.advert()!;
    expect(advert.server).toMatchObject({ kind: 'ollama', version: '0.12.3', reachable: true });
    expect(advert.models).toEqual([
      { name: 'nomic-embed-text:latest', family: 'nomic-bert', parameterSize: '137M', capabilities: ['embedding'], dimensions: 768, contextLength: 2048 },
      { name: 'llama3.2:3b', family: 'llama', parameterSize: '3.2B', capabilities: ['completion'], dimensions: null, contextLength: 131072 },
    ]);
    expect(JSON.stringify(advert)).not.toContain('://');
    expect(JSON.stringify(advert)).not.toContain('127.0.0.1');
    // The server's strict parser keeps all of it.
    expect(parseLocalModelsAdvert(advert)).toEqual(advert);
    expect(server.modelNames()).toEqual(['nomic-embed-text:latest', 'llama3.2:3b']);
  });

  it('reports no change on a second identical probe and does not ask for model details again', async () => {
    const { origin, calls } = fakeOllama();
    const server = new LocalModelServer({ origin });
    await server.probe();
    const shows = calls.filter(c => c === 'POST /api/show').length;
    expect(await server.probe()).toBe(false);
    expect(calls.filter(c => c === 'POST /api/show').length).toBe(shows);
  });

  it('falls back to an OpenAI-compatible model list and measures an embedding model\'s size', async () => {
    const { origin } = serve(async (req, url) => {
      if (url.pathname === '/v1/models') return json({ object: 'list', data: [{ id: 'text-embedding-bge-m3' }, { id: 'qwen2.5-coder' }] });
      if (url.pathname === '/v1/embeddings') {
        const body = await req.json() as { input: string[] };
        return json({ data: body.input.map((_, index) => ({ index, embedding: Array(1024).fill(0.1) })) });
      }
      return json({ error: 'not found' }, 404);
    });
    const server = new LocalModelServer({ origin });
    await server.probe();
    const advert = server.advert()!;
    expect(advert.server).toMatchObject({ kind: 'openai_compat', reachable: true, version: null });
    expect(advert.models).toEqual([
      { name: 'text-embedding-bge-m3', family: null, parameterSize: null, capabilities: ['embedding'], dimensions: 1024, contextLength: null },
      { name: 'qwen2.5-coder', family: null, parameterSize: null, capabilities: ['completion'], dimensions: null, contextLength: null },
    ]);
    expect(parseLocalModelsAdvert(advert)).toEqual(advert);
  });

  it('advertises nothing for a machine with no server, and says so once a known server goes away', async () => {
    const none = new LocalModelServer({ origin: 'http://127.0.0.1:9', probeTimeoutMs: 500 });
    expect(await none.probe()).toBe(false);
    expect(none.advert()).toBeNull();
    expect(none.modelNames()).toEqual([]);

    let up = true;
    const { origin } = fakeOllama({ '/api/tags': () => (up ? json({ models: [{ name: 'llama3.2:3b' }] }) : json({ error: 'down' }, 503)) });
    const server = new LocalModelServer({ origin });
    await server.probe();
    expect(server.modelNames()).toEqual(['llama3.2:3b']);
    up = false;
    expect(await server.probe()).toBe(true);
    expect(server.advert()).toMatchObject({ server: { reachable: false }, models: [] });
    expect(server.modelNames()).toEqual([]);
  });

  it('caps the advert at 50 models and drops names the server would refuse', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `m${i}`);
    const { origin } = serve((_req, url) => {
      if (url.pathname === '/v1/models') return json({ data: [{ id: 'has space' }, { id: 'http://evil/x' }, ...names.map(id => ({ id }))] });
      return json({}, 404);
    });
    const server = new LocalModelServer({ origin });
    await server.probe();
    expect(server.advert()!.models.length).toBe(50);
    expect(server.modelNames()).not.toContain('has space');
  });
});

describe('LocalModelServer.embed', () => {
  it('posts to /v1/embeddings and returns vectors in input order', async () => {
    let seen: any;
    const { origin, calls } = serve(async (req) => {
      seen = await req.json();
      return json({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 7 } });
    });
    const out = await new LocalModelServer({ origin }).embed('nomic-embed-text', ['a', 'b']);
    expect(calls).toEqual(['POST /v1/embeddings']);
    expect(seen).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
    expect(out).toEqual({ vectors: [[1, 2], [3, 4]], promptTokens: 7 });
  });

  it('maps a missing model, an upstream failure, a malformed body and an abort to relay error codes', async () => {
    const missing = serve(() => json({ error: { message: 'model "x" not found, try pulling it first' } }, 404));
    await expect(new LocalModelServer({ origin: missing.origin }).embed('x', ['a'])).rejects.toMatchObject({ code: 'model_missing' });

    const broken = serve(() => json({ error: 'out of memory' }, 500));
    const err = await new LocalModelServer({ origin: broken.origin }).embed('x', ['a']).catch(e => e);
    expect(err).toBeInstanceOf(LocalModelError);
    expect(err).toMatchObject({ code: 'ollama_error', httpStatus: 500 });
    expect(err.message).toContain('out of memory');

    const malformed = serve(() => json({ data: 'nope' }));
    await expect(new LocalModelServer({ origin: malformed.origin }).embed('x', ['a'])).rejects.toMatchObject({ code: 'bad_result' });

    const down = await new LocalModelServer({ origin: 'http://127.0.0.1:9' }).embed('x', ['a']).catch(e => e);
    expect(down).toMatchObject({ code: 'ollama_error' });
    expect(down.httpStatus).toBeUndefined();

    const slow = serve(() => new Promise<Response>(resolve => setTimeout(() => resolve(json({ data: [] })), 2_000)));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    await expect(new LocalModelServer({ origin: slow.origin }).embed('x', ['a'], ctl.signal)).rejects.toMatchObject({ code: 'timeout' });
  });
});

function sse(chunks: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        // Split a frame across two writes: the client must buffer lines.
        const frame = `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`;
        controller.enqueue(enc.encode(frame.slice(0, 9)));
        await new Promise(r => setTimeout(r, 2));
        controller.enqueue(enc.encode(frame.slice(9)));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('LocalModelServer.chat', () => {
  it('streams /v1/chat/completions, forwarding deltas and returning text, finish reason and usage', async () => {
    let seen: any;
    const { origin, calls } = serve(async (req) => {
      seen = await req.json();
      return sse([
        { choices: [{ delta: { role: 'assistant', content: '' } }] },
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } },
        '[DONE]',
      ]);
    });
    const deltas: string[] = [];
    const out = await new LocalModelServer({ origin }).chat(
      'llama3.2:3b',
      [{ role: 'user', content: 'hi' }],
      { temperature: 0.2, maxOutputTokens: 64, stop: ['END'], topP: 0.9, seed: 7, topK: 40 },
      { onDelta: d => deltas.push(d) },
    );
    expect(calls).toEqual(['POST /v1/chat/completions']);
    expect(seen).toEqual({
      model: 'llama3.2:3b', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
      temperature: 0.2, max_tokens: 64, stop: ['END'], top_p: 0.9, seed: 7,
    });
    expect(deltas.join('')).toBe('Hello');
    expect(out.text).toBe('Hello');
    expect(out.finishReason).toBe('length');
    expect(out.usage).toEqual({ promptTokens: 11, completionTokens: 2 });
  });

  it('accepts a server that answers without streaming', async () => {
    const { origin } = serve(() => json({ choices: [{ message: { content: 'whole' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const out = await new LocalModelServer({ origin }).chat('m', [{ role: 'user', content: 'hi' }]);
    expect(out).toMatchObject({ text: 'whole', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } });
  });

  it('maps a missing model to model_missing', async () => {
    const { origin } = serve(() => json({ error: { message: 'model "gone" not found' } }, 404));
    await expect(new LocalModelServer({ origin }).chat('gone', [])).rejects.toMatchObject({ code: 'model_missing' });
  });
});

describe('doctor: Local models line', () => {
  it('says what was found, and whether this runner is the relay host when it knows', async () => {
    const { checkLocalModels } = await import('../../src/doctor');
    const { origin } = fakeOllama();
    const server = new LocalModelServer({ origin });
    await server.probe();
    const advert = server.advert();

    expect(checkLocalModels({ enabled: false, advert: null, host: null })).toMatchObject({ name: 'Local models', status: 'ok' });
    expect(checkLocalModels({ enabled: true, advert: null, host: false }).message).toContain('No local model server');
    const hosted = checkLocalModels({ enabled: true, advert, host: true });
    expect(hosted.status).toBe('ok');
    expect(hosted.message).toBe('Ollama 0.12.3 reachable, 2 models (1 embedding); this runner is the pinned relay host');
    expect(checkLocalModels({ enabled: true, advert, host: null }).message).toBe('Ollama 0.12.3 reachable, 2 models (1 embedding)');
    expect(checkLocalModels({ enabled: true, advert: { ...advert!, server: { ...advert!.server, reachable: false }, models: [] }, host: true }).status).toBe('warn');
    expect(hosted.message).not.toContain('127.0.0.1');
  });
});

describe('LocalModelServer.probe: cost on a machine with no server', () => {
  it('is one refused connection per probe', async () => {
    let calls = 0;
    const server = new LocalModelServer({ origin: 'http://127.0.0.1:11434', fetch: (async () => { calls++; throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    await server.probe();
    expect(calls).toBe(1);
    expect(server.advert()).toBeNull();
  });
});
