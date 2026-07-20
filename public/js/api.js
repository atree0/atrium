// REST client + realtime socket.

let token = localStorage.getItem('atrium.token') || null;

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('atrium.token', t);
  else localStorage.removeItem('atrium.token');
}
export function getToken() { return token; }

export async function api(method, path, body = null) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function uploadFiles(files) {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await fetch('/api/v1/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'upload_failed');
  return data.files;
}

// ---- WebSocket ------------------------------------------------------------

let ws = null;
let handlers = new Map();
let reconnectDelay = 1000;
let closedByUser = false;

export function connectWs() {
  if (!token) return;
  closedByUser = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => { reconnectDelay = 1000; emitLocal('open'); };
  ws.onclose = () => {
    emitLocal('close');
    if (!closedByUser) {
      setTimeout(connectWs, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    }
  };
  ws.onmessage = (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }
    (handlers.get(event.type) || []).forEach(fn => fn(event));
  };
}

export function onWs(type, fn) {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(fn);
}

// 'open' and 'close' are pseudo-events about the socket itself.
function emitLocal(type) {
  (handlers.get(type) || []).forEach(fn => fn({ type }));
}

export function sendWs(payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function disconnectWs() {
  closedByUser = true;
  handlers = new Map();
  ws?.close();
}
