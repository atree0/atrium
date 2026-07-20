// App platform engine: events API dispatch, slash command invocation, and
// incoming webhook delivery. Outbound HTTP calls are signed HMAC-SHA256 so
// receivers can verify authenticity (see docs/APPS.md).
import { get, all, run, now } from './db.js';
import { on } from './bus.js';
import { randomToken, signPayload } from './auth.js';
import { createMessage } from './lib/messages.js';
import { sendToUser } from './realtime.js';
import { safeFetch } from './lib/netguard.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// safeFetch with retry: up to 2 retries (1s/3s backoff) on network failure.
// HTTP error responses (4xx/5xx) are returned, never retried.
async function fetchWithRetry(url, options = {}, { timeoutMs = 5000, retries = 2 } = {}) {
  const allowLocal = process.env.ATRIUM_ALLOW_LOCAL_CALLBACKS === '1';
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await safeFetch(url, options, { timeoutMs, allowLocal });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(attempt === 0 ? 1000 : 3000);
    }
  }
  throw lastErr;
}

async function postSigned(url, secret, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now() / 1000));
  try {
    await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Atrium-Timestamp': timestamp,
        'X-Atrium-Signature': signPayload(secret, timestamp, body),
      },
      body,
    });
  } catch (err) {
    console.warn(`app callback to ${url} failed: ${err.message}`);
  }
}

// Delivers an event to every app in the workspace subscribed to it. When
// `channelId` is given, only apps whose bot user is a member of that channel
// receive it — message content must never leak to apps outside the channel.
export function dispatchEvent(workspaceId, event, data, { channelId = null } = {}) {
  const apps = all(
    `SELECT a.* FROM apps a
     JOIN app_subscriptions s ON s.app_id = a.id AND s.event = ?
     WHERE a.workspace_id = ? AND a.request_url != ''`, event, workspaceId
  );
  for (const app of apps) {
    if (channelId != null
        && !get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, app.bot_user_id)) {
      continue;
    }
    postSigned(app.request_url, app.signing_secret, {
      type: 'event', event, workspace_id: workspaceId, data, timestamp: now(),
    });
  }
}

export function ensureBotInChannel(app, channelId) {
  run(
    'INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
    channelId, app.bot_user_id, now()
  );
}

// ---- Incoming webhooks ----------------------------------------------------

export function deliverWebhook(token, payload) {
  const webhook = get('SELECT * FROM webhooks WHERE token = ?', token);
  if (!webhook) return { ok: false, error: 'webhook_not_found' };
  const app = get('SELECT * FROM apps WHERE id = ?', webhook.app_id);
  if (!app) return { ok: false, error: 'app_not_found' };

  ensureBotInChannel(app, webhook.channel_id);
  const text = String(payload.text ?? '').slice(0, 40000);
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!text && !attachments.length) return { ok: false, error: 'text_required' };

  const message = createMessage({
    channelId: webhook.channel_id,
    userId: app.bot_user_id,
    text,
    attachments,
  });
  return { ok: true, message };
}

// ---- Slash commands --------------------------------------------------------

// Invoked when a message starts with `/command`. Returns immediately; the
// command endpoint is called async (5s budget) and its response is posted.
export function invokeSlashCommand({ command, args, user, channel }) {
  const row = get(
    `SELECT sc.*, a.signing_secret, a.bot_user_id, a.workspace_id, a.id AS app_id
     FROM slash_commands sc JOIN apps a ON a.id = sc.app_id
     WHERE a.workspace_id = ? AND sc.command = ?`,
    channel.workspace_id, command
  );
  if (!row) return { handled: false };

  const payload = {
    type: 'slash_command',
    command: `/${command}`,
    text: args,
    user_id: user.id,
    user_name: user.username,
    channel_id: channel.id,
    channel_name: channel.name,
    workspace_id: channel.workspace_id,
    timestamp: now(),
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now() / 1000));

  fetchWithRetry(row.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Atrium-Timestamp': timestamp,
      'X-Atrium-Signature': signPayload(row.signing_secret, timestamp, body),
    },
    body,
  })
    .then(async (res) => {
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data || !data.text) return;
      if (data.response_type === 'ephemeral') {
        sendToUser(user.id, {
          type: 'message.ephemeral',
          channel_id: channel.id,
          text: String(data.text),
          app_id: row.app_id,
        });
      } else {
        const app = get('SELECT * FROM apps WHERE id = ?', row.app_id);
        ensureBotInChannel(app, channel.id);
        createMessage({
          channelId: channel.id,
          userId: row.bot_user_id,
          text: String(data.text).slice(0, 40000),
          attachments: Array.isArray(data.attachments) ? data.attachments : [],
        });
      }
    })
    .catch((err) => console.warn(`slash command /${command} failed: ${err.message}`));

  return { handled: true };
}

// ---- Bus wiring ------------------------------------------------------------

export function registerAppEngine() {
  on('message.channels', ({ message, channel, workspace_id }) => {
    dispatchEvent(workspace_id, 'message.channels', { message, channel: publicChannel(channel) }, { channelId: channel.id });
  });
  on('message.im', ({ message, channel, workspace_id }) => {
    dispatchEvent(workspace_id, 'message.im', { message, channel: publicChannel(channel) }, { channelId: channel.id });
  });
  on('message.updated', ({ message, channel, workspace_id }) => {
    dispatchEvent(workspace_id, 'message.updated', { message, channel: publicChannel(channel) }, { channelId: channel.id });
  });
  on('message.deleted', ({ message, channel, workspace_id }) => {
    dispatchEvent(workspace_id, 'message.deleted', { message, channel: publicChannel(channel) }, { channelId: channel.id });
  });
  on('app_mention', ({ message, channel, workspace_id }) => {
    // Deliver only to apps whose own bot user was mentioned AND is a member of
    // the channel — otherwise a mention would leak private-channel content.
    const apps = all(
      `SELECT a.* FROM apps a
       JOIN app_subscriptions s ON s.app_id = a.id AND s.event = 'app_mention'
       WHERE a.workspace_id = ? AND a.request_url != ''`, workspace_id
    );
    for (const app of apps) {
      if (!message.mentions.includes(app.bot_user_id)) continue;
      if (!get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', channel.id, app.bot_user_id)) {
        continue;
      }
      postSigned(app.request_url, app.signing_secret, {
        type: 'event', event: 'app_mention', workspace_id,
        data: { message, channel: publicChannel(channel) }, timestamp: now(),
      });
    }
  });
  on('reaction.added', ({ reaction, message, channel, workspace_id }) => {
    dispatchEvent(workspace_id, 'reaction.added', { reaction, message, channel: publicChannel(channel) }, { channelId: channel.id });
  });
  on('reaction.removed', ({ reaction, message, channel, workspace_id }) => {
    dispatchEvent(workspace_id, 'reaction.removed', { reaction, message, channel: publicChannel(channel) }, { channelId: channel.id });
  });
  on('channel.created', ({ channel, workspace_id }) => {
    // Private channels (and DMs): only apps already inside may learn of them.
    const scoped = channel.is_private || channel.is_dm ? { channelId: channel.id } : {};
    dispatchEvent(workspace_id, 'channel.created', { channel: publicChannel(channel) }, scoped);
  });
}

function publicChannel(c) {
  const { dm_key, ...rest } = c;
  return rest;
}

export function createWebhookToken() {
  return randomToken(24);
}
