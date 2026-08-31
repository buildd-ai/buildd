/**
 * The app's public base URL, resolved once.
 *
 * Eight call sites open-coded this as
 *
 *   process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
 *     ? `https://${process.env.VERCEL_URL}`
 *     : 'https://buildd.dev'
 *
 * which parses as `(A || B) ? https://B : default` — so both real deployments
 * were wrong. With NEXT_PUBLIC_APP_URL set and VERCEL_URL unset (production,
 * self-hosted, local) the condition is truthy and the result is the literal
 * "https://undefined"; with only VERCEL_URL set it happened to work. Every share
 * and download URL minted through those sites was unusable.
 *
 * Precedence: explicit config, then the Vercel deployment host, then production.
 */
export function appBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/+$/, '')}`;
  return 'https://buildd.dev';
}
