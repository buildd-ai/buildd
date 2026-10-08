/**
 * Persistence for central model certification (model-certification.ts).
 *
 * One `system_cache` row per model, key `model_cert:<id>`, no expiry. No new
 * table: a record is re-derivable (lose it and the model is simply probed
 * again), which is what system_cache is for, and one row per model means two
 * runners reporting on two models never overwrite each other. Writes are
 * optimistic: an UPDATE only lands when the row still holds the value it was
 * computed from (neon-http has no interactive transactions).
 *
 * Every reader fails open to an empty map: no certifications means "the static
 * floor table only", which is exactly the behaviour before certification.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { systemCache } from './db/schema';
import type { CatalogEntry } from './model-catalog';
import { probeCandidates } from './model-certification-candidates';
import {
  applyAdminMark,
  applyCompatibilityIncident,
  applyProbeReport,
  leaseCertification,
  newCertification,
  parseRequiredCliVersion,
  type ModelCertification,
  type ProbeReport,
} from './model-certification';

export const CERT_KEY_PREFIX = 'model_cert:';
const CACHE_TTL_MS = 60 * 1000;

let memCache: { certs: Map<string, ModelCertification>; loadedAt: number } | null = null;

/** Exposed for tests and after a write in this process. */
export function invalidateCertificationCache(): void {
  memCache = null;
}

/** Every certification record, cached for 60s per process. Never throws. */
export async function getModelCertifications(): Promise<Map<string, ModelCertification>> {
  const now = Date.now();
  if (memCache && now - memCache.loadedAt < CACHE_TTL_MS) return memCache.certs;
  try {
    const rows = await db
      .select({ key: systemCache.key, value: systemCache.value })
      .from(systemCache)
      .where(sql`${systemCache.key} LIKE ${CERT_KEY_PREFIX + '%'}`);
    const certs = new Map<string, ModelCertification>();
    for (const r of rows) {
      const v = r.value as ModelCertification | null;
      if (v && typeof v.model === 'string' && v.probe) certs.set(v.model, v);
    }
    memCache = { certs, loadedAt: now };
    return certs;
  } catch {
    return memCache?.certs ?? new Map();
  }
}

async function readOne(model: string): Promise<ModelCertification | null> {
  const row = await db.query.systemCache.findFirst({ where: eq(systemCache.key, CERT_KEY_PREFIX + model) });
  return (row?.value as ModelCertification | undefined) ?? null;
}

/** Insert when absent, else replace only if the row still holds `prev`. True when the write landed. */
async function writeIfUnchanged(model: string, prev: ModelCertification | null, next: ModelCertification): Promise<boolean> {
  const key = CERT_KEY_PREFIX + model;
  const now = new Date();
  if (!prev) {
    const rows = await db
      .insert(systemCache)
      .values({ key, value: next, updatedAt: now, expiresAt: null })
      .onConflictDoNothing()
      .returning({ key: systemCache.key });
    if (rows.length > 0) invalidateCertificationCache();
    return rows.length > 0;
  }
  const rows = await db
    .update(systemCache)
    .set({ value: next, updatedAt: now })
    .where(and(eq(systemCache.key, key), sql`${systemCache.value} = ${JSON.stringify(prev)}::jsonb`))
    .returning({ key: systemCache.key });
  if (rows.length > 0) invalidateCertificationCache();
  return rows.length > 0;
}

export interface ProbeLease {
  model: string;
  leaseId: string;
}

/**
 * Offer a runner at `cliVersion` one model to probe, newest first, and take
 * its lease. Null when nothing needs probing (the common case) or every
 * candidate was taken by another runner in the meantime.
 */
export async function leaseModelProbe(
  catalog: readonly CatalogEntry[],
  cliVersion: string,
  now = Date.now(),
): Promise<ProbeLease | null> {
  const certs = await getModelCertifications();
  for (const entry of probeCandidates(catalog, certs, cliVersion, now).slice(0, 3)) {
    const prev = await readOne(entry.id);
    const base = prev ?? newCertification(entry.id, entry);
    const leaseId = randomUUID();
    if (await writeIfUnchanged(entry.id, prev, leaseCertification(base, leaseId, now))) {
      return { model: entry.id, leaseId };
    }
  }
  return null;
}

export type ProbeReportResult =
  | { ok: true; certification: ModelCertification }
  | { ok: false; reason: 'unknown_model' | 'lease_mismatch' | 'conflict' };

/** Record a probe's result. Only the runner holding the lease may report. */
export async function reportModelProbe(
  report: ProbeReport & { leaseId: string },
  now = Date.now(),
): Promise<ProbeReportResult> {
  const prev = await readOne(report.model);
  if (!prev) return { ok: false, reason: 'unknown_model' };
  if (prev.probe.leaseId !== report.leaseId) return { ok: false, reason: 'lease_mismatch' };
  const next = applyProbeReport(prev, report, now);
  return (await writeIfUnchanged(report.model, prev, next))
    ? { ok: true, certification: next }
    : { ok: false, reason: 'conflict' };
}

/**
 * A running worker on `model` failed with a compatibility error. Recorded only
 * when the model has a certification record (a probed model) and the error is
 * the provider's version gate; anything else is not evidence about the model.
 * Best effort: never throws.
 */
export async function recordModelCompatibilityIncident(model: string, error: string, now = Date.now()): Promise<void> {
  if (!parseRequiredCliVersion(error)) return;
  try {
    for (let i = 0; i < 2; i++) {
      const prev = await readOne(model);
      if (!prev) return;
      if (await writeIfUnchanged(model, prev, applyCompatibilityIncident(prev, error, now))) return;
    }
  } catch {
    // Best effort.
  }
}

/**
 * A platform admin's verdict or deprecation mark. Creates the record when
 * absent: `baseline` says whether the static table already vouches for the
 * model, so deprecating a baseline model does not uncertify it and
 * deprecating an unprobed one does not certify it.
 */
export async function markModelCertification(
  model: string,
  mark: Parameters<typeof applyAdminMark>[1],
  opts: { baseline: boolean },
  now = Date.now(),
): Promise<ModelCertification | null> {
  for (let i = 0; i < 3; i++) {
    const prev = await readOne(model);
    const base = prev ?? { ...newCertification(model), state: opts.baseline ? ('certified' as const) : ('failed' as const) };
    const next = applyAdminMark(base, mark, now);
    if (await writeIfUnchanged(model, prev, next)) return next;
  }
  return null;
}
