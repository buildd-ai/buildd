/**
 * A versioned dataset of one decision kind's ledger: `decision_records` and
 * their `decision_outcomes`, in the layout of the merge-readiness backtest
 * dataset (knowledge-base: buildd/reports/merge-readiness-backtest/README.md),
 * so `v2/` and later are comparable with `v1/`:
 *
 *   <version>/data/records.jsonl    one decision record per line
 *   <version>/data/outcomes.jsonl   one outcome label per line
 *   <version>/data/examples.jsonl   one record per line with its labels by source
 *   <version>/manifest.json         sha256, bytes and rows per file
 *   manifest-<version>.json         the same manifest object
 *
 * Pure and deterministic: rows are sorted and keys are emitted in a fixed
 * order, so the same ledger rows always hash the same. The I/O half is
 * `scripts/export-decision-dataset.ts`.
 */
import { createHash } from 'node:crypto';

export const DATASET_FORMAT = 'buildd.decision-dataset/1' as const;

export interface DatasetFile {
  /** Relative to the dataset root (the directory that holds `<version>/`). */
  path: string;
  content: string;
}

export interface DatasetManifest {
  format: typeof DATASET_FORMAT;
  dataset: string;
  version: string;
  kind: string;
  generatedAt: string;
  counts: { records: number; outcomes: number; labelled: number; bySourceLabel: Record<string, Record<string, number>> };
  files: Array<{ path: string; sha256: string; bytes: number; rows: number }>;
}

type Row = Record<string, unknown>;

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** JSON with keys sorted at every level, Dates as ISO strings. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Row).sort().map(k => [k, normalize((v as Row)[k])]));
  }
  return v === undefined ? null : v;
}

const time = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : 0);
const byTimeThenId = (key: string) => (a: Row, b: Row) => time(a[key]) - time(b[key]) || String(a.id).localeCompare(String(b.id));

const jsonl = (rows: readonly unknown[]) => rows.map(stableJson).join('\n') + (rows.length ? '\n' : '');

export function buildDecisionDataset(input: {
  /** Dataset name, e.g. 'merge-readiness'. */
  dataset: string;
  version: string;
  kind: string;
  records: readonly Row[];
  outcomes: readonly Row[];
  generatedAt: Date;
}): { files: DatasetFile[]; manifest: DatasetManifest } {
  if (!/^v\d+$/.test(input.version)) throw new Error(`version must look like v2, got ${input.version}`);
  const records = [...input.records].filter(r => r.capability === input.kind).sort(byTimeThenId('createdAt'));
  const ids = new Set(records.map(r => String(r.id)));
  const outcomes = [...input.outcomes].filter(o => ids.has(String(o.decisionRecordId))).sort(byTimeThenId('recordedAt'));

  const labelsByRecord = new Map<string, Record<string, Row>>();
  const bySourceLabel: Record<string, Record<string, number>> = {};
  for (const o of outcomes) {
    const id = String(o.decisionRecordId);
    const source = String(o.source);
    const label = String(o.label);
    const forRecord = labelsByRecord.get(id) ?? {};
    forRecord[source] = { label, value: o.value ?? null, metadata: o.metadata ?? null, observedAt: o.observedAt };
    labelsByRecord.set(id, forRecord);
    (bySourceLabel[source] ??= {})[label] = (bySourceLabel[source][label] ?? 0) + 1;
  }
  const examples = records.map(r => ({ record: r, outcomes: labelsByRecord.get(String(r.id)) ?? {} }));

  const data: Array<{ name: string; rows: readonly unknown[] }> = [
    { name: 'records.jsonl', rows: records },
    { name: 'outcomes.jsonl', rows: outcomes },
    { name: 'examples.jsonl', rows: examples },
  ];
  const files: DatasetFile[] = data.map(d => ({ path: `${input.version}/data/${d.name}`, content: jsonl(d.rows) }));
  const manifest: DatasetManifest = {
    format: DATASET_FORMAT,
    dataset: input.dataset,
    version: input.version,
    kind: input.kind,
    generatedAt: input.generatedAt.toISOString(),
    counts: { records: records.length, outcomes: outcomes.length, labelled: labelsByRecord.size, bySourceLabel },
    files: files.map((f, i) => ({ path: f.path, sha256: sha256Hex(f.content), bytes: Buffer.byteLength(f.content, 'utf8'), rows: data[i].rows.length })),
  };
  const manifestJson = JSON.stringify(normalize(manifest), null, 2) + '\n';
  files.push({ path: `${input.version}/manifest.json`, content: manifestJson });
  files.push({ path: `manifest-${input.version}.json`, content: manifestJson });
  return { files, manifest };
}
