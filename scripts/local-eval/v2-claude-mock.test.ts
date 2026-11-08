/**
 * The real Claude Code CLI, through the v2 executor, against a deterministic
 * mock Anthropic endpoint on loopback. CPU only: no model, no Ollama, no GPU.
 * The mock answers the first request with one Write tool call and the second
 * with a short text, so the full path runs: CLI transport -> tool call in the
 * agent tree -> hidden verifier on a copy -> run record.
 *
 * It checks the transport shape (one system prompt that is the treatment's,
 * exactly the six tools, the prompt arriving intact) and says nothing about
 * how a real model behaves. Skipped when `claude` is not on PATH.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeContentHash, namedPaths, GPU_WINDOW_OPENS_AT, type CaseManifestV2 } from '../../packages/core/local-eval-v2';
import { HARNESS_TREATMENTS_V2 } from '../../packages/core/local-eval-v2-exec';
import { runV2 } from './v2';
import { sh, tempDir } from './lib';

const haveClaude = sh('claude', ['--version']).code === 0 && !process.env.LOCAL_EVAL_SKIP_CLAUDE_MOCK;
const SENTINEL = 'SENTINEL-TASK-41c9';

function suite(): string {
  const root = tempDir('v2-mock-');
  const files: Record<string, string> = {
    'snapshot/src/live.ts': 'export const live = 1;\n',
    'instruction.md': `${SENTINEL}: write {"file":"src/live.ts"} to answer.json.\n`,
    'verifier/check.ts': "import { readFileSync } from 'node:fs';\nconst a = JSON.parse(readFileSync(process.env.CANDIDATE_DIR + '/answer.json', 'utf8'));\nprocess.exit(a.file === 'src/live.ts' ? 0 : 1);\n",
    'reference/answer.json': '{"file":"src/live.ts"}\n',
    'candidates/b/answer.json': '{"file":"x"}\n',
  };
  const m = {
    formatVersion: 2, id: 'find-mock', version: 1, contentHash: '', category: 'find-by-behaviour',
    files: { snapshot: ['snapshot/src/live.ts'], instruction: 'instruction.md', verifier: ['verifier/check.ts'], reference: ['reference/answer.json'], rubric: null, candidates: { broken: ['b'], alternative: null, files: ['candidates/b/answer.json'] } },
    deps: {}, resources: { cpuOnly: true, estimatedVramMb: null, estimatedRamMb: null, wallClockSeconds: 90, maxTurns: 4, toolBudget: 4 },
    labels: { difficulty: 'easy', skills: ['find'] }, exposing: false, provenance: { source: 'authored', licence: 'l', note: 'n' }, contamination: 'c',
    expected: { kind: 'verifier' }, admission: null,
  } as CaseManifestV2;
  m.contentHash = computeContentHash(files, namedPaths(m));
  const dir = join(root, 'cases', m.id);
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  writeFileSync(join(dir, 'case.json'), JSON.stringify(m));
  writeFileSync(join(root, 'suite.json'), JSON.stringify({ suiteId: 'coding-playground', suiteVersion: 'v2', formatVersion: 2, scoringVersion: 'score-v2', skills: ['find'], cases: [{ id: m.id, version: 1, contentHash: m.contentHash }] }));
  writeFileSync(join(root, 'models.json'), JSON.stringify({ modelsFormatVersion: 2, models: [{ tag: 'mock:1', digest: 'sha256:mock', estimatedVramMb: 1000 }] }));
  return root;
}

function sse(events: object[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe.skipIf(!haveClaude)('v2 executor with the real Claude Code CLI against a mock endpoint (CPU only)', () => {
  for (const treatmentId of ['claude-code-minimal-v1', 'claude-code-bare-v1'])
  it(`delivers the treatment (${treatmentId}), runs the tool call in the tree and grades it`, async () => {
    const treatment = HARNESS_TREATMENTS_V2[treatmentId];
    const runId = `v2.find-mock.mock_1@16384.single-context${treatmentId === 'claude-code-bare-v1' ? '.bare' : ''}.t1`;
    const root = suite(); const out = join(root, 'runs');
    // The executor puts the agent in a fresh temporary directory; point that at a place the mock can see.
    const work = join(root, 'agent-tmp'); mkdirSync(work, { recursive: true });
    const prevTmp = process.env.LOCAL_EVAL_TMP; process.env.LOCAL_EVAL_TMP = work;
    const agentTree = () => { const d = readdirSync(work).find((n) => n.startsWith('eval-agent-')); return d ? join(work, d, 'tree') : 'missing'; };
    const requests: any[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== 'POST' || !url.pathname.endsWith('/v1/messages')) return new Response('not found', { status: 404 });
        const body = await req.json();
        requests.push(body);
        const answered = JSON.stringify(body.messages).includes('tool_result');
        const start = { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } };
        if (!answered) {
          return sse([start,
            // Write when the treatment offers it, else Bash (the bare tool set has no Write).
            ...(body.tools.some((t: any) => t.name === 'Write')
              ? [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Write', input: {} } },
                 { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: join(agentTree(), 'answer.json'), content: '{"file":"src/live.ts"}\n' }) } }]
              : [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } },
                 { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `printf '%s\\n' '{"file":"src/live.ts"}' > answer.json`, description: 'write answer' }) } }]),
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
            { type: 'message_stop' }]);
        }
        return sse([start,
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
          { type: 'message_stop' }]);
      },
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const env = {
        minFreeMb: 1, readGpu: () => [{ usedMb: 0, totalMb: 24000 }], loaded: async () => [] as string[], now: () => new Date(Date.parse(GPU_WINDOW_OPENS_AT) + 60_000),
        ollama: { tagInfo: async () => ({ digest: 'sha256:mock', quantization: null }), loadModel: async () => undefined, unloadModel: async () => undefined },
        harnessVersion: () => sh('claude', ['--version']).out.trim() || null, claudeBin: Bun.which('claude') ?? 'claude',
      };
      const opt = (n: string) => ({ root, model: 'mock:1', harness: 'claude-code', context: '16384', case: 'find-mock', trials: '1', out, origin, ...(treatmentId === 'claude-code-minimal-v1' ? {} : { treatment: treatmentId }) } as Record<string, string>)[n];
      const code = await runV2('run', opt, () => false, env);
      expect(code).toBe(0);
      const main = requests.filter((r) => Array.isArray(r.tools) && r.tools.length);
      expect(main.length).toBeGreaterThanOrEqual(1);
      const first = main[0];
      const system = Array.isArray(first.system) ? first.system.map((b: any) => b.text).join('\n') : String(first.system ?? '');
      expect(system).toContain(treatment.systemPrompt);
      expect(first.tools.map((t: any) => t.name).sort()).toEqual([...treatment.tools].sort());
      expect(JSON.stringify(first.messages)).toContain(SENTINEL);
      // Output reservation and thinking are what the treatment declares.
      expect(first.max_tokens).toBe(treatment.maxOutputTokens);
      expect(first.thinking?.type === 'enabled').toBe(false);
      const rec = JSON.parse(readFileSync(join(out, runId, 'run.json'), 'utf8'));
      expect(rec).toMatchObject({ result: 'pass', hidden: { ran: true, passed: true }, harness: { name: 'claude-code' } });
      const ex = JSON.parse(readFileSync(join(out, runId, 'execution.json'), 'utf8'));
      expect(ex.exit.kind).toBe('completed');
      expect(ex.exit.toolCalls).toBe(1);
      // Size of the first request, for the record (characters of JSON, not tokens).
      process.stdout.write(`mock ${treatmentId}: ${requests.length} request(s); first main request ${JSON.stringify(first).length} JSON chars, system ${system.length} chars, ${first.tools.length} tools, max_tokens ${first.max_tokens}, thinking ${JSON.stringify(first.thinking ?? null)}; harness ${rec.harness.version}\n`);
    } finally {
      if (prevTmp === undefined) delete process.env.LOCAL_EVAL_TMP; else process.env.LOCAL_EVAL_TMP = prevTmp;
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
