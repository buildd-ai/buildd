/**
 * The database read behind a connector's settings tool list
 * (connector-tool-review.ts): tools the gateway refused recently on this
 * connector only because buildd did not know they read.
 */
import { TOOL_NAME_RE } from './connector-gateway';

/** The tools refused recently on one connector for want of a read-only mark (for its settings list). */
export async function recentUnvettedTools(connectorId: string, now = Date.now()): Promise<string[]> {
  const [{ db }, { agentCapabilityDecisions: d }, { and, eq, gte, sql }, { TOOL_CALL_CAPABILITY }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('./connector-gateway-store'),
  ]);
  const rows = await db.selectDistinct({ tool: sql<string>`${d.sideEffect}->>'tool'` }).from(d).where(and(
    eq(d.capability, TOOL_CALL_CAPABILITY),
    eq(d.decision, 'refused'),
    gte(d.occurredAt, new Date(now - 30 * 86_400_000)),
    sql`${d.sideEffect}->>'connectorId' = ${connectorId}`,
    sql`(${d.sideEffect}->>'readOnlyFix')::boolean is true`,
  )).limit(100);
  return rows.map(r => r.tool).filter((t): t is string => typeof t === 'string' && TOOL_NAME_RE.test(t));
}
