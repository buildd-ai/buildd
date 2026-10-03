import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { artifacts, missionNotes, tasks, teams, workspaces } from '@buildd/core/db/schema';
import { loadClaimReadoutInput, loadManifestReadoutInput } from '@buildd/core/orchestration-readout-source';
import { buildOrchestrationReadout, type GroupReadout, type OrchestrationReadout } from '@buildd/core/orchestration-readout';
import { arrayOverlaps, desc, eq } from 'drizzle-orm';
import { withCronRun } from '@/lib/cron-run';
import { channels, events, triggerEvent } from '@/lib/pusher';

export const maxDuration = 60;
const KEY = 'conflict-aware-orchestration-readout';
const DAY = 86_400_000;

/** No replay rows, confusion example ids, task content or promotion drafts. */
function aggregateGroup(g: GroupReadout) {
  const splits = Object.fromEntries(Object.entries(g.splits).map(([split, s]) => [split, {
    n: s.n, answered: s.answered, baselineAccuracy: s.baselineAccuracy, atThreshold: s.atThreshold,
    summary: {
      n: s.summary.n, errors: s.summary.errors, accuracy: s.summary.accuracy,
      coverage: s.summary.coverage, applyAt: s.summary.applyAt,
      perLabel: s.summary.perLabel,
      costUsd: s.summary.costUsd, costPer1k: s.summary.costPer1k, latencyMs: s.summary.latencyMs,
    },
  }]));
  return {
    capability: g.capability, key: g.key, counts: g.counts,
    verdict: { verdict: g.verdict.verdict, threshold: g.verdict.threshold, reasons: g.verdict.reasons },
    censoredShare: g.censoredShare, missingShare: g.missingShare,
    split: g.split, splits, latencyMs: g.latencyMs, sets: g.sets,
    // Claim summaries contain aggregates and group identity only.
    claim: g.claim,
  };
}

function aggregateReadout(readout: OrchestrationReadout) {
  return {
    capabilities: readout.capabilities.map(c => ({
      capability: c.capability, verdict: c.verdict, reasons: c.reasons,
      groups: c.groups.map(aggregateGroup),
    })),
  };
}

/** Stable UUID gives INSERT ... ON CONFLICT a race-safe, workspace/group dedupe. */
function noteId(workspaceId: string, g: GroupReadout): string {
  const hex = createHash('sha256').update(JSON.stringify([KEY, workspaceId, g.capability, g.key])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function GET(req: NextRequest) {
  return withCronRun('orchestration-readout', req, async report => {
    // One join, no loaders or artifact/note lookups unless a team opted in.
    const optedIn = await db.select({ workspaceId: workspaces.id }).from(workspaces)
      .innerJoin(teams, eq(workspaces.teamId, teams.id))
      .where(arrayOverlaps(teams.enabledDecisionShadows, ['orchestration_manifest', 'orchestration_claim']));
    const until = new Date();
    const since = new Date(until.getTime() - 30 * DAY);
    const laterFrom = new Date(until.getTime() - 7 * DAY);
    let changed = 0;
    let errors = 0;
    let notes = 0;
    for (const { workspaceId } of optedIn) {
      try {
        const window = { workspaceId, since, until };
        const [claim, manifest] = await Promise.all([loadClaimReadoutInput(window), loadManifestReadoutInput(window)]);
        const readout = await buildOrchestrationReadout({ claim, manifest, window: { since, until }, plan: { laterFrom, salt: workspaceId } });
        const content = JSON.stringify(aggregateReadout(readout));
        await db.insert(artifacts).values({
          workspaceId, key: KEY, type: 'analysis', title: 'Conflict-aware orchestration readout', content,
          visibility: 'private', shareToken: null,
        }).onConflictDoUpdate({
          target: [artifacts.workspaceId, artifacts.key],
          set: { content, visibility: 'private', shareToken: null, updatedAt: until },
        });
        changed++;
        const eligible = readout.capabilities.flatMap(c => c.groups).filter(g => g.verdict.verdict === 'eligible_for_gated');
        if (eligible.length === 0) continue;
        // A workspace note is attached to its latest task; mission-linked tasks
        // put the same note in that mission's feed. No content is read.
        const task = await db.query.tasks.findFirst({
          where: eq(tasks.workspaceId, workspaceId), columns: { id: true, missionId: true }, orderBy: desc(tasks.createdAt),
        });
        if (!task) throw new Error('Eligible readout has no workspace task for its advisory note');
        for (const g of eligible) {
          const title = `Orchestration group eligible for gated review: ${g.key.decisionId}`;
          const [note] = await db.insert(missionNotes).values({
            id: noteId(workspaceId, g), taskId: task.id, missionId: task.missionId,
            authorType: 'system', type: 'suggestion', status: 'answered', title,
            actorLabel: 'orchestration-readout',
            body: `${JSON.stringify(g.key)} is eligible_for_gated. Review the private ${KEY} artifact. Promotion requires a committed ORCHESTRATION_PROMOTIONS entry; this job applies nothing.`,
          }).onConflictDoNothing({ target: missionNotes.id }).returning({ id: missionNotes.id });
          if (!note) continue;
          notes++;
          await triggerEvent(task.missionId ? channels.mission(task.missionId) : channels.workspace(workspaceId), events.MISSION_NOTE_POSTED, {
            noteId: note.id, type: 'suggestion', authorType: 'system', title,
          });
        }
      } catch {
        // Keep the public response/run metadata aggregate-only too.
        errors++;
      }
    }
    const result = { processed: optedIn.length, changed, errors, notes };
    report({ ...result, result });
    return NextResponse.json(result);
  });
}
