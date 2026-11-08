/** Thin wrapper over the gateway. Every call may time out; the gateway does not de-duplicate requests. */
export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://gateway.internal${path}`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return (await res.json()) as T;
}
