/**
 * A waiver note's body: the person's reason, then the policy it was recorded
 * under on its own last line. The reason, who and when were already structured
 * (body, actor label, created-at); the policy is the fourth field the
 * completion record shows, kept in the same row so no migration is needed.
 * Notes written before this carry no policy line and read as policy unknown.
 */
const POLICY_LINE = /\n\nPolicy: ([a-z]+)$/;

export function formatWaiverBody(reason: string, policy: string): string {
  return `${reason.trim()}\n\nPolicy: ${policy}`;
}

export function parseWaiverBody(body: string | null | undefined): { reason: string; policy: string | null } {
  const text = (body ?? '').trim();
  const m = POLICY_LINE.exec(text);
  return m ? { reason: text.slice(0, m.index).trim(), policy: m[1] } : { reason: text, policy: null };
}
