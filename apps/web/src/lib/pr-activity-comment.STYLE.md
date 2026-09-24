# PR activity comment — copy style guide

The sticky `<!-- buildd-activity -->` comment that `pr-activity-comment.ts`
renders on every PR buildd works. It gets read on phones, often by someone
deciding whether to step in, so every rule below comes down to two things:
**say only what is true right now, and keep it short.**

## Shape

```
**buildd** · <glyph> **<Headline>** · <status tail> · [task](…)

- `0m` Reviewing
- `+9m` Changes requested · fix 1 of 3 queued · [task](…)
  <details><summary>Reviewer feedback</summary> … </details>
- `+14m` Fixing · fix 1 of 3

<sub>Started Sep 23, 07:31 EDT · edited in place by buildd</sub>
```

- **One status line**, then a **timeline**, then a **footer**. No heading, no
  "Activity" wrapper.
- The header is the newest *state*. Asides (`lede_corrected`) show up in the
  timeline and never replace the header.

## The status must be true

| Phase | Kind | Header | Motion |
|---|---|---|---|
| reviewing | `reviewing` | Reviewing / Re-reviewing · after fix N of M | spinner |
| changes requested, fix not claimed | `review_changes_requested` | ○ Fix N of M queued · waiting for a worker | none |
| CI red, fix not claimed | `ci_fixing` | ○ CI fix N of M queued · waiting for a worker | none |
| worker claimed the fix | `fix_started` | Fixing · fix N of M | spinner |
| fix pushed | `changes_pushed` | ○ Pushed `abc1234` · waiting on checks | none |
| approved, auto-merge pending | `review_approved` | ✓ Approved · merging once checks pass | none |
| approved, human merges | `review_approved_awaiting_human` | ✓ Approved · ready to merge | none |
| needs a human | `review_escalated`, `review_failed`, `human_review_required`, `ci_exhausted` | ⚑ … · needs a human | none |
| done | `merged`, `human_override_merge`, `review_superseded_by_merge` | ✓ Merged … | none |
| abandoned | `closed_unmerged` | ✕ Closed without merging | none |

Rules:

- **Nothing says "fixing" or "pushing" until a worker has claimed the task.**
  `fix_started` is written only by the claim route
  (`pr-activity-fix-claimed.ts`), after the atomic claim. A queued fix reads as
  *queued*.
- **The spinner means an agent is working right now.** Queued, waiting on
  checks and approved are not motion.
- **Always give the iteration** ("fix 1 of 3") when there is one, and link the
  task that is doing the work.

## Status vocabulary

Use these words and no synonyms. They match the dashboard (`CondensedTimeline`,
`PrStatusLine`): lowercase after the first word, `·` as the only separator.

reviewing · re-reviewing · changes requested · queued · fixing · pushed ·
waiting for a worker · waiting on checks · approved · ready to merge ·
needs a human · merged · closed without merging

Avoid: "buildd is on it", "working on", "applying", "attempt" (say "fix"),
exclamation marks, and anything that narrates intent instead of state.

## Length

- **Timeline row: 6–10 words** of visible text (links count as their label).
  Tests hold every row to 64 visible characters.
- **`detail`: a few words**, 60 characters at most. Anything longer is moved
  into a note automatically, so a long `detail` never breaks the layout. It is
  still wrong, though: pass `note`.
- **`note`** holds long text: reviewer feedback, an escalation reason, the
  original lede. It is always collapsed in `<details>` under its row and
  clipped at 1,200 characters. The task or the review has the full text.
- No email addresses, role slugs or confidence scores in the comment. The
  dashboard keeps the audit trail, and a public PR is not the place for it.

## Time

- **One absolute timestamp**, in the footer ("Started …"), in the team's zone.
- **Rows show offsets from the start** (`0m`, `+9m`, `+1h 4m`).
- **No relative "5m ago".** A GitHub comment is static between edits, so a
  relative time would go stale the moment it's posted. An offset is always
  correct.

## Glyphs

Four, each with one meaning. Rows only carry the outcome glyphs.

| Glyph | Meaning | Header | Row |
|---|---|---|---|
| spinner GIF | an agent is working right now | yes | never |
| `○` | nothing running: queued, or waiting on checks | yes | no |
| `✓` | good outcome: approved, merged | yes | yes |
| `⚑` | a human has to act | yes | yes |
| `✕` | ended without landing | yes | yes |

No emoji. They render inconsistently across GitHub clients and turn a
timeline into decoration.

## Adding a kind

1. Add it to `PrActivityKind` and `KNOWN_KINDS`.
2. Add its row to the table above, and pick its words from the vocabulary.
3. Add a `present()` case: label, tone, and `headline`, `status` or `noteLabel`
   only if they're needed.
4. Add a test in `pr-activity-comment.test.ts` for its header and its motion.
