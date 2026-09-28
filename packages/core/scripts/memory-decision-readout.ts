/**
 * Memory Jev decision readout: Jev vs the current rule vs the use ledger's
 * outcome, per decision. Every number comes from `computeMemoryDecisionReadout`
 * (../memory-decision-readout.ts); this file only queries.
 *
 * Usage:
 *   DATABASE_URL=... bun run packages/core/scripts/memory-decision-readout.ts
 *   DATABASE_URL=... bun run packages/core/scripts/memory-decision-readout.ts -- --days 14 --json
 *
 * Flags:
 *   --days <n>   window in days (default 30)
 *   --team <id>  one team only
 *   --json       machine-readable readout on stdout
 */
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { memoryDecisions, memoryUses } from '../db/schema';
import { computeMemoryDecisionReadout, formatMemoryDecisionReadout, type ReadoutOutcome } from '../memory-decision-readout';

const ROW_LIMIT = 20_000;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const days = Number(flag('days') ?? 30);
  const team = flag('team');
  const since = new Date(Date.now() - (Number.isFinite(days) && days > 0 ? days : 30) * 86_400_000);

  const rows = await db
    .select({
      decision: memoryDecisions.decision,
      taskId: memoryDecisions.taskId,
      memoryId: memoryDecisions.memoryId,
      verdict: memoryDecisions.verdict,
      confidence: memoryDecisions.confidence,
      rule: memoryDecisions.rule,
      applied: memoryDecisions.applied,
      error: memoryDecisions.error,
    })
    .from(memoryDecisions)
    .where(and(gte(memoryDecisions.createdAt, since), team ? eq(memoryDecisions.teamId, team) : undefined))
    .limit(ROW_LIMIT);

  const memoryIds = [...new Set(rows.map(r => r.memoryId).filter((v): v is string => !!v))];
  const outcomes: ReadoutOutcome[] = [];
  for (let i = 0; i < memoryIds.length; i += 500) {
    const chunk = memoryIds.slice(i, i + 500);
    const got = await db
      .select({ taskId: memoryUses.taskId, memoryId: memoryUses.memoryId, outcome: memoryUses.outcome })
      .from(memoryUses)
      .where(and(inArray(memoryUses.memoryId, chunk), isNotNull(memoryUses.outcome), gte(memoryUses.createdAt, since)));
    for (const g of got) if (g.outcome) outcomes.push({ taskId: g.taskId, memoryId: g.memoryId, outcome: g.outcome });
  }

  const summaries = computeMemoryDecisionReadout(rows, outcomes);
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(summaries) + '\n');
  else console.log(formatMemoryDecisionReadout(summaries));
  process.exit(0);
}

main().catch(err => {
  console.error('[memory-decision readout] Error:', err);
  process.exit(1);
});
