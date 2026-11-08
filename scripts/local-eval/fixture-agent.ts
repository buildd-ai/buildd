/**
 * Deterministic fixture agent for v2 (`--harness fixture`). Starts no model.
 *
 * Reads the prompt on stdin (and refuses an empty one, so the harness's
 * prompt delivery is exercised), then copies every file under $FIXTURE_DIR
 * into the current directory (the agent tree) and prints Claude Code-shaped
 * `stream-json`: one assistant message whose tool calls are the writes, then a
 * result record. Its output is whatever an operator authored in FIXTURE_DIR:
 * it never sees the case's verifier or reference, and it is not a model result.
 *
 * `$FIXTURE_DIR/_behaviour.json` (optional, not copied) simulates an exit:
 *   {"subtype": "error_max_turns"} | {"hang": true} | {"exitCode": 3, "silent": true} | {"resultText": "..."}
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const prompt = await Bun.stdin.text();
if (!prompt.trim()) { console.error('fixture agent: empty prompt on stdin'); process.exit(2); }
const dir = process.env.FIXTURE_DIR;
if (!dir || !existsSync(dir)) { console.error(`fixture agent: no fixture for this case (${dir ?? 'FIXTURE_DIR unset'})`); process.exit(2); }

const BEHAVIOUR = '_behaviour.json';
const behaviour = existsSync(join(dir, BEHAVIOUR)) ? JSON.parse(readFileSync(join(dir, BEHAVIOUR), 'utf8')) as Record<string, unknown> : {};
if (behaviour.hang) await new Promise(() => {});
if (behaviour.silent) process.exit(Number(behaviour.exitCode ?? 1));

const writes: { path: string; content: string }[] = [];
const walk = (rel: string) => {
  for (const n of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${n}` : n;
    if (!rel && n === BEHAVIOUR) continue;
    if (statSync(join(dir, r)).isDirectory()) walk(r); else writes.push({ path: r, content: readFileSync(join(dir, r), 'utf8') });
  }
};
walk('');
for (const w of writes) { mkdirSync(dirname(join(process.cwd(), w.path)), { recursive: true }); writeFileSync(join(process.cwd(), w.path), w.content); }

const line = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
line({ type: 'system', subtype: 'init', model: 'fixture', tools: ['Write'] });
line({ type: 'assistant', message: { content: writes.map((w, i) => ({ type: 'tool_use', id: `fx${i}`, name: 'Write', input: { file_path: w.path } })) } });
const subtype = typeof behaviour.subtype === 'string' ? behaviour.subtype : 'success';
line({ type: 'result', subtype, is_error: subtype !== 'success', num_turns: 1, result: typeof behaviour.resultText === 'string' ? behaviour.resultText : `fixture wrote ${writes.length} file(s)`, usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 1 } });
process.exit(Number(behaviour.exitCode ?? 0));
