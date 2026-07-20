// Central client state + derived helpers. Mutated by REST loads and WS events;
// views re-render from here.
export const state = {
  user: null,
  workspaces: [],
  workspaceId: null,
  myRole: null,
  channels: [],
  users: [],
  presence: new Set(),
  activeChannelId: null,
  messages: new Map(),      // channelId -> Message[] (ascending)
  hasMore: new Map(),       // channelId -> bool (older messages available)
  partial: new Set(),       // channelIds whose cached page is an `around` slice (tail missing)
  thread: null,             // { parent, messages, channelId }
  typing: new Map(),        // channelId -> Map(userId -> {name, until})
  ephemeral: new Map(),     // channelId -> [{id, text, at}]
  emojiMap: new Map(),      // custom emoji name -> url (active workspace)
  saved: new Map(),         // messageId -> saved message (active workspace)
  railBadges: new Map(),    // workspaceId -> {unreads, mentions} (inactive workspaces)
  channelMembers: new Map(),// channelId -> Set(userId), for mention autocomplete
  apps: [],                 // workspace apps (sidebar Apps section)
};

export function workspace() {
  return state.workspaces.find(w => w.id === state.workspaceId) || null;
}

export function channel(id = state.activeChannelId) {
  return state.channels.find(c => c.id === id) || null;
}

export function userById(id) {
  return state.users.find(u => u.id === id) || null;
}

export function usersByName() {
  return new Map(state.users.map(u => [u.username.toLowerCase(), u]));
}

export function channelTitle(c) {
  if (!c) return '';
  if (c.is_dm) {
    const others = (c.dm_users || []).filter(u => u.id !== state.user.id);
    if (!others.length) return `${state.user.display_name || state.user.username} (you)`;
    return others.map(u => u.display_name || u.username).join(', ');
  }
  return c.name;
}

// A DM whose only member is the viewer — their personal notepad.
export function isSelfDm(c) {
  return !!c?.is_dm && (c.dm_users || []).filter(u => u.id !== state.user.id).length === 0;
}

export function isOnline(id) {
  return state.presence.has(id);
}

// Presence class for a user object: 'on' (green), 'away' (hollow), '' (offline).
export function presenceClass(u) {
  if (!u || u.is_remote) return '';
  if (u.away) return 'away';
  return (u.online || isOnline(u.id)) ? 'on' : '';
}

// Inserts a message into the channel list, keeping ascending id order.
export function upsertMessage(msg) {
  const list = state.messages.get(msg.channel_id);
  if (!list) return false;
  const i = list.findIndex(m => m.id === msg.id);
  if (i >= 0) { list[i] = msg; return true; }
  if (msg.thread_id) return false; // replies don't live in the main list
  list.push(msg);
  list.sort((a, b) => a.id - b.id);
  return true;
}

export function removeMessage(id, channelId) {
  const list = state.messages.get(channelId);
  if (!list) return;
  const i = list.findIndex(m => m.id === id);
  if (i >= 0) list.splice(i, 1);
}

export function totalUnread() {
  let mentions = 0;
  let unreads = 0;
  for (const c of state.channels) {
    if (c.is_member && !c.muted) {
      unreads += c.unread_count || 0;
      mentions += c.mention_count || 0;
    }
  }
  return { unreads, mentions };
}

export function updateTitleBadge() {
  const { mentions, unreads } = totalUnread();
  document.title = mentions > 0 ? `(${mentions}) Atrium` : unreads > 0 ? '• Atrium' : 'Atrium';
  window.atriumDesktop?.setBadge(mentions + unreads);
}
