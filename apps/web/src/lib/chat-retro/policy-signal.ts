/**
 * The chat retro as a model-policy signal (experiment; see ./REMOVAL.md).
 *
 * Implements `ChatQualitySource` from `@buildd/core/tier-dial-chat`: whether
 * retros are on for a team, which model judges them, and each judged window's
 * verdict with who served its turns. The dependency runs one way: the policy
 * defines the interface and works without it (a chat dial cell then reads "no
 * quality signal"); this file plugs the retro in. Deleting it means removing
 * the `chatRetroQualitySource` argument from the two callers listed in
 * REMOVAL.md, nothing else.
 *
 * Reads lesson labels (`chat_retros`) and the model / tier columns of the
 * window's assistant turns. No message content is read or sent anywhere.
 */
import { sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { resolveDecisionAccess } from '@buildd/core/decision-client';
import type { ChatQualitySource, ChatSessionVerdict } from '@buildd/core/tier-dial-chat';
import { GATES } from './lesson';
import { chatRetroGloballyEnabled } from './settings';
import { readTeamRetroState } from './store';
import { SATISFIED_LABELS, type SatisfiedLabel } from './vocab';

/** Turn labels the model gives that say the turn went wrong for the person. */
const BAD_TURN_LABELS = new Set(['re_asked', 'wrong_tier']);
/** Candidate kinds code detects that say the same without the model. */
const BAD_TURN_KINDS = new Set(['stopped', 'routing_error']);

type EvidenceEntry = { kind?: unknown; label?: unknown; conf?: unknown };

/**
 * A window is clean when no turn was stopped, hit a routing error, or was
 * labelled re_asked / wrong_tier with the confidence a lesson's own turn gate
 * asks for (the evidence keeps the raw, ungated answer).
 */
export function windowClean(evidence: unknown): boolean {
  if (!Array.isArray(evidence)) return true;
  for (const e of evidence as EvidenceEntry[]) {
    if (typeof e?.kind === 'string' && BAD_TURN_KINDS.has(e.kind)) return false;
    if (typeof e?.label === 'string' && BAD_TURN_LABELS.has(e.label) && typeof e.conf === 'number' && e.conf >= GATES.turn) return false;
  }
  return true;
}

/** The judging model a lesson recorded (`cr1|<model>`), or null. */
export function judgeOf(version: string | null | undefined): string | null {
  if (!version) return null;
  const i = version.indexOf('|');
  return i > 0 && i < version.length - 1 ? version.slice(i + 1) : null;
}

export interface VerdictRow {
  conversation_id: string;
  from_at: string | Date;
  at: string | Date;
  satisfied: string | null;
  version: string | null;
  evidence: unknown;
  served: unknown;
}

export function verdictFromRow(r: VerdictRow): ChatSessionVerdict {
  const served = Array.isArray(r.served) ? r.served as Array<{ model?: unknown; tier?: unknown }> : [];
  return {
    conversationId: r.conversation_id,
    fromAt: new Date(r.from_at),
    at: new Date(r.at),
    satisfied: (SATISFIED_LABELS as readonly string[]).includes(r.satisfied ?? '') ? r.satisfied as SatisfiedLabel : null,
    clean: windowClean(r.evidence),
    judgeModel: judgeOf(r.version),
    served: served.map(t => ({
      model: typeof t?.model === 'string' ? t.model : null,
      tier: typeof t?.tier === 'string' ? t.tier : null,
    })),
  };
}

export const chatRetroQualitySource: ChatQualitySource = {
  async status(teamId) {
    if (!chatRetroGloballyEnabled()) return { enabled: false, judgeModel: null };
    const { settings } = await readTeamRetroState(teamId);
    if (!settings.lessons) return { enabled: false, judgeModel: null };
    // The model the retro's decision call would use now (no spend: policy
    // check and key resolution only). Not reachable ⇒ unknown judge.
    const access = await resolveDecisionAccess({ capability: 'chat', teamId });
    return { enabled: true, judgeModel: access.ok ? access.model : null };
  },

  async verdicts(teamId, since) {
    const result = await db.execute(sql`
      SELECT r.conversation_id, COALESCE(fm.created_at, r.to_message_at) AS from_at, r.to_message_at AS at,
        r.satisfied, r.version, r.evidence,
        (SELECT COALESCE(json_agg(json_build_object('model', m.model, 'tier', m.tier)), '[]'::json)
           FROM conversation_messages m
          WHERE m.conversation_id = r.conversation_id AND m.role = 'assistant'
            AND m.created_at >= COALESCE(fm.created_at, r.to_message_at)
            AND m.created_at <= r.to_message_at) AS served
      FROM chat_retros r
      LEFT JOIN conversation_messages fm ON fm.id = r.from_message_id
      WHERE r.team_id = ${teamId}
        AND r.status = 'judged'
        AND r.to_message_at >= ${since.toISOString()}::timestamptz
    `);
    return (result.rows as unknown as VerdictRow[]).map(verdictFromRow);
  },
};
