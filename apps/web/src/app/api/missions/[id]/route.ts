// GET /api/missions/[id] — get single mission
// PATCH /api/missions/[id] — update mission
// DELETE /api/missions/[id] — delete mission
// Re-exports from objectives route for backwards compatibility
export { GET, PATCH, DELETE } from '../../objectives/[id]/route';
