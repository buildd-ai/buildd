// RFC 9728 root fallback. A client that does not get (or does not read) the
// `resource_metadata` hint on the 401 tries
// `/.well-known/oauth-protected-resource/api/mcp` and then this root path, in
// that order (MCP authorization, "Protected Resource Metadata Discovery").
// Both serve the account-level document for `<issuer>/api/mcp`, the canonical
// connector address.
export { GET, OPTIONS } from './api/mcp/route';

export const dynamic = 'force-dynamic';
