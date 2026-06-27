-- Mask PII from prod clone; runs before app starts.
-- Counts only — never print row content.

-- users: scrub email and name (actual PII columns are on `users`, not `accounts`)
UPDATE users SET
  email = 'scrubbed-' || id || '@qa.example.com',
  name  = 'QA User ' || LEFT(id::text, 8)
WHERE email NOT LIKE '%@qa.example.com';

-- accounts: scrub stored Anthropic API keys (workspaces has no webhook_secret column;
-- sensitive keys live here and in the secrets table)
UPDATE accounts SET anthropic_api_key = 'sk-scrubbed'
WHERE anthropic_api_key IS NOT NULL;

-- accounts: scrub deprecated OAuth token column (superseded by secrets table but may still be populated)
UPDATE accounts SET oauth_token = NULL
WHERE oauth_token IS NOT NULL;

-- secrets: scrub encrypted OAuth tokens and MCP credentials
UPDATE secrets SET encrypted_value = 'SCRUBBED'
WHERE purpose IN ('oauth_token', 'mcp_credential');
