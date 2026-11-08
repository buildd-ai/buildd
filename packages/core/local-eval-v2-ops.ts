/**
 * Operating the v2 suite: listing and filtering cases, the permitted brief,
 * run planning (smoke preset, batches, explicit policy), and redaction and
 * retention of stored artifacts. Pure: `scripts/local-eval/v2.ts` does the I/O.
 *
 * Nothing here starts a model. A plan is a list of intended runs; whether a
 * run may start is `inferenceGuard`'s call, made again per case at run time.
 */
import {
  CONTEXT_SIZES, exportAgentTree, inferenceGuard, unsupportedCapabilities,
  type CaseFiles, type CaseManifestV2, type Category, type ModelAdapter,
} from './local-eval-v2';

export type Split = 'dev' | 'sealed-holdout';

export interface CaseRow {
  id: string;
  version: number;
  category: Category | string;
  difficulty: string;
  skills: string[];
  contextSizes: number[];
  cpuOnly: boolean;
  estimatedVramMb: number | null;
  exposing: boolean;
  split: Split;
  /** Sealed cases are descriptors only: their content is not in this repository. */
  available: boolean;
}

export interface SealedDescriptor { id: string; category: string; version: number; difficulty: string; skills: string[]; exposing: boolean }

export function caseRow(m: CaseManifestV2, split: Split): CaseRow {
  return {
    id: m.id, version: m.version, category: m.category, difficulty: m.labels.difficulty, skills: [...m.labels.skills],
    contextSizes: m.longContext?.sizes ? [...m.longContext.sizes] : [], cpuOnly: m.resources.cpuOnly, estimatedVramMb: m.resources.estimatedVramMb,
    exposing: m.exposing, split, available: true,
  };
}

export function sealedRow(d: SealedDescriptor): CaseRow {
  return { id: d.id, version: d.version, category: d.category, difficulty: d.difficulty, skills: d.skills, contextSizes: [], cpuOnly: false, estimatedVramMb: null, exposing: d.exposing, split: 'sealed-holdout', available: false };
}

export interface CaseFilter {
  skill?: string;
  difficulty?: string;
  category?: string;
  /** A long-context size the case is built for (8192, 16384, 32768). */
  context?: number;
  /** `cpu-only`, `needs-gpu` or `vram<=<MiB>`. */
  resource?: string;
  split?: Split;
}

/** What `cli list` prints for a case's resource need. A sealed descriptor does not carry one: say so rather than print a GPU figure. */
export function resourceLabel(r: CaseRow): string {
  if (!r.available) return 'resource unknown';
  if (r.cpuOnly) return 'cpu-only';
  return r.estimatedVramMb === null ? 'gpu (vram not estimated)' : `gpu ${r.estimatedVramMb}MiB`;
}

export function parseResourceFilter(v: string): { ok: true; test: (r: CaseRow) => boolean } | { ok: false; error: string } {
  if (v === 'cpu-only') return { ok: true, test: (r) => r.cpuOnly };
  if (v === 'needs-gpu') return { ok: true, test: (r) => !r.cpuOnly };
  const m = /^vram<=(\d+)$/.exec(v);
  if (m) { const max = Number(m[1]); return { ok: true, test: (r) => r.estimatedVramMb !== null && r.estimatedVramMb <= max }; }
  return { ok: false, error: `resource must be cpu-only, needs-gpu or vram<=<MiB>, got ${v}` };
}

export function filterCases(rows: CaseRow[], f: CaseFilter): { rows: CaseRow[]; error?: string } {
  let res: ((r: CaseRow) => boolean) | null = null;
  if (f.resource) {
    const p = parseResourceFilter(f.resource);
    if (!p.ok) return { rows: [], error: p.error };
    res = p.test;
  }
  const out = rows.filter((r) =>
    (!f.skill || r.skills.includes(f.skill)) && (!f.difficulty || r.difficulty === f.difficulty) && (!f.category || r.category === f.category) &&
    (!f.context || r.contextSizes.includes(f.context)) && (!f.split || r.split === f.split) && (!res || res(r)));
  return { rows: out.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** The brief an agent is permitted to see: the instruction and the snapshot paths. Never verifier, reference, rubric or candidates. */
export function permittedBrief(m: CaseManifestV2, files: CaseFiles): { id: string; category: string; instruction: string; snapshotPaths: string[]; resources: CaseManifestV2['resources'] } {
  const t = exportAgentTree(m, files);
  return { id: m.id, category: m.category, instruction: t.instruction, snapshotPaths: Object.keys(t.files).sort(), resources: m.resources };
}

// ─── Run planning ────────────────────────────────────────────────────────────

export interface RunPolicy {
  model: string;
  harness: string;
  contextTokens: number;
  trials: number;
  track: 'single-context' | 'tool-retrieval';
  retrievalPolicy: string;
}

export const SMOKE_CATEGORIES: Category[] = ['find-by-behaviour', 'causal-debugging', 'code-review', 'long-context-requirements'];
export const SMOKE_MAX_CASES = 4;

/** Four dev cases, one per category above, exposing cases first, then alphabetical. One trial. A bounded first look, not a measurement. */
export function smokeCases(rows: CaseRow[]): CaseRow[] {
  const dev = rows.filter((r) => r.split === 'dev' && r.available);
  const picked: CaseRow[] = [];
  for (const c of SMOKE_CATEGORIES) {
    const pool = dev.filter((r) => r.category === c).sort((a, b) => Number(b.exposing) - Number(a.exposing) || a.id.localeCompare(b.id));
    if (pool[0]) picked.push(pool[0]);
  }
  return picked.slice(0, SMOKE_MAX_CASES);
}

export function validatePolicy(p: Partial<RunPolicy>): string[] {
  const errs: string[] = [];
  if (!p.model?.trim()) errs.push('--model is required (an explicit model tag)');
  if (!p.harness?.trim()) errs.push('--harness is required (an explicit harness, e.g. claude-code)');
  if (!(CONTEXT_SIZES as readonly number[]).includes(p.contextTokens as number)) errs.push(`--context must be one of ${CONTEXT_SIZES.join(', ')}`);
  if (!Number.isInteger(p.trials) || (p.trials as number) < 1 || (p.trials as number) > 10) errs.push('--trials must be 1 to 10');
  return errs;
}

export interface PlannedRun {
  runId: string;
  caseId: string;
  trial: number;
  configId: string;
  split: Split;
  /** `run`: may start once the guard passes. `refused`: never starts (reason says why). */
  action: 'run' | 'refused' | 'unsupported';
  reason: string | null;
}

export interface PlanInput {
  cases: CaseRow[];
  needs: Record<string, { toolCalling: boolean; systemPrompt: boolean; structuredOutput: boolean; contextTokens: number }>;
  policy: RunPolicy;
  adapter: ModelAdapter;
  now: Date;
  gpus: { usedMb: number; totalMb: number }[] | null;
  loadedModels: string[];
  windowOpensAt?: string;
}

/**
 * One planned run per case and trial. A holdout case is refused (its content is
 * not here). A case the adapter cannot serve is `unsupported` (recorded, never
 * altered to fit). The guard is evaluated now for each case and again by the
 * runner immediately before it loads a model.
 */
export function planRuns(i: PlanInput): PlannedRun[] {
  const configId = `${i.policy.model}@${i.policy.contextTokens}`;
  const safe = configId.replace(/[^a-z0-9.@-]/gi, '_');
  const out: PlannedRun[] = [];
  for (const c of i.cases) {
    for (let trial = 1; trial <= i.policy.trials; trial++) {
      const runId = `v2.${c.id}.${safe}.${i.policy.track}.t${trial}`;
      const base = { runId, caseId: c.id, trial, configId, split: c.split };
      if (!c.available) { out.push({ ...base, action: 'refused', reason: 'sealed-holdout content is not in this repository; it is run only for a decision, by whoever holds it' }); continue; }
      const need = i.needs[c.id];
      const lacking = need ? unsupportedCapabilities(i.adapter, { ...need, contextTokens: Math.max(need.contextTokens, i.policy.contextTokens) }) : [];
      if (lacking.length) { out.push({ ...base, action: 'unsupported', reason: `unsupported: ${lacking.join(', ')}` }); continue; }
      const g = inferenceGuard({ cpuOnly: c.cpuOnly, estimatedVramMb: c.estimatedVramMb, gpus: i.gpus, loadedModels: i.loadedModels, now: i.now, purpose: 'model-run', windowOpensAt: i.windowOpensAt });
      out.push({ ...base, action: g.allowed ? 'run' : 'refused', reason: g.allowed ? null : g.reason });
    }
  }
  return out;
}

// ─── Redaction and retention of stored artifacts ─────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\bbld_[A-Za-z0-9]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*(?!\[redacted\])\S{6,}/g,
];
const USER_PATHS: RegExp[] = [/\/home\/[^/\s"']+/g, /\/Users\/[^/\s"']+/g, /[A-Za-z]:\\Users\\[^\\\s"']+/g];

export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(text); });
}

/** Secrets become `[redacted]`, machine user paths become `~`. Idempotent. */
export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, name) => (typeof name === 'string' ? `${name}=[redacted]` : '[redacted]'));
  for (const re of USER_PATHS) out = out.replace(re, '~');
  return out;
}

export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactText(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

export const RETENTION_DAYS = 30;

/** Raw trajectories and agent output are kept this long on the evaluating machine; the run record (no transcript) is what is kept. */
export function isExpired(writtenAt: Date, now: Date, days = RETENTION_DAYS): boolean {
  return now.getTime() - writtenAt.getTime() > days * 86_400_000;
}
