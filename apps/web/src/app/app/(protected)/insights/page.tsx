import { redirect } from 'next/navigation';

/** Insights moved under Health; old links keep working, query string included. */
export default async function InsightsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  const qs = params.toString();
  redirect(`/app/health/insights${qs ? `?${qs}` : ''}`);
}
