# MCP guidance topics

Workflow guidance the buildd MCP server serves to any client, tools-only ones included, through `help {topic}` (a group tool's `help` action, or `buildd` action `help`). Each `<topic>.md` file here is one topic, and its file name is the topic. Write it SKILL.md-style: frontmatter `name` and `description` (the description is what `help {}` lists), then the body. This README is not a topic. Adding a file adds a topic with no code change; `packages/core/guidance-topics.ts` reads the directory at request time, and `apps/web/next.config.mjs` ships it with both MCP routes.
