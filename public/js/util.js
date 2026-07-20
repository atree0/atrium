// Small shared utilities: escaping, formatting, markdown-lite, DOM helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtDay(ms) {
  const d = new Date(ms);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Compact relative time for feeds: "now", "5m", "3h", "2d", then a date.
export function timeAgo(ms) {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Deterministic pleasant gradient per user/workspace id.
const PALETTES = [
  ['#5e5ce6', '#bf5af2'], ['#0a84ff', '#64d2ff'], ['#30d158', '#66d4cf'],
  ['#ff9f0a', '#ffd60a'], ['#ff375f', '#ff9f0a'], ['#bf5af2', '#ff375f'],
  ['#64d2ff', '#0a84ff'], ['#ff453a', '#bf5af2'], ['#32ade6', '#30d158'],
];
export function gradientFor(id) {
  const [c1, c2] = PALETTES[Math.abs(Number(id) || 0) % PALETTES.length];
  return `--c1:${c1};--c2:${c2}`;
}

export function initials(name) {
  return String(name || '?').split(/[\s._-]+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

export function avatarHtml(user, cls = 'md') {
  const name = user?.display_name || user?.username || '?';
  if (user?.avatar_url) {
    return `<div class="avatar ${cls}" title="${escapeHtml(name)}"><img src="${escapeHtml(user.avatar_url)}" alt=""></div>`;
  }
  return `<div class="avatar ${cls}" style="${gradientFor(user?.id)}" title="${escapeHtml(name)}">${escapeHtml(initials(name))}</div>`;
}

// markdown-lite: code blocks, inline code, bold, italic, strike, quotes, links,
// mentions, broadcast mentions (@channel/@here), and custom :emoji: images.
// All constructs are extracted to private-use-area sentinels before inline
// passes run, so no pass can see (or corrupt) another pass's HTML output.
export function renderMarkdown(text, { meId = null, usersByName = new Map(), emojiMap = new Map() } = {}) {
  const stash = [];
  const put = (html) => {
    stash.push(html);
    return `\uE001${stash.length - 1}\uE001`;
  };
  const restore = (s) => s.replace(/\uE001(\d+)\uE001/g, (_m, i) => stash[Number(i)] ?? '');

  let s = escapeHtml(text);

  // Block constructs first: fenced code, then inline code, then links.
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) =>
    put(`<pre>${code.replace(/^\n+|\n+$/g, '')}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => put(`<code class="inline">${code}</code>`));
  s = s.replace(/(https?:\/\/[^\s<]+)/g, (url) =>
    put(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
  // Custom workspace emoji: :name: -> inline image (only known names).
  s = s.replace(/:([a-z0-9_+-]{2,32}):/g, (m, name) => {
    const url = emojiMap.get(name);
    return url ? put(`<img class="emoji-custom" src="${escapeHtml(url)}" alt=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:">`) : m;
  });
  // Mentions are stashed too so formatting passes can't mangle the span.
  // Remote (shadow) usernames carry an @host segment: `name@somehost`.
  s = s.replace(/@([A-Za-z0-9_.-]+(?:@[A-Za-z0-9_.-]+)?)/g, (m, name) => {
    if (['channel', 'here', 'everyone'].includes(name.toLowerCase())) {
      return put(`<span class="mention broadcast">@${escapeHtml(name)}</span>`);
    }
    const u = usersByName.get(name.toLowerCase());
    const cls = u && u.id === meId ? 'mention me' : 'mention';
    return put(`<span class="${cls}" data-user-id="${u?.id ?? ''}">@${escapeHtml(name)}</span>`);
  });

  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n/g, '<br>');

  return restore(s);
}

export function toast(msg) {
  const root = $('#toast-root');
  const node = el(`<div class="toast glass">${escapeHtml(msg)}</div>`);
  root.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(() => node.remove(), 2600);
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
