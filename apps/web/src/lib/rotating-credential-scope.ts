/**
 * Why a subscription sign-in (Claude OAuth / .credentials.json, Codex auth.json)
 * cannot be applied to "All my teams": the provider rotates the refresh token on
 * every use, and each team's copy refreshes on its own — so the first refresh
 * leaves every other team holding a dead token. API keys and setup tokens do not
 * rotate and keep the fan-out. Client-safe: shared by the exchange route and the
 * settings UI.
 */
export const ROTATING_CREDENTIAL_ALL_TEAMS_ERROR =
  'A subscription sign-in can’t be copied to all your teams: its refresh token changes ' +
  'every time it is used, so the other teams’ copies would stop working. Connect it for ' +
  'one team at a time, or use an API key for all teams.';
