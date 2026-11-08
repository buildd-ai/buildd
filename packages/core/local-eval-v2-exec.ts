/**
 * Executing a v2 run: the pure half (spec: coding-eval-playground, "Execution").
 *
 * `scripts/local-eval/v2-exec.ts` does the I/O (export, subprocess, verifier,
 * files). Everything here is deterministic and is what the tests pin: the
 * versioned harness treatment, the prompt, how an agent exit is classified,
 * how a candidate is scored, the run record, the model profile, sealed
 * content import and the per-split readout.
 *
 * Nothing here reads a reference solution. Grading takes the candidate's own
 * output and the hidden verifier's verdict on the candidate tree.
 */
import { createHash } from 'node:crypto';
import type { RunRecord, RunDetailV2 } from './local-eval';
import {
  APPROX_TOKEN_COUNTER, GRADER_IDS, SCORING_VERSION_V2, SUITE_VERSION_V2,
  buildEvidence, checkFit, computeContentHash, gradeCompaction, gradeFind, gradeReview, namedPaths, scoreRunV2, validateManifestV2,
  type CaseFiles, type CaseManifestV2, type EvidenceBuild, type EvidencePosition, type FindAnswer, type OverflowRecord, type ReviewFinding,
  type ScoreV2, type StageCheck, type StoredArtifact,
} from './local-eval-v2';
import type { PlannedRun, RunPolicy, SealedDescriptor, Split } from './local-eval-v2-ops';
import { wilsonInterval, type Interval } from './stat-intervals';

// ─── Harness treatment ───────────────────────────────────────────────────────

/**
 * The fixed, versioned harness configuration. Claude Code's default system
 * prompt and full tool set do not fit a 16K local context, so v2 runs replace
 * the system prompt and name the tools. A change here is a new treatment id:
 * results from two treatments are never one comparison.
 */
export const HARNESS_TREATMENT_V2 = {
  id: 'claude-code-minimal-v1',
  systemPrompt: [
    'You are a software engineering agent working in a local repository: the current directory.',
    'Complete the task in the user message using the tools you have. Read files before you change them.',
    'Change only what the task asks for. When the task asks for an output file, write it in exactly the format given.',
    'Nobody will answer questions: decide and work. Stop when the task is done.',
  ].join('\n'),
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
  /** Flags that keep the harness's own context small and the operator's setup out of the run. */
  // The transport shape a CPU-only check against a mock Anthropic endpoint confirmed: one request,
  // the replaced system prompt, exactly these tools, no MCP servers, no settings sources.
  flags: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'],
  /**
   * Tokens held back for the six tool schemas when checking that a prompt
   * fits. A declared allowance, not a tokenizer count: with Claude Code
   * 2.1.310 the first request of this treatment against a mock endpoint was
   * about 25.6K characters of JSON, almost all of it the tool schemas (about
   * 6K tokens at chars/4).
   */
  toolSchemaTokens: 6144,
  /** Per-request output cap (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`), reserved in the fit check. */
  maxOutputTokens: 2048,
  /** Extended thinking is off (`MAX_THINKING_TOKENS=0`): a thinking model's hidden tokens would otherwise eat the window unreported. */
  thinking: 'disabled' as const,
  /** Everything the fit check holds back besides the system prompt and the prompt. */
  get reserveTokens(): number { return this.toolSchemaTokens + this.maxOutputTokens; },
  /** Compaction is the harness's own mechanism at the loaded window (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`). */
  compaction: 'claude-code auto-compact at the loaded context',
} as const;

export function treatmentHash(t: { id: string; systemPrompt: string; tools: readonly string[]; flags: readonly string[]; maxOutputTokens: number; thinking: string; toolSchemaTokens: number } = HARNESS_TREATMENT_V2): string {
  return createHash('sha256').update(JSON.stringify({ id: t.id, systemPrompt: t.systemPrompt, tools: t.tools, flags: t.flags, maxOutputTokens: t.maxOutputTokens, thinking: t.thinking, toolSchemaTokens: t.toolSchemaTokens })).digest('hex');
}

/** Things this harness cannot measure; recorded on every run so a reader does not mistake them for zero. */
export const HARNESS_UNKNOWNS_V2 = [
  'tool schema tokens are not reported by the harness; reserveTokens is a declared allowance',
  'Ollama may truncate input beyond num_ctx without reporting it; truncation is unknown unless the agent reports an overflow',
  'token counts before the run use approx-chars/4, not the model tokenizer',
  'toolBudget is recorded and checked after the run; the harness does not stop at it',
  'filesystem isolation is by location (a fresh temporary directory outside the repository and the run output, an empty HOME), not a sandbox: an agent that searches the whole disk by absolute path is not stopped',
  'network is not blocked by the harness',
];

// ─── Prompt ──────────────────────────────────────────────────────────────────

export type AnswerChannel = 'file' | 'final-message';

export interface PromptV2 {
  text: string;
  hash: string;
  /** Extra files placed in the agent tree before its baseline commit (tool-retrieval evidence). Derived from the snapshot only. */
  extraFiles: CaseFiles;
  evidence: (Omit<EvidenceBuild, 'text'> & { size: number }) | null;
  /** Estimated tokens of system prompt + prompt + reserve, and how they were counted. */
  estimatedTokens: number;
  tokenMethod: string;
  overflow: OverflowRecord | null;
  answerChannel: AnswerChannel;
}

/** Which file the case asks the agent to write, for cases whose output is an answer rather than code. */
export function answerFileOf(m: CaseManifestV2): string | null {
  if (m.category === 'code-review') return 'review.json';
  if (m.category === 'find-by-behaviour' || m.category === 'long-context-requirements') return 'answer.json';
  return null;
}

/** Default evidence size for a context: the largest the case is built for that is below the window, else the smallest (which then records overflow). */
export function defaultEvidenceSize(sizes: number[], contextTokens: number): number {
  const s = [...sizes].sort((a, b) => a - b);
  const below = s.filter((x) => x < contextTokens);
  return below.length ? below[below.length - 1] : s[0];
}

export function fillerPool(filler: string): string[] {
  return filler.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/**
 * The exact text the agent receives. The case instruction is used verbatim;
 * the harness adds evidence (long-context cases) and the budget line. Nothing
 * from the verifier, reference, rubric or candidates is read.
 */
export function buildPromptV2(i: {
  manifest: CaseManifestV2;
  files: CaseFiles;
  track: RunPolicy['track'];
  contextTokens: number;
  evidenceSize?: number;
  position?: EvidencePosition;
  toolCalling: boolean;
  systemPrompt?: string;
  reserveTokens?: number;
}): PromptV2 {
  const m = i.manifest;
  const instr = i.files[m.files.instruction];
  if (instr === undefined) throw new Error(`instruction missing: ${m.files.instruction}`);
  const extraFiles: CaseFiles = {};
  let text = instr.trimEnd();
  let evidence: PromptV2['evidence'] = null;
  let overflow: OverflowRecord | null = null;
  if (m.category === 'long-context-requirements') {
    const needles = JSON.parse(i.files['snapshot/evidence/needles.json'] ?? 'null') as { id: string; text: string }[] | null;
    const filler = i.files['snapshot/evidence/filler.md'];
    if (!Array.isArray(needles) || filler === undefined) throw new Error(`${m.id}: long-context case without snapshot/evidence/needles.json and filler.md`);
    const size = i.evidenceSize ?? defaultEvidenceSize(m.longContext?.sizes ?? [8192], i.contextTokens);
    const position = i.position ?? 'dispersed';
    const b = buildEvidence({ pool: fillerPool(filler), needles, targetTokens: size, position });
    if ('kind' in b) overflow = b;
    else {
      const { text: evText, ...meta } = b;
      evidence = { ...meta, size };
      if (i.track === 'tool-retrieval') {
        extraFiles[`evidence/context-${size}.md`] = evText;
        text += `\n\nThe combined evidence (${size}-token set) is in \`evidence/context-${size}.md\`.`;
      } else {
        text += `\n\nThe combined evidence (${size}-token set) follows in full; it is the same material as \`evidence/\`.\n\n<evidence>\n${evText}</evidence>`;
      }
    }
  }
  const answer = answerFileOf(m);
  const channel: AnswerChannel = !i.toolCalling && answer ? 'final-message' : 'file';
  if (channel === 'final-message') text += `\n\nYou have no tools in this run. Reply with only the JSON that the task says to write to \`${answer}\`; the harness writes it there.`;
  text += `\n\nBudget: at most ${m.resources.maxTurns} turns and ${m.resources.toolBudget} tool calls.\n`;
  const sys = i.systemPrompt ?? HARNESS_TREATMENT_V2.systemPrompt;
  const estimatedTokens = APPROX_TOKEN_COUNTER.count(sys) + APPROX_TOKEN_COUNTER.count(text) + (i.reserveTokens ?? HARNESS_TREATMENT_V2.reserveTokens);
  overflow ??= checkFit(estimatedTokens, i.contextTokens);
  const hash = createHash('sha256').update(`${sys}\0${text}`).digest('hex');
  return { text, hash, extraFiles, evidence, estimatedTokens, tokenMethod: APPROX_TOKEN_COUNTER.method, overflow, answerChannel: channel };
}

// ─── Agent exit classification ───────────────────────────────────────────────

export interface AgentExit { code: number; out: string; err: string; timedOut: boolean; spawnError: string | null }

export type ExitKind = 'completed' | 'budget_exhausted' | 'harness' | 'infra' | 'overflow';

export interface ExitClass {
  kind: ExitKind;
  note: string;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number | null;
  toolCalls: number | null;
  /** The agent's final message text, when the harness reported one. */
  resultText: string | null;
}

const OVERFLOW_RE = /prompt is too long|context length|context window|exceeds? (the )?(maximum )?context|too many tokens|input length .* exceeds/i;
const INFRA_RE = /ECONNREFUSED|ECONNRESET|connection error|fetch failed|unable to connect|socket hang up|API Error: 5\d\d|status code 5\d\d|overloaded|out of memory|CUDA error/i;

/** Parse Claude Code's `stream-json` (or a single `json`) output. Unknown fields stay null. */
export function parseAgentStream(stdout: string): { result: any | null; toolCalls: number | null } {
  let result: any = null;
  let tools = 0; let sawAssistant = false;
  for (const line of stdout.split('\n')) {
    const t = line.trim(); if (!t.startsWith('{')) continue;
    let o: any; try { o = JSON.parse(t); } catch { continue; }
    if (o?.type === 'assistant' && Array.isArray(o.message?.content)) { sawAssistant = true; tools += o.message.content.filter((b: any) => b?.type === 'tool_use').length; }
    if (o?.type === 'result') result = o;
  }
  return { result, toolCalls: sawAssistant ? tools : null };
}

/**
 * What the agent's exit means, before any grading. A model that ran out of
 * turns or wall clock is graded on what it left (a model outcome). A harness
 * that could not start or crashed, an unreachable or failing server and an
 * overflowing context are not model failures.
 */
export function classifyAgentExit(x: AgentExit): ExitClass {
  const { result, toolCalls } = parseAgentStream(x.out);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const u = result?.usage ?? {};
  const inParts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(n);
  const base = {
    inputTokens: inParts.some((v) => v !== null) ? inParts.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
    outputTokens: n(u.output_tokens), turns: n(result?.num_turns), toolCalls,
    resultText: typeof result?.result === 'string' ? result.result : null,
  };
  const all = `${base.resultText ?? ''}\n${x.err}`;
  if (x.spawnError) return { ...base, kind: 'harness', note: `agent could not start: ${x.spawnError}` };
  // A run that hit the wall clock while the server was failing is the server's failure, not the model's.
  if (x.timedOut && INFRA_RE.test(all)) return { ...base, kind: 'infra', note: 'wall-clock reached while the model server was failing or unreachable' };
  if (x.timedOut) return { ...base, kind: 'budget_exhausted', note: 'wall-clock budget reached; graded on the tree it left' };
  if (result) {
    if (result.is_error || (typeof result.subtype === 'string' && result.subtype !== 'success')) {
      if (result.subtype === 'error_max_turns') return { ...base, kind: 'budget_exhausted', note: 'turn budget reached; graded on the tree it left' };
      if (OVERFLOW_RE.test(all)) return { ...base, kind: 'overflow', note: 'the model server reported the context was exceeded' };
      if (INFRA_RE.test(all)) return { ...base, kind: 'infra', note: 'the model server failed or was unreachable' };
      return { ...base, kind: 'harness', note: `agent reported an error (${String(result.subtype ?? 'unknown')})` };
    }
    return { ...base, kind: 'completed', note: 'agent finished' };
  }
  if (OVERFLOW_RE.test(all)) return { ...base, kind: 'overflow', note: 'the model server reported the context was exceeded' };
  if (INFRA_RE.test(all)) return { ...base, kind: 'infra', note: 'the model server failed or was unreachable' };
  return { ...base, kind: 'harness', note: `agent exited ${x.code} without a result record` };
}

/** The last JSON object in a final message, for the no-tools answer channel. Null when there is none. */
export function extractJsonAnswer(text: string | null): string | null {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  const candidates = [...fenced.reverse(), text.trim()];
  for (const c of candidates) {
    const start = c.indexOf('{'); const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try { JSON.parse(c.slice(start, end + 1)); return c.slice(start, end + 1) + '\n'; } catch { /* next */ }
  }
  return null;
}

// ─── Tampering ───────────────────────────────────────────────────────────────

/** Visible test files shipped in the snapshot (paths in the agent tree). */
export function visibleTestPaths(m: CaseManifestV2): string[] {
  return m.files.snapshot.filter((p) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(p)).map((p) => p.replace(/^snapshot\//, '')).sort();
}

/** Editing or deleting a shipped test is tampering. Adding a test is not. */
export function tamperingV2(changed: { path: string; status: 'added' | 'modified' | 'deleted' }[], m: CaseManifestV2): string[] {
  const tests = new Set(visibleTestPaths(m));
  return changed.filter((c) => tests.has(c.path) && c.status !== 'added').map((c) => `${c.status} test ${c.path}`);
}

// ─── Grading a candidate ─────────────────────────────────────────────────────

export interface VerifierRun { ran: boolean; passed: boolean | null; stdout: string }

export interface CandidateOutputs {
  /** Contents of the answer file the case asks for, as the agent left it; null when absent. */
  answer: string | null;
}

export interface GradeV2 {
  score: ScoreV2;
  flags: string[];
  detail: NonNullable<RunDetailV2['detail']>;
  absenceClaimed: boolean;
  /** Pure-grader artifacts for `regrade`. The expected value is hidden material and stays in the run directory, never in the agent tree. */
  artifacts: StoredArtifact[];
  tampering: string[];
  leaks: string[];
}

const KNOWN_FLAGS = new Set(['fabrication', 'wrong_abstention', 'followed_superseded', 'constraint_dropped']);

function parseJson<T>(s: string | null): T | null { if (s === null) return null; try { return JSON.parse(s) as T; } catch { return null; } }

/** The stage vector the terminal/compaction verifier prints (`{"stages": [...]}`); null when absent. */
export function parseStageVector(stdout: string): StageCheck[] | null {
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim(); if (!t.startsWith('{')) continue;
    const o = parseJson<{ stages?: StageCheck[] }>(t);
    if (o && Array.isArray(o.stages)) return o.stages;
  }
  return null;
}

/**
 * Score one run. The hidden verifier is the authority on the candidate; the
 * pure graders add the flags and drilldown the spec asks for (fabrication,
 * review precision and recall, per-stage retention). `exit` decides whether
 * grading happens at all: a harness or infra error is never graded as a model.
 */
export function gradeRunV2(i: {
  runId: string;
  manifest: CaseManifestV2;
  exit: ExitClass | null;
  overflow: OverflowRecord | null;
  unsupported: string | null;
  leaks: string[];
  tampering: string[];
  verifier: VerifierRun;
  visible: { ran: boolean; passed: boolean | null } | null;
  outputs: CandidateOutputs;
  toolBudget: number;
  contextTokens: number;
}): GradeV2 {
  const m = i.manifest;
  const flags: string[] = [];
  const detail: GradeV2['detail'] = {};
  const artifacts: StoredArtifact[] = [];
  let absenceClaimed = false;
  const graded = !!i.exit && (i.exit.kind === 'completed' || i.exit.kind === 'budget_exhausted') && !i.overflow && !i.unsupported;
  if (graded) {
    if (i.exit!.kind === 'budget_exhausted') flags.push('budget_exhausted');
    if (i.exit!.toolCalls !== null && i.exit!.toolCalls > i.toolBudget) flags.push('tool_budget_exceeded');
    const e = m.expected;
    if (e.kind === 'answer' || e.kind === 'abstain') {
      const a = parseJson<FindAnswer>(i.outputs.answer);
      const ans: FindAnswer = a && typeof a === 'object' ? { ...a, citations: Array.isArray(a.citations) ? a.citations : [] } : { citations: [] };
      absenceClaimed = ans.abstain === true;
      const g = gradeFind(ans, e);
      for (const n of g.notes) if (KNOWN_FLAGS.has(n)) flags.push(n);
      if (e.kind === 'answer') { detail.citationsTotal = e.locations.length; detail.citationsCorrect = g.metrics.recall === null || g.metrics.recall === undefined ? null : Math.round(g.metrics.recall * e.locations.length); }
      artifacts.push({ runId: i.runId, caseId: m.id, graderId: GRADER_IDS.find, output: ans, expected: e, recorded: { pass: g.pass, graderId: GRADER_IDS.find } });
    } else if (e.kind === 'review') {
      const r = parseJson<{ findings?: ReviewFinding[] }>(i.outputs.answer);
      const findings = Array.isArray(r?.findings) ? r!.findings.filter((f) => f && typeof f.file === 'string' && typeof f.line === 'number' && typeof f.description === 'string') : [];
      const g = gradeReview(findings, e.defects);
      detail.precision = g.metrics.precision ?? null; detail.recall = g.metrics.recall ?? null; detail.falsePositives = g.metrics.falsePositives ?? null;
      artifacts.push({ runId: i.runId, caseId: m.id, graderId: GRADER_IDS.review, output: findings, expected: { defects: e.defects }, recorded: { pass: g.pass, graderId: GRADER_IDS.review } });
    } else if (m.category === 'long-context-requirements') {
      const a = parseJson<{ abstain?: boolean }>(i.outputs.answer);
      absenceClaimed = a?.abstain === true;
    }
    if (m.category === 'terminal-recovery-compaction' && i.verifier.ran) {
      const stages = parseStageVector(i.verifier.stdout);
      if (stages) {
        const g = gradeCompaction(stages);
        if (g.notes.includes('constraint_dropped')) flags.push('constraint_dropped');
        detail.retention = g.retention;
        artifacts.push({ runId: i.runId, caseId: m.id, graderId: GRADER_IDS.compaction, output: stages, expected: null, recorded: { pass: g.pass, graderId: GRADER_IDS.compaction } });
      }
    }
  }
  const score = scoreRunV2({
    graderId: GRADER_IDS.verifier,
    unsupported: i.unsupported,
    harnessError: i.exit?.kind === 'harness',
    infraError: i.exit?.kind === 'infra',
    // A server-reported overflow carries the counts the harness saw; when it reported none, the input is at least the window.
    overflow: i.overflow ?? (i.exit?.kind === 'overflow' ? { kind: 'overflow', inputTokens: Math.max(i.exit.inputTokens ?? 0, i.contextTokens), contextTokens: i.contextTokens, tokensOver: Math.max(0, (i.exit.inputTokens ?? i.contextTokens) - i.contextTokens) } : null),
    verifier: graded ? { ran: i.verifier.ran, passed: i.verifier.passed } : { ran: false, passed: null },
    visible: i.visible, tampering: i.tampering, leaks: i.leaks, flags,
  });
  return { score, flags: [...new Set(flags)], detail, absenceClaimed, artifacts, tampering: i.tampering, leaks: i.leaks };
}

// ─── Run record ──────────────────────────────────────────────────────────────

export interface RunContextV2 {
  planned: PlannedRun;
  manifest: CaseManifestV2;
  split: Split;
  policy: RunPolicy;
  model: { tag: string; digest: string | null; quantization: string | null };
  harness: { name: string; version: string | null };
  runtime: RunRecord['runtime'];
  promptHash: string;
  startedAt: Date;
  endedAt: Date;
  exit: ExitClass | null;
  peakVramMb: number | null;
  vramSamples: number | null;
  verifier: VerifierRun;
  visible: { ran: boolean; passed: boolean | null } | null;
  grade: GradeV2;
  note: string | null;
}

export function buildRunRecordV2(c: RunContextV2, suiteId = 'coding-playground'): RunRecord {
  const s = c.grade.score;
  return {
    runId: c.planned.runId, suiteId, suiteVersion: SUITE_VERSION_V2, scoringVersion: SCORING_VERSION_V2, caseId: c.manifest.id, trial: c.planned.trial, configId: c.planned.configId,
    model: c.model, contextTokens: c.policy.contextTokens, promptHash: c.promptHash, harness: c.harness, runtime: c.runtime,
    startedAt: c.startedAt.toISOString(), endedAt: c.endedAt.toISOString(), durationMs: Math.max(0, c.endedAt.getTime() - c.startedAt.getTime()),
    inputTokens: c.exit?.inputTokens ?? null, outputTokens: c.exit?.outputTokens ?? null, turns: c.exit?.turns ?? null,
    peakVramMb: c.peakVramMb, vramSamples: c.vramSamples,
    result: s.result,
    hidden: { ran: c.verifier.ran, passed: c.verifier.passed },
    // A case with no visible checks records "did not run"; v2.detail and the notes say there were none.
    visible: c.visible ?? { ran: false, passed: null },
    tampering: c.grade.tampering,
    leaks: c.grade.leaks,
    review: null,
    harnessNote: c.note ? c.note.slice(0, 500) : null,
    v2: {
      category: c.manifest.category, split: c.split, graderId: s.graderId, failureClass: s.result === 'pass' ? null : s.failureClass,
      track: c.policy.track, retrievalPolicy: c.policy.retrievalPolicy, skills: [...c.manifest.labels.skills], difficulty: c.manifest.labels.difficulty,
      ...(c.grade.flags.length ? { flags: c.grade.flags.slice(0, 20) } : {}),
      ...(c.grade.absenceClaimed ? { absenceClaimed: true } : {}),
      ...(Object.keys(c.grade.detail).length ? { detail: c.grade.detail } : {}),
    },
  };
}

/** One line per run, typed, for the CLI and for tests. */
export interface CaseResultV2 {
  runId: string;
  caseId: string;
  trial: number;
  split: Split;
  outcome: 'pass' | 'fail' | 'invalid' | 'error' | 'unscored' | 'skipped';
  failureClass: 'model' | 'harness' | 'infra' | null;
  notes: string[];
}

// ─── Model profile ───────────────────────────────────────────────────────────

export interface ModelEntryV2 { tag: string; digest: string | null; estimatedVramMb: number | null; tier?: string }
export interface ModelsV2 { modelsFormatVersion: 2; note?: string; models: ModelEntryV2[] }

export function validateModelsV2(j: unknown): string[] {
  const o = j as Partial<ModelsV2>;
  const errs: string[] = [];
  if (!o || o.modelsFormatVersion !== 2) errs.push('models.json: modelsFormatVersion must be 2');
  if (!Array.isArray(o?.models)) return [...errs, 'models.json: models must be an array'];
  const seen = new Set<string>();
  for (const m of o.models) {
    if (!m || typeof m.tag !== 'string' || !m.tag) { errs.push('models.json: every model needs a tag'); continue; }
    if (seen.has(m.tag)) errs.push(`models.json: duplicate tag ${m.tag}`);
    seen.add(m.tag);
    if (m.digest !== null && typeof m.digest !== 'string') errs.push(`models.json: ${m.tag} digest must be a string or null`);
    if (m.estimatedVramMb !== null && !(typeof m.estimatedVramMb === 'number' && m.estimatedVramMb > 0)) errs.push(`models.json: ${m.tag} estimatedVramMb must be positive or null`);
  }
  return errs;
}

// ─── Sealed holdout content ──────────────────────────────────────────────────

/**
 * Whether out-of-repository content may stand in for a sealed descriptor. Its
 * id, version and category must match the descriptor and its recomputed hash
 * must equal the published one, so the content run is the content that was
 * sealed. Empty = usable.
 */
export function verifySealedContent(d: SealedDescriptor & { contentHash?: string }, m: CaseManifestV2, files: CaseFiles): string[] {
  const errs = validateManifestV2(m, files).map((e) => `sealed ${d.id}: ${e}`);
  if (m.id !== d.id) errs.push(`sealed ${d.id}: content is case ${m.id}`);
  if (m.version !== d.version) errs.push(`sealed ${d.id}: content is version ${m.version}, descriptor is ${d.version}`);
  if (m.category !== d.category) errs.push(`sealed ${d.id}: content category ${m.category}, descriptor ${d.category}`);
  if (!d.contentHash) errs.push(`sealed ${d.id}: descriptor publishes no contentHash`);
  else {
    let h: string | null = null;
    try { h = computeContentHash(files, namedPaths(m)); } catch (e) { errs.push(`sealed ${d.id}: ${(e as Error).message}`); }
    if (h !== null && h !== d.contentHash) errs.push(`sealed ${d.id}: content hash ${h.slice(0, 12)} does not match the published ${d.contentHash.slice(0, 12)}`);
  }
  return errs;
}

// ─── Readout ─────────────────────────────────────────────────────────────────

export interface ReadoutRow {
  configId: string;
  harness: string;
  split: string;
  track: string;
  category: string;
  runs: number;
  pass: number;
  /** Model failures: fail, and invalid with failureClass model. */
  modelFail: number;
  harnessErrors: number;
  infraErrors: number;
  unscored: number;
  /** pass / (pass + modelFail); null when nothing resolved. Harness and infra errors are counts beside it, never in it. */
  passRate: number | null;
  interval: Interval;
  flags: Record<string, number>;
}

/** Per configuration, split, track and category. Splits are never pooled. Fixture runs are labelled by their harness, not hidden. */
export function readoutV2(records: RunRecord[]): ReadoutRow[] {
  const rows = new Map<string, ReadoutRow>();
  for (const r of records) {
    if (r.suiteVersion !== SUITE_VERSION_V2 || !r.v2) continue;
    const k = [r.configId, r.harness.name, r.v2.split, r.v2.track ?? 'single-context', r.v2.category].join('\u0000');
    let row = rows.get(k);
    if (!row) { row = { configId: r.configId, harness: r.harness.name, split: r.v2.split, track: r.v2.track ?? 'single-context', category: r.v2.category, runs: 0, pass: 0, modelFail: 0, harnessErrors: 0, infraErrors: 0, unscored: 0, passRate: null, interval: wilsonInterval(0, 0), flags: {} }; rows.set(k, row); }
    row.runs++;
    if (r.result === 'pass') row.pass++;
    else if (r.result === 'unscored') row.unscored++;
    else if (r.v2.failureClass === 'harness') row.harnessErrors++;
    else if (r.v2.failureClass === 'infra') row.infraErrors++;
    else row.modelFail++;
    for (const f of r.v2.flags ?? []) row.flags[f] = (row.flags[f] ?? 0) + 1;
  }
  return [...rows.values()].map((row) => {
    const n = row.pass + row.modelFail;
    return { ...row, passRate: n ? row.pass / n : null, interval: wilsonInterval(row.pass, n) };
  }).sort((a, b) => [a.configId, a.split, a.track, a.category].join().localeCompare([b.configId, b.split, b.track, b.category].join()));
}
