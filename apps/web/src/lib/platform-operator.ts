/**
 * Who counts as a buildd platform operator in the web app: the people who run
 * buildd itself, as opposed to the teams that use it.
 *
 * Operators see Health → Operator, buildd's own tooling (dispatch internals,
 * gates, experiments). It is cross-team platform
 * plumbing, so it is not a team permission: a team owner is not an operator.
 *
 * The signed-in counterpart of lib/platform-admin.ts (which gates API keys by
 * account id): a person is an operator when their email is listed in
 * `BUILDD_OPERATOR_USER_EMAILS` (comma-separated, case-insensitive). When the
 * variable is unset or empty nobody is one: the gate fails closed.
 */

export const PLATFORM_OPERATOR_ENV = 'BUILDD_OPERATOR_USER_EMAILS';

export function platformOperatorEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env[PLATFORM_OPERATOR_ENV] ?? '';
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export function isPlatformOperator(
  user: { email?: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const email = user?.email?.trim().toLowerCase();
  if (!email) return false;
  return platformOperatorEmails(env).has(email);
}
