/**
 * Story dataset helpers shared by seed.ts / advance.ts / run-storyboard.ts.
 *
 * A story is a JSON file of synthetic entities (each with a `key`) plus a
 * `timeline[]` of events keyed by `t` = seconds since the story began. Entity
 * cross-references use keys ("T3", "w3", "ws"); the seed mints deterministic
 * UUIDs for them (honouring `_idShort` as the first 8 hex chars, so branch names
 * like buildd/<id8>-… line up with the real id).
 *
 * Fields starting with `_`, plus `key` and `table`, are dataset metadata, never
 * columns.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { basename, resolve } from 'path';
import { sql, type LocalDb } from '../../../packages/core/db/local-client';

export type Entity = Record<string, any> & { key?: string };
export type TimelineEvent = Record<string, any> & { t: number; op: string };
export type Story = Record<string, any> & { timeline: TimelineEvent[] };

export function loadStory(path: string): { story: Story; name: string; path: string } {
  const abs = resolve(path);
  const story = JSON.parse(readFileSync(abs, 'utf8')) as Story;
  story.timeline = [...(story.timeline ?? [])].sort((a, b) => a.t - b.t);
  const name = basename(abs).replace(/\.json$/, '').replace(/[^a-z0-9-]+/gi, '-');
  return { story, name, path: abs };
}

/** Deterministic UUID for a dataset key; `idShort` (8 hex) becomes its prefix. */
export function mintId(storyName: string, key: string, idShort?: string): string {
  const h = createHash('sha256').update(`${storyName}:${key}`).digest('hex');
  const hex = (idShort && /^[0-9a-f]{8}$/i.test(idShort) ? idShort.toLowerCase() : h.slice(0, 8)) + h.slice(8, 32);
  const chars = hex.split('');
  chars[12] = '4';
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const s = chars.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Columns whose string value is a dataset key to resolve to a UUID. */
const REF_FIELDS = new Set([
  'teamId', 'userId', 'workspaceId', 'missionId', 'taskId', 'workerId', 'accountId',
  'createdByUserId', 'createdByWorkerId', 'createdByAccountId', 'parentTaskId', 'scheduleId',
  'claimedBy', 'replyTo', 'lastTaskId', 'parentMissionId', 'dependsOnMissionId', 'githubRepoId',
  'githubInstallationId', 'installationId',
]);

export class IdMap {
  constructor(public storyName: string, public ids: Record<string, string> = {}) {}
  register(key: string, idShort?: string): string {
    return (this.ids[key] ??= mintId(this.storyName, key, idShort));
  }
  get(key: string): string {
    const id = this.ids[key];
    if (!id) throw new Error(`[demo] unknown dataset key "${key}"`);
    return id;
  }
  has(key: string) {
    return key in this.ids;
  }
  /** Resolve a single value that may be a key. Unknown strings pass through. */
  ref(v: unknown): unknown {
    return typeof v === 'string' && this.ids[v] ? this.ids[v] : v;
  }
}

/** Strip dataset metadata and resolve key references → a drizzle insert row. */
export function toRow(entity: Entity, ids: IdMap, overrides: Record<string, unknown> = {}): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k.startsWith('_') || k === 'key' || k === 'table') continue;
    if (REF_FIELDS.has(k)) out[k] = v == null ? v : ids.ref(v);
    else if (k === 'dependsOn' && Array.isArray(v)) out[k] = v.map((x) => ids.ref(x));
    else if (k === 'source' && typeof v === 'string') out[k] = v.replace(/^(task|mission):(\w+)$/, (m, kind, key) => (ids.has(key) ? `${kind}:${ids.get(key)}` : m));
    else out[k] = v;
  }
  return { ...out, ...overrides };
}

/** '-3d' / '-6h' / '-15m' relative to `anchorMs` → Date. */
export function relTime(anchorMs: number, rel: string | undefined, fallbackMs = 0): Date {
  const m = /^-?(\d+(?:\.\d+)?)([smhd])$/.exec(rel ?? '');
  if (!m) return new Date(anchorMs - fallbackMs);
  const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return new Date(anchorMs - Number(m[1]) * unit);
}

export const SCHEDULE_INTERVAL_MS = 6 * 3_600_000;

/**
 * A schedule's baseline lastRunAt/nextRunAt. If the timeline fires it
 * (`schedule_fire`), the next run is due exactly when that tick fires, so the
 * recurring mission counts down ("next 9m") instead of reading "due now" for the
 * whole story; the previous run is one interval earlier.
 */
export function scheduleBaseline(story: Story, scheduleKey: string, anchorMs: number, intervalMs = SCHEDULE_INTERVAL_MS): { lastRunAt: Date; nextRunAt: Date } {
  const fire = (story.timeline ?? []).find((e) => e.op === 'schedule_fire' && e.schedule === scheduleKey);
  const nextMs = fire ? anchorMs + fire.t * 1000 : anchorMs;
  return { lastRunAt: new Date(nextMs - intervalMs), nextRunAt: new Date(nextMs) };
}

// ── persisted demo state (lives in the demo DB itself, system_cache) ──────────

export type DemoState = {
  storyPath: string;
  storyName: string;
  ids: Record<string, string>;
  /** Wall-clock ms that corresponds to story t=0. */
  anchorMs: number;
  /** Highest t already applied (-1 = only the t<0 baseline). */
  appliedT: number;
  /** Index into the sorted timeline of the next unapplied event. */
  nextEvent: number;
};

const STATE_KEY = 'demo:state';

export async function loadState(db: LocalDb): Promise<DemoState> {
  const rows = (await db.execute(sql`select value from system_cache where key = ${STATE_KEY}`)).rows as Array<{ value: DemoState }>;
  if (!rows[0]) throw new Error('[demo] no demo state — run scripts/demo/seed.ts first');
  return rows[0].value;
}

export async function saveState(db: LocalDb, state: DemoState): Promise<void> {
  await db.execute(sql`
    insert into system_cache (key, value, updated_at) values (${STATE_KEY}, ${JSON.stringify(state)}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
}

/**
 * Shift every timestamp in the demo DB by `deltaMs`, so "story now" tracks the
 * wall clock without the app ever seeing a faked server time. Covers every
 * timestamp column in `public` plus the ms-epoch `ts`/`timestamp` fields inside
 * workers.milestones.
 */
export async function shiftAllTimestamps(db: LocalDb, deltaMs: number): Promise<void> {
  if (!deltaMs) return;
  const secs = (deltaMs / 1000).toFixed(3);
  await db.execute(sql.raw(`
    do $$
    declare r record; sets text;
    begin
      for r in
        select table_name, string_agg(format('%I = %I + interval ''${secs} seconds''', column_name, column_name), ', ') as sets
        from information_schema.columns
        where table_schema = 'public' and data_type like 'timestamp%'
        group by table_name
      loop
        execute format('update %I set %s', r.table_name, r.sets);
      end loop;
    end $$;`));
  const ms = Math.round(deltaMs);
  await db.execute(sql.raw(`
    update workers set milestones = (
      select coalesce(jsonb_agg(
        case
          when jsonb_typeof(m->'ts') = 'number' then jsonb_set(m, '{ts}', to_jsonb(round((m->>'ts')::numeric) + ${ms}))
          when jsonb_typeof(m->'timestamp') = 'number' then jsonb_set(m, '{timestamp}', to_jsonb(round((m->>'timestamp')::numeric) + ${ms}))
          else m end), '[]'::jsonb)
      from jsonb_array_elements(milestones) m)
    where jsonb_typeof(milestones) = 'array' and jsonb_array_length(milestones) > 0`));
}

/**
 * A real runner claims with `runner = <its localUiUrl>` and reports that URL on
 * the worker row too; the platform joins workers to heartbeats on it. Stories
 * name runners by key ("atlas"), so map the key to the runner's URL.
 */
export function runnerUrl(story: Story, key: string | null | undefined): string {
  const r = (story.runners ?? []).find((x: Entity) => x.runner === key || x.key === key);
  return r?.localUiUrl ?? String(key ?? 'runner');
}

/** The heartbeat `environment` a real runner reports: hostname + a readable machine label. */
export function runnerEnvironment(r: Entity): Record<string, unknown> {
  const [host, machine] = String(r._display ?? r.runner ?? '').split(/\s*·\s*/);
  return {
    tools: [], envKeys: [], mcp: [], scannedAt: new Date(0).toISOString(),
    labels: { type: 'local', hostname: host || String(r.runner), ...(machine ? { machine } : {}) },
  };
}
