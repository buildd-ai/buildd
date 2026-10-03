<!-- keep-if: importFrom -->
@{{importFrom}}
<!-- /keep-if -->
<!-- keep-if: !importFrom -->
# {{projectName}} - Agent Instructions

Instructions for AI agents (and humans) working in this repo. Every command
below was either detected from the repo or is marked `TODO(owner)` — a marked
line means nobody has confirmed the real command yet, so ask before guessing.

## Commands

- **Install:** {{installCommandMd}}
- **Test:** {{testCommandMd}}
- **Typecheck / lint:** {{typecheckCommandMd}}
- **Build:** {{buildCommandMd}}

Run the test command (and the typecheck command, if one exists) before opening
a PR. A PR that was never tested is not finished work.

## Git Workflow

- **Default branch:** `{{defaultBranch}}`
- **PRs target:** `{{prTarget}}`
- Never commit directly to `{{defaultBranch}}`. Work on a branch and open a PR.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- One concern per PR. Keep diffs focused.

## Testing

**Tests first, code second.** A bug fix starts with a failing regression test.
A feature needs tests for the happy path and the key edge cases. Docs-only and
config-only changes are exempt.

<!-- keep-if: testDir -->
- Tests live in `{{testDir}}`.
<!-- /keep-if -->
<!-- keep-if: !testDir -->
- TODO(owner): say where tests live and how a new test file gets picked up.
<!-- /keep-if -->
<!-- keep-if: migrationsDir -->

## Database Migrations

Schema migrations live in `{{migrationsDir}}`. A schema change ships with its
migration in the same PR. Never edit a migration that has already been merged;
add a new one.
<!-- /keep-if -->
<!-- keep-if: specsRoot -->

## Specs

Capability specs live in `{{specsRoot}}/` and follow `{{specsRoot}}/SPEC-FORMAT.md`.
A spec is a contract: when a change alters observable behaviour, update the
spec in the same PR.
<!-- /keep-if -->
<!-- keep-if: designRoot -->

## Design Docs

Proposals for changes that are not built yet live in `{{designRoot}}/` and
follow `{{designRoot}}/DESIGN-FORMAT.md`.
<!-- /keep-if -->
<!-- keep-if: isPublic -->

## This Repo Is Public

Nothing from a private system goes into code, comments, commit messages, PR
bodies, test fixtures or docs: no customer names, no internal hostnames, no
real IDs, no usage numbers. State evidence qualitatively.
<!-- /keep-if -->

## Issues & Friction

When you hit a blocker or broken tooling while working a task, report it
instead of silently working around it. File a task titled
`[friction] <short description>` saying what broke, what you expected, and what
you did instead. Low priority is fine; it is background signal.
<!-- keep-if: consumerSkill -->

## Working Through buildd

If you are a buildd worker, read `.claude/skills/buildd-mcp-consumer/SKILL.md`
for the task lifecycle (claim, progress, PR, complete), when to block versus
flag an assumption, and which branch a task's PR should target.
<!-- /keep-if -->
<!-- /keep-if -->
