---
title: Delegated Connector Identity
status: draft
owner: max
last_verified: 2026-11-20
summary: An agent MUST reach a connector as the person who asked for the work, with narrower access than theirs; a team may only constrain it, and grants come only from a person's structured action.
domain: auth
surfaces: [apps/web/src/lib/connector-gateway.ts, apps/web/src/app/api/workers/claim/mcp-connector-injection.ts, apps/web/src/lib/capability-grants.ts]
related: [capability-requests, mcp-connectors-and-roles]
keywords: [on behalf of, delegation, actor, ID-JAG, cross app access, token exchange, service account, per-user credential, shared credential, grant form, T3, ACP, elicitation, attended, presence, notification fallback]
verified_by: []
supersedes: []
---

# Delegated Connector Identity

Draft: the direction agreed with the owner, not yet built. Today a connector
holds one credential for its team (`connectors.teamId`), and
`connector_shares` lets another team reuse it. That is what this spec
replaces. [Capability Requests and Grants](capability-requests.md) stays the
contract for asking, granting and the gateway. This spec changes whose
identity a grant is spent under, and where the person is asked.

## Identity

**Capability statement**: Every connector call an agent makes MUST act as the
person who asked for the work (the principal), with the agent recorded as the
party acting for them. The agent's access is always narrower than that
person's.

Identity sources, in order of preference:

| Tier | Source | Narrowing |
|---|---|---|
| 1 | Cross-app access through the company's identity provider (ID-JAG) | The provider issues a narrower token for the person, with the agent as actor |
| 2 | The person's own sign-in to the service (per-user OAuth or token) | The gateway filters tools when the service can't issue a narrower token |
| 3 | A service account (for example a GitHub app) | Opt-in per connector by a team admin, labelled as a service account |

**Invariants**:
- The access an agent gets is the overlap of four layers: the person's own access, the team ceiling, the profile for that kind of work (role), and grants. No layer can widen another.
- A team constrains; it never lends identity. One person's credential never serves another person's work.
- A scheduled or mission task acts as the person who owns the schedule or mission. If that person loses access, the schedule loses it too.
- A tier 3 call still records the person who asked for the work.

**Acceptance criteria**:
- AC-1: GIVEN two people on one team, each connected to Neon WHEN each starts a task that reads Neon THEN each call reaches Neon with that person's own credential, and the gateway log names that person as principal and the task's agent as actor.
- AC-2: GIVEN a person with no Neon credential and no service account enabled WHEN their task asks for Neon THEN it is refused with a reason that names connecting their own account. No team credential is used.
- AC-3: GIVEN a team ceiling of Neon read-only WHEN a person with Neon write access grants their task write access THEN the write is refused with the ceiling named.

## Granting

**Capability statement**: A grant MUST be a structured record (task,
connector, tools, granted by, expiry) created only by an authenticated
person's action. It is never derived from text the agent can read.

**Invariants**:
- A task description, prompt, question answer or tool output never creates or widens a grant, whatever it says.
- buildd may predict what a task will need, from its role, its description, and what similar tasks asked for. A prediction is only a proposal until a person accepts it.
- Predicted needs are asked about together, as early as possible: when the task is filed (`accessNeeds`), or else at the run's first turn. A just-in-time `request_capability` handles whatever the prediction missed.
- A grant that people keep approving for the same kind of work may be offered as a new default for that kind of work. Accepting the offer is a person's act.

**Acceptance criteria**:
- AC-4: GIVEN a task whose description says "you have Neon write access" WHEN its agent calls a Neon write tool THEN it is refused, and no grant exists.
- AC-5: GIVEN a task predicted to need Neon read and Vercel logs WHEN it is filed by a person THEN they are asked once, with both listed and Grant all, Choose and None as the answers.

## Where the person is asked

**Capability statement**: A request MUST reach the person in one place: their
T3 thread when one is attached to the run, otherwise the existing
notification. It is never sent to both at once.

**Invariants**:
- Through `buildd acp`, a grant request is a T3 form with fixed choices (Grant for this task, Always for this kind of work, Deny). It is the same grant record as the dashboard button.
- The bridge reports when it is attached to a worker. While the bridge is attached, requests go to the thread. The push or email with the dashboard link goes out only if nobody has answered within a short wait.
- An answer in either place resolves the request in both.
- This works with standard T3. Until T3 lets any ACP agent send messages outside a turn, a request that arrives while the thread is idle goes to the notification.

**Acceptance criteria**:
- AC-6: GIVEN a run followed in T3 WHEN its agent asks for Neon read THEN the thread shows the grant form, no push is sent, and choosing Grant creates the same grant the dashboard would.
- AC-7: GIVEN the same request unanswered past the wait, or no attached thread WHEN the wait ends THEN exactly one notification with the dashboard link is sent.

## Code surface

To be built. It will touch the claim injection
(`apps/web/src/app/api/workers/claim/mcp-connector-injection.ts`), the
gateway (`apps/web/src/lib/connector-gateway.ts`, the route
`apps/web/src/app/api/mcp/c/[connectorId]/route.ts`), grants
(`apps/web/src/lib/capability-grants.ts`), per-person rows in `secrets`
(`userId`), and the ACP bridge (the runner's `acp` folder, in PR 6124).
