# Import a Claude Design canvas as a buildd design

`export-canvas.ts` turns a claude.ai Design canvas into one buildd design: a
single HTML file holding every board as a screen, with `metadata.screens`
filled in. A design stored in buildd can be read by every runner; the canvas
itself can be read only by a session signed in to claude.ai.

```
bun scripts/design/export-canvas.ts <projectDir> <out.html> \
  --title "Navigation, one place per task" \
  --source https://claude.ai/artifact/<id> \
  [--upload --mission <id> [--spec <id>] [--artifact <id>]]
```

## 1. Get the canvas files

A canvas is a folder of files: `project/canvas.json` (board order, titles,
sizes) and one `project/<Board>.dc.html` per board. Copy them into an empty
temp dir, keeping the `project/` layout.

**With the Artifact tool.** The tool exists in an owner's own Claude Code
session, and in a worker whose role or task sets `claudeAiArtifacts: 'read'`
(the runner then sets `CLAUDE_CODE_ARTIFACT=1` and allows only read and list).
The runner must run on a claude.ai login, not an API key.

1. `Artifact list url=<canvas url> scope=files` lists the files.
2. `Artifact read path=project/canvas.json` and `read path=project/<Board>.dc.html`
   for each board it lists. Write each one, byte for byte, to
   `<tmp>/project/<name>`.

Never fetch claude.ai with curl, WebFetch or a browser: the edge answers with
a Cloudflare challenge, and getting around it is off-limits.

**Fallback: copy-in.** A worker that has no Artifact tool (an API-key or
gateway team, a `--once` runner, a canvas the seat account cannot see) cannot
read the canvas. A person copies the files in for it: download them from the
canvas (or run this script in their own session), then either run the export
there or put the files where the worker can read them.

## 2. Export

The script reads `canvas.json` for board order, titles and sizes (a board with
no size there uses the `$preview` size in its own file). For each board it keeps
the `<x-dc>` body and the `<helmet>` head, drops the canvas runtime, and:

- makes the board `<section id=<screen> data-screen=<screen> data-viewport=WxH>`;
- rewrites `href="<Board>.dc.html"` to `href="#<screen>"` (a link to a board
  the canvas does not list is left alone and reported);
- merges every board's `<helmet>`: each font link and each CSS rule once;
- adds an index of screens and a small hash router: `out.html#<screen>` shows
  that one screen at its own size, no hash lists them all.

Screen ids come from the file name in kebab case, prefixed `phone-` (under
768px wide) or `desktop-`: `TaskDetail.dc.html` at 1440 is
`desktop-task-detail`. Names are `Phone · <title>` / `Desktop · <title>`.
Override either in `project/screens.json`:

```json
{ "Coverage": "coverage", "Detail.dc.html": { "id": "phone-task-merged", "name": "Phone · Task merged" } }
```

Boards are live components: text like `{{count}}` is filled in by the canvas
at runtime. A static design needs a value for each, in
`project/placeholders.json`, per board or for all (`"*"`):

```json
{ "*": { "missionTitle": "Registered requirement verification" }, "Detail": { "count": "3" } }
```

A placeholder with no value stops the export and names the board and the
placeholder. Values are HTML-escaped.

Next to `out.html` the script writes `out.metadata.json`:
`{ kind: "design", screens: [{ id, name, viewport }], source }`, checked
with buildd's own design check before anything is uploaded.

To check a re-export keeps the screen ids a spec already names, pass
`--expect-screens a,b,c` or `--expect-screens @old.metadata.json`.

## 3. Store it

`--upload` stores the file in one step, with `BUILDD_API_KEY` (a `bld_` key
that can write to the mission or spec) and `BUILDD_SERVER` (default
`https://buildd.dev`):

- `--mission <id>`: a new design on the mission, attached to it.
- `--spec <id>`: also attached to the spec; alone, the spec is the scope.
- `--artifact <id>`: a new revision of that design instead of a new one.
  Links that follow the current body move to it; a spec pinned to an earlier
  revision keeps it.

It calls the same endpoints as `upload_artifact`, PUTs the bytes, and
finalizes with their sha256. Without a key (a worker on MCP only), run the
export without `--upload` and store the result over MCP: `upload_artifact`
with the filename, size and the metadata from `out.metadata.json`, the `curl`
PUT it returns, then `upload_artifact { artifactId }`.

## 4. Pin it in a spec

Point the spec's design at the buildd artifact revision, not the canvas URL:
`design: { kind: "artifact", ref: <artifactId>, version: <revision>, screens }`.
Every runner can read that; the canvas URL stays in the artifact's
`metadata.source`, so anyone can find the original.
