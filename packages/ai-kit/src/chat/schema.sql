-- @builddai/ai-kit/chat/schema.sql
--
-- A REFERENCE layout for the tables a `ChatStore` needs (Postgres). The kit
-- never runs this: each app writes its own migration with its own tool
-- (Drizzle, ...) and implements `ChatStore` over it. Rename freely; keep the
-- constraints marked MUST, they are what the approval and taint rules rely on.

CREATE TABLE conversations (
  id               uuid PRIMARY KEY,
  owner_user_id    text NOT NULL,
  title            text,
  tier             text,                    -- a pinned tier, or NULL = Auto
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);

CREATE TABLE conversation_messages (
  id               text PRIMARY KEY,        -- the kit's message id (saveMessage upserts on it)
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant', 'event', 'system')),
  parts            jsonb NOT NULL,          -- AI SDK v7 UIMessage parts, as streamed
  metadata         jsonb,                   -- ChatTurnMetadata
  author_user_id   text,
  tier             text,
  model            text,
  usage            jsonb,                   -- ChatUsage
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- loadMessages: the newest N, returned oldest first.
CREATE INDEX conversation_messages_conv_created ON conversation_messages (conversation_id, created_at DESC);

CREATE TABLE conversation_approvals (
  approval_id      text PRIMARY KEY,        -- MUST be unique: recordApprovals is idempotent on it
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       text NOT NULL,
  tool_call_id     text NOT NULL,
  tool_name        text NOT NULL,
  input_hash       text NOT NULL,           -- sha256 hex of canonicalJson(input)
  user_id          text NOT NULL,           -- the only person who may answer it
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  result           jsonb,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- decideApproval MUST be one atomic compare-and-set:
--   UPDATE conversation_approvals SET status = $approved, decided_at = now()
--   WHERE approval_id = $1 AND conversation_id = $2 AND user_id = $3
--     AND input_hash = $4 AND status = 'pending'
--   RETURNING approval_id;           -- true iff a row came back

CREATE TABLE conversation_handoffs (
  task_id          text PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       text,
  tool_call_id     text NOT NULL,
  url              text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The per-person tool-permission preference (createPermissionsApi's PermissionPrefs):
-- the group keys the person set to Allow. Default empty = every write asks.
CREATE TABLE chat_tool_permissions (
  user_id          text PRIMARY KEY,
  allowed_groups   text[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Optional: the app's own usage ledger (createChatTurn's onUsage). This one
-- carries identity and is the app's source of truth for cost; the receipt to
-- buildd (/models recordUsage) never does.
CREATE TABLE ai_usage (
  id               bigserial PRIMARY KEY,
  user_id          text NOT NULL,
  conversation_id  uuid,
  message_id       text,
  plan_id          text,
  plan_source      text NOT NULL,
  provider         text NOT NULL,
  model            text NOT NULL,
  tier             text,
  input_tokens     integer NOT NULL,
  output_tokens    integer NOT NULL,
  cost_usd         numeric(12, 6),
  latency_ms       integer NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('ok', 'error', 'aborted')),
  meta             jsonb,                   -- e.g. { "keyScope": "household", "keyOwnerTenantId": "…" }
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_user_created ON ai_usage (user_id, created_at DESC);
