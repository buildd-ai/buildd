/**
 * The per-turn context block (docs/design/agent-chat.md → Context on every turn).
 *
 * Models read "today" from their training data unless told, so every turn gets
 * the real local date and time, in the user's zone, with the zone named. Pure:
 * the clock and zone are parameters, so it is testable with a fixed instant.
 */

export interface ChatContextInput {
  now: Date;
  /** IANA zone: users.timezone, then teams.timezone, then UTC. */
  timeZone: string;
  conversationId: string;
  workspace: { id: string; name: string } | null;
  user: { name: string | null; teamRole: 'owner' | 'admin' | 'member'; isOperator: boolean };
  tier: string;
  /** True once the team has used 80% of its daily chat budget. */
  budgetWarning?: boolean;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * `2026-09-27T09:30:00+12:00` for `now` in `timeZone`. Built from
 * `formatToParts`, so the output doesn't depend on the machine's locale or ICU.
 */
export function zonedIsoWithOffset(now: Date, timeZone: string): { iso: string; weekday: string; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value]),
  ) as Record<string, string>;
  const y = Number(parts.year), mo = Number(parts.month), d = Number(parts.day);
  const h = Number(parts.hour), mi = Number(parts.minute), s = Number(parts.second);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetMin = Math.round((asUtc - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${y}-${pad(mo)}-${pad(d)}`;
  const iso = `${date}T${pad(h)}:${pad(mi)}:${pad(s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return { iso, weekday, date };
}

export function renderChatContextBlock(input: ChatContextInput): string {
  const { iso, weekday } = zonedIsoWithOffset(input.now, input.timeZone);
  const who = [
    input.user.name ? `Name: ${input.user.name}` : null,
    `Team role: ${input.user.teamRole}`,
    `Home view: ${input.user.isOperator ? 'operator' : 'member'}`,
  ].filter(Boolean).join('. ');
  const lines = [
    '<context>',
    `Current local time: ${iso} (${weekday}), time zone ${input.timeZone}. Use this for "today", "tomorrow" and any schedule; never assume UTC.`,
    `Conversation id: ${input.conversationId}.`,
    input.workspace
      ? `Default workspace: ${input.workspace.name} (id ${input.workspace.id}). Tool calls use it unless the user names another.`
      : 'No default workspace: ask which workspace, or pass workspaceId, before filing work.',
    `${who}.`,
    `Model tier for this turn: ${input.tier}.`,
    input.budgetWarning
      ? 'The team has used over 80% of its daily chat budget. Mention this once, briefly.'
      : null,
    '</context>',
  ];
  return lines.filter(Boolean).join('\n');
}
