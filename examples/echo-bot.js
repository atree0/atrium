// Example Atrium app: /echo slash command + @mention replies.
//
// Setup:
//   1. Create an app in Atrium (workspace menu → Apps & integrations).
//   2. Copy the bot token + signing secret below via env vars.
//   3. Register the slash command:
//        curl -X POST $ATRIUM_URL/api/v1/apps/<APP_ID>/commands \
//          -H "Authorization: Bearer <your user token>" \
//          -H 'Content-Type: application/json' \
//          -d '{"command":"echo","url":"http://localhost:4000/atrium"}'
//   4. Subscribe to app_mention:
//        curl -X POST $ATRIUM_URL/api/v1/apps/<APP_ID>/subscriptions \
//          -H "Authorization: Bearer <your user token>" \
//          -H 'Content-Type: application/json' -d '{"event":"app_mention"}'
//   5. Run:  ATRIUM_URL=http://localhost:3000 BOT_TOKEN=xatb-… SIGNING_SECRET=… node echo-bot.js
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const ATRIUM_URL = process.env.ATRIUM_URL || 'http://localhost:3000';
const BOT_TOKEN = process.env.BOT_TOKEN;
const SIGNING_SECRET = process.env.SIGNING_SECRET;
const PORT = Number(process.env.BOT_PORT || 4000);

if (!BOT_TOKEN || !SIGNING_SECRET) {
  console.error('Set BOT_TOKEN and SIGNING_SECRET (see header comment).');
  process.exit(1);
}

function verifyRequest(req, rawBody) {
  const ts = req.headers['x-atrium-timestamp'];
  const sig = req.headers['x-atrium-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = createHmac('sha256', SIGNING_SECRET).update(`${ts}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
}

async function postMessage(channelId, text) {
  const res = await fetch(`${ATRIUM_URL}/api/v1/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BOT_TOKEN}` },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (!data.ok) console.error('post failed:', data);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/atrium') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (!verifyRequest(req, body)) {
      res.writeHead(401).end('bad signature');
      return;
    }
    const payload = JSON.parse(body);

    if (payload.type === 'slash_command' && payload.command === '/echo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: `echo: ${payload.text || '(nothing)'}` }));
      return;
    }

    if (payload.type === 'event' && payload.event === 'app_mention') {
      const msg = payload.data.message;
      await postMessage(msg.channel_id, `You rang, @${msg.user.username}? 🤖`);
      res.writeHead(200).end('{}');
      return;
    }

    res.writeHead(200).end('{}');
  });
});

server.listen(PORT, () => console.log(`echo-bot listening on :${PORT} (POST /atrium)`));
