#!/usr/bin/env bun
/**
 * sync-crons.ts — reconcile the external cron trigger against cron-manifest.json.
 *
 * Buildd's `/api/cron/*` routes are NOT Vercel-native crons — that mechanism
 * does not fire in this project, so vercel.json declares none. They are driven by an
 * external scheduler (cron-job.org). Historically that schedule lived only in
 * the provider's web console, which meant:
 *   - the cadence was invisible to code review, and
 *   - a hand-edited hour restriction silently blackholed the schedules tick
 *     for 12 hours a night with no error anywhere (the route is never called,
 *     so Vercel logs show only absence).
 *
 * `cron-manifest.json` is now the single source of truth. This script makes the
 * live job set match it: creates missing jobs, updates drifted ones, collapses
 * accidental duplicates.
 *
 * ORIGIN SCOPING — the separation guarantee. "Managed" means any live job whose
 * URL starts with `CRON_TARGET_BASE_URL + "/api/cron/"`. Jobs on any other
 * origin are invisible to this script and can never be updated or deleted by
 * it, even with --prune. The provider account is shared with unrelated
 * projects; this is what keeps them from clobbering each other.
 *
 * Modes:
 *   (default)   apply changes
 *   --dry-run   print the plan, write nothing, exit 0
 *   --check     report drift, write nothing, exit 1 if out of sync (CI gate)
 *   --prune     also delete managed jobs absent from the manifest (opt-in)
 *
 * Env:
 *   CRONJOB_API_KEY       provider API key (console -> Settings -> API)
 *   CRON_SECRET           injected as `Authorization: Bearer <secret>` per job.
 *                         MUST match Vercel production's CRON_SECRET, or the
 *                         synced jobs will start getting 401s.
 *   CRON_TARGET_BASE_URL  prod origin (default https://buildd.dev)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://api.cron-job.org';
const MANIFEST_PATH = join(import.meta.dir, '..', 'cron-manifest.json');

// cron-job.org uses -1 in a schedule array to mean "every value".
const EVERY = -1;

// cron-job.org requestMethod enum.
const METHOD_CODES = { GET: 0, POST: 1 } as const;

export type HttpMethod = keyof typeof METHOD_CODES;

export interface ManifestJob {
  title: string;
  /** e.g. "/api/cron/foo?mode=bar" */
  path: string;
  /** 5-field cron expression, evaluated in the job's timezone */
  schedule: string;
  /** defaults to GET */
  method?: HttpMethod;
  /** defaults to true; false stages a job in the console without firing it */
  enabled?: boolean;
  /** per-job override of the manifest default */
  timezone?: string;
}

export interface Manifest {
  timezone?: string;
  jobs: ManifestJob[];
}

export interface Schedule {
  timezone: string;
  expiresAt: number;
  hours: number[];
  mdays: number[];
  minutes: number[];
  months: number[];
  wdays: number[];
}

export interface JobBody {
  url: string;
  enabled: boolean;
  title: string;
  saveResponses: boolean;
  requestMethod: number;
  extendedData: { headers: Record<string, string>; body: string };
  schedule: Schedule;
}

// --- manifest ---------------------------------------------------------------

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

// --- cron parsing -----------------------------------------------------------

/** Expand one cron field into the provider's array form ([-1] === "every"). */
export function parseCronField(field: string, min: number, max: number): number[] {
  if (field === '*') return [EVERY];
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((n) => parseInt(n, 10));
      lo = a;
      hi = b;
    } else {
      lo = hi = parseInt(rangePart, 10);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function cronToSchedule(expr: string, timezone: string): Schedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Bad cron expression "${expr}" (need 5 fields)`);
  const [min, hour, dom, mon, dow] = parts;
  // cron allows both 0 and 7 for Sunday; the provider only accepts 0-6.
  let wdays = parseCronField(dow, 0, 7).map((d) => (d === 7 ? 0 : d));
  wdays = wdays.includes(EVERY) ? [EVERY] : [...new Set(wdays)].sort((a, b) => a - b);
  return {
    timezone,
    expiresAt: 0,
    minutes: parseCronField(min, 0, 59),
    hours: parseCronField(hour, 0, 23),
    mdays: parseCronField(dom, 1, 31),
    months: parseCronField(mon, 1, 12),
    wdays,
  };
}

export function methodToCode(method: HttpMethod | undefined): number {
  if (method === undefined) return METHOD_CODES.GET;
  const code = METHOD_CODES[method];
  if (code === undefined) throw new Error(`Unsupported request method "${method}"`);
  return code;
}

export function buildJob(
  m: ManifestJob,
  defaultTz: string,
  baseUrl: string,
  cronSecret: string | undefined,
): JobBody {
  return {
    url: baseUrl + m.path,
    enabled: m.enabled !== false,
    title: m.title,
    saveResponses: true,
    requestMethod: methodToCode(m.method),
    extendedData: {
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
      body: '',
    },
    schedule: cronToSchedule(m.schedule, m.timezone || defaultTz),
  };
}

/**
 * Body for updating an existing job. By default we omit `extendedData`, so the
 * provider keeps the Authorization header it already has. Managing the secret
 * value from a local shell is the one genuinely dangerous operation here: if
 * the caller's CRON_SECRET differs from Vercel production's, overwriting the
 * header turns a healthy job into a silent 401. Opt in with --rotate-secret.
 */
export function updateBody(job: JobBody, rotateSecret: boolean, liveHasAuthHeader: boolean): Partial<JobBody> {
  if (rotateSecret || !liveHasAuthHeader) return job;
  const { extendedData, ...rest } = job;
  return rest;
}

/** Stable comparison signature: the fields we care about staying in sync. */
export function signature(j: {
  enabled: boolean;
  title: string;
  requestMethod: number;
  schedule: Schedule;
  extendedData?: { headers?: Record<string, string> };
}): string {
  const s = j.schedule;
  return JSON.stringify({
    enabled: j.enabled,
    title: j.title,
    requestMethod: j.requestMethod,
    schedule: {
      timezone: s.timezone,
      minutes: s.minutes,
      hours: s.hours,
      mdays: s.mdays,
      months: s.months,
      wdays: s.wdays,
    },
    // Presence, not value: the secret itself is deliberately NOT managed by
    // this script (see buildJob / --rotate-secret). Comparing the value would
    // make every run with a stale local CRON_SECRET look like drift, and
    // "fixing" that drift would break auth on a job that was working.
    hasAuthHeader: Boolean(j.extendedData?.headers?.Authorization),
  });
}

// --- API --------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_GAP_MS = 700; // the provider rate-limits; space requests out
let lastCallAt = 0;

async function api(apiKey: string, path: string, init?: RequestInit): Promise<any> {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(init?.headers || {}),
  };
  let res = await fetch(API + path, { ...init, headers });
  if (res.status === 429) {
    await sleep(3000); // back off and retry once
    lastCallAt = Date.now();
    res = await fetch(API + path, { ...init, headers });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init?.method || 'GET'} ${path} -> ${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// --- reconcile --------------------------------------------------------------

async function main() {
  const MODE: 'apply' | 'dry-run' | 'check' = process.argv.includes('--check')
    ? 'check'
    : process.argv.includes('--dry-run')
      ? 'dry-run'
      : 'apply';
  const PRUNE = process.argv.includes('--prune');
  const ROTATE_SECRET = process.argv.includes('--rotate-secret');

  const apiKey = process.env.CRONJOB_API_KEY;
  const cronSecret = process.env.CRON_SECRET;
  const baseUrl = (process.env.CRON_TARGET_BASE_URL || 'https://buildd.dev').replace(/\/+$/, '');

  if (!apiKey) throw new Error('CRONJOB_API_KEY is not set');
  // CRON_SECRET is only needed to CREATE a job (or to --rotate-secret).
  // Updates preserve whatever header the live job already carries, so the
  // common case — fixing a schedule — needs no secret at all.
  if (!cronSecret && MODE === 'apply') {
    console.warn('!  CRON_SECRET is not set: existing jobs keep their current auth header; newly created jobs would carry none and return 401.');
  }
  if (ROTATE_SECRET && !cronSecret) {
    throw new Error('--rotate-secret requires CRON_SECRET to be set');
  }

  const manifest = loadManifest();
  const defaultTz = manifest.timezone || 'UTC';
  const desired = manifest.jobs.map((m) => buildJob(m, defaultTz, baseUrl, cronSecret));
  const desiredUrls = new Set(desired.map((d) => d.url));
  const managedPrefix = `${baseUrl}/api/cron/`;

  console.log(`cron-sync [${MODE}] -> ${baseUrl}  (${desired.length} job(s) in manifest, tz ${defaultTz})\n`);

  const list = await api(apiKey, '/jobs');
  const existing: Array<{ jobId: number; url: string }> = (list.jobs || []).map((j: any) => ({
    jobId: j.jobId,
    url: j.url,
  }));
  // Origin scoping: everything outside our own /api/cron/ namespace is invisible.
  const managed = existing.filter((j) => j.url.startsWith(managedPrefix));
  const foreign = existing.length - managed.length;

  const liveByUrl = new Map<string, typeof managed>();
  for (const j of managed) {
    const arr = liveByUrl.get(j.url) || [];
    arr.push(j);
    liveByUrl.set(j.url, arr);
  }

  const plan = {
    create: [] as JobBody[],
    update: [] as Array<{ jobId: number; job: JobBody; liveHasAuthHeader: boolean }>,
    delete: [] as Array<{ jobId: number; url: string; reason: string }>,
  };

  for (const want of desired) {
    const matches = liveByUrl.get(want.url) || [];
    if (matches.length === 0) {
      plan.create.push(want);
      continue;
    }
    const [keep, ...dupes] = matches;
    const details = (await api(apiKey, `/jobs/${keep.jobId}`)).jobDetails;
    if (signature(details) !== signature(want)) {
      plan.update.push({
        jobId: keep.jobId,
        job: want,
        liveHasAuthHeader: Boolean(details?.extendedData?.headers?.Authorization),
      });
    }
    for (const d of dupes) plan.delete.push({ jobId: d.jobId, url: d.url, reason: 'duplicate' });
  }

  const unmanaged = managed.filter((j) => !desiredUrls.has(j.url));

  // --- report ---
  const short = (u: string) => u.slice(baseUrl.length) || u;
  const fmt = (a: number[]) => (a.length === 1 && a[0] === EVERY ? '*' : a.join(','));
  for (const j of plan.create) {
    const s = j.schedule;
    console.log(`  + CREATE  ${short(j.url)}  -> minutes=${fmt(s.minutes)} hours=${fmt(s.hours)} wdays=${fmt(s.wdays)} enabled=${j.enabled}`);
  }
  for (const u of plan.update) {
    const keeps = ROTATE_SECRET || !u.liveHasAuthHeader ? 'auth header written' : 'auth header preserved';
    const s = u.job.schedule;
    console.log(`  ~ UPDATE  ${short(u.job.url)}  -> minutes=${fmt(s.minutes)} hours=${fmt(s.hours)} wdays=${fmt(s.wdays)} enabled=${u.job.enabled} (${keeps})`);
  }
  for (const d of plan.delete) console.log(`  - DELETE  ${short(d.url)}  (jobId ${d.jobId}, ${d.reason})`);
  for (const u of unmanaged) {
    if (PRUNE) plan.delete.push({ jobId: u.jobId, url: u.url, reason: 'not in manifest (--prune)' });
    console.log(
      `  ${PRUNE ? '- DELETE' : '. KEEP  '}  ${short(u.url)}  (jobId ${u.jobId}, not in manifest${PRUNE ? ', pruning' : ' — left alone; --prune to remove'})`,
    );
  }
  if (foreign > 0) console.log(`  . ${foreign} job(s) on other origins — out of scope, untouched`);

  const drift = plan.create.length + plan.update.length + plan.delete.length;
  if (drift === 0) console.log('  = in sync — nothing to do');

  if (MODE === 'check') {
    if (drift > 0) {
      console.error(`\ncron-job drift: ${drift} change(s) needed. Run \`bun run cron:sync\`.`);
      process.exit(1);
    }
    return;
  }
  if (MODE === 'dry-run') return;

  // --- apply ---
  for (const j of plan.create) {
    await api(apiKey, '/jobs', { method: 'PUT', body: JSON.stringify({ job: j }) });
    console.log(`  + created  ${short(j.url)}`);
  }
  for (const u of plan.update) {
    const body = updateBody(u.job, ROTATE_SECRET, u.liveHasAuthHeader);
    await api(apiKey, `/jobs/${u.jobId}`, { method: 'PATCH', body: JSON.stringify({ job: body }) });
    const secretNote = 'extendedData' in body ? ' (auth header written)' : ' (auth header preserved)';
    console.log(`  ~ updated  ${short(u.job.url)}${secretNote}`);
  }
  for (const d of plan.delete) {
    await api(apiKey, `/jobs/${d.jobId}`, { method: 'DELETE' });
    console.log(`  - deleted  ${short(d.url)}`);
  }
  console.log(`\ndone (${drift} change(s))`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
