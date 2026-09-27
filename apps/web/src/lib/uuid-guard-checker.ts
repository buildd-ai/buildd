/**
 * Structural check: does a Next.js route handler destructure a dynamic path
 * param and guard it with `isUuid(...)` before the first query that compares
 * it to a uuid column?
 *
 * Extracted from the checker #2749 wrote for /api/workers/[id] (see
 * apps/web/src/app/api/workers/[id]/uuid-guard.test.ts) so the same structural
 * test can be pinned onto other `[paramName]`-style route trees without
 * duplicating the regex logic per tree.
 */

const METHODS = 'GET|POST|PATCH|PUT|DELETE';
// Any export of a method name, in whatever form: `export async function GET(`,
// `export function GET(`, `export const GET = ...`.
const ANY_EXPORT = new RegExp(`export\\s+(?:async\\s+function|function|const|let)\\s+(${METHODS})\\b`, 'g');
const HANDLER = new RegExp(`export async function (${METHODS})\\s*\\(`, 'g');

/** Drop line and block comments so a commented-out guard cannot satisfy the check. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every violation in one route file's source for the dynamic segment named
 * `paramName` (defaults to `id`); empty means compliant.
 */
export function uuidGuardViolations(rawSrc: string, paramName: string = 'id'): string[] {
  const src = stripComments(rawSrc);
  const out: string[] = [];

  const exported = [...src.matchAll(ANY_EXPORT)].map(m => m[1]);
  const starts = [...src.matchAll(HANDLER)].map(m => ({ method: m[1], index: m.index! }));
  // A handler in any other shape would be invisible to the body checks below.
  for (const method of exported) {
    if (!starts.some(s => s.method === method)) {
      out.push(`${method}: export is not \`export async function ${method}(\`, so the guard cannot be checked`);
    }
  }

  // A nested route (e.g. .../[id]/notes/[noteId]/reply) destructures both
  // segments in one statement — `const { id, noteId } = await params` — so the
  // target name must be matched as a bare, unrenamed entry anywhere in the
  // braces, not only as the sole entry.
  const destructure = new RegExp(`const \\{\\s*(?:\\w+\\s*,\\s*)*${paramName}\\s*(?:,\\s*\\w+\\s*)*\\} = await params\\b`);
  const guardRe = new RegExp(`if \\(!isUuid\\(${paramName}\\)\\)`);
  const queryRe = new RegExp(`db\\.(query|select|update|insert|delete|execute)\\b|eq\\(\\w+\\.\\w+, ${paramName}\\)`);

  for (let i = 0; i < starts.length; i++) {
    const { method, index } = starts[i];
    const body = src.slice(index, i + 1 < starts.length ? starts[i + 1].index : undefined);
    // A handler that doesn't touch `params` at all has nothing to guard.
    if (!/\bparams\b/.test(body)) continue;
    // Every handler in an [paramName] tree receives the id. Anything that
    // reads params must bind it as `paramName` so the guard check below is
    // meaningful; a renamed or inline read (`{ id: workerId }`,
    // `(await params).id`) would otherwise skip the check and pass silently.
    if (!destructure.test(body)) {
      out.push(`${method}: reads params without \`const { ${paramName} } = await params\``);
      continue;
    }
    const guard = body.search(guardRe);
    if (guard === -1) {
      out.push(`${method}: no \`if (!isUuid(${paramName}))\` guard`);
      continue;
    }
    const firstQuery = body.search(queryRe);
    if (firstQuery > -1 && guard > firstQuery) out.push(`${method}: guard comes after the first query`);
  }
  return out;
}
