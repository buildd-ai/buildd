# @buildd/ai-kit

Shared chat contract, tool permissions, model plans and Jev decisions for apps
that use [buildd](https://buildd.dev)'s model economy.

buildd decides **which model** a call uses and **whether it may spend**. Your
app makes the call with its own provider key and reports a content-free usage
record. buildd never sees prompts, tool results or replies.

```sh
bun add @buildd/ai-kit@0.0.1 --exact
```

Pin exact versions: a Jev model bump or a contract change is a new kit release,
and you should re-run your evals before taking it.

## Entry points

| Import | What | Status |
|---|---|---|
| `@buildd/ai-kit/chat/contract` | Wire types: parts, object refs, data parts, approval previews, tool-permission rows. No deps, isomorphic | Ready |
| `@buildd/ai-kit/chat/server` | `defineToolGroups` + server-side Allow enforcement. Turn runner later (peer `ai@^7`) | Permissions ready |
| `@buildd/ai-kit/chat/react` | UI components (peers `react@^19`, `@ai-sdk/react@^4`) | Types only |
| `@buildd/ai-kit/chat/theme.css` | `--kit-*` CSS custom properties. No Tailwind | Ready |
| `@buildd/ai-kit/models` | Model-plan client + usage sink | Types only |
| `@buildd/ai-kit/decide` | Jev decisions (peer `@typesafe-ai/sdk`) | Types only |
| `@buildd/ai-kit/surfaces` | Jev picks among the app's own chips and cards | Types only |

## Tool permissions

Declare your tool groups once. The same declaration drives the tools menu,
the per-person preference and server-side enforcement.

```ts
import { defineToolGroups } from '@buildd/ai-kit/chat/server';

export const groups = defineToolGroups({
  notes:  { label: 'Notes',  tools: [{ name: 'create_note', class: 'write' }], modes: ['ask', 'allow'] },
  search: { label: 'Search', tools: [{ name: 'search', class: 'read' }],       fixed: 'read' },
  keys:   { label: 'Keys',                                                     fixed: 'never' },
});

groups.rows(groups.parseAllowed(storedPreference)); // menu rows; badge = allowedBadgeCount(rows)

// In your tool-approval hook:
if (groups.canSkipCard({ tool, input, allowedGroups, tainted, docked, skippedThisTurn })) {
  // still build the same preview a card would, and skip only if it resolves
}
```

- `ask`: every write gets an approval card (the default for every toggleable group).
- `allow`: a write may skip its card, only if it is the first skip of the turn,
  no tool output is in the model's context, nothing is docked, it starts no
  unattended work and doesn't spend, and its input carries only skippable fields.
- `read`: no write tools (declaring one throws at startup).
- `never`: not a tool at all; shown as a locked row.

## Theming

Import `@buildd/ai-kit/chat/theme.css` and override the `--kit-*` variables
with your own tokens.

## License

Apache-2.0
