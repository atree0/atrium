// Small guards shared by route modules.
import { get } from '../db.js';

export function sendError(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

// Wraps async route handlers so rejected promises reach Express 4's error
// middleware instead of crashing the process (Express 4 doesn't forward them).
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Resolves workspace membership for the current user. Bots are scoped to
// their app's workspace. Returns the membership row or null.
export function workspaceMember(req, workspaceId) {
  if (req.botApp && Number(workspaceId) !== req.botApp.workspace_id) return null;
  return get(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    workspaceId, req.user.id
  );
}

export function channelMember(req, channelId) {
  const channel = get('SELECT * FROM channels WHERE id = ?', channelId);
  if (!channel) return { channel: null, member: null };
  if (req.botApp && channel.workspace_id !== req.botApp.workspace_id) return { channel, member: null };
  const member = get(
    'SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?',
    channelId, req.user.id
  );
  return { channel, member };
}

// Channel is readable if it's a public channel in a workspace the user
// belongs to, or the user is an explicit member (private channels and DMs).
export function canReadChannel(req, channel) {
  if (!channel) return false;
  if (req.botApp && channel.workspace_id !== req.botApp.workspace_id) return false;
  if (!workspaceMember(req, channel.workspace_id)) return false;
  if (channel.is_private || channel.is_dm) {
    return !!get(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?',
      channel.id, req.user.id
    );
  }
  return true;
}
