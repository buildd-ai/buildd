/**
 * advance.ts — replay a story's timeline into the LOCAL demo DB up to time t.
 *
 *   bun run scripts/demo/advance.ts <t>        # t in seconds, or mm:ss, or "end"
 *   bun run scripts/demo/advance.ts 14:30      # state just after the waiting_input question
 *
 * Each event is applied DB-direct (deterministic for filming — no GitHub/CI to
 * fake) and then announced on the same Pusher channels/events the real API
 * uses, via the local soketi, so open dashboards update live. Going backwards
 * re-seeds and replays from scratch.
 *
 * Time: "story now" always equals the wall clock. Before applying anything, every
 * timestamp in the DB is shifted so t=0 lands at (now - t), so relative labels
 * ("3m ago", "running 6m") read correctly without faking the server's clock.
 */
import { DEMO } from './lib/guard';
import { createLocalDb, schema as s, sql, eq, type LocalDb } from '../../packages/core/db/local-client';
import { IdMap, loadState, loadStory, saveState, shiftAllTimestamps, toRow, type DemoState, type Entity, type Story, type TimelineEvent } from './lib/story';
import { artifactRow, seedStory } from './seed';
import { triggerPusher } from './lib/pusher';
import { toolMilestone } from './lib/tool-milestone';

type Ctx = { db: LocalDb; story: Story; ids: IdMap; state: DemoState; at: (t: number) => Date; ms: (t: number) => number; pushes: Array<[string, string, unknown]> };

const LIVE = new Set(['idle', 'starting', 'running', 'waiting_input']);

export function parseT(v: string, story: Story): number {
  if (v === 'end') return Math.max(...story.timeline.map((e) => e.t), 0);
  const mm = /^(\d+):(\d{1,2})$/.exec(v);
  if (mm) return Number(mm[1]) * 60 + Number(mm[2]);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`[advance] bad time "${v}" (seconds, mm:ss or "end")`);
  return n;
}

const find = (list: Entity[] | undefined, key: string) => {
  const e = (list ?? []).find((x) => x.key === key);
  if (!e) throw new Error(`[advance] dataset has no entity "${key}"`);
  return e;
};

async function workerRow(c: Ctx, key: string) {
  const [w] = await c.db.select().from(s.workers).where(eq(s.workers.id, c.ids.get(key)));
  return w;
}

async function appendMilestones(c: Ctx, workerKey: string, add: Array<Record<string, unknown>>) {
  await c.db.execute(sql`update workers set milestones = coalesce(milestones, '[]'::jsonb) || ${JSON.stringify(add)}::jsonb where id = ${c.ids.get(workerKey)}`);
}

async function hasCheckpoint(c: Ctx, workerKey: string, event: string) {
  const r = await c.db.execute(sql`select 1 from workers, jsonb_array_elements(milestones) m where id = ${c.ids.get(workerKey)} and m->>'event' = ${event} limit 1`);
  return r.rows.length > 0;
}

async function ensureTask(c: Ctx, key: string, t: number) {
  if ((await c.db.select({ id: s.tasks.id }).from(s.tasks).where(eq(s.tasks.id, c.ids.get(key)))).length) return;
  const task = find(c.story.tasks, key);
  await c.db.insert(s.tasks).values(toRow(task, c.ids, {
    id: c.ids.get(key), status: 'pending', createdAt: c.at(t), updatedAt: c.at(t),
    heartbeatTickAnchor: task.heartbeatTickAnchor ? c.at(t).toISOString() : null,
  }) as any);
  c.pushes.push([`workspace-${task.workspaceId ? c.ids.ref(task.workspaceId) : ''}`, 'task:created', { task: { id: c.ids.get(key) } }]);
}

function wsChannel(c: Ctx) {
  return `workspace-${c.ids.get(c.story.workspace.key)}`;
}

function workerPush(c: Ctx, workerKey: string, taskKey: string | null, status: string, extra: Record<string, unknown> = {}) {
  const event = status === 'completed' ? 'worker:completed' : status === 'failed' ? 'worker:failed' : 'worker:progress';
  const payload = { workerId: c.ids.get(workerKey), taskId: taskKey ? c.ids.get(taskKey) : null, status, updatedAt: new Date().toISOString(), ...extra };
  c.pushes.push([`worker-${c.ids.get(workerKey)}`, event, payload], [wsChannel(c), event, payload]);
}

async function insertNote(c: Ctx, noteKey: string, t: number) {
  const n = find(c.story.missionNotes, noteKey);
  await c.db.insert(s.missionNotes).values(toRow(n, c.ids, { id: c.ids.get(noteKey), status: 'open', createdAt: c.at(t) }) as any)
    .onConflictDoNothing();
  if (n.missionId) c.pushes.push([`mission-${c.ids.ref(n.missionId)}`, 'mission:note_posted', { noteId: c.ids.get(noteKey), type: n.type }]);
}

function taskKeyOfWorker(c: Ctx, workerKey: string): string {
  return find(c.story.workers, workerKey).taskId;
}

const handlers: Record<string, (c: Ctx, e: TimelineEvent) => Promise<void>> = {
  async mission_create(c, e) {
    const m = find(c.story.missions, e.mission);
    const user = c.story.users?.[0];
    await c.db.insert(s.missions).values(toRow(m, c.ids, {
      id: c.ids.get(m.key!), teamId: c.ids.get(c.story.team.key), status: 'active', goalCriteriaState: null,
      createdByUserId: m.createdByUserId ? c.ids.ref(m.createdByUserId) : user ? c.ids.get(user.key) : null,
      createdAt: c.at(e.t), updatedAt: c.at(e.t),
    }) as any);
  },

  async task_create(c, e) {
    await ensureTask(c, e.task, e.t);
  },

  async claim(c, e) {
    await ensureTask(c, e.task, e.t);
    const w = find(c.story.workers, e.worker);
    const account = c.story.accounts?.[0];
    await c.db.update(s.tasks).set({ status: 'assigned', claimedBy: account ? c.ids.get(account.key) : null, claimedAt: c.at(e.t), updatedAt: c.at(e.t) } as any)
      .where(eq(s.tasks.id, c.ids.get(e.task)));
    await c.db.insert(s.workers).values(toRow(w, c.ids, {
      id: c.ids.get(w.key!), status: 'idle', runner: e.runner ?? w.runner, milestones: [], createdAt: c.at(e.t), updatedAt: c.at(e.t),
    }) as any);
    const task = find(c.story.tasks, e.task);
    if (task.missionId) await c.db.update(s.missions).set({ lastTaskStartedAt: c.at(e.t) } as any).where(eq(s.missions.id, c.ids.get(task.missionId)));
    c.pushes.push([wsChannel(c), 'task:claimed', { task: { id: c.ids.get(e.task) }, workerId: c.ids.get(w.key!) }]);
  },

  async worker_status(c, e) {
    const taskKey = taskKeyOfWorker(c, e.worker);
    const set: Record<string, unknown> = { status: e.status, updatedAt: c.at(e.t) };
    // Like PATCH /api/workers/[id]: startedAt is stamped on the FIRST running
    // report only, so a session resumed after an answer keeps its start.
    if (e.status === 'running' && !(await workerRow(c, e.worker))?.startedAt) set.startedAt = c.at(e.t);
    await c.db.update(s.workers).set(set as any).where(eq(s.workers.id, c.ids.get(e.worker)));
    if (e.status === 'running') {
      await c.db.update(s.tasks).set({ status: 'in_progress', updatedAt: c.at(e.t) } as any).where(eq(s.tasks.id, c.ids.get(taskKey)));
      if (!(await hasCheckpoint(c, e.worker, 'session_started')))
        await appendMilestones(c, e.worker, [{ type: 'checkpoint', event: 'session_started', label: 'Session started', ts: c.ms(e.t) }]);
    }
    workerPush(c, e.worker, taskKey, e.status);
  },

  async progress(c, e) {
    const add: Array<Record<string, unknown>> = [];
    if (!(await hasCheckpoint(c, e.worker, 'first_read')))
      add.push({ type: 'checkpoint', event: 'first_read', label: 'First file read', ts: c.ms(e.t) - 1500 });
    if ((e.pct ?? 0) >= 40 && !(await hasCheckpoint(c, e.worker, 'first_edit')))
      add.push({ type: 'checkpoint', event: 'first_edit', label: 'First edit', ts: c.ms(e.t) - 500 });
    add.push({ type: 'status', label: e.message, ...(e.pct != null ? { progress: e.pct } : {}), ts: c.ms(e.t) });
    await appendMilestones(c, e.worker, add);
    const w = await workerRow(c, e.worker);
    // Plausible live counters: turns/tokens/cost grow with progress.
    const pct = Math.max(1, e.pct ?? 30);
    await c.db.update(s.workers).set({
      currentAction: e.message, updatedAt: c.at(e.t),
      turns: Math.max(w?.turns ?? 0, Math.round(pct * 0.42)),
      inputTokens: Math.max(w?.inputTokens ?? 0, pct * 4_100),
      outputTokens: Math.max(w?.outputTokens ?? 0, pct * 290),
      costUsd: Math.max(Number(w?.costUsd ?? 0), pct * 0.031).toFixed(4),
    } as any).where(eq(s.workers.id, c.ids.get(e.worker)));
    workerPush(c, e.worker, taskKeyOfWorker(c, e.worker), w?.status ?? 'running', { currentAction: String(e.message).slice(0, 200) });
  },

  // One tool call, recorded the way the runner records it: an action milestone
  // with structured {tool, path, add, rem, cmd, count} and the legacy label.
  async tool(c, e) {
    await appendMilestones(c, e.worker, [toolMilestone(e, c.ms(e.t))]);
  },

  async mission_note(c, e) {
    await insertNote(c, e.note, e.t);
  },

  async pr_open(c, e) {
    await c.db.update(s.workers).set({
      prUrl: e.prUrl, prNumber: e.prNumber, prLifecycleStatus: 'pr_open', prBaseRef: 'main',
      linesAdded: e.linesAdded ?? 0, linesRemoved: e.linesRemoved ?? 0, filesChanged: e.filesChanged ?? 0, commitCount: e.commitCount ?? 1,
      lastCommitSha: (c.ids.get(e.worker).replace(/-/g, '').slice(8, 15)), updatedAt: c.at(e.t),
    } as any).where(eq(s.workers.id, c.ids.get(e.worker)));
    const add: Array<Record<string, unknown>> = [];
    if (!(await hasCheckpoint(c, e.worker, 'first_commit')))
      add.push({ type: 'checkpoint', event: 'first_commit', label: 'First commit', ts: c.ms(e.t) - 20_000 });
    add.push({ type: 'status', label: `Opened PR #${e.prNumber}: ${e.title ?? ''}`.trim(), ts: c.ms(e.t) });
    await appendMilestones(c, e.worker, add);
    const w = await workerRow(c, e.worker);
    workerPush(c, e.worker, taskKeyOfWorker(c, e.worker), w?.status ?? 'running');
  },

  async ci(c, e) {
    await c.db.update(s.workers).set({ prLifecycleStatus: e.state, prLastCheckedAt: c.at(e.t), updatedAt: c.at(e.t) } as any)
      .where(eq(s.workers.id, c.ids.get(e.worker)));
    const w = await workerRow(c, e.worker);
    workerPush(c, e.worker, taskKeyOfWorker(c, e.worker), w?.status ?? 'completed');
  },

  async merge(c, e) {
    await c.db.update(s.workers).set({ mergedAt: c.at(e.t), prLifecycleStatus: 'merged', updatedAt: c.at(e.t) } as any)
      .where(eq(s.workers.id, c.ids.get(e.worker)));
    const w = await workerRow(c, e.worker);
    workerPush(c, e.worker, taskKeyOfWorker(c, e.worker), w?.status ?? 'completed');
  },

  async complete(c, e) {
    const w = find(c.story.workers, e.worker);
    const row = await workerRow(c, e.worker);
    const final = w._final ?? {};
    await c.db.update(s.workers).set({
      status: 'completed', completedAt: c.at(e.t), updatedAt: c.at(e.t), currentAction: null, waitingFor: null,
      ...(row?.prNumber ? {} : pick(final, ['prUrl', 'prNumber', 'linesAdded', 'linesRemoved', 'filesChanged', 'commitCount'])),
    } as any).where(eq(s.workers.id, c.ids.get(e.worker)));
    await appendMilestones(c, e.worker, [
      { type: 'status', label: e.summary ?? 'Done', progress: 100, ts: c.ms(e.t) },
      { type: 'checkpoint', event: 'task_completed', label: 'Task completed', ts: c.ms(e.t) },
    ]);
    const after = await workerRow(c, e.worker);
    await c.db.update(s.tasks).set({
      status: 'completed', updatedAt: c.at(e.t),
      result: {
        summary: e.summary ?? 'Done.', branch: after?.branch,
        ...(after?.prUrl ? { prUrl: after.prUrl, prNumber: after.prNumber } : {}),
        commits: after?.commitCount ?? 0, files: after?.filesChanged ?? 0, added: after?.linesAdded ?? 0, removed: after?.linesRemoved ?? 0,
      },
    } as any).where(eq(s.tasks.id, c.ids.get(e.task)));
    workerPush(c, e.worker, e.task, 'completed');
    c.pushes.push([wsChannel(c), 'task:completed', { task: { id: c.ids.get(e.task) } }]);
  },

  async waiting_input(c, e) {
    await c.db.update(s.workers).set({ status: 'waiting_input', waitingFor: e.waitingFor, currentAction: e.waitingFor?.prompt ?? null, updatedAt: c.at(e.t) } as any)
      .where(eq(s.workers.id, c.ids.get(e.worker)));
    await appendMilestones(c, e.worker, [{ type: 'status', label: `Asked: ${e.waitingFor?.prompt ?? 'a question'}`, ts: c.ms(e.t) }]);
    if (e.note) await insertNote(c, e.note, e.t);
    workerPush(c, e.worker, e.task, 'waiting_input');
  },

  async human_reply(c, e) {
    if (e.note) {
      await insertNote(c, e.note, e.t);
      const n = find(c.story.missionNotes, e.note);
      if (n.replyTo) await c.db.update(s.missionNotes).set({ status: 'answered' } as any).where(eq(s.missionNotes.id, c.ids.get(n.replyTo)));
    }
    const w = await workerRow(c, e.worker);
    await c.db.update(s.workers).set({
      status: 'running', waitingFor: null, currentAction: 'Applying your answer', updatedAt: c.at(e.t),
      instructionHistory: [...((w?.instructionHistory as any[]) ?? []), { type: 'response', message: e.message, timestamp: c.ms(e.t), deliveryState: 'delivered' }],
    } as any).where(eq(s.workers.id, c.ids.get(e.worker)));
    await appendMilestones(c, e.worker, [{ type: 'status', label: `Answer received: ${e.message}`, ts: c.ms(e.t) }]);
    workerPush(c, e.worker, e.task, 'running');
  },

  async agent_message(c, e) {
    const w = await workerRow(c, e.toWorker);
    if (w) {
      await c.db.update(s.workers).set({
        instructionHistory: [...((w.instructionHistory as any[]) ?? []), { type: 'instruction', message: e.message, timestamp: c.ms(e.t), deliveryState: 'delivered' }],
        updatedAt: c.at(e.t),
      } as any).where(eq(s.workers.id, c.ids.get(e.toWorker)));
    }
    await appendMilestones(c, e.fromWorker, [{ type: 'status', label: `Messaged the ${find(c.story.tasks, e.toTask).title.split(':')[0]} agent: ${e.message}`, ts: c.ms(e.t) }]);
  },

  async artifact(c, e) {
    const a = find(c.story.artifacts, e.artifact);
    await c.db.insert(s.artifacts).values(artifactRow(a, c.ids, c.at(e.t)) as any).onConflictDoNothing();
    if (a.workerId) {
      c.pushes.push([wsChannel(c), 'worker:artifact', { workerId: c.ids.ref(a.workerId), artifactId: c.ids.get(a.key!) }]);
      await appendMilestones(c, a.workerId, [{ type: 'status', label: `Saved ${a.type}: ${a.title}`, ts: c.ms(e.t) }]);
    }
  },

  async memory(c, e) {
    const m = find(c.story.memories, e.memory);
    await c.db.insert(s.memories).values(toRow(m, c.ids, { id: c.ids.get(m.key!), teamId: c.ids.get(c.story.team.key), createdAt: c.at(e.t), updatedAt: c.at(e.t) }) as any)
      .onConflictDoNothing();
  },

  async push_commit(c, e) {
    await c.db.execute(sql`update workers set last_commit_sha = ${e.sha}, commit_count = coalesce(commit_count, 0) + 1, updated_at = ${c.at(e.t)} where id = ${c.ids.get(e.worker)}`);
    await appendMilestones(c, e.worker, [{ type: 'status', label: `Pushed ${e.sha} to the PR #${e.prNumber} branch`, ts: c.ms(e.t) }]);
  },

  async schedule_fire(c, e) {
    await ensureTask(c, e.task, e.t);
    await c.db.execute(sql`update task_schedules set last_run_at = ${c.at(e.t)}, next_run_at = ${new Date(c.ms(e.t) + 6 * 3_600_000)},
      total_runs = total_runs + 1, last_task_id = ${c.ids.get(e.task)} where id = ${c.ids.get(e.schedule)}`);
  },

  async criteria_eval(c, e) {
    const m = find(c.story.missions, e.mission);
    const [row] = await c.db.select({ state: s.missions.goalCriteriaState }).from(s.missions).where(eq(s.missions.id, c.ids.get(m.key!)));
    const prev = ((row?.state as any)?.criteria ?? []) as any[];
    const criteria = (e.state.criteria ?? []).map((cr: any) => {
      const base = prev.find((p) => p.index === cr.index) ?? {};
      const goal = (m.goalCriteria ?? [])[cr.index] ?? {};
      const merged = { type: goal.type, label: goal.label, ...base, ...cr };
      if (merged.workerTaskId) merged.workerTaskId = c.ids.ref(merged.workerTaskId);
      return merged;
    });
    await c.db.update(s.missions).set({
      goalCriteriaState: { evaluatedAt: c.at(e.t).toISOString(), evaluatedBy: 'auto', overall: e.state.overall, criteria },
      updatedAt: c.at(e.t),
    } as any).where(eq(s.missions.id, c.ids.get(m.key!)));
    c.pushes.push([`mission-${c.ids.get(m.key!)}`, 'mission:completion_decision', { overall: e.state.overall }]);
  },

  async mission_complete(c, e) {
    const m = find(c.story.missions, e.mission);
    await c.db.update(s.missions).set({ status: 'completed', completedAt: c.at(e.t), updatedAt: c.at(e.t) } as any).where(eq(s.missions.id, c.ids.get(m.key!)));
    const summary = (c.story.artifacts ?? []).find((a: Entity) => a.missionId === m.key && a.type === 'summary');
    await c.db.insert(s.missionNotes).values({
      missionId: c.ids.get(m.key!), authorType: 'system', type: 'update', title: 'Mission completed',
      body: summary?.content ?? null, actorLabel: 'buildd', status: 'open', createdAt: c.at(e.t),
    } as any);
    c.pushes.push([`mission-${c.ids.get(m.key!)}`, 'mission:note_posted', {}], [wsChannel(c), 'task:completed', {}]);
  },
};

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

/**
 * Runner heartbeats: keep them fresh and their active counts true to the replay.
 * A real runner syncs each live worker every ~30s, so live workers' updated_at
 * is pulled to within the last half-minute — otherwise liveness checks read a
 * worker that last reported progress minutes ago as silent.
 */
async function syncRunners(c: Ctx) {
  await c.db.execute(sql`
    update workers set updated_at = greatest(updated_at, now() - make_interval(secs => 5 + (abs(hashtext(id::text)) % 25)))
    where status in ('idle','starting','running','waiting_input')`);
  for (const r of c.story.runners ?? []) {
    await c.db.execute(sql`
      update worker_heartbeats set last_heartbeat_at = now(), updated_at = now(),
        active_worker_count = (select count(*) from workers where runner = ${r.runner} and status in ('idle','starting','running','waiting_input'))
      where local_ui_url = ${r.localUiUrl}`);
  }
}

export async function advanceTo(db: LocalDb, target: number, opts: { quiet?: boolean } = {}): Promise<{ applied: number; t: number }> {
  let state = await loadState(db);
  let { story } = loadStory(state.storyPath);
  // Asking for "end" after already running past it is not a rewind.
  const lastT = story.timeline.length ? story.timeline[story.timeline.length - 1].t : 0;
  if (target < state.appliedT && target >= lastT && state.nextEvent >= story.timeline.length) target = state.appliedT;
  if (target < state.appliedT) {
    if (!opts.quiet) console.log(`[advance] t=${target} is before t=${state.appliedT}; re-seeding`);
    await seedStory(db, story, state.storyName, state.storyPath);
    state = await loadState(db);
  }

  // Rebase the clock: story t=target is "now".
  const newAnchor = Date.now() - target * 1000;
  await shiftAllTimestamps(db, newAnchor - state.anchorMs);
  state.anchorMs = newAnchor;

  const ids = new IdMap(state.storyName, state.ids);
  const c: Ctx = {
    db, story, ids, state, pushes: [],
    at: (t) => new Date(newAnchor + t * 1000),
    ms: (t) => newAnchor + t * 1000,
  };

  let applied = 0;
  while (state.nextEvent < story.timeline.length && story.timeline[state.nextEvent].t <= target) {
    const e = story.timeline[state.nextEvent];
    const h = handlers[e.op];
    if (!h) console.warn(`[advance] no handler for op "${e.op}" (t=${e.t}) — skipped`);
    else await h(c, e);
    state.nextEvent++;
    applied++;
  }
  state.appliedT = target;
  state.ids = ids.ids;
  await syncRunners(c);
  await saveState(db, state);

  // Announce after the DB is consistent. Dedupe: one refresh per channel+event is enough.
  const seen = new Set<string>();
  let delivered = 0;
  for (const [ch, ev, data] of c.pushes.reverse()) {
    const k = `${ch}|${ev}|${(data as any)?.workerId ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (await triggerPusher(ch, ev, data)) delivered++;
  }
  if (!opts.quiet) console.log(`[advance] t=${target}s: applied ${applied} event(s), ${delivered}/${seen.size} realtime push(es) delivered`);
  return { applied, t: target };
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: bun run scripts/demo/advance.ts <seconds|mm:ss|end>');
    process.exit(1);
  }
  const db = createLocalDb();
  const state = await loadState(db);
  const { story } = loadStory(state.storyPath);
  console.log(`[advance] ${DEMO.databaseUrl}`);
  await advanceTo(db, parseT(arg, story));
}
