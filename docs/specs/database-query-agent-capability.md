---
title: Database Query Agent Capability
status: active
owner: max
last_verified: 2026-10-28
summary: An agent MUST read production only through buildd's broker, under a live task-scoped database.query grant, as one SELECT over an allowlist run by a read-only role, with every query recorded on the task.
domain: auth
surfaces: [apps/web/src/lib/capability-database-query.ts, apps/web/src/lib/capability-database-query-store.ts, apps/web/src/app/api/agent-capabilities/database-query/route.ts, scripts/query-role-grants.ts]
related: [capability-requests, model-inference-agent-capability, agent-capabilities]
keywords: [database.query, query_database, neon, neonctl, production reads, read-only role, buildd_query_ro, BUILDD_QUERY_DATABASE_URL, delivery forensics, access trail]
verified_by: [apps/web/src/lib/capability-database-query.test.ts, apps/web/src/lib/capability-database-query-store.test.ts, apps/web/src/app/api/agent-capabilities/database-query/route.test.ts, apps/web/src/lib/capability-grants.test.ts, apps/web/src/lib/agent-capabilities/access-log.test.ts, apps/web/tests/db/database-query-role.test.ts, packages/core/__tests__/mcp-tools-capabilities.test.ts, scripts/query-role-grants.test.ts]
supersedes: []
assertions:
  - id: "database-query-route"
    type: "route"
    method: "POST"
    path: "/api/agent-capabilities/database-query"
    file: "apps/web/src/app/api/agent-capabilities/database-query/route.ts"
  - id: "sql-check"
    type: "symbol"
    name: "checkReadOnlySql"
    path: "apps/web/src/lib/capability-database-query.ts"
  - id: "route-uses-broker"
    type: "symbol_reachable"
    symbol: "runDatabaseQuery"
    entry: "apps/web/src/app/api/agent-capabilities/database-query/route.ts"
  - id: "read-only-executor"
    type: "symbol"
    name: "readOnlyQueryExecutor"
    path: "apps/web/src/lib/capability-database-query-store.ts"
  - id: "role-db-tests"
    type: "test_file"
    path: "apps/web/tests/db/database-query-role.test.ts"
---

# Database Query Agent Capability

## Brokered production reads

**Capability statement**: A live agent run that needs to read production
(delivery forensics: workflow, gate, mission, task, worker, verdict and
decision rows) asks with `request_capability { provider: "neon", access: "read" }`
and, once granted, reads with the `query_database` MCP action
(`POST /api/agent-capabilities/database-query`). buildd runs the statement
server-side; the agent never receives a connection string.

Why a buildd-owned action rather than mounting the Neon connector: a read
grant cannot narrow a mounted connector. Neon's MCP exposes SQL-running tools
whose risk is decided by the SQL text, not the tool name, so the gateway's
tool-class filter cannot tell a SELECT from a DROP. Argument-level policy (one
statement, these tables, a row cap) is exactly what justifies a buildd-owned
action.

**Status today: built, refusing until a role is configured.** With
`BUILDD_QUERY_DATABASE_URL` unset every query refuses with
`query_role_unconfigured`. A platform admin runs `scripts/query-role-grants.ts`
against the owner connection once, then sets the variable.

**Invariants**:

- `{ provider: "neon", access: "read" }` with no tool, or
  `{ capability: "database.query" }`, parses to capability `database.query`
  at risk `read` with no connector (`parseCapabilityRequest`). A Neon write,
  or an exact Neon tool, still asks for the connector and a person.
- `database.query` is decided by team policy alone (`isBrokeredRequest`): the
  team's Access policy row for Neon → Read is the setting. With no rule it is
  `ask_human`, whether or not a role mounts the Neon connector. `auto_grant`
  is a rule an admin sets; `forbidden` refuses.
- Every query re-reads this worker's grant and re-checks it with
  `checkGrantUse` (team, workspace, task, worker, role, expiry, revocation,
  policy) through `findDatabaseQueryGrant`. A policy grant stops when the rule
  stops auto-granting; a revoke stops the next query.
- The grant is checked first. With none the call returns 403 `no_grant` and a
  `requestWith` naming the `request_capability` call to make; nothing is sent.
- `checkReadOnlySql` refuses before any connection: more than one statement;
  anything not starting `SELECT` or `WITH`; write, DDL, privilege, session or
  transaction keywords (including `INTO` and `FOR UPDATE`); `pg_` names,
  `pg_catalog` and `information_schema`; functions that run SQL from a string
  or change a setting; and any schema table not in `DATABASE_QUERY_TABLES`, by
  name wherever it appears.
- What is sent is the statement wrapped by `wrapWithRowCap` (a subquery under
  `LIMIT maxRows + 1`; a data-modifying `WITH` is illegal below top level),
  inside a non-interactive READ ONLY transaction with `SET LOCAL`
  statement and lock timeouts (`DATABASE_QUERY_LIMITS`).
- The connection is the role in `BUILDD_QUERY_DATABASE_URL` only, never
  `DATABASE_URL`. `queryRoleGrantStatements` gives it SELECT on exactly the
  allowlist, revokes everything else (and `neon_superuser`), and sets
  `default_transaction_read_only`. Each layer holds alone.
- Every call that reaches the broker writes one `database.query` row to
  `agent_capability_decisions`: the SQL (cut at `auditSqlChars`), the row
  count, the duration, whether the cap truncated it, and for a refusal its
  reason and SQLSTATE. Result rows are never written. The task page's Access
  section and `explain`'s `access` list show each query with its SQL
  (`summarizeAccess` never folds queries).

**Acceptance criteria**:

- AC-1: GIVEN no live grant WHEN `query_database` is called THEN it returns 403 `no_grant` with `requestWith` `{ tool: "request_capability", params: { provider: "neon", access: "read" } }`, and the executor is not called.
- AC-2: GIVEN a live grant WHEN the SQL is an INSERT, UPDATE, DELETE, DDL or a data-modifying CTE THEN it is refused with 400 and the executor is not called.
- AC-3: GIVEN a live grant WHEN the SQL names a table outside the allowlist THEN it is refused with 400 `table_not_allowed`.
- AC-4: GIVEN the role from `scripts/query-role-grants.ts` WHEN a statement the check would refuse is sent straight to the executor THEN Postgres refuses it: `42501` for a table outside the allowlist, an error for any write or DDL.
- AC-5: WHEN any query is made (allowed or refused) THEN exactly one `database.query` row is written with its SQL, and an allowed one carries row count and duration and no result value.
- AC-6: GIVEN no team rule WHEN `request_capability { provider: "neon", access: "read" }` is asked THEN it resolves `pending_approval`; GIVEN a Neon read rule of `auto_grant` THEN `auto_granted`.
- AC-7: GIVEN `BUILDD_QUERY_DATABASE_URL` unset WHEN a granted, valid SELECT is made THEN it returns 503 `query_role_unconfigured`.

**Code surface**: `apps/web/src/lib/capability-database-query.ts` (rules,
SQL check, `runDatabaseQuery`), `apps/web/src/lib/capability-database-query-store.ts`
(`readOnlyQueryExecutor`, `defaultDatabaseQueryDeps`),
`apps/web/src/app/api/agent-capabilities/database-query/route.ts`,
`apps/web/src/lib/capability-grants.ts` (`parseCapabilityRequest`,
`isBrokeredRequest`), `apps/web/src/lib/capability-grants-store.ts`
(`findDatabaseQueryGrant`), `apps/web/src/lib/agent-capabilities/access-log.ts`,
`packages/core/mcp-tools.ts` (`query_database`), `scripts/query-role-grants.ts`.

**Out of scope**: an interactive session on a person's own machine running
`neonctl` or `psql` with that person's own credential; that is their access,
not an agent's grant. Per-table or per-column grants inside the allowlist;
writes of any kind (a Neon write still asks for the connector and a person).
