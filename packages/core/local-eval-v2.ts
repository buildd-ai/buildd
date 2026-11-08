/**
 * Coding evaluation playground, v2: pure rules (spec: coding-eval-playground).
 *
 * Extends `local-eval.ts` without changing it: v1 suite bytes and `score-v1`
 * stay as they are. Nothing here touches disk, Git, Ollama or the database;
 * `scripts/local-eval/v2.ts` does the I/O. Everything here is deterministic,
 * so a stored artifact regrades to the same score under the same grader id.
 */
import { createHash } from 'node:crypto';
import { gpuGate } from './local-eval';

export const SUITE_VERSION_V2 = 'v2';
export const SCORING_VERSION_V2 = 'score-v2';
export const MANIFEST_FORMAT_VERSION = 2;

export const CATEGORIES = [
  'find-by-behaviour',
  'causal-debugging',
  'multi-file-change',
  'code-review',
  'long-context-requirements',
  'terminal-recovery-compaction',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const DIFFICULTIES_V2 = ['easy', 'medium', 'hard'] as const;
export const CONTEXT_SIZES = [8192, 16384, 32768] as const;
export const POSITIONS = ['start', 'middle', 'end', 'dispersed'] as const;
export type EvidencePosition = (typeof POSITIONS)[number];

/** Scoring version a suite version must be scored (and ingested) with. */
export function scoringVersionForSuite(suiteVersion: string): string | null {
  if (suiteVersion === SUITE_VERSION_V2) return SCORING_VERSION_V2;
  if (suiteVersion === 'v1') return 'score-v1';
  return null;
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export type Expected =
  | { kind: 'answer'; locations: ExpectedLocation[]; decoys?: string[]; liveSite?: string }
  | { kind: 'abstain'; searchScope: AbsenceAudit }
  | { kind: 'review'; defects: SeededDefect[] }
  | { kind: 'verifier' };

export interface ExpectedLocation { file: string; symbol?: string; startLine?: number; endLine?: number }

/** Gate 4: everything searched, how, by whom, and a second confirmer. */
export interface AbsenceAudit {
  filesSearched: string[] | 'all-snapshot';
  dependencyTreeSearched: boolean;
  generatedAndConfigSearched: boolean;
  identifiers: string[];
  behaviourKeywords: string[];
  method: string;
  auditor: string;
  confirmer: string | null;
}

export interface CaseManifestV2 {
  formatVersion: 2;
  id: string;
  version: number;
  contentHash: string;
  category: Category;
  /** Paths are relative to the case directory. Every one is hashed. */
  files: {
    snapshot: string[];
    instruction: string;
    verifier: string[];
    reference: string[];
    rubric: string | null;
    /** Overlay trees (files under `candidates/<name>/`) used only by admission. */
    candidates: { broken: string[]; alternative: string | null; files: string[] };
  };
  deps: Record<string, string>;
  resources: {
    cpuOnly: boolean;
    estimatedVramMb: number | null;
    estimatedRamMb: number | null;
    wallClockSeconds: number;
    maxTurns: number;
    toolBudget: number;
  };
  labels: { difficulty: (typeof DIFFICULTIES_V2)[number]; skills: string[] };
  /** Does the case expose an incorrect absence/success conclusion? Needs two broken candidates. */
  exposing: boolean;
  provenance: { source: 'authored' | 'this-repo'; licence: string; note: string };
  contamination: string;
  expected: Expected;
  admission: AdmissionRecord | null;
  /** Long-context cases only. */
  longContext?: { sizes: number[]; positions: EvidencePosition[] };
}

export interface AdmissionRecord {
  admittedOn: string | null;
  toolchain: string;
  gates: GateResult[];
}

export interface GateResult { gate: AdmissionGate; ok: boolean; detail: string }

const TEXT_ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Path segments that must never be inside an agent tree. */
const HIDDEN_PATH = /(^|\/)(verifier|reference|candidates|rubric|admission|review-calibration|local-suite|\.git)(\/|$)|(^|\/)(case|suite)\.json$|(^|\/)(reference|solution)[^/]*\.(patch|diff)$/i;

export type CaseFiles = Record<string, string>;

/** Every path the manifest names (the bytes `contentHash` covers). */
export function namedPaths(m: CaseManifestV2): string[] {
  const f = m.files;
  return [...new Set([...f.snapshot, f.instruction, ...f.verifier, ...f.reference, ...(f.rubric ? [f.rubric] : []), ...f.candidates.files])].sort();
}

/** SHA-256 over canonical bytes: sorted `path\0length\0content\0` records. Order and platform independent. */
export function computeContentHash(files: CaseFiles, paths: string[]): string {
  const h = createHash('sha256');
  for (const p of [...paths].sort()) {
    const c = files[p];
    if (c === undefined) throw new Error(`named file missing: ${p}`);
    h.update(`${p}\0${Buffer.byteLength(c)}\0`).update(c).update('\0');
  }
  return h.digest('hex');
}

function safeRel(p: string): boolean {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.split('/').includes('..');
}

/** Errors that make one manifest unusable; with `files`, also checks the hash and that named files exist. */
export function validateManifestV2(m: CaseManifestV2, files?: CaseFiles): string[] {
  const errs: string[] = [];
  const at = `case ${m?.id ?? '?'}`;
  if (!m || typeof m !== 'object') return ['manifest must be an object'];
  if (m.formatVersion !== MANIFEST_FORMAT_VERSION) errs.push(`${at}: formatVersion must be ${MANIFEST_FORMAT_VERSION}`);
  if (!TEXT_ID.test(m.id ?? '')) errs.push(`${at}: id must be kebab-case`);
  if (!Number.isInteger(m.version) || m.version < 1) errs.push(`${at}: version must be a positive integer`);
  if (!SHA256.test(m.contentHash ?? '')) errs.push(`${at}: contentHash must be a sha-256 hex digest`);
  if (!CATEGORIES.includes(m.category)) errs.push(`${at}: unknown category ${String(m.category)}`);
  const f = m.files;
  if (!f || !Array.isArray(f.snapshot) || !f.snapshot.length || typeof f.instruction !== 'string' || !Array.isArray(f.verifier) || !f.verifier.length || !Array.isArray(f.reference) || !f.reference.length || !f.candidates) {
    errs.push(`${at}: files needs snapshot, instruction, verifier, reference and candidates`);
  } else {
    for (const p of namedPaths(m)) if (!safeRel(p)) errs.push(`${at}: unsafe path ${p}`);
    for (const p of f.snapshot) if (HIDDEN_PATH.test(p)) errs.push(`${at}: snapshot path ${p} looks like hidden material`);
    const snap = new Set(f.snapshot);
    for (const p of [...f.verifier, ...f.reference, ...f.candidates.files]) if (snap.has(p)) errs.push(`${at}: ${p} is both in the snapshot and hidden`);
    for (const p of f.verifier) if (f.reference.includes(p)) errs.push(`${at}: verifier and reference share ${p}; the verifier must be independent`);
    if (!f.candidates.broken.length) errs.push(`${at}: at least one named broken candidate is required`);
    if (m.exposing && f.candidates.broken.length < 2) errs.push(`${at}: an exposing case needs two broken candidates`);
  }
  if (!m.deps || typeof m.deps !== 'object') errs.push(`${at}: deps is required`);
  const r = m.resources;
  if (!r || typeof r.cpuOnly !== 'boolean') errs.push(`${at}: resources.cpuOnly must be a boolean`);
  else {
    if (!r.cpuOnly && !(typeof r.estimatedVramMb === 'number' && r.estimatedVramMb > 0)) errs.push(`${at}: a model-running case needs a positive estimatedVramMb`);
    if (r.estimatedVramMb !== null && !(typeof r.estimatedVramMb === 'number' && r.estimatedVramMb >= 0)) errs.push(`${at}: estimatedVramMb must be a number or null (unknown is null, never zero-by-default)`);
    if (r.estimatedRamMb !== null && typeof r.estimatedRamMb !== 'number') errs.push(`${at}: estimatedRamMb must be a number or null`);
    for (const k of ['wallClockSeconds', 'maxTurns', 'toolBudget'] as const) if (!(typeof r[k] === 'number' && r[k] > 0)) errs.push(`${at}: resources.${k} must be positive`);
  }
  if (!m.labels || !DIFFICULTIES_V2.includes(m.labels.difficulty) || !Array.isArray(m.labels.skills)) errs.push(`${at}: labels needs difficulty and skills`);
  if (typeof m.exposing !== 'boolean') errs.push(`${at}: exposing must be a boolean`);
  if (!m.provenance || !m.provenance.licence?.trim() || !m.provenance.note?.trim() || !['authored', 'this-repo'].includes(m.provenance.source)) errs.push(`${at}: provenance needs source (authored|this-repo), licence and note`);
  if (!m.contamination?.trim()) errs.push(`${at}: contamination note is required`);
  const e = m.expected;
  if (!e || !['answer', 'abstain', 'review', 'verifier'].includes(e.kind)) errs.push(`${at}: expected.kind is required`);
  else if (e.kind === 'answer' && !e.locations?.length) errs.push(`${at}: an expected answer names at least one location`);
  else if (e.kind === 'review' && !Array.isArray(e.defects)) errs.push(`${at}: expected.defects must be an array (empty for a clean control)`);
  if (m.category === 'long-context-requirements' && !m.longContext) errs.push(`${at}: long-context case needs longContext sizes and positions`);
  if (m.longContext) {
    for (const s of m.longContext.sizes) if (!(CONTEXT_SIZES as readonly number[]).includes(s)) errs.push(`${at}: long-context size ${s} is not one of ${CONTEXT_SIZES.join('/')}`);
    for (const p of m.longContext.positions) if (!POSITIONS.includes(p)) errs.push(`${at}: unknown position ${p}`);
  }
  if (m.admission?.admittedOn) {
    for (const g of ADMISSION_GATES) {
      const r2 = m.admission.gates.find((x) => x.gate === g);
      if (!r2 || !r2.ok) errs.push(`${at}: admitted without a passing ${g} gate`);
    }
  }
  if (files) {
    const missing = namedPaths(m).filter((p) => files[p] === undefined);
    for (const p of missing) errs.push(`${at}: named file missing: ${p}`);
    if (!missing.length && SHA256.test(m.contentHash ?? '') && computeContentHash(files, namedPaths(m)) !== m.contentHash) {
      errs.push(`${at}: contentHash does not match the case files (edit => new version and a new hash)`);
    }
    const text = Object.values(files).join('\n') + JSON.stringify(m);
    if (UUID.test(text)) errs.push(`${at}: contains a UUID`);
    if (files[m.files?.instruction] !== undefined) {
      const instr = files[m.files.instruction];
      for (const p of [...(f?.verifier ?? []), ...(f?.reference ?? [])]) if (instr.includes(p)) errs.push(`${at}: instruction names hidden file ${p}`);
    }
  }
  return errs;
}

export interface SuiteV2 {
  suiteId: string;
  suiteVersion: string;
  formatVersion: 2;
  scoringVersion: string;
  /** Closed list the `skills` labels come from. */
  skills: string[];
  /** Case ids to their directory names; hashes pinned so a swapped manifest is caught. */
  cases: { id: string; version: number; contentHash: string }[];
}

/** Validates the suite file against the loaded manifests/files; AC-2 names the offending case. */
export function validateSuiteV2(s: SuiteV2, manifests: Record<string, { manifest: CaseManifestV2; files: CaseFiles }>): string[] {
  const errs: string[] = [];
  if (s.suiteVersion !== SUITE_VERSION_V2) errs.push(`suiteVersion must be ${SUITE_VERSION_V2}`);
  if (s.scoringVersion !== SCORING_VERSION_V2) errs.push(`scoringVersion must be ${SCORING_VERSION_V2}`);
  if (s.formatVersion !== MANIFEST_FORMAT_VERSION) errs.push(`formatVersion must be ${MANIFEST_FORMAT_VERSION}`);
  const seen = new Set<string>();
  for (const ref of s.cases) {
    if (seen.has(ref.id)) errs.push(`case ${ref.id}: duplicate id`);
    seen.add(ref.id);
    const loaded = manifests[ref.id];
    if (!loaded) { errs.push(`case ${ref.id}: listed in the suite but no case directory`); continue; }
    errs.push(...validateManifestV2(loaded.manifest, loaded.files));
    if (loaded.manifest.id !== ref.id) errs.push(`case ${ref.id}: manifest id is ${loaded.manifest.id}`);
    if (loaded.manifest.contentHash !== ref.contentHash || loaded.manifest.version !== ref.version) errs.push(`case ${ref.id}: suite pins version ${ref.version} ${ref.contentHash.slice(0, 12)} but the case is version ${loaded.manifest.version} ${loaded.manifest.contentHash.slice(0, 12)}`);
    for (const sk of loaded.manifest.labels?.skills ?? []) if (!s.skills.includes(sk)) errs.push(`case ${ref.id}: skill ${sk} is not in the suite's closed list`);
  }
  for (const id of Object.keys(manifests)) if (!seen.has(id)) errs.push(`case ${id}: has a directory but is not listed in the suite`);
  return errs;
}

// ─── Admission ───────────────────────────────────────────────────────────────

export const ADMISSION_GATES = [
  'reference-passes',
  'negative-control-fails',
  'independent-of-patch',
  'absence-audited',
  'isolation-holds',
  'deterministic',
] as const;
export type AdmissionGate = (typeof ADMISSION_GATES)[number];

export const DETERMINISM_RUNS = 3;

/** Run the hidden verifier on one candidate tree: 'snapshot' | 'reference' | 'broken:<name>' | 'alternative'. */
export type VerifyFn = (candidate: string) => boolean | Promise<boolean>;

export interface AdmissionEvidence {
  caseId: string;
  version: number;
  contentHash: string;
  admitted: boolean;
  gates: GateResult[];
  /** Raw verdicts per candidate, kept even when the case is rejected. */
  verdicts: Record<string, boolean[]>;
  leaks: string[];
}

/**
 * Prove the case is worth running. The verifier must pass the reference and
 * an alternative correct solution, and fail the unmodified snapshot and every
 * named broken candidate. A case that fails any gate is rejected and its
 * evidence is kept.
 */
export async function admitCase(m: CaseManifestV2, verify: VerifyFn, probe: { leaks: string[] }): Promise<AdmissionEvidence> {
  const verdicts: Record<string, boolean[]> = {};
  const run = async (c: string, times = 1) => {
    const out: boolean[] = [];
    for (let i = 0; i < times; i++) out.push(await verify(c));
    verdicts[c] = out;
    return out;
  };
  const gates: GateResult[] = [];
  const gate = (g: AdmissionGate, ok: boolean, detail: string) => gates.push({ gate: g, ok, detail });

  const ref = await run('reference', DETERMINISM_RUNS);
  gate('reference-passes', ref[0] === true, ref[0] ? 'verifier passes the reference' : 'verifier FAILS the reference solution');
  gate('deterministic', ref.every((v) => v === ref[0]), ref.every((v) => v === ref[0]) ? `${DETERMINISM_RUNS} identical runs` : `reference verdicts differ across ${DETERMINISM_RUNS} runs: ${ref.join(',')}`);

  const snap = await run('snapshot');
  const brokenNames = m.files.candidates.broken;
  const brokenVerdicts: Record<string, boolean> = {};
  for (const b of brokenNames) brokenVerdicts[b] = (await run(`broken:${b}`))[0];
  const passedBad = [...(snap[0] ? ['unmodified snapshot'] : []), ...brokenNames.filter((b) => brokenVerdicts[b]).map((b) => `broken candidate ${b}`)];
  const needBroken = m.exposing ? 2 : 1;
  const negOk = !passedBad.length && brokenNames.length >= needBroken;
  gate('negative-control-fails', negOk, passedBad.length ? `verifier PASSES: ${passedBad.join(', ')}` : brokenNames.length < needBroken ? `needs ${needBroken} named broken candidates, has ${brokenNames.length}` : `fails the snapshot and ${brokenNames.length} broken candidate(s)`);

  const alt = m.files.candidates.alternative;
  if (!alt) gate('independent-of-patch', false, 'no alternative correct solution recorded');
  else {
    const a = await run('alternative');
    gate('independent-of-patch', a[0] === true, a[0] ? 'a different correct solution passes' : 'the alternative correct solution FAILS: the verifier matches the reference patch, not the behaviour');
  }

  if (m.expected.kind === 'abstain') {
    const s = m.expected.searchScope;
    const problems: string[] = [];
    if (s.filesSearched !== 'all-snapshot' && !(Array.isArray(s.filesSearched) && s.filesSearched.length)) problems.push('no recorded file scope');
    if (!s.dependencyTreeSearched) problems.push('dependency tree not searched');
    if (!s.generatedAndConfigSearched) problems.push('generated files and config not searched');
    if (!s.identifiers?.length || !s.behaviourKeywords?.length) problems.push('identifiers and behavioural keywords not recorded');
    if (!s.method?.trim() || !s.auditor?.trim()) problems.push('audit method or auditor missing');
    if (!s.confirmer?.trim()) problems.push('no second confirmer');
    else if (s.confirmer === s.auditor) problems.push('confirmer is the auditor');
    gate('absence-audited', !problems.length, problems.length ? problems.join('; ') : `scope recorded, confirmed by an independent reviewer (named in searchScope.confirmer)`);
  } else gate('absence-audited', true, 'not an answer-absent case');

  gate('isolation-holds', probe.leaks.length === 0, probe.leaks.length ? `agent tree leaks: ${probe.leaks.join('; ')}` : 'probe agent tree is clean');

  return { caseId: m.id, version: m.version, contentHash: m.contentHash, admitted: gates.every((g) => g.ok), gates, verdicts, leaks: probe.leaks };
}

// ─── Isolation export ────────────────────────────────────────────────────────

export interface AgentTree {
  /** Files the agent receives, by relative path. */
  files: CaseFiles;
  instruction: string;
  /** Always one commit, no remote. */
  git: { commits: 1; remotes: [] };
}

/**
 * Build the agent-visible tree: snapshot files and the instruction only.
 * Verifier, reference, rubric, candidates, history and suite files are
 * withheld by construction, not by filtering a bigger tree.
 */
export function exportAgentTree(m: CaseManifestV2, files: CaseFiles): AgentTree {
  const out: CaseFiles = {};
  for (const p of m.files.snapshot) {
    const c = files[p];
    if (c === undefined) throw new Error(`snapshot file missing: ${p}`);
    out[p.replace(/^snapshot\//, '')] = c;
  }
  const instr = files[m.files.instruction];
  if (instr === undefined) throw new Error(`instruction missing: ${m.files.instruction}`);
  return { files: out, instruction: instr, git: { commits: 1, remotes: [] } };
}

export interface TreeProbe { files: CaseFiles; commits: string[]; remotes: string[] }

/** Anything in an agent tree that gives away the answer. Empty = isolated. Path rules plus content fingerprints of hidden files. */
export function leakFindingsV2(m: CaseManifestV2, hidden: CaseFiles, probe: TreeProbe): string[] {
  const out: string[] = [];
  const hiddenPaths = [...m.files.verifier, ...m.files.reference, ...(m.files.rubric ? [m.files.rubric] : []), ...m.files.candidates.files];
  const hiddenHashes = new Map<string, string>();
  for (const p of hiddenPaths) if (hidden[p] !== undefined && hidden[p].trim().length >= 8) hiddenHashes.set(sha(hidden[p]), p);
  // A line the agent is meant to see (it is in the snapshot) cannot leak: a reference or candidate that
  // replaces a whole file legitimately repeats every unchanged line of it.
  const visible = new Set<string>();
  for (const sp of m.files.snapshot) for (const line of (hidden[sp] ?? '').split('\n')) visible.add(line.trim());
  const lines = hiddenLines(hidden, hiddenPaths).filter(([h]) => !visible.has(h));
  for (const [p, c] of Object.entries(probe.files)) {
    if (HIDDEN_PATH.test(p)) out.push(`hidden or grading path present: ${p}`);
    const hp = hiddenHashes.get(sha(c));
    if (hp) out.push(`${p} is byte-identical to withheld ${hp}`);
    // A line-level copy of the hidden material (>= 40 chars) catches a pasted verifier or reference.
    for (const [h, src] of lines) if (c.includes(h)) { out.push(`${p} contains a line of withheld ${src}`); break; }
  }
  if (probe.commits.length > 1) out.push(`workspace has ${probe.commits.length} commits; expected one baseline commit`);
  if (probe.remotes.length) out.push('workspace has a Git remote');
  return [...new Set(out)];
}

function sha(s: string) { return createHash('sha256').update(s).digest('hex'); }
function hiddenLines(hidden: CaseFiles, paths: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const p of paths) for (const line of (hidden[p] ?? '').split('\n')) { const t = line.trim(); if (t.length >= 40) out.push([t, p]); }
  return out;
}

// ─── Deterministic graders ───────────────────────────────────────────────────

export const GRADER_IDS = { find: 'find-v1', review: 'review-v1', longContext: 'longctx-v1', compaction: 'compaction-v1', verifier: 'verifier-v1' } as const;
export type GraderId = (typeof GRADER_IDS)[keyof typeof GRADER_IDS];

export interface GradeOutcome {
  graderId: string;
  pass: boolean;
  /** Reasons and flags such as `fabrication`, `constraint_dropped`. */
  notes: string[];
  metrics: Record<string, number | null>;
}

// find ----------------------------------------------------------------------

export interface FindAnswer { abstain?: boolean; citations: { file: string; line?: number; symbol?: string }[]; liveSite?: string }

function cites(c: FindAnswer['citations'][number], e: ExpectedLocation): boolean {
  if (c.file !== e.file) return false;
  if (e.startLine !== undefined) {
    if (c.line !== undefined) return c.line >= e.startLine && c.line <= (e.endLine ?? e.startLine);
    return e.symbol !== undefined && c.symbol === e.symbol;
  }
  return e.symbol === undefined || c.symbol === undefined || c.symbol === e.symbol;
}

/** Citations against expected locations, including abstention. File overlap with what the agent opened is never used. */
export function gradeFind(answer: FindAnswer, expected: Expected): GradeOutcome {
  const g = GRADER_IDS.find;
  if (expected.kind === 'abstain') {
    if (answer.abstain && !answer.citations.length) return { graderId: g, pass: true, notes: ['correct abstention'], metrics: {} };
    return { graderId: g, pass: false, notes: ['fabrication', `named ${answer.citations.map((c) => c.file).join(', ') || 'an answer'} where the behaviour is absent`], metrics: {} };
  }
  if (expected.kind !== 'answer') return { graderId: g, pass: false, notes: ['expected is not a find case'], metrics: {} };
  if (answer.abstain) return { graderId: g, pass: false, notes: ['wrong_abstention'], metrics: {} };
  const notes: string[] = [];
  const missing = expected.locations.filter((e) => !answer.citations.some((c) => cites(c, e)));
  for (const e of missing) notes.push(`missing location ${e.file}${e.symbol ? `#${e.symbol}` : ''}`);
  for (const d of expected.decoys ?? []) if (answer.citations.some((c) => c.file === d)) notes.push(`cited decoy ${d}`);
  if (expected.liveSite && answer.liveSite !== expected.liveSite) notes.push(`live site should be ${expected.liveSite}`);
  const total = expected.locations.length;
  return { graderId: g, pass: notes.length === 0, notes: notes.length ? notes : ['all locations cited'], metrics: { recall: (total - missing.length) / total } };
}

// review --------------------------------------------------------------------

export interface SeededDefect {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Every group needs at least one of its words in the description: matches cause, not wording. */
  cause: string[][];
}
export interface ReviewFinding { file: string; line: number; description: string }

const LINE_TOLERANCE = 2;

export function gradeReview(findings: ReviewFinding[], defects: SeededDefect[]): GradeOutcome & { truePositives: string[]; falsePositives: ReviewFinding[]; missed: string[] } {
  const matched = new Map<string, ReviewFinding>();
  const falsePositives: ReviewFinding[] = [];
  const duplicates: ReviewFinding[] = [];
  for (const f of findings) {
    const d = defects.find((x) => x.file === f.file && f.line >= x.startLine - LINE_TOLERANCE && f.line <= x.endLine + LINE_TOLERANCE
      && x.cause.every((grp) => grp.some((w) => f.description.toLowerCase().includes(w.toLowerCase()))));
    if (!d) falsePositives.push(f);
    else if (matched.has(d.id)) duplicates.push(f);
    else matched.set(d.id, f);
  }
  const missed = defects.filter((d) => !matched.has(d.id)).map((d) => d.id);
  const tp = matched.size;
  const fp = falsePositives.length;
  const notes: string[] = [];
  if (!defects.length && fp) notes.push('false positive on a clean control');
  for (const f of falsePositives) notes.push(`false positive: ${f.file}:${f.line}`);
  for (const m of missed) notes.push(`missed defect ${m}`);
  return {
    graderId: GRADER_IDS.review,
    pass: !missed.length && !fp,
    notes: notes.length ? notes : ['all defects found, no false positives'],
    metrics: {
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: defects.length ? tp / defects.length : null,
      falsePositives: fp,
      cleanControlFalsePositive: defects.length ? null : fp > 0 ? 1 : 0,
    },
    truePositives: [...matched.keys()], falsePositives, missed,
  };
}

/** AC-10: a grader that is the model under test (or the same id as it) is refused. */
export function assertGraderAllowed(grader: { kind: 'model' | 'person' | 'deterministic'; id: string }, modelUnderTest: string): void {
  if (grader.kind === 'model' && normaliseModel(grader.id) === normaliseModel(modelUnderTest)) {
    throw new Error(`grader ${grader.id} is the model under test; grading refused`);
  }
}
const normaliseModel = (s: string) => s.trim().toLowerCase().replace(/@\d+$/, '');

// long context --------------------------------------------------------------

export type TokenCounter = { method: string; count: (text: string) => number };
/** A stand-in used when the model's tokenizer is unavailable: recorded as an estimate, never as the model's own count. */
export const APPROX_TOKEN_COUNTER: TokenCounter = { method: 'approx-chars/4', count: (t) => Math.ceil(t.length / 4) };

export interface Needle { id: string; text: string }
export interface EvidenceBuild {
  text: string;
  targetTokens: number;
  tokens: number;
  tokenMethod: string;
  position: EvidencePosition;
  needles: { id: string; charOffset: number; tokenOffset: number; fraction: number }[];
}
export interface OverflowRecord { kind: 'overflow'; inputTokens: number; contextTokens: number; tokensOver: number }
export interface TruncationRecord { truncated: true; tokensDropped: number; text: string }

/**
 * Same material at every size: filler paragraphs are drawn from the pool in a
 * fixed order, so 8K is a prefix of 16K is a prefix of 32K filler. Needles go
 * at the named position and their offsets are recorded. Never exceeds the
 * target; if the needles alone do not fit, returns an overflow record.
 */
export function buildEvidence(input: { pool: string[]; needles: Needle[]; targetTokens: number; position: EvidencePosition; counter?: TokenCounter }): EvidenceBuild | OverflowRecord {
  const counter = input.counter ?? APPROX_TOKEN_COUNTER;
  if (!input.pool.length) throw new Error('filler pool is empty');
  const sep = '\n\n';
  const needleCost = input.needles.reduce((n, x) => n + counter.count(x.text + sep), 0);
  if (needleCost > input.targetTokens) return { kind: 'overflow', inputTokens: needleCost, contextTokens: input.targetTokens, tokensOver: needleCost - input.targetTokens };
  const filler: string[] = [];
  let used = needleCost;
  for (let i = 0; ; i++) {
    const para = input.pool[i % input.pool.length] + sep;
    const cost = counter.count(para);
    if (used + cost > input.targetTokens) break;
    filler.push(para);
    used += cost;
    if (i > 1_000_000) throw new Error('filler pool produces no tokens');
  }
  const n = filler.length;
  const k = input.needles.length;
  const slot = (j: number): number => {
    switch (input.position) {
      case 'start': return 0;
      case 'middle': return Math.floor(n / 2);
      case 'end': return n;
      case 'dispersed': return Math.floor(((j + 1) * n) / (k + 1));
    }
  };
  const parts: { id: string | null; text: string }[] = filler.map((t) => ({ id: null, text: t }));
  // Insert from the back so earlier slots keep their index.
  const order = input.needles.map((nd, j) => ({ nd, at: slot(j), j })).sort((a, b) => b.at - a.at || b.j - a.j);
  for (const { nd, at } of order) parts.splice(at, 0, { id: nd.id, text: nd.text + sep });
  let text = '';
  const offsets: EvidenceBuild['needles'] = [];
  for (const p of parts) {
    if (p.id) offsets.push({ id: p.id, charOffset: text.length, tokenOffset: counter.count(text), fraction: 0 });
    text += p.text;
  }
  const tokens = counter.count(text);
  for (const o of offsets) o.fraction = tokens ? Math.round((o.tokenOffset / tokens) * 1000) / 1000 : 0;
  return { text, targetTokens: input.targetTokens, tokens, tokenMethod: counter.method, position: input.position, needles: offsets.sort((a, b) => a.charOffset - b.charOffset) };
}

/** AC-12: an input larger than the loaded context is an overflow record, never a silent cut. */
export function checkFit(inputTokens: number, contextTokens: number): OverflowRecord | null {
  return inputTokens > contextTokens ? { kind: 'overflow', inputTokens, contextTokens, tokensOver: inputTokens - contextTokens } : null;
}

/** Truncation only ever happens through this call, and it says what was dropped. */
export function truncateExplicit(text: string, maxTokens: number, counter: TokenCounter = APPROX_TOKEN_COUNTER): TruncationRecord | { truncated: false; text: string } {
  const total = counter.count(text);
  if (total <= maxTokens) return { truncated: false, text };
  let lo = 0; let hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (counter.count(text.slice(0, mid)) <= maxTokens) lo = mid; else hi = mid - 1; }
  const kept = text.slice(0, lo);
  return { truncated: true, tokensDropped: total - counter.count(kept), text: kept };
}

export interface LongContextAnswer { abstain?: boolean; answer?: string }
export interface LongContextExpected { answer: string | null; abstain?: boolean; superseded?: string[] }

export function gradeLongContext(a: LongContextAnswer, e: LongContextExpected): GradeOutcome {
  const g = GRADER_IDS.longContext;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (e.abstain) return a.abstain && !a.answer ? { graderId: g, pass: true, notes: ['correct abstention'], metrics: {} } : { graderId: g, pass: false, notes: ['fabrication'], metrics: {} };
  if (a.abstain || !a.answer) return { graderId: g, pass: false, notes: ['wrong_abstention'], metrics: {} };
  const got = norm(a.answer);
  const follows = (e.superseded ?? []).find((s) => got.includes(norm(s)));
  if (follows && !(e.answer && got.includes(norm(e.answer)))) return { graderId: g, pass: false, notes: [`followed_superseded: ${follows}`], metrics: {} };
  const ok = !!e.answer && got.includes(norm(e.answer)) && !follows;
  return { graderId: g, pass: ok, notes: ok ? ['answer matches'] : follows ? [`mentions superseded ${follows}`] : ['answer does not match'], metrics: {} };
}

// compaction ----------------------------------------------------------------

export interface StageCheck { stage: number; constraints: Record<string, boolean>; testsPass: boolean }

/** Stage 0 is before compaction. Green at the end with an earlier constraint failure is `constraint_dropped`, not a clean pass. */
export function gradeCompaction(stages: StageCheck[]): GradeOutcome & { retention: (number | null)[] } {
  const ordered = [...stages].sort((a, b) => a.stage - b.stage);
  const retention = ordered.map((s) => { const v = Object.values(s.constraints); return v.length ? v.filter(Boolean).length / v.length : null; });
  const notes: string[] = [];
  const dropped = new Set<string>();
  for (const s of ordered) for (const [c, ok] of Object.entries(s.constraints)) if (!ok) { dropped.add(c); notes.push(`stage ${s.stage}: constraint ${c} failed`); }
  const last = ordered[ordered.length - 1];
  const finalGreen = !!last && last.testsPass && Object.values(last.constraints).every(Boolean);
  const testsGreen = !!last && last.testsPass;
  if (testsGreen && dropped.size) notes.unshift('constraint_dropped');
  const pass = !!last && finalGreen && !dropped.size;
  if (!last) notes.push('no stages recorded');
  else if (!last.testsPass) notes.push('final tests failed');
  return { graderId: GRADER_IDS.compaction, pass, notes: notes.length ? notes : ['all constraints retained at every stage'], metrics: { stages: ordered.length, finalRetention: retention.length ? retention[retention.length - 1] : null }, retention };
}

// ─── Stored artifacts and regrade ────────────────────────────────────────────

/** What a run keeps so it can be regraded without the model: the agent's observable output and what it was graded against. */
export interface StoredArtifact {
  runId: string;
  caseId: string;
  graderId: string;
  output: unknown;
  expected: unknown;
  /** The score recorded when the run was first graded. */
  recorded?: { pass: boolean; graderId: string };
}

type GraderFn = (output: never, expected: never) => GradeOutcome;
export const GRADERS: Record<string, GraderFn> = {
  [GRADER_IDS.find]: ((o: FindAnswer, e: Expected) => gradeFind(o, e)) as GraderFn,
  [GRADER_IDS.review]: ((o: ReviewFinding[], e: { defects: SeededDefect[] }) => gradeReview(o, e.defects)) as GraderFn,
  [GRADER_IDS.longContext]: ((o: LongContextAnswer, e: LongContextExpected) => gradeLongContext(o, e)) as GraderFn,
  [GRADER_IDS.compaction]: ((o: StageCheck[]) => gradeCompaction(o)) as GraderFn,
};

export interface Regrade { runId: string; caseId: string; graderId: string; outcome: GradeOutcome; changedFromRecorded: boolean | null }

/** Re-score from stored artifacts under the grader id each was recorded with. An id this build does not know is an error, never a silent substitute. */
export function regrade(artifacts: StoredArtifact[], registry: Record<string, GraderFn> = GRADERS): Regrade[] {
  return artifacts.map((a) => {
    const fn = registry[a.graderId];
    if (!fn) throw new Error(`run ${a.runId}: grader ${a.graderId} is not available in this build; refusing to regrade with another grader`);
    const outcome = fn(a.output as never, a.expected as never);
    return { runId: a.runId, caseId: a.caseId, graderId: a.graderId, outcome, changedFromRecorded: a.recorded ? a.recorded.pass !== outcome.pass : null };
  });
}

// ─── score-v2 ────────────────────────────────────────────────────────────────

export type RunResultV2 = 'pass' | 'fail' | 'invalid' | 'error' | 'unscored';
export type FailureClass = 'model' | 'harness' | 'infra';
export interface ScoreV2 {
  result: RunResultV2;
  failureClass: FailureClass | null;
  scoringVersion: typeof SCORING_VERSION_V2;
  /** Retained on every score so a regrade knows what produced it. */
  graderId: string;
  notes: string[];
}

export interface ScoreInputV2 {
  graderId: string;
  harnessError?: boolean;
  infraError?: boolean;
  overflow?: OverflowRecord | null;
  /** Capability the adapter lacks for this case. */
  unsupported?: string | null;
  verifier: { ran: boolean; passed: boolean | null };
  /** Null when the case ships no visible checks (answer-only cases): nothing to run, not a check that failed to run. */
  visible: { ran: boolean; passed: boolean | null } | null;
  tampering: string[];
  leaks: string[];
  /** Notes from the grader: `fabrication`, `constraint_dropped`, ... */
  flags?: string[];
}

export function scoreRunV2(i: ScoreInputV2): ScoreV2 {
  const mk = (result: RunResultV2, failureClass: FailureClass | null, notes: string[]): ScoreV2 => ({ result, failureClass, scoringVersion: SCORING_VERSION_V2, graderId: i.graderId, notes });
  if (i.unsupported) return mk('unscored', null, [`unsupported: ${i.unsupported}`]);
  if (i.harnessError) return mk('error', 'harness', ['harness error']);
  if (i.overflow) return mk('error', 'infra', [`overflow: ${i.overflow.inputTokens} tokens in a ${i.overflow.contextTokens} context (${i.overflow.tokensOver} over)`]);
  if (i.infraError) return mk('error', 'infra', ['infrastructure error']);
  if (i.leaks.length) return mk('invalid', 'harness', i.leaks);
  if (i.tampering.length) return mk('invalid', 'model', i.tampering);
  if (!i.verifier.ran) return mk('unscored', 'harness', ['verifier did not run']);
  const flags = i.flags ?? [];
  if (i.verifier.passed !== true) return mk('fail', 'model', flags);
  if (i.visible && !i.visible.ran) return mk('unscored', 'harness', ['visible checks did not run']);
  if (i.visible && i.visible.passed !== true) return mk('fail', 'model', ['visible checks failed', ...flags]);
  if (flags.includes('constraint_dropped') || flags.includes('fabrication')) return mk('fail', 'model', flags);
  return mk('pass', null, flags);
}

// ─── Adapters and the CPU-only guard ─────────────────────────────────────────

export const CAPABILITIES = ['toolCalling', 'systemPrompt', 'structuredOutput'] as const;
export type Capability = (typeof CAPABILITIES)[number] | `context:${number}`;

export interface ModelAdapter {
  id: string;
  capabilities: { toolCalling: boolean; systemPrompt: boolean; structuredOutput: boolean; contextTokens: number };
}
export interface CaseNeeds { toolCalling: boolean; systemPrompt: boolean; structuredOutput: boolean; contextTokens: number }

/** What the adapter lacks for the case. The case is never altered to fit; the run is recorded `unsupported: <capability>`. */
export function unsupportedCapabilities(a: ModelAdapter, needs: CaseNeeds): string[] {
  const out: string[] = [];
  for (const k of CAPABILITIES) if (needs[k] && !a.capabilities[k]) out.push(k);
  if (needs.contextTokens > a.capabilities.contextTokens) out.push(`context:${needs.contextTokens}`);
  return out;
}

/** 09:00 America/New_York on 2026-11-08 (EST, UTC-5). */
export const GPU_WINDOW_OPENS_AT = '2026-11-08T14:00:00.000Z';

export interface InferenceGuardInput {
  /**
   * VRAM the run needs: the larger of the model profile's figure (or the
   * operator's declared floor) and the case's own estimate. Null = nobody
   * has said, and the guard refuses rather than guess.
   */
  requiredVramMb: number | null;
  gpus: { usedMb: number; totalMb: number }[] | null;
  loadedModels: string[];
  now: Date;
  /** Verification/unit work asks for no model; a run request asks for one. */
  purpose: 'verify' | 'model-run';
  windowOpensAt?: string;
}

/**
 * The larger of the known VRAM figures; null when none is known. `cpuOnly` is
 * not an input: it says the case's verifier needs no inference, which is true
 * of every case, and says nothing about the model a run loads.
 */
export function requiredVramMb(caseEstimateMb: number | null, modelEstimateMb: number | null): number | null {
  const known = [caseEstimateMb, modelEstimateMb].filter((v): v is number => typeof v === 'number' && v > 0);
  return known.length ? Math.max(...known) : null;
}

/**
 * No model starts for verification, before the GPU window, without a VRAM
 * figure, or unless the GPU gate passes with room for that figure. Verification
 * never needs, and never gets, a model.
 */
export function inferenceGuard(i: InferenceGuardInput): { allowed: boolean; reason: string } {
  if (i.purpose === 'verify') return { allowed: false, reason: 'verification runs the hidden verifier only; no model is started' };
  if (i.now.getTime() < Date.parse(i.windowOpensAt ?? GPU_WINDOW_OPENS_AT)) return { allowed: false, reason: `GPU runs are deferred until ${i.windowOpensAt ?? GPU_WINDOW_OPENS_AT}` };
  if (i.requiredVramMb === null) return { allowed: false, reason: 'no VRAM figure for this model or case (set estimatedVramMb in models.json or pass --vram-mb); refusing to load a model before it can be checked' };
  const g = gpuGate({ gpus: i.gpus, loadedModels: i.loadedModels, minFreeMb: i.requiredVramMb });
  return { allowed: g.ok, reason: g.reason };
}
