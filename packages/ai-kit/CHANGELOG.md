# @builddai/ai-kit changelog

Independent semver, not buildd's release version. Consumers pin exact versions.
Breaking changes to `/chat/contract` or to the tool-group declaration are major
bumps; new optional data parts are minor.

Releasing: bump `version` in package.json and `KIT_VERSION` in
`src/decide/index.ts`, add a `## <version>` heading here, and merge to dev.
The merge publishes to npm and tags the commit `ai-kit-v<version>`
(`.github/workflows/publish-ai-kit.yml`); a version with no heading here fails
the publish.

## 0.9.1 — 2026-09-28

The desktop menu popover always fits the viewport. Patch: no API is removed
and the phone sheet is unchanged.

- `/chat/react` `Menu` (and so `ToolsMenu`, `ScopePicker`, `TierPicker`): the
  wide-screen popover opened on a fixed side (`up` by default) with a fixed
  `max-height: min(70vh, 520px)`, and nothing measured the viewport. A
  composer near the top of a page (an app's home screen) pushed the panel
  past the top edge, cutting off its title and first options. Now, when it
  opens and on resize or scroll, the panel measures itself: it keeps its
  side (`placement`, or what `auto` picks) if it fits there, flips when it
  only fits on the other side, and otherwise takes the roomier side. It stays
  `MENU_EDGE` (12px) from the viewport edges: its max-height is capped to the
  room on that side, so it scrolls instead of overflowing, and it shifts
  sideways rather than run off the left or right edge. The resolved side is
  still `data-placement` on the wrapper.
- `/chat/styles.css`: `.kit-menu-panel` reads `--kit-menu-room` (in its
  max-height) and `--kit-menu-shift` (as `translate`). `Menu` sets both on
  the panel; they are listed in the new `KIT_MENU_FIT_VARS` and never carried
  to the phone sheet.
- New exports: `fitMenuPanel(rect, panelHeight, viewportHeight, preferred)`,
  `menuShift(rect, viewportWidth)`, `MENU_EDGE`, `KIT_MENU_FIT_VARS`.
- The phone sheet (`KIT_SHEET_QUERY`, `[data-sheet]`) is untouched: no
  measuring, no new variables, same `data-placement`.
- `KIT_VERSION` is `0.9.1` (pinned decision versions read `…|kit-0.9.1`;
  fingerprints unchanged).

## 0.9.0 — 2026-09-28

The thread slots an app with its own feed needs, found moving buildd's
conversation onto `ChatThread`. Minor: every addition is optional; without
them the thread renders the same markup as on 0.8.0 (checked against the 0.8
component, and pinned in `thread-slots.dom.test.tsx`).

- `/chat/react` `ChatThread`:
  - `renderMessageHeader(message, ctx)` / `renderMessageFooter(message, ctx)`:
    a node above and after a message's parts (`.kit-msg-head` /
    `.kit-msg-foot`, only when not null). `ctx` is `{ index, streaming,
    messages }` (`ThreadMessageContext`, exported).
  - `renderToolGroup(parts, message, ctx)`: each run of consecutive tool
    calls as one node. Text, approvals, hand-offs, steers and turn errors end
    a run; parts that render nothing don't. `renderTool` still wins; a group
    drawn as null leaves no frame.
  - `steps(message, streaming)`: the app's own checklist (an empty list: no
    panel), also for the pending turn; `thinkingTitle` for its summary.
  - `eventPartType`: an app's own event part (e.g. `data-buildd-event`),
    passed to `renderEvent` as is.
  - `renderText(text, message, part)`: the text part (its `streaming` state).
- `ThinkingPanel` `title` takes a node.
- `ChatComposer` `inputId`: the message box's id, for a focus shortcut.
- `/chat/styles.css`: the approval card's fold toggle keeps its mono face
  inside a thread (`button.kit-fold-toggle`; it lost to `.kit-chat button`).
- `KIT_VERSION` is `0.9.0` (pinned decision versions read `…|kit-0.9.0`;
  fingerprints unchanged).

## 0.8.0 — 2026-09-28

The approval, empty-state, tier and menu slots buildd's own chat needed.
Minor: every addition is optional and off by default, so an app that passes
none of them renders exactly as on 0.7.0 (tests pin the default markup).

**Upgrading: what you can delete**

- **A copy of your tool part with a made-up `type`** to title an approval
  card: pass `headline`.
- **CSS `content` tricks for the card's verb or workspace**: pass `eyebrow`
  and `meta`.
- **Your own card for a draft** (a new record with its fields and criteria):
  the kit card takes `body`, `details`, `fold`, `confirmLabel` / `busyLabel`.
- **`display: contents` / `order` on `.kit-empty`** to place an overline, a
  sub line or a header over the chips: pass `overline`, `mood`, `sub`,
  `chipsHeader` / `chipsAside`. A chip id prefix used as a styling hook:
  `tone`.
- **An override of `.kit-sheet-scrim` for a dark theme**: set `--kit-scrim`.
- **A hover tooltip wrapped around a menu**: `Menu` / `ToolsMenu` /
  `TierPicker` take `hover`.
- **A cast on `effectiveClass`** returning your own classes, and **leaving
  deferred tools out of a read group**: see below.

**Changes**

- `/chat/react` `ApprovalCard`: `headline` (the title; default as before),
  `eyebrow` and `meta` (a head row, `.kit-card-head` with `.kit-card-tag` /
  `.kit-card-meta`, only when either is set), `body` (`.kit-approval-body`,
  always shown), `details` (replaces the change list and the raw fields),
  `fold` (`true` or `{ summary }`: "Show details · N changes" below 640px,
  `kit-approval-fold` / `kit-approval-details`, `.kit-fold[data-open]`),
  `confirmLabel` (default "Confirm"), `busyLabel` (default "Applying…"),
  `settled: 'card' | 'row'` (default `card`; `row` is one line,
  `.kit-approval-row`) and `deniedNote`. The `+` marker is
  `.kit-change-mark[data-mark="add"]` and the arrow `.kit-change-arrow`,
  same text as before.
- `ChatEmpty`: `overline` (`.kit-empty-overline`), `mood` (`data-mood`, and a
  `.kit-mood-dot` leading the overline), `sub` (`.kit-empty-sub`),
  `chipsHeader` / `chipsAside` (`.kit-chips-head`, read before the chips),
  `variant: 'chips' | 'rows'` and a chip's `tone` (`data-tone`).
- `TierPicker`: `options[].detail` and `autoDetail` (a second line under the
  name, `.kit-option-detail`), `triggerExtra` (`.kit-trigger-extra`), `hover`;
  `autoMeta={null}` drops Auto's meta. `MenuOption` takes `detail`.
- `Menu`: `hover` (`${testId}-hover`, `.kit-menu-hover`): shown on a hovering
  pointer at 640px and up, never while open, on the side the panel opens.
  `ToolsMenu` passes it through.
- `--kit-scrim`: the phone sheet's scrim, carried into the sheet with the
  other `--kit-*`. Unset (the default) it is the 0.7 ink mix.
- `/chat/server` `KitToolDecl.effectiveClass` returns
  `SkipCardFacts['callClass']` (your own classes, or `undefined` for an
  unknown input) instead of `ToolCallClass`; only `'write'` ever skips.
- `KitToolDecl.deferred`: declared but not registered with the model yet.
  Not in `registeredToolNames` (a turn that passes it still throws), class
  `'deferred'` (never skips), not the write a toggleable group needs, and
  allowed in a `fixed: 'read'` group whatever its `class`. A read group still
  throws on a registered write.
- `KIT_VERSION` is `0.8.0`, so pinned decision versions read `…|kit-0.8.0`
  (fingerprints are unchanged).

## 0.7.0 — 2026-09-28

LiteLLM gateways and custom decision models. Minor: all additive; an app that
passes neither `gateway` nor `endpoint` behaves exactly as on 0.6.1, and every
existing decision fingerprint is unchanged.

- `/models` `toCallConfig(plan, { gateway: { kind: 'litellm', baseURL, apiKey?, models?, prefix? } })`:
  the call goes to a LiteLLM proxy's OpenAI-compatible API, model
  `provider/model` or a mapped alias. New `CallConfig.via` (`direct` |
  `litellm`); `provider` stays the planned one, so receipts price the model
  it is. New `gatewayModel(gateway, provider, model)` and `GatewayConfig`.
- `/chat/server` `modelFromPlan({ gateway })`: a gateway (or a function of the
  turn returning one, or null for the direct path) pays for the turn. `key` is
  now optional when a gateway is given.
- `/decide` `endpoint` on `decide` and `defineDecision`:
  `{ kind: 'systemone', baseURL? }` (default OpenRouter) or
  `{ kind: 'chat', baseURL, provider? }` for any model behind an
  OpenAI-compatible API, with confidence from token logprobs. `model` takes
  any id (required for `chat`). New error kind `uncalibrated` (no logprobs).
  New exports `resolveDecisionEndpoint`, `DecisionEndpoint`,
  `DecisionEndpointKind`, `DecisionProvider`.
- `DecisionReceipt.provider` widens from `'openrouter'` to `DecisionProvider`
  and gains optional `endpoint`; `toModelsUsage` passes the provider through.
- `describeDecideError({ kind: 'missing_key' })` reads "no decision key
  configured" (it no longer assumes OpenRouter).
- `KIT_VERSION` is `0.7.0`, so pinned decision versions read `…|kit-0.7.0`.

## 0.6.1 — 2026-09-28

Gaps found moving buildd's own chat onto the kit. Patch: every addition is
optional and off by default, so an app that passes none of them renders
exactly as on 0.6.0.

- `/chat/react` `Menu`: `placement: 'up' | 'down' | 'auto'` (default `up`,
  as before) for the wide-screen popover; `auto` measures the trigger when
  it opens and opens down unless there is little room below and more above.
  The resolved side is on the wrapper as `data-placement`. New export
  `menuDropSide(rect, viewportHeight)`.
- `Menu`: `sheetClose` puts a close (×) button beside the phone sheet's title
  (`${testId}-close`, `.kit-sheet-head` / `.kit-sheet-close`). Off by default.
- `ToolsMenu` and `TierPicker` pass `placement` and `sheetClose` through.
- `TierPicker`: `footer` (under the options, e.g. the conversation's running
  cost; `.kit-menu-footer`, `kit-tier-footer`) and `autoMeta` (the line under
  Auto; default "picks per turn").
- `ChatSetupCard`: `title`, a heading between the eyebrow and the message
  (`kit-setup-title`).
- `KIT_VERSION` is `0.6.1`, so pinned decision versions read `…|kit-0.6.1`
  (fingerprints are unchanged).

## 0.6.0 — 2026-09-28

Per-app tier defaults, names and offer, plus a remembered last pick. Minor:
all additive; an app that passes no policy behaves exactly as on 0.5.0 (Auto
first and the default, Budget / Standard / Premium).

- `/chat/contract` new: `defineTierPolicy({ offer?, defaultTier?, labels?,
  auto?, autoLabel? })` → `{ offer, defaultTier, auto, autoLabel, label,
  isOffered, accepts, resolve, options }`, plus `CHAT_TIERS`, `ChatTier`,
  `isChatTier`, `defaultTierName`. Isomorphic, so the server validates a
  turn's tier with the same object (`accepts`, `resolve(saved) → default`).
  Also re-exported from `/chat/react`.
- `/chat/react` `TierPicker`: optional `policy` (only its tiers, its names,
  Auto only when offered, Auto's name) and `auto` (hide Auto without a policy).
- `/chat/react` `createComposerStore({ tiers })`: a new chat starts on the
  policy's `defaultTier` instead of Auto; a seeded tier the policy doesn't
  accept is dropped; `setTier` ignores one (to `onError`). Precedence: saved
  choice → app default → kit default. `store.initial` and `store.tiers`.
- `/chat/react` `ComposerPrefsAdapter.peek?(key)`: a synchronous first-paint
  seed (e.g. localStorage) applied before `load` answers.
- `/chat/react` new: `tierPrefs({ load, save, peek? })`, a tier-only adapter
  (`load(): Tier | null | Promise<…>`, `save(tier)`).
- `tierLabel(pinned, last, labels?, autoLabel?)`: optional Auto name.
- **Pinned decision versions** read `…|kit-0.6.0` now (fingerprints are
  unchanged).
- `KIT_VERSION` is `0.6.0`.

## 0.5.0 — 2026-09-28

The generic half of buildd's chat, lifted into the kit so buildd, Cue and moa
share it. Minor: everything is additive, except that `ToolsMenu` drops its
Allow count (a visible change, no API removed).

**Upgrading: what you can delete**

- **Any CSS or test that reads the tools count.** `ToolsMenu`'s trigger is a
  plain `···` named "Tools"; `kit-tools-count` is gone. `allowedBadgeCount`
  stays in `/chat/contract` for settings pages.
- **Local copies of these helpers**, if your app wrote its own: per-turn
  thumbs, a steer box, a live object cache, a pinned object strip, a pane
  side reducer, a parked first message, refusal parsing, cost formatting.
- **Pinned decision versions** read `…|kit-0.4.0` now (fingerprints are
  unchanged): update `expectDecisionPinned({ version })` and version regexes.

**Changes**

- `/chat/react` `ToolsMenu`: no Allow count on the trigger; its accessible
  name is the title ("Tools").
- `/chat/react` `ChatComposer`: optional `leading` (a row in the box above the
  message), `actions` (toolbar controls after `tier`), `edge` (decoration over
  the top edge), `footer` (under the box), `mood` and `compact` (as
  `data-mood` / `data-compact`). Nothing renders without them.
- `/chat/react` new: `TurnFeedbackProvider` / `TurnFeedback` /
  `useTurnFeedback` / `DEFAULT_FEEDBACK_REASONS` (thumbs with one optional
  reason; `onFeedback` records, `loadVotes` or `initial` seeds; no fetch).
- `/chat/react` new: `SteerComposer`, `steerTitle`, `steerStatusLabel`,
  `canSteer` (steer a running agent through the app's `onSend`, each message
  `sent` then `delivered`).
- `/chat/react` new: `createObjectStore` (one live copy per `ObjectRef`, with
  an app `classify` for events and a per-object `sidecar`),
  `createTrailingThrottle`, `ObjectStoreProvider`, `useObjectStore`,
  `useObjectEntry`, `ObjectCard`, `ObjectPane`, `ObjectPlaceholder`,
  `PinnedObject`, `pinnedObjectTitle`, and the dock models `paneReducer`,
  `parsePaneSide`, `dockChoice`, `INITIAL_PANE`, `PANE_SIDE_KEY`.
- `/chat/react` new: `createPendingMessages`, `approvalDraft`,
  `approvalLabel`, `firstParagraph`, `toolAction`, `toolInput`, `formatCost`,
  `formatPer1k`.
- `/chat/contract` new: `refKey`, `parseChatUnavailable`, `chatErrorLine`
  (with `DEFAULT_CHAT_ERROR_LINES`), `TurnSignal`, `TurnVote`,
  `applyTurnVote`.
- `/chat/styles.css`: `kit-feedback*`, `kit-thumb*`, `kit-steer*`,
  `kit-object-*`, `kit-pinned*` and the composer slot classes, reading only
  `--kit-*`. No new custom properties.
- `KIT_VERSION` is `0.4.0`.

## 0.4.0 — 2026-09-28

Conversation titles, opt-in. Nothing changes unless you pass `title`.

- `createChatTurn({ title: { needed, save, rules?, model?, later? } })`: after
  a new question's turn is saved, titles the conversation: your rules, then
  the built-in rule (a 2–7 word first message is its own title), then one
  call on `model` (a `budget` plan). Failures go to `onError(e, 'title')`,
  which gains the `'title'` value.
- `titleConversation`, `ruleTitle`, `normalizeTitle`, `titleMessages` from
  `/chat/server`, for apps that run their own turn loop.
- The model step leaves room for reasoning (`maxOutputTokens: 512`). A
  title-sized cap is spent on a reasoning model's thinking and comes back
  empty; buildd's own chat lost every title that way.
- **Pinned decision versions** read `…|kit-0.4.0` now (fingerprints are
  unchanged).

## 0.3.1 — 2026-09-28

Two fixes to 0.3.0's `/chat/react`. No API is removed.

**Upgrading: what you can delete**

- **The tools-panel width override.** Remove `.kit-menu-panel { width:
  max-content }` (or `:not([data-sheet])` variants) and `.kit-row >
  .kit-toggle { flex: none }` from your chat CSS. The kit does both now.
- **A local copy of the sheet breakpoint.** Import `KIT_SHEET_QUERY` from
  `@builddai/ai-kit/chat/react` instead of hard-coding `(max-width: 639px)`.
- **Pinned decision versions** read `…|kit-0.3.1` now (fingerprints are
  unchanged): update `expectDecisionPinned({ version })` and version regexes.

**Changes**

- `/chat/styles.css`: the desktop menu panel sizes to its content
  (`width: max-content`) between its 260px min-width and `min(92vw, 380px)`.
  It used to resolve to 260px, because it is absolutely positioned inside a
  trigger-sized `.kit-menu`, so next to a long tool-group label ("Shipments:
  hold, release, merge, consolidate") the Ask first / Allow toggle was cut
  off. The toggle and the lock label never shrink (`flex: none`, toggle
  buttons `nowrap`); the row label takes the rest and wraps. The phone sheet
  stays full width.
- `/chat/react`: `KIT_SHEET_QUERY` is re-exported, as the 0.3.0 notes said.
- `KIT_VERSION` is `0.3.1`.

## 0.3.0 — 2026-09-28

Fixes from the first two apps on 0.2.0, plus the rank slot of `/surfaces`.
Minor because `/surfaces` and `/chat/contract` gain API; nothing is removed.

**Upgrading: what you can delete**

- **The local output cap.** `createChatTurn` now sends `maxOutputTokens: 4096`
  on every model step (`limits.maxOutputTokens`, `0` = no cap). Remove any
  `wrapLanguageModel` + `defaultSettingsMiddleware({ maxOutputTokens })`
  around the model you return from `modelFromPlan`'s `create`. Apps that never
  added one were exposed to the same failure and are fixed by the upgrade.
- **The menu CSS workarounds.** Remove overrides of `.kit-composer`
  `overflow`, `.kit-send` / `.kit-stop` corner radius, `.kit-menu` /
  `.kit-menu-panel` position, and the `max-width: 639px` sheet `left` / `right`
  fix. If the app has a fixed bottom tab bar, set `--kit-sheet-bottom-offset`
  to its height instead. Rules scoped under your chat wrapper
  (`.app-chat .kit-menu-panel`) no longer reach the phone sheet, which now
  lives in `<body>`; target `.kit-sheet-layer .kit-menu-panel` if you need to.
- **`:root:root`.** The kit's theme defaults are on `:where(:root)`, so a
  plain `:root` (or wrapper) mapping of `--kit-*` wins in any import order.
- **Pinned decision versions** read `…|kit-0.3.0` now (fingerprints are
  unchanged): update `expectDecisionPinned({ version })` and version regexes.

**Changes**

- `/chat/server`: `DEFAULT_TURN_LIMITS.maxOutputTokens = 4_096`, passed to
  `streamText`. With no cap, OpenRouter reserves the model's whole output
  window (131k tokens on some models) against the key, and a key with a daily
  or credit limit refuses every call ("requires more credits, or fewer
  max_tokens"), which showed as "The turn failed." on every turn.
- `/chat/server`: provider failures mid-stream are typed. The turn writes a
  `data-turn-error` part (`TurnErrorData { code, message, status? }`, saved
  with the message) before the stream's error chunk, and the `errorText` is
  the same readable sentence. Codes: `insufficient_credit`, `rate_limited`,
  `invalid_key`, `failed`. `classifyTurnError(error)` is exported; it reads
  `APICallError`-shaped errors through `RetryError.lastError` and `cause`.
- `/chat/contract` (additive): `TURN_ERROR_PART_TYPE`, `TurnErrorData`,
  `ChatTurnErrorCode`, `isTurnErrorPart`.
- `/chat/react`: `useKitChat` returns `turnError`. `<ChatThread>` renders a
  `data-turn-error` part in place (`.kit-error[data-turn-error]`) and doesn't
  repeat the `error` prop under it.
- `/chat/react` + `/chat/styles.css`: the composer no longer clips its menus
  (`overflow: hidden` removed; the send / stop button rounds its own corner).
  Desktop panels scroll past `min(70vh, 520px)`. Below 640px `Menu` portals
  the sheet to `<body>` (a transformed or clipping ancestor can't capture its
  `position: fixed`), full width, with a scrim, carrying the `--kit-*` values
  from where it was opened, and `--kit-sheet-bottom-offset` above the bottom.
  The safe-area inset is padded only for what the offset doesn't cover.
  `KIT_SHEET_QUERY` is exported. `/chat/react` now imports `react-dom`
  (`createPortal`), declared as an optional peer `react-dom@^19` like `react`;
  every React app already has it.
- `/chat/theme.css`: defaults on `:where(:root)`; new
  `--kit-sheet-bottom-offset: 0px` (also in `KIT_CSS_VARS`).
- `/surfaces`: `defineRankSurface({ id, promptVersion, candidates, question,
  levels?, fallback, max?, mode, minConfidence?, minAppliedShare?, timeoutMs?,
  model? })` → `{ decision, version, pick(state, runOpts), rank(state, run),
  resolve(ids) }`. One `score` question per candidate in one Jev call; applied
  scores order the candidates, the app's `fallback` order breaks ties and
  stands when there is no key, the call fails, fewer than `minAppliedShare`
  (default half) are applied, or the mode is `shadow`. The multi-slot
  `defineSurface` remains types only.
- `KIT_VERSION` is `0.3.0`.

## 0.2.0 — 2026-09-27

The chat turn runner and the React components (P3 of
`docs/design/shared-ai-kit.md`), generalised from buildd's v3 chat. See the
README's "Chat" section for the full API.

- `/chat/server`: `createChatTurn` — one streamed turn on AI SDK v7
  (`streamText` → UI message stream) with: refusals before any spend
  (`409 no_key`, `429 budget_exhausted` / `rate_limited`); approval cards
  gated on the server (approval id + input hash + approver + the store's
  atomic compare-and-set, and a fingerprint re-check at execution); Allow
  through `canSkipCard` plus a resolving preview; at most one card per turn;
  hand-offs (`handoffResult` → `data-handoff` + `store.linkHandoff`,
  `handoffEventMessage` for later updates); `data-step` thinking rows from the
  tool lifecycle and `ctx.step()`; Stop / deadline aborts that save the partial
  turn; a content-free `/models` receipt plus the app's `onUsage` record per
  request; mid-turn steering behind `steering: { queue }`.
  `modelFromPlan` builds the turn's model from a `/models` plan (a `deny` plan
  refuses the turn). `ChatStore` is the persistence adapter
  (`memoryChatStore` for tests); `createPermissionsApi` serves `GET`/`PATCH`
  permissions. `ai` is loaded lazily, so the entry still imports without it.
- `/chat/server` also exports the approval primitives (`canonicalJson`,
  `hashToolInput` — WebCrypto, byte-identical to buildd's — `approvalRequestsIn`,
  `reconcileApprovals`, `previewMatches`).
- `KitToolDecl` gains optional `steps: { active, done, failed? }`;
  `ToolGroups` gains `labelOf(group)`.
- `ChatTurnOptions` (the 0.1 skeleton type) is replaced by the real options:
  `groups` is now `toolGroups`, `key` moved into `modelFromPlan`, and
  `preview` returns `{ ok: false, question }` (was `message`).
- `/chat/react`: `useKitChat`, `ChatThread`, `ChatComposer`, `ToolsMenu` /
  `ToolRows`, `ScopePicker`, `TierPicker`, `ThinkingPanel`, `ApprovalCard`,
  `HandoffCard`, `ChatEmpty`, `ChatSetupCard`, `Menu`, and the pure view
  helpers (`thinkingSteps`, `tierLabel`, `greeting`, ...). Peers `react@^19`,
  `@ai-sdk/react@^4` and `ai@^7` are all required by this entry (the build
  audit allows it and only it to import optional peers statically).
- `/chat/react`: `createComposerStore` / `useComposerState` / `applyComposerSeed`
  — the shared new-chat composer (one draft, scope and tier across a home
  card, the chat page and a canvas, keyed per team), seeded from and saved
  through an app `ComposerPrefsAdapter`; a late seed never overwrites a field
  the person already changed, and a page's own scope wins until they pick.
  Generalised from buildd's composer-store (#2907), with storage left to the
  app.
- `/chat/styles.css` (new): the components' layout, reading only `--kit-*`.
  `/chat/theme.css` gains `--kit-rule`. `/chat/schema.sql` (new): reference
  tables for a `ChatStore`.
- `/chat/contract` (additive): `SteerData` / `data-steer` (`isSteerPart`),
  `isEventPart`, `latestHandoffs`, `ChatTurnRequest`, `ChatTurnMetadata`,
  `ChatUnavailableBody`; `HandoffData` gains optional `title`, `toolCallId`,
  `summary`; `ToolResult` gains optional `handoff`.
- `KIT_VERSION` is `0.2.0`, so `/decide` versions change to `…|kit-0.2.0`.
- `scripts/smoke-consumer.mjs` also checks `/chat/react` fails bare only by
  naming its peers, `/chat/server` loads without `ai`, and, with peers, runs a
  real turn on a mock model (one card, nothing runs) and server-renders the
  components.

## 0.1.1 — 2026-09-27

- Fix: `/decide` declares `@typesafe-ai/sdk` as an optional peer; consumers
  can import it. 0.1.0 declared the peer but imported the SDK statically, so
  `import('@builddai/ai-kit/decide')` threw `ERR_MODULE_NOT_FOUND` in any
  project without the SDK. The SDK is now loaded on the first `decide` call:
  the module imports cleanly without it, and `decide` returns a new
  `DecideError` kind, `sdk_missing`, instead of throwing. Install
  `@typesafe-ai/sdk@0.6.0` to make decision calls. `.d.ts` no longer
  references the SDK either.
- `DECIDE_SDK_PACKAGE` names the peer, for install hints.
- The build fails if a dist `.js` imports a package that is neither a
  dependency nor a peer, or statically imports an optional peer.
  `scripts/smoke-consumer.mjs` packs the dist, installs it into a clean
  project outside the monorepo from the public registry, and imports every
  entry with and without the peers (CI runs it on every build and before
  publishing).

## 0.1.0 — 2026-09-27

First published release. (`0.0.1` was the in-repo P0 version and was never
published to npm; its placeholder `/models` and `/decide` types are gone.)

Published as `@builddai/ai-kit` (the npm user scope of the `builddai`
account). The in-repo name was `@buildd/ai-kit`, which was never published;
update any `@buildd/ai-kit` imports to `@builddai/ai-kit`.

- `/chat/contract` (P0 of `docs/design/shared-ai-kit.md`): message and
  tool-part types, object refs, the `data-step`, `data-handoff` and
  `data-event` parts, approval previews, tool-permission rows. buildd's own
  chat reads these from here.
- `/chat/server`: `defineToolGroups` and the pure Allow enforcement
  (`skipCardVerdict` / `canSkipCard`, `contentInContext`,
  `toolOutputInHistory`). buildd's chat enforces Allow through this function.
- `/chat/theme.css`: the `--kit-*` custom properties.
- `/models`: the model-plan client. `createModelsClient` (`plan`,
  `recordUsage`, `flush`, `stats`) against buildd's `POST /api/ai/plan` and
  `/api/ai/usage`: 60s plan cache with a pluggable `PlanStore`, 800ms
  deadline, 24h stale window then fixed `defaults`, `PlanDeniedError` on deny,
  allowlisted and batched receipts with one retry. `toCallConfig` for
  OpenRouter / Anthropic / OpenAI.
- `/models` receipts take an optional `kind` (`chat` | `inference` |
  `decision`, `USAGE_KINDS`), and a `decision` receipt may omit `plan.tier`,
  so buildd reports decision spend apart from chat.
- `/decide` (P2): question builders (`choice`, `score`, `noul`); `decide`,
  the transport over `@typesafe-ai/sdk` to OpenRouter (never throws, one
  deadline, retries on 408/429/5xx, pinned `JEV_MODEL`); `runDecisionPool`
  for fan-out; `defineDecision` (`DecisionConfig` / `Decision`) with
  `shadow | gated | live` modes, per-question thresholds, `version` and
  `fingerprint`; `expectDecisionPinned`; `runDecisionEval` /
  `summarizeDecisionEval`; metadata-only `DecisionReceipt`s and
  `toModelsUsage` (sends `kind: 'decision'`, no tier) for `/models`'
  `recordUsage`. buildd's `decisionCall` uses this transport and these types.
- Relative imports in the source are extensionless and the build rewrites
  them to `.js`, so the kit is consumable from source by Next/Turbopack with
  no consumer config, and `dist/` is valid Node ESM.
- `/chat/react`, `/surfaces`: types only. Implementations land in later
  phases.
