---
name: living-specs
description: "Read before you draft, revise, read or build against a Living Spec (native buildd specs, manage_specs), or when asked to spec something: when to make one, the draft to approval to verdict loop, duplicates, comments, and what an agent must never do."
---

# Living Specs over MCP

A Living Spec is governed intent stored in buildd: a body with immutable
revisions, requirement ids (`R-n`, `AC-n`, `D-n`, `I-n`) parsed from it, and
one revision a person approved. Work pins an approved revision and is judged
against its criteria. Every call below is `buildd action=manage_specs` with
the sub-action in `params.action`.

This is not the `spec-sync` skill. `spec-sync` keeps a repo's own spec files
(`docs/SPEC.md`, `docs/specs/`) in step with the code. A Living Spec lives in
buildd, not in a repo file.

## When to make one

- **Living Spec:** intent a person must approve before work is built against
  it, with criteria someone can grade (a feature, a contract, a product area).
- **Task:** a unit of work. If it needs a spec, file it against one (below).
- **Artifact:** a deliverable or report (`create_artifact`). It has no
  approval and no criteria.
- **Repo spec file:** the repo already keeps its contracts in Git and the
  owner wants them there. A Living Spec can cite one at a commit with
  `repoRefs`; it does not replace it.

Asked to "spec this"? Look for an existing spec first: `list` (below), and
`recall query="<topic>" scope=["spec"]`, which finds approved revisions only
(drafts are not indexed).

## The loop

1. **Find:** `buildd action=manage_specs params={ action: "list" }`, then
   `buildd action=manage_specs params={ action: "get", specId }`. `get` shows
   the version, the head and approved revisions, requirement ids, any design
   and cited repo files. A body over 20,000 characters is not inlined: read it
   with `get_artifact` views (`outline`, then `section` or `grep`).
2. **Draft:** `buildd action=manage_specs params={ action: "create_draft", title, body, scope, parentSpecId, changeSummary, repoRefs, design }`.
   Only `title` and `body` are required. `scope` is `product`, `domain`,
   `feature` (default) or `mission`. Write each criterion as a line starting
   `R-n` or `AC-n`. A criterion may carry a line `check: <command>` (buildd
   runs it at each PR head and records the exit code) or
   `screen: <id>, <id>` (screens of the design it covers).
3. **Revise:** `buildd action=manage_specs params={ action: "revise", specId, expectedVersion, body, changeSummary }`.
   `expectedVersion` is the version `get` showed. To replace one section,
   add `section` (an outline id) or `heading` (a heading used once) and send
   only that section's text, heading line included. Omitted `repoRefs` or
   `design` carry forward; `[]` or `null` clears.
4. **Submit and approve: a person's act.** `buildd action=manage_specs params={ action: "submit", specId, expectedVersion }`
   and `buildd action=manage_specs params={ action: "approve", specId, revision, expectedVersion }`
   return 403 to an agent run or API key. From a person's own OAuth session,
   `approve` approves nothing: it returns a link the person opens on
   buildd.dev to confirm. Hand that link to the person. Tell them what
   changed (`diff`, below) and stop.
5. **Pin:** file work with `create_task` and
   `context: { specSource: { specId, criteria } }`. The server pins the
   approved revision itself; a spec with no approved revision refuses the
   filing. `criteria` (optional, 1 to 50 `R-n`/`AC-n` ids) narrows what the
   task answers for; left out, it answers for all of them. The first claim
   re-pins to the revision approved then; after that the pin never moves.
6. **Build:** read the pinned revision, not the head:
   `buildd action=manage_specs params={ action: "get", specId, revision }`.
   Later revisions are proposals until a person approves them.
7. **Outcome:** `buildd action=manage_specs params={ action: "outcome", taskId }`
   lists each criterion's verdict on the current PR head. `verified` only
   when every criterion passes there; `fail` when one fails; otherwise
   `unverified`. It is advisory: it never blocks completing or merging.
8. **Verdict (reviewers only):** `buildd action=manage_specs params={ action: "verdict", taskId, criterionId, verdict, headSha, evidenceRefs, observed }`.
   `verdict` is `pass`, `fail`, `inconclusive` or `unsupported`. A task cannot
   grade itself: its own token gets a 403. The reviewer of its PR, or a
   person, records verdicts. A visual audit adds `checker: "visual"` with
   `capturedSha` and `screenshotIds` in place of `headSha`.
9. **Conflict:** two criteria of an approved revision that disagree:
   `buildd action=manage_specs params={ action: "conflict", specId, revision, criterionIds, note }`.
   It records an advisory discrepancy and blocks nothing.

## Version conflicts

A stale `expectedVersion` writes nothing and the error names
`currentVersion`. Re-read with `get`, merge your change into that text, and
revise again with the new version. Never retry the same body blindly. A 409
that names no `currentVersion` (the body moved outside a revise) has no retry:
say so and stop.

## Duplicates (409 `spec_duplicate`)

`create_draft` compares the draft with approved specs in the workspace.

- A clear duplicate is refused with 409 `spec_duplicate` naming the spec(s).
  Nothing is written. Read the named spec. Then either revise it instead,
  or create again with one of:
  - `supersedes`: the id of the spec this one replaces, or
  - `distinctBecause`: at least 10 characters saying why it is different.
  Both are recorded. Do not invent a reason to get past the check.
- An overlap only warns: the draft is created and the reply lists the
  overlapping specs. Check the shared criteria; consider a common parent.
- A check that could not run says so; the draft is still created.

## Structure and neighbours

- One tree: product, then area (`domain`), then feature, by parent. An area
  is a spec with scope `domain`: a title and a one-paragraph charter. It is a
  parent from its first revision, approved or not.
- A draft with no parent comes back with a suggested parent, and after the
  reply buildd files it itself when it is sure: the spec page then says
  "Filed by buildd", with undo. Otherwise it only suggests a place. Set the
  parent yourself with
  `buildd action=manage_specs params={ action: "relate", specId, parentSpecId }`;
  `parentSpecId: null` clears it. A parent in another workspace, or one that
  forms a cycle, is refused. Relating does not change the version, and a spec
  you place by hand is never moved by buildd again.
- Organize a whole workspace:
  `buildd action=manage_specs params={ action: "organize", workspaceId, dryRun }`.
  `dryRun` defaults to true and writes nothing. With no product or area it
  proposes a taxonomy (areas with charters and the specs each would hold);
  `dryRun: false` creates it, `areas: [keys]` and
  `edits: { [key]: { title, charter } }` accept part of it or rename. With
  areas it sweeps the unfiled specs into one batch grouped by area; with
  `dryRun: false` the confident ones are filed (each with undo) and the rest
  stay suggestions. Run the dry run first and show it to a person before a
  taxonomy is created.
- Neighbours (similar specs, specs whose work touched the same files,
  criteria judged to overlap) show on the spec page under Related. They are
  information: they approve, pin, grade and block nothing.

## Repo files and designs

- `repoRefs: [{ path, commitSha }]` cites a repo file at a full 40-character
  commit SHA. A branch name, a short SHA or a missing file is a 400.
  Read a cited file at its commit:
  `buildd action=manage_specs params={ action: "read_ref", specId, path, view }`
  (`view` as `get_artifact`: `outline`, `section`, `range`, `grep`, `meta`,
  `full`).
- `design: { kind, ref, version, screens }` names what the revision is built
  to. `kind` is `artifact` (default: an artifact in the workspace, such as an
  HTML prototype or images, pinned to its current revision), `url` or
  `figma`; `url` and `figma` need `version`. Figma is one kind among several,
  not the default.

## Reading changes

`buildd action=manage_specs params={ action: "diff", specId, from, to }`
lists sections added, removed and changed, then a capped line diff with a
count of what it left out. `to` defaults to the head; `from` to the approved
revision. Use it before asking a person to approve, and when a pinned task
sees a newer approved revision.

## Comments

- Add: `buildd action=manage_specs params={ action: "comment", specId, criterion, body, revision, replyTo }`.
  Anchor on one `criterion` (an `R-n`/`AC-n` id), or on a `section` (outline
  id) or `heading` instead. A comment never changes the spec.
- Read: `buildd action=manage_specs params={ action: "comments", specId, revision }`.
  Each reads `open` (anchor unchanged), `outdated` (anchor changed) or
  `resolved`. Only a person resolves one, on the spec page.

## Never

- Never approve, or say a spec is approved, unless `get` shows that revision
  approved. Drafted, submitted and in review are not approved.
- Never click, open or forward a confirm link as if you were the person.
- Never record a verdict on your own task, or a pass you did not observe on
  that exact head.
- Never write a spec body through `update_artifact`; it is refused. Use
  `revise`.
- Never build against the head revision when the task is pinned to another.
- Never override a duplicate refusal without reading the spec it names.
