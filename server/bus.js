// Tiny synchronous event bus. Decouples message creation (lib/messages.js)
// from the app-platform engine (apps.js) so neither imports the other.
const listeners = new Map();

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

export function emit(type, payload) {
  for (const fn of listeners.get(type) || []) {
    try { fn(payload); } catch (err) { console.error(`bus listener for "${type}" failed:`, err); }
  }
}
