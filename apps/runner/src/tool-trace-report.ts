/**
 * Local, inspectable tool-efficiency report: `bun apps/runner/src/tool-trace-report.ts <file> [--json] [--format auto|trace|claude-transcript]`.
 *
 * Reads a runner trace file (JSON Lines written under BUILDD_TOOL_TRACE_DIR) or
 * imports a Claude Code interactive/historical transcript, runs the versioned
 * analyser, and prints JSON or readable text. Nothing is sent anywhere; the
 * output is for the person at the keyboard, and the report states how much of
 * the session the source could actually show.
 *
 * Coverage, stated honestly:
 *  - runner trace: full per-call record, with timings.
 *  - Claude Code transcript (`~/.claude/projects/**.jsonl`): tool calls and
 *    results are importable; exit codes are parsed from text; timings come from
 *    line timestamps and are approximate.
 *  - Codex: only through the runner's own adapter. There is no importer for a
 *    Codex desktop session and none is claimed.
 */
import { readFileSync } from 'node:fs';
import { ToolTraceRecorder, TRACE_SCHEMA_VERSION, type TraceCounters, type TraceEvent, type TraceHeader } from './tool-trace';
import { analyseToolTrace, buildToolEfficiencyAggregate, ANALYSER_VERSION, type ToolFinding } from './tool-trace-analysis';
import type { ToolEfficiencyAggregate } from '@buildd/core/tool-efficiency';

export type TraceSource = 'runner_trace' | 'claude_transcript';

export interface LoadedTrace {
  source: TraceSource;
  header: Pick<TraceHeader, 'harness' | 'taskId' | 'model'> & Partial<TraceHeader>;
  events: TraceEvent[];
  counters: Partial<TraceCounters>;
  /** What this source cannot tell you. */
  limits: string[];
}

function lines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ }
  }
  return out;
}

export function detectFormat(rows: unknown[]): 'trace' | 'claude-transcript' | 'unknown' {
  for (const r of rows.slice(0, 20)) {
    const o = r as any;
    if (o?.kind === 'header' || o?.kind === 'call') return 'trace';
    if (o?.message?.content && (o.type === 'assistant' || o.type === 'user')) return 'claude-transcript';
  }
  return 'unknown';
}

/** Load a runner trace: header, call events (last write of a callId wins), last counter footer. */
export function loadRunnerTrace(rows: unknown[]): LoadedTrace {
  let header: any = { harness: 'unknown', taskId: 'unknown', model: null };
  const byId = new Map<string, TraceEvent>();
  let counters: LoadedTrace['counters'] = {};
  for (const r of rows as any[]) {
    if (r?.kind === 'header') {
      if (typeof r.v === 'number' && r.v > TRACE_SCHEMA_VERSION) throw new Error(`trace schema v${r.v} is newer than this reader (v${TRACE_SCHEMA_VERSION})`);
      header = r;
    } else if (r?.kind === 'call' && typeof r.callId === 'string') byId.set(r.callId, r);
    else if (r?.kind === 'summary' && r.counters) counters = r.counters;
  }
  return {
    source: 'runner_trace', header, events: [...byId.values()].sort((a, b) => a.seq - b.seq), counters,
    limits: ['Raw commands are not kept unless excerpts were opted into; findings rest on fingerprints and enums.'],
  };
}

/** Import a Claude Code transcript by replaying its tool blocks through a recorder. */
export function importClaudeTranscript(rows: unknown[], meta: { taskId?: string } = {}): LoadedTrace {
  let clock = 0;
  const rec = new ToolTraceRecorder({ taskId: meta.taskId ?? 'imported', harness: 'claude', now: () => clock });
  for (const r of rows as any[]) {
    const t = typeof r?.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(t)) clock = t;
    const content = r?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (r.type === 'assistant' && b?.type === 'tool_use') rec.onToolUse({ id: b.id, name: b.name, input: b.input });
      else if (r.type === 'user' && b?.type === 'tool_result') rec.onToolResult({ tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error === true });
    }
  }
  rec.close();
  return {
    source: 'claude_transcript',
    header: { harness: 'claude', taskId: meta.taskId ?? 'imported', model: null },
    events: [...rec.events], counters: { ...rec.counters },
    limits: [
      'Imported from a transcript: exit codes are parsed from result text or inferred from is_error.',
      'Timings are differences between transcript line timestamps and are approximate.',
      'File changes made outside recorded tool calls are invisible, so repeats may be over- or under-reported.',
      'No Codex desktop import exists; only sessions run through the runner adapter are traced for Codex.',
    ],
  };
}

export function loadTraceFile(path: string, format: 'auto' | 'trace' | 'claude-transcript' = 'auto'): LoadedTrace {
  const rows = lines(readFileSync(path, 'utf8'));
  const fmt = format === 'auto' ? detectFormat(rows) : format;
  if (fmt === 'trace') return loadRunnerTrace(rows);
  if (fmt === 'claude-transcript') return importClaudeTranscript(rows);
  throw new Error('Unrecognised file: expected a runner trace or a Claude Code transcript (JSON Lines).');
}

export interface ToolTraceReport {
  analyserVersion: string;
  schemaVersion: number;
  source: TraceSource;
  harness: string;
  taskId: string;
  model: string | null;
  calls: number;
  findings: ToolFinding[];
  aggregate: ToolEfficiencyAggregate;
  limits: string[];
  /** Always true: findings are heuristics over a trace, not verdicts. */
  heuristic: true;
}

export function buildReport(t: LoadedTrace): ToolTraceReport {
  const findings = analyseToolTrace(t.events);
  const aggregate = buildToolEfficiencyAggregate({ header: { harness: t.header.harness }, events: t.events, counters: t.counters, findings });
  return {
    analyserVersion: ANALYSER_VERSION, schemaVersion: 1, source: t.source, harness: t.header.harness,
    taskId: t.header.taskId, model: t.header.model ?? null, calls: t.events.length, findings, aggregate, limits: t.limits, heuristic: true,
  };
}

export function renderText(r: ToolTraceReport): string {
  const out: string[] = [];
  out.push(`Tool efficiency report (analyser ${r.analyserVersion}, source ${r.source})`);
  out.push(`Task ${r.taskId}  harness ${r.harness}  model ${r.model ?? 'unknown'}  calls ${r.calls}`);
  const c = r.aggregate.coverage;
  out.push(`Coverage: ${c.recorded} recorded, ${c.dropped} dropped, ${c.unobserved} without a result.`);
  const t = r.aggregate.timing;
  out.push(`Timing: ${t.observedCalls} timed calls, median ${t.p50Ms ?? 'n/a'} ms, p90 ${t.p90Ms ?? 'n/a'} ms.`);
  out.push('');
  if (!r.findings.length) out.push('No findings.');
  for (const f of r.findings) {
    out.push(`- ${f.kind} [${f.confidence}] ${f.reason}`);
    out.push(`    calls: ${f.evidence.map((e) => `#${e.seq}(${e.callId})`).join(', ')}`);
  }
  out.push('');
  out.push('These are heuristic observations, not verdicts. Limits of this source:');
  for (const l of r.limits) out.push(`  * ${l}`);
  return out.join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const fi = args.indexOf('--format');
  const format = (fi >= 0 ? args[fi + 1] : 'auto') as 'auto' | 'trace' | 'claude-transcript';
  if (!file) { console.error('usage: tool-trace-report.ts <file> [--json] [--format auto|trace|claude-transcript]'); process.exit(2); }
  try {
    const report = buildReport(loadTraceFile(file, format));
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderText(report));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
