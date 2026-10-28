/**
 * UUID shape check for route params compared against a Postgres `uuid`
 * column. The definition lives in `@buildd/shared`; this path stays so the
 * many existing `@/lib/uuid` imports keep working.
 */
export { isUuid } from '@buildd/shared';
