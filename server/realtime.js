// Realtime hub: one WebSocket endpoint (/ws), token-authed, with channel and
// workspace fan-out, presence, and typing indicators.
import { WebSocketServer } from 'ws';
import { get, all, now } from './db.js';

const connections = new Map(); // userId -> Set<WebSocket>

export function isOnline(userId) {
  if (!connections.has(userId) || connections.get(userId).size === 0) return false;
  // A user who set themselves away presents as offline everywhere.
  return !get('SELECT away FROM users WHERE id = ?', userId)?.away;
}

export function sendToUser(userId, event) {
  const set = connections.get(userId);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(payload);
}

export function broadcastToChannel(channelId, event, excludeUserId = null) {
  const members = all('SELECT user_id FROM channel_members WHERE channel_id = ?', channelId);
  for (const m of members) {
    if (m.user_id !== excludeUserId) sendToUser(m.user_id, event);
  }
}

export function broadcastToWorkspace(workspaceId, event, excludeUserId = null) {
  const members = all('SELECT user_id FROM workspace_members WHERE workspace_id = ?', workspaceId);
  for (const m of members) {
    if (m.user_id !== excludeUserId) sendToUser(m.user_id, event);
  }
}

function workspacesOf(userId) {
  return all('SELECT workspace_id FROM workspace_members WHERE user_id = ?', userId)
    .map(r => r.workspace_id);
}

function presencePayload(user) {
  return { type: 'presence', user_id: user.id, online: isOnline(user.id) };
}

export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy(); // no other upgrade handler exists — don't leak the socket
      return;
    }
    const token = url.searchParams.get('token') || '';

    const session = get('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', token, now());
    let user = null;
    if (session) user = get('SELECT * FROM users WHERE id = ?', session.user_id);
    if (!user) {
      const app = get('SELECT * FROM apps WHERE bot_token = ?', token);
      if (app) user = get('SELECT * FROM users WHERE id = ?', app.bot_user_id);
    }
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const user = ws.user;
    if (!connections.has(user.id)) connections.set(user.id, new Set());
    const wasOffline = connections.get(user.id).size === 0;
    connections.get(user.id).add(ws);
    ws.isAlive = true;

    if (wasOffline) {
      for (const wsId of workspacesOf(user.id)) {
        broadcastToWorkspace(wsId, presencePayload(user), user.id);
      }
    }

    ws.send(JSON.stringify({ type: 'hello', user_id: user.id, server_time: now() }));

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'typing' && typeof msg.channel_id === 'number') {
        // Throttle: one typing frame per second per user is plenty.
        const nowMs = now();
        if (ws.lastTypingAt && nowMs - ws.lastTypingAt < 1000) return;
        ws.lastTypingAt = nowMs;
        const member = get(
          'SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?',
          msg.channel_id, user.id
        );
        if (member) {
          broadcastToChannel(msg.channel_id, {
            type: 'typing',
            channel_id: msg.channel_id,
            user_id: user.id,
            display_name: user.display_name || user.username,
          }, user.id);
        }
      }
    });

    ws.on('close', () => {
      const set = connections.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          connections.delete(user.id);
          for (const wsId of workspacesOf(user.id)) {
            broadcastToWorkspace(wsId, presencePayload(user), user.id);
          }
        }
      }
    });
  });

  // Heartbeat: drop connections that stop responding.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}
