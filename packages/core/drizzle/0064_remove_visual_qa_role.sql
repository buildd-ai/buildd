-- Remove any stray 'visual-qa' rows from workspace_skills.
-- Visual QA runs as a CI workflow only (visual-qa.yml). It was never intended to be
-- registered as a routable agent role — see PR #1029. Any rows that exist were
-- created manually and contradict the CI-only design decision.
DELETE FROM "workspace_skills" WHERE slug = 'visual-qa';
