/** Ollama + GPU I/O for the local replay evaluation. Loopback only. */
import { sh } from './lib';
import { parseGpuMemory } from '../../packages/core/local-eval';

export function assertLoopback(origin: string): URL {
  const u = new URL(origin);
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (!(h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h))) throw new Error('Ollama origin must be loopback');
  return u;
}

async function j(origin: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(new URL(path, origin), body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

export interface TagInfo { tag: string; digest: string | null; quantization: string | null }

export async function tagInfo(origin: string, tag: string): Promise<TagInfo | null> {
  const tags = await j(origin, '/api/tags');
  const hit = (tags.models ?? []).find((m: any) => m.name === tag || m.model === tag || m.name === `${tag}:latest`);
  if (!hit) return null;
  let quantization: string | null = null;
  try { quantization = (await j(origin, '/api/show', { model: hit.name })).details?.quantization_level ?? null; } catch { /* unknown stays unknown */ }
  return { tag, digest: typeof hit.digest === 'string' ? hit.digest : null, quantization };
}

export async function loadedModels(origin: string): Promise<Array<{ name: string; contextLength: number | null; sizeVramMb: number | null }>> {
  const ps = await j(origin, '/api/ps');
  return (ps.models ?? []).map((m: any) => ({ name: m.name, contextLength: typeof m.context_length === 'number' ? m.context_length : null, sizeVramMb: typeof m.size_vram === 'number' ? Math.round(m.size_vram / 1048576) : null }));
}

/** Load the model and keep it resident. Throws when the server reports a different context than requested. */
export async function loadModel(origin: string, tag: string, contextTokens: number) {
  await j(origin, '/api/generate', { model: tag, prompt: '', keep_alive: '30m', options: { num_ctx: contextTokens } });
  const m = (await loadedModels(origin)).find((x) => x.name === tag || x.name === `${tag}:latest`);
  if (!m) throw new Error(`${tag} did not load`);
  if (m.contextLength !== contextTokens) throw new Error(`loaded context is ${m.contextLength ?? 'unknown'}, wanted ${contextTokens}; start the server with OLLAMA_CONTEXT_LENGTH=${contextTokens}`);
  return m;
}

export async function unloadModel(origin: string, tag: string) {
  await j(origin, '/api/generate', { model: tag, prompt: '', keep_alive: 0 });
}

export function readGpu() {
  const r = sh('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']);
  return r.code === 0 ? parseGpuMemory(r.out) : null;
}

export function gpuName(): string | null {
  const r = sh('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
  return r.code === 0 ? r.out.split('\n')[0].trim() || null : null;
}
