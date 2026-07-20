// Link unfurling: after a message is posted, fetch the FIRST http(s) URL in
// its text, extract <title>/OpenGraph metadata, and append a {type:'link'}
// attachment. Best-effort: any failure is silently skipped. Never blocks
// the posting response — callers fire and forget.
import { get, run } from '../db.js';
import { serializeMessage } from './messages.js';
import { broadcastToChannel } from '../realtime.js';
import { safeFetch } from './netguard.js';

const MAX_BYTES = 512 * 1024;
const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function firstUrl(text) {
  const m = String(text || '').match(URL_RE);
  return m ? m[0] : null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; }
    })
    .replace(/&(quot|amp|apos|lt|gt|nbsp);/g, (_, e) => ({
      quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ',
    }[e]));
}

function unescapeAttr(s) {
  return s.replace(/\\(["'\\])/g, '$1');
}

function parseHtmlMeta(html) {
  const pick = (prop) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=(["'])((?:\\1|(?!\\1).)*)\\1`,
      'i'
    );
    const m = html.match(re);
    if (m) return unescapeAttr(m[2]);
    // Tolerate attributes in the other order: content=... property=...
    const re2 = new RegExp(
      `<meta[^>]+content=(["'])((?:\\1|(?!\\1).)*)\\1[^>]+(?:property|name)=["']${prop}["']`,
      'i'
    );
    const m2 = html.match(re2);
    return m2 ? unescapeAttr(m2[2]) : '';
  };
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() || '';
  const image = pick('og:image');
  return {
    title: decodeEntities(pick('og:title') || titleTag).slice(0, 200),
    description: decodeEntities(pick('og:description')).slice(0, 500),
    // Only absolute http(s) images — anything else (protocol-relative,
    // data:, javascript:) is dropped so clients can auto-load it safely.
    image: /^https?:\/\//i.test(image) ? image : '',
    site_name: decodeEntities(pick('og:site_name')),
  };
}

async function readBodyCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total >= MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  return buf.subarray(0, MAX_BYTES).toString('utf8');
}

// Fetches `url` and, if it's HTML, persists a link attachment on the message
// and notifies channel members. Resolves silently on any failure.
export async function unfurlMessage(msg, text) {
  try {
    const url = firstUrl(text);
    if (!url) return;
    const res = await safeFetch(url, {}, {
      timeoutMs: 4000,
      allowLocal: process.env.ATRIUM_ALLOW_LOCAL_UNFURL === '1',
    });
    if (!res.ok) return;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return;
    const html = await readBodyCapped(res);
    const meta = parseHtmlMeta(html);
    if (!meta.title && !meta.description) return;

    // Re-read inside a retry loop so concurrent unfurls/edits don't clobber
    // each other's attachment lists. If the text changed since the URL was
    // extracted, the edit raced us — drop this unfurl (the edit path
    // re-unfurls from the new text).
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = get('SELECT text, attachments FROM messages WHERE id = ?', msg.id);
      if (!fresh || fresh.text !== text) return;
      const attachments = JSON.parse(fresh.attachments || '[]');
      attachments.push({ type: 'link', url, ...meta });
      const result = run(
        'UPDATE messages SET attachments = ? WHERE id = ? AND attachments = ?',
        JSON.stringify(attachments), msg.id, fresh.attachments
      );
      if (result.changes === 1) break;
      if (attempt === 2) return;
    }

    const updated = serializeMessage(get('SELECT * FROM messages WHERE id = ?', msg.id));
    const channel = get('SELECT workspace_id FROM channels WHERE id = ?', msg.channel_id);
    broadcastToChannel(msg.channel_id, {
      type: 'message.updated', workspace_id: channel?.workspace_id, message: updated,
    });
  } catch { /* best-effort — silently skip */ }
}

// Edit path: unfurl attachments must survive edits. Strip existing
// {type:'link'} attachments (synchronous DB work); re-unfurl in the
// background only if the text's first URL changed.
export function refreshUnfurl(msg, newText) {
  try {
    const fresh = get('SELECT attachments FROM messages WHERE id = ?', msg.id);
    if (!fresh) return;
    const attachments = JSON.parse(fresh.attachments || '[]');
    const links = attachments.filter(a => a && a.type === 'link');
    const kept = attachments.filter(a => !(a && a.type === 'link'));
    const newFirst = firstUrl(newText);
    const carried = links.filter(a => a.url === newFirst).slice(0, 1);
    if (kept.length + carried.length !== attachments.length) {
      run('UPDATE messages SET attachments = ? WHERE id = ?',
        JSON.stringify([...kept, ...carried]), msg.id);
    }
    if (newFirst && carried.length === 0) {
      const updated = get('SELECT * FROM messages WHERE id = ?', msg.id);
      if (updated) unfurlMessage(updated, newText); // fire-and-forget
    }
  } catch { /* best-effort */ }
}
