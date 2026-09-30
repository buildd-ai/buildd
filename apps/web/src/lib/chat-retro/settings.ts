/**
 * Chat retro team settings (experiment; see ./REMOVAL.md).
 *
 * Stored in `teams.chat_retro` next to the team's other settings columns.
 * Opt-in: NULL, a missing key or anything malformed reads as OFF, for every
 * team. Two switches:
 *
 * - `lessons`: the daily pass records content-free lesson rows for this
 *   team's chat sessions (shadow: nothing is filed).
 * - `proposals`: the daily pass may also file suggested improvements as tasks
 *   in the team's workspaces. Requires `lessons`.
 *
 * Turning `lessons` off also turns `proposals` off and deletes the team's
 * existing lessons (`deleteLessons`).
 *
 * `CHAT_RETRO_ENABLED=0` is the global kill switch: nothing runs for any team,
 * whatever it opted into. Unset (or any other value) = opted-in teams run.
 *
 * No imports: the settings UI (a client component) reads this module.
 */

export interface ChatRetroSettings {
  lessons: boolean;
  proposals: boolean;
}

export const CHAT_RETRO_DEFAULT: Readonly<ChatRetroSettings> = Object.freeze({ lessons: false, proposals: false });

/** The stored value, read fail-closed: only a literal `true` turns anything on. */
export function readChatRetroSettings(raw: unknown): ChatRetroSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...CHAT_RETRO_DEFAULT };
  const r = raw as Record<string, unknown>;
  const lessons = r.lessons === true;
  return { lessons, proposals: lessons && r.proposals === true };
}

/** Global kill switch. Only `CHAT_RETRO_ENABLED=0` turns the experiment off everywhere. */
export function chatRetroGloballyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CHAT_RETRO_ENABLED ?? '').trim() !== '0';
}

export type ChatRetroPatchResult =
  | { ok: true; next: ChatRetroSettings; deleteLessons: boolean }
  | { ok: false; error: string };

/**
 * Apply a PATCH body `{ lessons?, proposals? }` to the current settings.
 * Unknown keys are rejected so a typo cannot read as "saved".
 */
export function applyChatRetroPatch(current: ChatRetroSettings, body: unknown): ChatRetroPatchResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be an object: { lessons?: boolean, proposals?: boolean }' };
  }
  const b = body as Record<string, unknown>;
  const unknownKeys = Object.keys(b).filter(k => k !== 'lessons' && k !== 'proposals');
  if (unknownKeys.length > 0) return { ok: false, error: `Unknown field(s): ${unknownKeys.join(', ')}` };
  if (b.lessons === undefined && b.proposals === undefined) {
    return { ok: false, error: 'Nothing to change: send lessons and/or proposals' };
  }
  for (const k of ['lessons', 'proposals'] as const) {
    if (b[k] !== undefined && typeof b[k] !== 'boolean') return { ok: false, error: `${k} must be a boolean` };
  }
  const lessons = (b.lessons as boolean | undefined) ?? current.lessons;
  let proposals = (b.proposals as boolean | undefined) ?? current.proposals;
  if (!lessons) {
    if (b.proposals === true) return { ok: false, error: 'proposals require lessons: turn lessons on too' };
    proposals = false;
  }
  return { ok: true, next: { lessons, proposals }, deleteLessons: !lessons };
}
