# Local UI TODOs

## Image Upload Support

Both the runner and the buildd server need to support image attachments on tasks.

### Server-side (apps/web)

1. **Tasks API** - Accept attachments array in POST /api/tasks:
   ```typescript
   attachments?: Array<{
     data: string;       // base64 data URL
     mimeType: string;   // image/png, image/jpeg, etc
     filename: string;
   }>
   ```

2. **Storage** - Upload to Cloudflare R2 (already configured in .env):
   - STORAGE_ENDPOINT
   - STORAGE_BUCKET
   - STORAGE_ACCESS_KEY
   - STORAGE_SECRET_KEY

3. **Attachments table** - Already exists in schema, link to tasks

4. **SDK Integration** - Pass images to Claude Agent SDK:
   ```typescript
   // The SDK supports images via message content
   await session.send({
     type: 'user',
     message: {
       role: 'user',
       content: [
         { type: 'text', text: taskDescription },
         { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
       ]
     }
   });
   ```

### Runner (apps/runner)

1. **File picker** - ✅ Done - multi-image selection
2. **Preview thumbnails** - ✅ Done
3. **Upload to server** - ✅ Done (sends base64 in task creation)
4. **Pass to SDK** - ✅ Done (uses AsyncIterable prompt with image content blocks)

## Workspace Resolution

Current approach:
- Check projectsRoot/{workspace.name}
- Check projectsRoot/{repo-name-from-url}
- Check lowercase variants

Could improve:
- Add workspace path override in settings
- Auto-clone if missing (prompt user)
- Remember successful resolutions

## Status Indicators

- 🔵 New activity (hasNewActivity = true)
- ⚪ Working (status = 'working', animated)
- 🟢 Done (status = 'done')
- 🔴 Error (status = 'error')
- ⚫ Stale (no activity 2min+)

## Milestones (not %)

Track meaningful checkpoints:
- Session started
- Each file edit/write
- Git commits
- Task completed/error

Display as boxes: [■][■][■][□][□] 3/8
