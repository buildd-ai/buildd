/**
 * The `workflow_dispatch` inputs a GitHub Actions workflow file declares, read
 * from the file itself at a ref. Used where buildd is about to dispatch a
 * team's workflow with inputs the team declared in config (the release
 * candidate amend contract): the declaration says what buildd should send, the
 * file says whether the workflow takes it.
 *
 * The parser reads only `on.workflow_dispatch.inputs` keys, by indentation. It
 * is not a YAML parser: the web app has none, and the one shape needed here
 * (block mappings, plus the `on: workflow_dispatch` / `on: [a, b]` scalars) is
 * small enough to read directly. Anything it cannot follow reads as "no
 * workflow_dispatch", which refuses rather than dispatches.
 */
import { githubApi as defaultGithubApi } from '@/lib/github';

interface Line { indent: number; text: string }

function lines(yaml: string): Line[] {
  const out: Line[] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    // Drop a comment: `#` at the start or after whitespace. Input names never contain one.
    const text = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    if (!text.trim() || text.trim() === '---') continue;
    out.push({ indent: text.length - text.trimStart().length, text: text.trim() });
  }
  return out;
}

/** `key: rest` → [key, rest], with the key unquoted; null when the line is not a mapping entry. */
function entry(text: string): [string, string] | null {
  const m = /^("([^"]+)"|'([^']+)'|([^:\s][^:]*?))\s*:(\s+(.*))?$/.exec(text);
  if (!m) return null;
  return [(m[2] ?? m[3] ?? m[4]).trim(), (m[6] ?? '').trim()];
}

/** The child entries of the block that starts after `lines[at]` (deeper indent), as [index, key, rest]. */
function children(ls: Line[], at: number): Array<[number, string, string]> {
  const parent = ls[at].indent;
  const out: Array<[number, string, string]> = [];
  let childIndent = -1;
  for (let i = at + 1; i < ls.length && ls[i].indent > parent; i++) {
    if (childIndent === -1) childIndent = ls[i].indent;
    if (ls[i].indent !== childIndent) continue;
    const e = entry(ls[i].text);
    if (e) out.push([i, e[0], e[1]]);
  }
  return out;
}

const EMPTY = new Set(['', '{}', 'null', '~']);

/**
 * The input names under `on.workflow_dispatch.inputs`, `[]` when the workflow
 * has a workflow_dispatch trigger with no inputs, or null when it has none.
 */
export function parseWorkflowDispatchInputs(yaml: string): string[] | null {
  const ls = lines(yaml);
  const onAt = ls.findIndex((l) => l.indent === 0 && entry(l.text)?.[0] === 'on');
  if (onAt === -1) return null;
  const onValue = entry(ls[onAt].text)![1];
  if (onValue) {
    const events = onValue.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    return events.includes('workflow_dispatch') ? [] : null;
  }
  const dispatch = children(ls, onAt).find(([, k]) => k === 'workflow_dispatch');
  if (!dispatch) return null;
  const [dispatchAt, , dispatchValue] = dispatch;
  if (!EMPTY.has(dispatchValue)) return null;
  if (dispatchValue) return [];
  const inputs = children(ls, dispatchAt).find(([, k]) => k === 'inputs');
  if (!inputs) return [];
  const [inputsAt, , inputsValue] = inputs;
  if (!EMPTY.has(inputsValue)) return null;
  return children(ls, inputsAt).map(([, k]) => k);
}

/** The repo path of a configured workflow file: a bare name lives in .github/workflows/. */
export function workflowFilePath(workflowFile: string): string {
  const f = workflowFile.trim().replace(/^\/+/, '');
  return f.startsWith('.github/') ? f : `.github/workflows/${f}`;
}

export type WorkflowInputsRead =
  | { ok: true; inputs: string[] | null; path: string }
  | { ok: false; error: string; path: string };

/**
 * Read the workflow file at `ref` and return its dispatch inputs. `ok: false`
 * is a read failure (missing file, no access, GitHub error); a file that exists
 * but has no workflow_dispatch is `ok: true, inputs: null`.
 */
export async function readWorkflowDispatchInputs(
  params: { installationId: number; repoFullName: string; workflowFile: string; ref: string },
  githubApi: typeof defaultGithubApi = defaultGithubApi,
): Promise<WorkflowInputsRead> {
  const path = workflowFilePath(params.workflowFile);
  if (/^\d+$/.test(params.workflowFile.trim())) {
    return { ok: false, path, error: `workflowFile ${params.workflowFile} is a workflow id; name the file (e.g. release.yml) so buildd can read its inputs` };
  }
  try {
    const file = await githubApi(
      params.installationId,
      `/repos/${params.repoFullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(params.ref)}`,
    );
    if (typeof file?.content !== 'string') return { ok: false, path, error: `${path} was not found at ${params.ref}` };
    const yaml = Buffer.from(file.content, 'base64').toString('utf8');
    return { ok: true, path, inputs: parseWorkflowDispatchInputs(yaml) };
  } catch (err) {
    return { ok: false, path, error: `could not read ${path} at ${params.ref}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
