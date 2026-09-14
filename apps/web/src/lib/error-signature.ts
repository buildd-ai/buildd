/**
 * Re-export shim. The canonical normalizer now lives in
 * `packages/core/error-signature.ts` so that `packages/core/gate-events.ts` —
 * which cannot import from `apps/web` — records `gate_events.reason` through
 * the SAME normalizer `get_failure_analytics` clusters worker errors with. Two
 * copies of that function would silently split one family in two.
 *
 * It is still dependency-free and still safe in a client bundle: the core
 * module imports nothing, so pulling it in cannot drag `@buildd/core/db` (and
 * with it `dotenv.config()`, which throws on `process.stdout.isTTY` in the
 * browser) into `HealthClient.tsx` via `health-metric-grammar.ts`.
 */
export { normalizeErrorSignature, EMPTY_SIGNATURE } from '@buildd/core/error-signature';
