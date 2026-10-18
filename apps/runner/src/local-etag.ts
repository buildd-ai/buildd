/**
 * The runner's own list endpoints `buildd top` polls (/api/tasks,
 * /api/missions/recent, /api/queue) answer 304 when nothing changed (spec
 * 3ef37387 R-20). The tag is a hash of the answer: the runner already holds it
 * (its server reads are conditional too, buildd.ts), so top re-renders only
 * when something did change.
 */
export function localTag(body: unknown): string {
  return `W/"l-${Bun.hash(JSON.stringify(body)).toString(36)}"`;
}

/** JSON with its tag, or a bodiless 304 when the caller already holds that tag. */
export function jsonUnlessUnchanged(req: Request, body: unknown, headers: Record<string, string>): Response {
  const tag = localTag(body);
  const held = req.headers.get('if-none-match');
  if (held && held.split(',').some(t => t.trim() === tag)) return new Response(null, { status: 304, headers: { ...headers, ETag: tag } });
  return Response.json(body, { headers: { ...headers, ETag: tag } });
}
