/**
 * Guessing which files a task is about, from its own text.
 *
 * **This is for RETRIEVAL ONLY. Never write the result to
 * `tasks.path_manifest`.**
 *
 * That column is load-bearing for three safety mechanisms — path claims,
 * inferred `dependsOn` edges, and the claim route's path-overlap gate — and all
 * three treat it as a *declaration* by the task's author. Feeding them paths
 * regexed out of prose would defer or serialise unrelated work on a guess, and
 * the failure would look like ordinary contention rather than a bad inference.
 * A wrong guess here costs one slightly-off memory in a prompt; a wrong guess
 * there costs correctness. Different blast radius, so a different code path and
 * a different lifetime: these paths are computed at retrieval time and thrown
 * away.
 *
 * `extractExcerptPaths` in ./friction-manifest.ts is deliberately not reused.
 * It is tuned for a single error line and it *does* feed `path_manifest`, so
 * broadening its regex to suit prose would silently widen what the serialisation
 * gates act on. Two callers with different risk tolerances need two functions.
 *
 * Why bother at all: only about a tenth of tasks declare a path manifest, so
 * the file-scoped memory retrieval that depends on one sits idle for the rest.
 * Task descriptions in practice name files constantly — this recovers that.
 */

/**
 * A path-shaped token: at least one `/`, ending in a `.ext`, or rooted at a
 * recognisable top-level directory.
 *
 * Requiring either an extension or a known root is what keeps ordinary prose
 * out. Bare two-segment fragments ("and/or", "read/write", "9/10") are far more
 * common in English than in file references, and admitting them would make the
 * inference worse than nothing.
 *
 * **Known limitation.** The root list is shaped like this monorepo, so an
 * extensionless path under some other top-level directory (`templates/x/y`,
 * `infra/z`) is missed. That is the deliberate trade: this runs for every
 * workspace, and a list broad enough to catch every layout would also start
 * matching prose. Extensionful paths are caught anywhere by the second
 * alternative, which covers the common case. Widen the list per real misses
 * rather than pre-emptively.
 */
const PATH_RE = new RegExp(
  [
    // Rooted at a known top-level dir, with or without an extension:
    //   apps/web/src/lib/foo.ts, packages/core, docs/design/x.md
    String.raw`(?:apps|packages|docs|scripts|tests|src|\.github)\/[\w.@/-]*[\w-]`,
    // Any absolute-ish path that ends in an extension: /home/coder/x.json
    String.raw`\/[\w.@/-]+\.\w+`,
  ].join('|'),
  'g',
);

/**
 * Directory segments that mark generated output rather than source.
 *
 * These are stripped from the text BEFORE matching, not filtered afterwards.
 * Filtering after does not work: the absolute-path alternative below happily
 * matches `/foo/bar.js` starting at the slash *after* `node_modules`, so the
 * extracted string no longer contains the segment that should have rejected it.
 * (Observed: `node_modules/foo/bar.js` yielded `/foo/bar.js`.)
 *
 * `build` is deliberately absent: unlike `dist` it is a plausible *source*
 * directory name, so rejecting it would lose genuine paths. (Note that a path
 * like `templates/claude-code/build/Dockerfile` is still missed today, but for
 * an unrelated reason — see the root-list limitation on PATH_RE.)
 */
const GENERATED_SEGMENTS = ['node_modules', '.next', '.git', 'dist', 'coverage'];

/**
 * Markers used to make an absolute path repo-relative. Ordered longest-first so
 * `/packages/` wins before a bare `/src/` inside it.
 */
const REPO_ROOT_MARKERS = ['/packages/', '/apps/', '/docs/', '/scripts/', '/tests/'] as const;

/** Trailing punctuation a path collects when it appears in a sentence. */
function trimSentencePunctuation(p: string): string {
  return p.replace(/[.,;:!?)\]}'"`]+$/, '');
}

function normalize(p: string): string {
  let out = trimSentencePunctuation(p);
  for (const marker of REPO_ROOT_MARKERS) {
    const idx = out.indexOf(marker);
    if (idx !== -1) {
      out = out.slice(idx + 1);
      break;
    }
  }
  return out.replace(/\/+$/, '');
}

/**
 * Strip spans that contain path-shaped text but are not paths.
 *
 * URLs are the big one: `https://github.com/buildd-ai/buildd/pull/2186` yields
 * `buildd-ai/buildd/pull/2186` under any reasonable path regex, and a task
 * description that links a PR would then retrieve memories about a directory
 * that does not exist. Fenced code blocks are left alone deliberately — a
 * description quoting a diff or a stack trace is exactly where the real paths
 * are.
 */
function stripUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
}

/** Blank out any whitespace-delimited token that sits under generated output. */
function stripGenerated(text: string): string {
  const alternation = GENERATED_SEGMENTS.map(s => s.replace(/\./g, '\\.')).join('|');
  return text.replace(new RegExp(String.raw`\S*(?:${alternation})\/\S*`, 'gi'), ' ');
}

/** Upper bound, matching what the memory store will accept as a file scope. */
export const MAX_INFERRED_PATHS = 12;

/**
 * Repo-relative paths a task's own text mentions, best-effort.
 *
 * Order is first-seen, so the earliest mention — usually the subject of the
 * task — leads. Returns [] rather than throwing on any input.
 */
export function inferPathsFromText(...parts: Array<string | null | undefined>): string[] {
  const text = parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
  if (!text) return [];

  const matches = stripGenerated(stripUrls(text)).match(PATH_RE);
  if (!matches) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const path = normalize(raw);
    if (!path || !path.includes('/')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_INFERRED_PATHS) break;
  }
  return out;
}
