/**
 * seed.ts — load a synthetic story dataset into the LOCAL demo database.
 *
 *   bun run scripts/demo/seed.ts [story.json]      (default: scripts/demo/stories/placeholder.json)
 *
 * Wipes every public table first (the demo DB holds nothing else), inserts the
 * story's baseline — team, user, roles, workspace, runners, background
 * missions, memories — and records demo state (id map, clock anchor) in
 * system_cache. Timeline events are NOT applied here; run advance.ts for that.
 *
 * Refuses to run unless DATABASE_URL and the Neon proxy are on localhost
 * (lib/guard.ts). Everything written is synthetic.
 */
import { DEMO } from './lib/guard';
import { createHash } from 'crypto';
import { createLocalDb, schema, sql, type LocalDb } from '../../packages/core/db/local-client';
import { IdMap, loadStory, relTime, saveState, toRow, type Entity, type Story } from './lib/story';

const DEFAULT_STORY = new URL('./stories/placeholder.json', import.meta.url).pathname;

const s = schema;

async function wipe(db: LocalDb) {
  const rows = (await db.execute(sql`
    select string_agg(format('%I.%I', schemaname, tablename), ', ') as list
    from pg_tables where schemaname = 'public'`)).rows as Array<{ list: string | null }>;
  if (rows[0]?.list) await db.execute(sql.raw(`truncate ${rows[0].list} restart identity cascade`));
}

function sha256(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

/** Insert in chunks; drizzle ignores object keys that aren't columns. */
async function insertAll(db: LocalDb, table: any, rows: Record<string, any>[]) {
  for (let i = 0; i < rows.length; i += 50) {
    if (rows.slice(i, i + 50).length) await db.insert(table).values(rows.slice(i, i + 50));
  }
}

/** Warn once per dataset field that isn't a real column (catches schema drift in the story). */
function checkColumns(label: string, table: any, entities: Entity[]) {
  const cols = new Set(Object.keys(table));
  const unknown = new Set<string>();
  for (const e of entities)
    for (const k of Object.keys(e)) if (!k.startsWith('_') && k !== 'key' && k !== 'table' && !cols.has(k)) unknown.add(k);
  if (unknown.size) console.warn(`[seed] ${label}: dataset fields with no column (ignored): ${[...unknown].join(', ')}`);
}

export async function seedStory(db: LocalDb, story: Story, storyName: string, storyPath: string) {
  const ids = new IdMap(storyName);
  const anchorMs = Date.now(); // story t=0 == now; advance.ts rebases as it goes
  const at = (rel?: string, fallbackMs = 0) => relTime(anchorMs, rel, fallbackMs);

  // ── register every key up front so cross-references resolve in any order ──
  const reg = (e: Entity | undefined) => e?.key && ids.register(e.key, e._idShort);
  reg(story.team);
  (story.users ?? []).forEach(reg);
  (story.accounts ?? []).forEach(reg);
  reg(story.workspace);
  (story.roles ?? []).forEach(reg);
  (story.missions ?? []).forEach(reg);
  (story.taskSchedules ?? []).forEach(reg);
  (story.tasks ?? []).forEach(reg);
  (story.workers ?? []).forEach(reg);
  (story.missionNotes ?? []).forEach(reg);
  (story.memories ?? []).forEach(reg);
  (story.artifacts ?? []).forEach(reg);
  for (const bm of story.backgroundMissions ?? []) (bm.tasks ?? []).forEach(reg);
  ids.register('__gh_install');
  ids.register('__gh_repo');

  await wipe(db);

  // ── identity ───────────────────────────────────────────────────────────────
  const team = story.team;
  await db.insert(s.teams).values(toRow(team, ids, { id: ids.get(team.key), createdAt: at('-60d') }) as any);
  for (const u of story.users ?? []) {
    await db.insert(s.users).values(toRow(u, ids, { id: ids.get(u.key), timezone: team.timezone ?? null, createdAt: at('-60d') }) as any);
    await db.insert(s.teamMembers).values({ teamId: ids.get(team.key), userId: ids.get(u.key), role: 'owner' });
  }
  for (const a of story.accounts ?? []) {
    await db.insert(s.accounts).values(toRow(a, ids, { id: ids.get(a.key), teamId: ids.get(team.key), createdAt: at('-60d') }) as any);
  }

  // ── workspace + (synthetic) GitHub linkage for the repo chip ──────────────
  const ws = story.workspace;
  const gh = ws._github as { fullName?: string } | undefined;
  let githubRepoId: string | null = null;
  if (gh?.fullName) {
    const [owner, name] = gh.fullName.split('/');
    await db.insert(s.githubInstallations).values({
      id: ids.get('__gh_install'), installationId: 1000001, accountType: 'Organization', accountLogin: owner, accountId: 2000001,
    } as any);
    await db.insert(s.githubRepos).values({
      id: ids.get('__gh_repo'), installationId: ids.get('__gh_install'), repoId: 3000001, fullName: gh.fullName, name, owner,
    } as any);
    githubRepoId = ids.get('__gh_repo');
  }
  checkColumns('workspace', s.workspaces, [ws]);
  await db.insert(s.workspaces).values(toRow(ws, ids, {
    id: ids.get(ws.key), teamId: ids.get(team.key), githubRepoId,
    githubInstallationId: githubRepoId ? ids.get('__gh_install') : null, createdAt: at('-60d'),
  }) as any);
  for (const a of story.accounts ?? []) {
    await db.insert(s.accountWorkspaces).values({ accountId: ids.get(a.key), workspaceId: ids.get(ws.key), canClaim: true, canCreate: true });
  }

  // ── roles (team-level, like seedDefaultRolesForTeam) ──────────────────────
  checkColumns('roles', s.workspaceSkills, story.roles ?? []);
  for (const r of story.roles ?? []) {
    const content = /Seed with the stock body/.test(r.content ?? '') || !r.content
      ? `# ${r.name}\n\n${r.description ?? ''}\n`
      : r.content;
    await db.insert(s.workspaceSkills).values(toRow(r, ids, {
      id: ids.get(r.key), teamId: ids.get(team.key), workspaceId: null, content, contentHash: sha256(content), createdAt: at('-60d'),
    }) as any);
  }

  // ── runners (heartbeats keep them "online") ───────────────────────────────
  for (const a of (story.accounts ?? []).slice(0, 1))
    for (const r of story.runners ?? []) {
      await db.insert(s.workerHeartbeats).values({
        accountId: ids.get(a.key), localUiUrl: r.localUiUrl, workspaceIds: [ids.get(ws.key)],
        maxConcurrentWorkers: r.maxConcurrentWorkers ?? 2, activeWorkerCount: 0, lastHeartbeatAt: new Date(anchorMs),
        environment: r._display ? ({ label: r._display } as any) : undefined,
      } as any);
    }

  // ── schedules + missions that exist before t=0 ────────────────────────────
  // The story's primary mission is created by a `mission_create` event.
  const createdByEvent = new Set((story.timeline ?? []).filter((e) => e.op === 'mission_create').map((e) => e.mission));
  const userKey = story.users?.[0]?.key;
  checkColumns('missions', s.missions, story.missions ?? []);
  for (const m of story.missions ?? []) {
    if (createdByEvent.has(m.key)) continue;
    const created = at(m._createdAgo, 86_400_000);
    await db.insert(s.missions).values(toRow(m, ids, {
      id: ids.get(m.key), teamId: ids.get(team.key), createdByUserId: m.createdByUserId ? ids.ref(m.createdByUserId) : userKey ? ids.get(userKey) : null,
      scheduleId: null, createdAt: created, updatedAt: m._completedAgo ? at(m._completedAgo) : created,
      completedAt: m.status === 'completed' ? at(m._completedAgo, 3_600_000) : null,
      goalCriteriaState: m.goalCriteriaState
        ? { evaluatedAt: at(m._completedAgo).toISOString(), evaluatedBy: 'auto', criteria: (m.goalCriteria ?? []).map((c: any, index: number) => ({ index, type: c.type, label: c.label, verdict: 'pass' })), ...m.goalCriteriaState }
        : null,
    }) as any);
  }
  for (const sch of story.taskSchedules ?? []) {
    const lastRun = at('-6h');
    await db.insert(s.taskSchedules).values(toRow(sch, ids, {
      id: ids.get(sch.key), workspaceId: ids.get(ws.key),
      taskTemplate: JSON.parse(JSON.stringify(sch.taskTemplate ?? {}), (k, v) => (k === 'missionId' ? ids.ref(v) : v)),
      lastRunAt: lastRun, nextRunAt: new Date(lastRun.getTime() + 6 * 3_600_000), createdAt: at('-12d'),
    }) as any);
    // Link missions that point at this schedule.
    for (const m of story.missions ?? []) {
      if (m.scheduleId === sch.key && !createdByEvent.has(m.key))
        await db.update(s.missions).set({ scheduleId: ids.get(sch.key) }).where(sql`id = ${ids.get(m.key)}`);
    }
  }

  // ── background missions: completed history so lists aren't empty ─────────
  const account = story.accounts?.[0];
  let prSeq = 0;
  for (const bm of story.backgroundMissions ?? []) {
    const mission = (story.missions ?? []).find((m) => m.key === bm.missionKey) ?? {};
    const createdMs = at(mission._createdAgo, 4 * 86_400_000).getTime();
    const doneMs = mission._completedAgo ? at(mission._completedAgo).getTime() : createdMs + 3_600_000;
    const tasks = bm.tasks ?? [];
    tasks.forEach((t: Entity, i: number) => {
      // Spread task lifetimes across the mission's window.
      const span = Math.max(doneMs - createdMs, 600_000);
      t.__start = Math.round(createdMs + (span * i) / Math.max(tasks.length, 1));
      t.__end = Math.round(Math.min(t.__start + (span / Math.max(tasks.length, 1)) * 0.9, doneMs));
    });
    checkColumns(`background ${bm.missionKey} tasks`, s.tasks, tasks);
    await insertAll(db, s.tasks, tasks.map((t: Entity) => toRow(t, ids, {
      id: ids.get(t.key!), workspaceId: ids.get(ws.key), missionId: ids.get(bm.missionKey),
      claimedBy: t.status === 'pending' ? null : account ? ids.get(account.key) : null,
      claimedAt: t.status === 'pending' ? null : new Date(t.__start),
      createdAt: new Date(t.__start - 30_000), updatedAt: new Date(t.__end),
      result: t.status === 'completed' ? { summary: t._summary ?? 'Done.', ...(t._worker?.prUrl ? { prUrl: t._worker.prUrl, prNumber: t._worker.prNumber } : {}) } : null,
    })));
    const workers = tasks.filter((t: Entity) => t._worker).map((t: Entity) => {
      const w = t._worker;
      const shortId = ids.get(t.key!).slice(0, 8);
      return {
        id: ids.register(`${t.key}__w`), taskId: ids.get(t.key!), workspaceId: ids.get(ws.key), accountId: account ? ids.get(account.key) : null,
        name: `${account?.name ?? 'demo'}-${shortId}`, runner: w.runner ?? 'atlas',
        branch: `buildd/${shortId}-${String(t.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}`,
        status: w.status ?? 'completed', startedAt: new Date(t.__start), completedAt: w.status === 'completed' ? new Date(t.__end) : null,
        updatedAt: new Date(t.__end), createdAt: new Date(t.__start),
        prUrl: w.prUrl ?? null, prNumber: w.prNumber ?? null, prLifecycleStatus: w.prLifecycleStatus ?? null,
        mergedAt: w.prLifecycleStatus === 'merged' ? new Date(t.__end) : null,
        linesAdded: w.linesAdded ?? 0, linesRemoved: w.linesRemoved ?? 0, filesChanged: w.filesChanged ?? (w.prNumber ? 4 + (prSeq++ % 7) : 0),
        commitCount: w.prNumber ? 2 + (prSeq % 3) : 0, turns: 18 + (prSeq % 23), inputTokens: 180_000 + prSeq * 9_000, outputTokens: 12_000 + prSeq * 700,
        costUsd: (0.8 + (prSeq % 5) * 0.37).toFixed(4),
        error: w.status === 'error' ? w.error ?? 'Paused: mission is held for review' : null,
        milestones: [
          { type: 'checkpoint', event: 'session_started', label: 'Session started', ts: t.__start },
          { type: 'status', label: 'Done', progress: 100, ts: t.__end },
        ],
      };
    });
    await insertAll(db, s.workers, workers);
  }

  // ── heartbeat history for the recurring mission ───────────────────────────
  const hbMission = (story.missions ?? []).find((m) => m.scheduleId);
  const hbSchedule = (story.taskSchedules ?? [])[0];
  for (const [i, tick] of (story.heartbeatPastTicks ?? []).entries()) {
    if (!hbMission) break;
    const startMs = anchorMs - tick.agoHours * 3_600_000;
    const tKey = `__hb${i}`;
    const tId = ids.register(tKey);
    await db.insert(s.tasks).values({
      id: tId, workspaceId: ids.get(ws.key), missionId: ids.get(hbMission.key), title: hbSchedule?.taskTemplate?.title ?? `Mission: ${hbMission.title}`,
      description: 'Heartbeat tick.', status: 'completed', mode: 'planning', roleSlug: 'organizer', kind: 'coordination', creationSource: 'schedule',
      scheduleId: hbSchedule ? ids.get(hbSchedule.key) : null, heartbeatTickAnchor: new Date(startMs).toISOString(),
      claimedBy: account ? ids.get(account.key) : null, claimedAt: new Date(startMs), createdAt: new Date(startMs), updatedAt: new Date(startMs + 70_000),
      result: { summary: tick.summary }, outputRequirement: 'none',
    } as any);
    await db.insert(s.workers).values({
      id: ids.register(`${tKey}__w`), taskId: tId, workspaceId: ids.get(ws.key), accountId: account ? ids.get(account.key) : null,
      name: `${account?.name ?? 'demo'}-${tId.slice(0, 8)}`, runner: 'dune', branch: `buildd/${tId.slice(0, 8)}-mission-keep-dependencies-curr`,
      status: 'completed', startedAt: new Date(startMs), completedAt: new Date(startMs + 70_000), createdAt: new Date(startMs), updatedAt: new Date(startMs + 70_000),
      turns: 9, inputTokens: 60_000, outputTokens: 3_000, costUsd: '0.21', milestones: [{ type: 'status', label: tick.summary, progress: 100, ts: startMs + 60_000 }],
    } as any);
  }

  // ── memories not produced by the timeline ─────────────────────────────────
  const byEvent = new Set((story.timeline ?? []).filter((e) => e.op === 'memory').map((e) => e.memory));
  const baseMemories = (story.memories ?? []).filter((m: Entity) => !byEvent.has(m.key));
  checkColumns('memories', s.memories, story.memories ?? []);
  await insertAll(db, s.memories, baseMemories.map((m: Entity, i: number) => toRow(m, ids, {
    id: ids.get(m.key!), teamId: ids.get(team.key), createdAt: at(`-${3 + i * 3}d`), updatedAt: at(`-${3 + i * 3}d`),
  })));

  // ── pre-existing artifacts (none reference the timeline) ──────────────────
  const artByEvent = new Set((story.timeline ?? []).filter((e) => e.op === 'artifact').map((e) => e.artifact));
  const baseArtifacts = (story.artifacts ?? []).filter((a: Entity) => !artByEvent.has(a.key));
  await insertAll(db, s.artifacts, baseArtifacts.map((a: Entity) => artifactRow(a, ids, new Date(anchorMs - 86_400_000))));

  // Sanity: dataset fields that don't map to columns (story generator drift).
  checkColumns('tasks', s.tasks, story.tasks ?? []);
  checkColumns('workers', s.workers, story.workers ?? []);
  checkColumns('missionNotes', s.missionNotes, story.missionNotes ?? []);
  checkColumns('artifacts', s.artifacts, (story.artifacts ?? []).map(({ key: _k, artifactKey: _a, ...rest }: Entity) => rest));

  await saveState(db, { storyPath, storyName, ids: ids.ids, anchorMs, appliedT: -1, nextEvent: 0 });
  return ids;
}

/** artifacts.key is the dataset's `artifactKey`; the dataset `key` is only a ref. */
export function artifactRow(a: Entity, ids: IdMap, when: Date) {
  const { artifactKey, ...rest } = a;
  return toRow(rest, ids, { id: ids.get(a.key!), key: artifactKey ?? null, createdAt: when, updatedAt: when });
}

if (import.meta.main) {
  const path = process.argv[2] ?? DEFAULT_STORY;
  const { story, name, path: abs } = loadStory(path);
  const db = createLocalDb();
  console.log(`[seed] story "${name}" → ${DEMO.databaseUrl}`);
  await seedStory(db, story, name, abs);
  console.log(`[seed] done. Login user: ${story.users?.[0]?.email}. Next: bun run scripts/demo/advance.ts <t|end>`);
}
