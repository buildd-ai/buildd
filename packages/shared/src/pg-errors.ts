/**
 * Postgres unique-violation detection — the one definition for the monorepo.
 *
 * True when `err`, or an error in its `cause` chain (up to 4 deep: drivers and
 * ORMs wrap), carries SQLSTATE 23505, or its message reads like one
 * ("duplicate key value violates unique constraint", "unique constraint
 * failed"). The message arm covers drivers that drop the code. Anything else,
 * including null/undefined and non-errors, is false.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    if (/duplicate key|unique constraint/i.test(String((e as { message?: unknown }).message ?? ''))) return true;
  }
  return false;
}
