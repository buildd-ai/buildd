/**
 * The one line the team page shows when a role change, removal or ownership
 * transfer lowered API keys (the `clampedKeys` count those routes return).
 * Empty when nothing changed, or the count is missing or malformed.
 */
export function clampedKeysNotice(clampedKeys: unknown, who: 'they' | 'you'): string {
  const n = typeof clampedKeys === 'number' && Number.isInteger(clampedKeys) && clampedKeys > 0 ? clampedKeys : 0;
  if (n === 0) return '';
  const keys = n === 1 ? 'API key' : 'API keys';
  const was = n === 1 ? 'was' : 'were';
  const role = who === 'you' ? 'your new role' : 'their new role';
  return `${n} ${keys} ${who} created ${was} lowered to what ${role} allows.`;
}
