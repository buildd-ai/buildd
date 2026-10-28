---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "github-comment-ingest"
    type: "route"
    method: "POST"
    path: "/api/github/webhook"
    file: "apps/web/src/app/api/github/webhook/route.ts"
    skip_until: "2027-01-26"
    skip_reason: "Passes structurally because route.ts's POST handler serves every GitHub webhook event, not because @buildd mention routing shipped — there is no issue_comment case, no mention detection, no comment-authorization check, and no gitConfig.commentMentions flag anywhere in the tree. See Current state. Owner note (max, restaged 2026-10-28 from 2026-12-15): mention routing is not built; the passing assertion is structural only; re-review by 2027-01-26."
  - id: "issue-comment-dispatch"
    type: "symbol_reachable"
    symbol: "issue_comment"
    entry: "apps/web/src/app/api/github/webhook/route.ts"
    as: "read"
---

# github-comment-mentions

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/github-comment-mentions.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
