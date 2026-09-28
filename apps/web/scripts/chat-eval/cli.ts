#!/usr/bin/env bun
/**
 * Chat v3 / MCP token-efficiency eval — experimental, local, OAuth-only.
 * See README.md next to this file. Run from apps/web:
 *
 *   bun run chat-eval <command> [flags]
 *
 *   static                     offline size of every tool, group and prompt (no model calls)
 *   probe [--per-tool]         exact token overhead per tool set via `claude -p` (OAuth, haiku)
 *   questions --mine [--days 30]      real user chat messages (DATABASE_URL) → questions.jsonl
 *   questions --synth 40 [--replace] [--model sonnet]   likely questions from Claude (OAuth), grounded in live state
 *   questions --add "text" [--weight 3]     add one by hand
 *   questions --classify       Jev: chat's router (complexity / intent / area) on each
 *   questions --list
 *   run --surface chat|mcp [--routing jev|fallback|all] [--model sonnet|haiku|opus|tier]
 *       [--limit N] [--ids a,b] [--area tasks] [--workspace name] [--concurrency 2] [--label x]
 *   judge --run <id>           Jev judges answered / efficiency / obstacle per question
 *   report --run <id> [--vs <id>]
 *
 * Model spend: `claude` children are OAuth only (no API key in their env; a
 * run reporting any other auth aborts). Jev (OpenRouter) is the one exception:
 * classify and judge, one small decision call per question.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, dataPath, DATA_DIR, estTokens, flag, readJsonl } from './lib/env';
import {
  activeChatDefs, chatGroups, chatSystemPrompt, chatToolDefs, MCP_SERVER_INSTRUCTIONS, MCP_SYSTEM_PROMPT, mcpToolDefs,
  type Surface, type ToolDef,
} from './lib/surfaces';
import { runClaude, type ClaudeRun } from './lib/claude';
import { callRemoteTool } from './lib/remote';
import { classify, judge, type Classification, type Judgement } from './lib/jev';
import { TOOL_GROUPS, type ToolGroup } from '../../src/lib/chat/registry';

const argv = process.argv.slice(2);
const cmd = argv[0];
const QUESTIONS = () => dataPath('questions.jsonl');

export interface Question {
  id: string;
  text: string;
  source: 'real' | 'synth' | 'manual';
  /** How likely a user asks this: real = times seen, synth/manual = 1–5 guess. */
  weight: number;
  note?: string;
  classification?: Classification | null;
}

/** What a client that loads tools by name pulls in for "what is this mission / runner doing?". */
const MCP_VISUAL_TOOLS = ['buildd_missions', 'buildd_runners'];

const defSize = (d: ToolDef) => JSON.stringify({ name: d.name, description: d.description, input_schema: d.inputSchema }).length;
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

// ── static ──────────────────────────────────────────────────────────────────

function cmdStatic() {
  const chat = chatToolDefs();
  const mcp = mcpToolDefs();
  const sum = (ds: ToolDef[]) => ds.reduce((s, d) => s + estTokens(JSON.stringify({ name: d.name, description: d.description, input_schema: d.inputSchema })), 0);
  const prompt = chatSystemPrompt({ workspace: null, workspaces: [{ id: crypto.randomUUID(), name: 'example' }] });

  console.log('Estimated tokens (≈3.6 chars/token; `probe` gives exact numbers)\n');
  console.log(`chat instructions + context block   ${lpad(estTokens(prompt), 6)}`);
  console.log(`chat, every tool (${chat.length})              ${lpad(sum(chat), 6)}`);
  console.log(`chat, fallback turn (no area)       ${lpad(sum(activeChatDefs(chat, chatGroups(null))), 6)}`);
  for (const g of TOOL_GROUPS) {
    console.log(`chat, turn routed to ${pad(g, 14)} ${lpad(sum(activeChatDefs(chat, chatGroups(g))), 6)}`);
  }
  const legacy = mcpToolDefs('legacy');
  console.log(`mcp legacy tools (${legacy.map(d => d.name).join(', ')})  ${lpad(sum(legacy), 6)}`);
  console.log(`mcp tools, every one (${mcp.length})            ${lpad(sum(mcp), 6)}`);
  for (const d of mcp) console.log(`  mcp ${pad(d.name, 30)} ${lpad(sum([d]), 6)}`);
  console.log(`mcp, a visual question (${MCP_VISUAL_TOOLS.join(' + ')})  ${lpad(sum(mcp.filter(d => MCP_VISUAL_TOOLS.includes(d.name))), 6)}`);
  console.log(`mcp server instructions             ${lpad(estTokens(MCP_SERVER_INSTRUCTIONS), 6)}`);

  console.log('\nPer chat tool (largest first):');
  console.log(`${pad('tool', 26)}${pad('group', 14)}${lpad('desc', 6)}${lpad('schema', 8)}${lpad('≈tok', 7)}`);
  for (const d of [...chat].sort((a, b) => defSize(b) - defSize(a))) {
    console.log(`${pad(d.name, 26)}${pad(d.group ?? '', 14)}${lpad(estTokens(d.description), 6)}${lpad(estTokens(JSON.stringify(d.inputSchema)), 8)}${lpad(estTokens(JSON.stringify({ name: d.name, description: d.description, input_schema: d.inputSchema })), 7)}`);
  }
}

// ── probe ───────────────────────────────────────────────────────────────────

function proxyServer(surface: Surface, toolsFile: string, logFile: string, qid: string, extra: Record<string, string> = {}) {
  return {
    command: 'bun',
    args: ['--preload', join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'stub-server-only.ts'), join(import.meta.dir, 'lib', 'proxy.ts')],
    env: { CHAT_EVAL_SURFACE: surface, CHAT_EVAL_TOOLS: toolsFile, CHAT_EVAL_LOG: logFile, CHAT_EVAL_QID: qid, PATH: process.env.PATH ?? '', ...extra },
  };
}

async function cmdProbe() {
  const model = arg(argv, 'model') ?? 'haiku';
  const chat = chatToolDefs();
  const prompt = chatSystemPrompt({ workspace: null, workspaces: [{ id: crypto.randomUUID(), name: 'example' }] });
  const dir = dataPath('probe', 'x');
  const variants: Array<{ label: string; surface: Surface; system: string; tools: ToolDef[] | null }> = [
    { label: 'no tools, one-line system prompt', surface: 'chat', system: 'Reply OK.', tools: null },
    { label: 'no tools, chat system prompt', surface: 'chat', system: prompt, tools: null },
    { label: 'chat fallback turn', surface: 'chat', system: prompt, tools: activeChatDefs(chat, chatGroups(null)) },
    ...TOOL_GROUPS.map(g => ({ label: `chat routed: ${g}`, surface: 'chat' as Surface, system: prompt, tools: activeChatDefs(chat, chatGroups(g)) })),
    { label: 'chat every tool', surface: 'chat', system: prompt, tools: chat },
    { label: 'mcp legacy (buildd + others)', surface: 'mcp', system: MCP_SYSTEM_PROMPT, tools: mcpToolDefs('legacy') },
    { label: 'mcp groups (every tool)', surface: 'mcp', system: MCP_SYSTEM_PROMPT, tools: mcpToolDefs() },
    { label: 'mcp groups: missions + runners', surface: 'mcp', system: MCP_SYSTEM_PROMPT, tools: mcpToolDefs().filter(d => MCP_VISUAL_TOOLS.includes(d.name)) },
  ];
  if (flag(argv, 'per-tool')) {
    for (const d of chat) variants.push({ label: `tool ${d.name}`, surface: 'chat', system: 'Reply OK.', tools: [d] });
    for (const d of mcpToolDefs()) variants.push({ label: `mcp tool ${d.name}`, surface: 'mcp', system: 'Reply OK.', tools: [d] });
  }
  variants.splice(2, 0, { label: 'no tools, mcp system prompt', surface: 'mcp', system: MCP_SYSTEM_PROMPT, tools: null });
  const rows: Array<{ label: string; input: number; toolsTokens?: number }> = [];
  const bare = new Map<string, number>();
  for (const v of variants) {
    let server;
    if (v.tools) {
      const f = join(dir, '..', `tools-${rows.length}.json`);
      writeFileSync(f, JSON.stringify(v.tools));
      server = proxyServer(v.surface, f, join(dir, '..', 'probe-calls.jsonl'), 'probe');
    }
    const r = await runClaude({ prompt: 'Reply with the single word OK. Do not call any tool.', systemPrompt: v.system, model, mcpServer: server, maxTurns: 1 });
    if (!v.tools) bare.set(v.system, r.firstStepInput);
    const toolsTokens = v.tools ? r.firstStepInput - (bare.get(v.system) ?? 0) : 0;
    rows.push({ label: v.label, input: r.firstStepInput, ...(v.tools ? { toolsTokens } : {}) });
    console.log(`${pad(v.label, 40)} ${lpad(r.firstStepInput, 7)} input tokens${v.tools ? `   (tools ${toolsTokens})` : ''}`);
  }
  writeFileSync(join(dir, '..', `probe-${model}.json`), JSON.stringify({ model, at: new Date().toISOString(), rows }, null, 2));
  console.log(`\nSaved ${join(dir, '..', `probe-${model}.json`)}. Tool deltas subtract the matching no-tools row.`);
}

// ── questions ───────────────────────────────────────────────────────────────

const loadQuestions = () => readJsonl<Question>(QUESTIONS());
const saveQuestions = (qs: Question[]) => writeFileSync(QUESTIONS(), qs.map(q => JSON.stringify(q)).join('\n') + (qs.length ? '\n' : ''));
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const qidFor = (text: string) => Bun.hash(norm(text)).toString(36).slice(0, 8);

function upsert(qs: Question[], q: Omit<Question, 'id'>): boolean {
  const id = qidFor(q.text);
  const hit = qs.find(x => x.id === id);
  if (hit) { if (q.source === 'real') hit.weight += q.weight; return false; }
  qs.push({ id, ...q });
  return true;
}

async function workspacesInReach(): Promise<Array<{ id: string; name: string }>> {
  const r = await callRemoteTool('buildd', { action: 'manage_workspaces', params: { action: 'list' } });
  const out: Array<{ id: string; name: string }> = [];
  const re = /\*\*(.+?)\*\*[\s\S]*?ID: ([0-9a-f-]{36})/g;
  for (let m; (m = re.exec(r.text));) out.push({ name: m[1], id: m[2] });
  return out;
}

async function cmdQuestions() {
  const qs = loadQuestions();
  if (flag(argv, 'list')) {
    for (const q of [...qs].sort((a, b) => b.weight - a.weight)) {
      const c = q.classification;
      console.log(`${q.id}  w${lpad(q.weight, 3)}  ${pad(q.source, 6)} ${pad(c ? `${c.area}/${c.intent}/${c.complexity}` : '-', 28)} ${q.text.slice(0, 90).replace(/\n/g, ' ')}`);
    }
    return;
  }
  const add = arg(argv, 'add');
  if (add) {
    upsert(qs, { text: add, source: 'manual', weight: Number(arg(argv, 'weight') ?? 3) });
    saveQuestions(qs);
    console.log(`added ${qidFor(add)}`);
  }
  if (flag(argv, 'mine')) {
    if (!process.env.DATABASE_URL) throw new Error('--mine needs DATABASE_URL (load apps/web/.env.local)');
    const { db } = await import('@buildd/core/db');
    const { sql } = await import('drizzle-orm');
    const days = Number(arg(argv, 'days') ?? 30);
    const rows = await db.execute(sql`
      select parts from conversation_messages
      where role = 'user' and created_at > now() - make_interval(days => ${days})
      order by created_at desc limit 2000`);
    let added = 0;
    for (const r of ((rows as { rows?: unknown[] }).rows ?? rows) as Array<{ parts: Array<{ type: string; text?: string }> }>) {
      const text = (r.parts ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('\n').trim();
      // Skip one-word acks ("yes", "thanks"): they measure nothing about tools.
      if (text.length < 12 || text.length > 1200) continue;
      if (upsert(qs, { text, source: 'real', weight: 1 })) added++;
    }
    saveQuestions(qs);
    console.log(`mined ${added} new real questions (last ${days} days)`);
  }
  const synthN = arg(argv, 'synth');
  if (synthN) {
    if (flag(argv, 'replace')) for (let i = qs.length - 1; i >= 0; i--) if (qs[i].source === 'synth') qs.splice(i, 1);
    const ws = await workspacesInReach();
    // Live state, so the questions name things that exist (stays local).
    const snap = async (action: string, params: Record<string, unknown>) => (await callRemoteTool('buildd', { action, params }).catch(() => ({ text: '' }))).text.slice(0, 2500);
    const state = [
      `Open missions:\n${await snap('manage_missions', { action: 'list' })}`,
      `Active tasks:\n${await snap('list_tasks', { status: 'active', workspaceId: ws[0]?.id })}`,
      `Recently completed tasks:\n${await snap('list_tasks', { status: 'completed', limit: 15, workspaceId: ws[0]?.id })}`,
    ].join('\n\n');
    const tools = chatToolDefs().map(d => `${d.name} (${d.group})`).join(', ');
    const examples = qs.filter(q => q.source === 'real').sort((a, b) => b.weight - a.weight).slice(0, 15).map(q => `- ${q.text.slice(0, 200)}`).join('\n');
    const prompt = `Buildd coordinates AI coding agents: people file missions (goals with criteria) and tasks, agents on runners claim tasks and open PRs, and a chat assistant answers from live state and steers work. The chat assistant's tools: ${tools}.
Workspaces this person has: ${ws.map(w => w.name).join(', ') || 'unknown'}.
What is in buildd right now (so questions can name real missions, tasks and PRs):
${state}
${examples ? `Questions real users have asked:\n${examples}\n` : ''}
Write the ${synthN} questions or requests a busy engineering lead is MOST LIKELY to type into this chat in a normal week, most likely first. Cover status checks, "why is X stuck", what shipped, steering running work, filing work, schedules, PRs and memory, in proportion to how often they'd really come up. Use the workspace names naturally where a person would. Mix short and specific phrasings.
Reply with ONLY a JSON array: [{"text": "...", "likelihood": 1-5, "note": "what it tests"}].`;
    const r = await runClaude({ prompt, systemPrompt: 'You write realistic user test prompts. Output only JSON.', model: arg(argv, 'model') ?? 'sonnet', maxTurns: 1 });
    const json = r.answer.slice(r.answer.indexOf('['), r.answer.lastIndexOf(']') + 1);
    const items = JSON.parse(json) as Array<{ text: string; likelihood?: number; note?: string }>;
    let added = 0;
    for (const it of items) if (it.text && upsert(qs, { text: it.text, source: 'synth', weight: Math.max(1, Math.min(5, it.likelihood ?? 3)), note: it.note })) added++;
    saveQuestions(qs);
    console.log(`synthesized ${added} new questions (${r.totalInput} in / ${r.totalOutput} out tokens, OAuth)`);
  }
  if (flag(argv, 'classify')) {
    const todo = qs.filter(q => flag(argv, 'force') || !q.classification);
    await pool(todo, 4, async q => { q.classification = await classify(q.text).catch(() => null); });
    saveQuestions(qs);
    const byArea = new Map<string, number>();
    for (const q of qs) byArea.set(q.classification?.area ?? '?', (byArea.get(q.classification?.area ?? '?') ?? 0) + q.weight);
    console.log(`classified ${todo.length}. Weighted by area: ${[...byArea].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(', ')}`);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

export interface RunResult {
  qid: string;
  question: string;
  weight: number;
  surface: Surface;
  tools: string[];
  toolsTokensEst: number;
  area: string | null;
  run: Omit<ClaudeRun, 'steps'> & { steps: ClaudeRun['steps'] };
  judgement?: Judgement | { error: string };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const t = items[i++]; await fn(t); }
  }));
}

const TIER_MODEL: Record<string, string> = { budget: 'haiku', standard: 'sonnet', premium: 'opus' };

async function cmdRun() {
  const surface = (arg(argv, 'surface') ?? 'chat') as Surface;
  const routing = arg(argv, 'routing') ?? 'jev';
  const modelArg = arg(argv, 'model') ?? 'sonnet';
  let qs = loadQuestions().sort((a, b) => b.weight - a.weight);
  const ids = arg(argv, 'ids')?.split(',');
  if (ids) qs = qs.filter(q => ids.includes(q.id));
  const areaFilter = arg(argv, 'area');
  if (areaFilter) qs = qs.filter(q => q.classification?.area === areaFilter);
  qs = qs.slice(0, Number(arg(argv, 'limit') ?? qs.length));
  if (!qs.length) throw new Error('no questions: run `questions --synth 30` (and --classify) first');

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${surface}${surface === 'chat' ? `-${routing}` : ''}-${modelArg}${arg(argv, 'label') ? `-${arg(argv, 'label')}` : ''}`;
  const out = (f: string) => dataPath('runs', runId, f);
  const all = await workspacesInReach();
  const pinName = arg(argv, 'workspace');
  const pinned = pinName ? all.find(w => w.name === pinName || w.id === pinName) ?? null : null;
  if (pinName && !pinned) throw new Error(`workspace ${pinName} not in reach`);
  writeFileSync(out('meta.json'), JSON.stringify({ runId, surface, routing, model: modelArg, workspace: pinned?.name ?? null, questions: qs.length, at: new Date().toISOString() }, null, 2));
  console.log(`run ${runId}: ${qs.length} questions on ${surface}${surface === 'chat' ? ` (routing ${routing})` : ''}, model ${modelArg}`);

  await pool(qs, Number(arg(argv, 'concurrency') ?? 2), async q => {
    let defs: ToolDef[];
    let system: string;
    let area: string | null = null;
    let model = modelArg;
    if (surface === 'chat') {
      let c = q.classification;
      if (routing === 'jev' && !c) c = await classify(q.text).catch(() => null);
      const route = routing === 'jev' ? c?.route : undefined;
      area = routing === 'all' ? 'all' : route?.area ?? null;
      defs = activeChatDefs(chatToolDefs({ allowWrites: route?.allowWrites ?? true }), chatGroups(routing === 'all' ? 'all' : (route?.area ?? null)));
      if (modelArg === 'tier') model = TIER_MODEL[route?.tier ?? 'standard'];
      system = chatSystemPrompt({ workspace: pinned, workspaces: all, tier: route?.tier });
    } else {
      defs = mcpToolDefs();
      system = MCP_SYSTEM_PROMPT;
      if (modelArg === 'tier') model = 'sonnet';
    }
    const toolsFile = out(`tools-${q.id}.json`);
    writeFileSync(toolsFile, JSON.stringify(defs));
    let run: ClaudeRun;
    try {
      run = await runClaude({ prompt: q.text, systemPrompt: system, model, mcpServer: proxyServer(surface, toolsFile, out('calls.jsonl'), q.id, {
        CHAT_EVAL_WORKSPACE_ID: pinned?.id ?? '',
        // Every workspace counts as active: the harness can't see task activity.
        CHAT_EVAL_WORKSPACES: JSON.stringify(all.map(w => ({ ...w, lastActiveAt: new Date().toISOString() }))),
      }), maxTurns: 9 });
    } catch (e) {
      console.error(`${q.id} failed: ${e instanceof Error ? e.message : e}`);
      if (String(e).includes('apiKeySource')) process.exit(2);
      return;
    }
    const r: RunResult = {
      qid: q.id, question: q.text, weight: q.weight, surface, area,
      tools: defs.map(d => d.name),
      toolsTokensEst: defs.reduce((s, d) => s + estTokens(JSON.stringify({ name: d.name, description: d.description, input_schema: d.inputSchema })), 0),
      run,
    };
    appendFileSync(out('results.jsonl'), `${JSON.stringify(r)}\n`);
    console.log(`${q.id}  ${lpad(run.totalInput, 7)} in ${lpad(run.totalOutput, 5)} out  ${run.toolUses.length} calls  ${run.ok ? '' : `[${run.error}] `}${q.text.slice(0, 60).replace(/\n/g, ' ')}`);
  });
  console.log(`\nnext: bun run chat-eval judge --run ${runId}`);
}

// ── judge ───────────────────────────────────────────────────────────────────

const latestRun = () => readdirSync(dataPath('runs', 'x', '..')).filter(d => existsSync(join(DATA_DIR, 'runs', d, 'results.jsonl'))).sort().at(-1);

async function cmdJudge() {
  const runId = arg(argv, 'run') ?? latestRun();
  if (!runId) throw new Error('no run');
  const file = join(DATA_DIR, 'runs', runId, 'results.jsonl');
  const results = readJsonl<RunResult>(file);
  const calls = readJsonl<{ qid: string; tool: string; action?: string; input: unknown; chars: number; isError: boolean; write: boolean; head: string }>(join(DATA_DIR, 'runs', runId, 'calls.jsonl'));
  const todo = results.filter(r => flag(argv, 'force') || !r.judgement || 'error' in r.judgement);
  await pool(todo, 4, async r => {
    const mine = calls.filter(c => c.qid === r.qid);
    r.judgement = await judge({
      question: r.question.slice(0, 1500),
      answer: r.run.answer.slice(0, 3000),
      tool_calls: mine.filter(c => !c.write).map(c => ({ tool: c.action ? `buildd.${c.action}` : c.tool, input: JSON.stringify(c.input).slice(0, 200), chars: c.chars, error: c.isError, output_start: c.head })),
      proposed_writes: mine.filter(c => c.write).map(c => ({ tool: c.action ? `buildd.${c.action}` : c.tool, input: JSON.stringify(c.input).slice(0, 300) })),
    }).catch(e => ({ error: String(e) }));
  });
  writeFileSync(file, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`judged ${todo.length} in ${runId}\nnext: bun run chat-eval report --run ${runId}`);
}

// ── report ──────────────────────────────────────────────────────────────────

function summarize(runId: string) {
  const results = readJsonl<RunResult>(join(DATA_DIR, 'runs', runId, 'results.jsonl'));
  const calls = readJsonl<{ qid: string; tool: string; action?: string; chars: number; estTokens: number; isError: boolean; write: boolean; truncated: boolean; clarification: boolean }>(join(DATA_DIR, 'runs', runId, 'calls.jsonl'));
  const n = results.length;
  const W = results.reduce((s, r) => s + r.weight, 0) || 1;
  const wavg = (f: (r: RunResult) => number) => results.reduce((s, r) => s + r.weight * f(r), 0) / W;
  const count = (key: 'answered' | 'efficiency' | 'obstacle') => {
    const m = new Map<string, number>();
    for (const r of results) {
      const j = r.judgement && !('error' in r.judgement) ? r.judgement[key].choice : 'unjudged';
      m.set(j, (m.get(j) ?? 0) + r.weight);
    }
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((100 * v) / W)}%`).join(', ');
  };
  const byTool = new Map<string, { calls: number; tokens: number; errors: number; truncated: number; clarify: number }>();
  for (const c of calls) {
    const k = c.action ? `buildd.${c.action}` : c.tool;
    const t = byTool.get(k) ?? { calls: 0, tokens: 0, errors: 0, truncated: 0, clarify: 0 };
    t.calls++; t.tokens += c.estTokens; if (c.isError) t.errors++; if (c.truncated) t.truncated++; if (c.clarification) t.clarify++;
    byTool.set(k, t);
  }
  const resultTokens = (qid: string) => calls.filter(c => c.qid === qid).reduce((s, c) => s + c.estTokens, 0);
  return {
    runId, n, results, byTool,
    meta: JSON.parse(readFileSync(join(DATA_DIR, 'runs', runId, 'meta.json'), 'utf8')),
    avgInput: wavg(r => r.run.totalInput),
    avgOutput: wavg(r => r.run.totalOutput),
    avgFirst: wavg(r => r.run.firstStepInput),
    avgCalls: wavg(r => r.run.toolUses.length),
    avgSteps: wavg(r => r.run.steps.length),
    avgResultTok: wavg(r => resultTokens(r.qid)),
    avgToolsTok: wavg(r => r.toolsTokensEst),
    avgMs: wavg(r => r.run.durationMs),
    virtualCost: results.reduce((s, r) => s + r.run.virtualCostUsd, 0),
    answered: count('answered'), efficiency: count('efficiency'), obstacle: count('obstacle'),
    fullRate: results.filter(r => r.judgement && !('error' in r.judgement) && ['full', 'declined_correctly', 'clarified_correctly'].includes(r.judgement.answered.choice)).reduce((s, r) => s + r.weight, 0) / W,
    resultTokens,
  };
}

function cmdReport() {
  const runId = arg(argv, 'run') ?? latestRun();
  if (!runId) throw new Error('no run');
  const s = summarize(runId);
  const vs = arg(argv, 'vs') ? summarize(arg(argv, 'vs')!) : null;
  const k = (x: number) => Math.round(x).toLocaleString('en-US');
  const col = (a: number, b?: number) => b === undefined ? k(a) : `${k(a)} | ${k(b)} | ${b ? `${a > b ? '+' : ''}${Math.round((100 * (a - b)) / b)}%` : ''}`;
  const lines: string[] = [];
  lines.push(`# Chat eval: ${runId}`, '');
  lines.push(`surface **${s.meta.surface}**${s.meta.surface === 'chat' ? `, routing **${s.meta.routing}**` : ''}, model **${s.meta.model}**, ${s.n} questions (weighted by likelihood)${vs ? `, vs \`${vs.runId}\`` : ''}`, '');
  lines.push(vs ? '| per question (weighted avg) | this | vs | Δ |' : '| per question (weighted avg) | value |', vs ? '|---|---|---|---|' : '|---|---|');
  const row = (label: string, a: number, b?: number) => lines.push(`| ${label} | ${col(a, b)} |`);
  lines.push(`| handled well (Jev: full, declined or clarified correctly) | ${Math.round(100 * s.fullRate)}%${vs ? ` | ${Math.round(100 * vs.fullRate)}% |` : ''} |`);
  row('input tokens, all steps', s.avgInput, vs?.avgInput);
  row('output tokens', s.avgOutput, vs?.avgOutput);
  row('first-step prompt (system + tools + question)', s.avgFirst, vs?.avgFirst);
  row('tool definitions sent (est)', s.avgToolsTok, vs?.avgToolsTok);
  row('tool output read (est)', s.avgResultTok, vs?.avgResultTok);
  lines.push(`| tool calls | ${s.avgCalls.toFixed(1)}${vs ? ` | ${vs.avgCalls.toFixed(1)} |` : ''} |`);
  lines.push(`| model steps | ${s.avgSteps.toFixed(1)}${vs ? ` | ${vs.avgSteps.toFixed(1)} |` : ''} |`);
  lines.push(`| latency (s) | ${(s.avgMs / 1000).toFixed(1)}${vs ? ` | ${(vs.avgMs / 1000).toFixed(1)} |` : ''} |`);
  lines.push('', `Virtual cost (OAuth, not billed): $${s.virtualCost.toFixed(2)}`, '');
  lines.push(`**Answered:** ${s.answered}`, '', `**Efficiency:** ${s.efficiency}`, '', `**Obstacle:** ${s.obstacle}`, '');
  lines.push('## Tool outputs by cost', '', '| tool | calls | est tokens | avg | errors | truncated | clarify |', '|---|---|---|---|---|---|---|');
  for (const [t, v] of [...s.byTool].sort((a, b) => b[1].tokens - a[1].tokens)) {
    lines.push(`| ${t} | ${v.calls} | ${k(v.tokens)} | ${k(v.tokens / v.calls)} | ${v.errors} | ${v.truncated} | ${v.clarify} |`);
  }
  lines.push('', '## Most expensive questions', '', '| id | w | input | calls | tool out | answered | efficiency | obstacle | question |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of [...s.results].sort((a, b) => b.run.totalInput - a.run.totalInput).slice(0, 15)) {
    const j = r.judgement && !('error' in r.judgement) ? r.judgement : null;
    lines.push(`| ${r.qid} | ${r.weight} | ${k(r.run.totalInput)} | ${r.run.toolUses.length} | ${k(s.resultTokens(r.qid))} | ${j?.answered.choice ?? '-'} | ${j?.efficiency.choice ?? '-'} | ${j?.obstacle.choice ?? '-'} | ${r.question.slice(0, 70).replace(/[\n|]/g, ' ')} |`);
  }
  const md = lines.join('\n');
  writeFileSync(join(DATA_DIR, 'runs', runId, 'report.md'), md);
  console.log(md);
}

const commands: Record<string, () => unknown> = { static: cmdStatic, probe: cmdProbe, questions: cmdQuestions, run: cmdRun, judge: cmdJudge, report: cmdReport };
if (!commands[cmd]) {
  console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0]);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
process.exit(0);
