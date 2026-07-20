// Atrium client entry: boot, data loading, WS wiring, and all view actions.
import { api, setToken, getToken, connectWs, onWs, sendWs, disconnectWs, uploadFiles } from './api.js';
import { state, channel, userById, isSelfDm, upsertMessage, removeMessage, updateTitleBadge } from './state.js';
import { $, toast } from './util.js';
import { renderRail, renderSidebar, renderSidebarSkeleton } from './sidebar.js';
import {
  initChat, renderChatShell, renderMessages, appendMessageDom, updateMessageDom,
  removeMessageDom, renderTypingLine, renderThread, refreshThreadDom,
  renderSearchResults, refreshPinsCount, setPendingJump, setUnreadDivider,
} from './chat.js';
import {
  initModals, renderAuth, renderOnboarding, openWorkspaceModal, openWorkspaceMenu, openProfileMenu,
  openChannelBrowser, openDmPicker, showMembersPopover, showPinsPopover,
  openSavedModal, openChannelMenu, openChannelRowMenu, showProfileCard,
  openAppsModal, openFilesPanel, showActivityPopover, openQuickSwitcher,
} from './modals.js';
import { closeModal, closePopover } from './ui.js';
import { icon } from './icons.js';

// ---- boot -------------------------------------------------------------------

// Invite links are shareable URLs: /join/<code>. A pending code is redeemed
// after auth and cleared either way.
let pendingInviteCode = null;

function captureInviteLink() {
  const m = location.pathname.match(/^\/join\/([A-Za-z0-9_-]+)/);
  if (m) {
    pendingInviteCode = m[1];
    history.replaceState(null, '', '/');
  }
}

async function redeemPendingInvite() {
  if (!pendingInviteCode) return;
  const code = pendingInviteCode;
  pendingInviteCode = null;
  try {
    const { workspace } = await api('POST', '/workspaces/join', { code });
    if (state.workspaces.some(w => w.id === workspace.id)) {
      toast(`You're already in ${workspace.name}`);
    } else {
      toast(`Joined ${workspace.name}`);
      state.workspaces.push(workspace);
    }
    await loadWorkspace(workspace.id);
    return true;
  } catch (ex) {
    toast(ex.message.replace(/_/g, ' '));
    return false;
  }
}

async function boot() {
  initChat(actions);
  initModals(actions);
  if (window.atriumDesktop) document.body.classList.add('desktop');
  // Read a session-seeding token BEFORE anything rewrites the URL.
  const urlToken = new URLSearchParams(location.search).get('token');
  captureInviteLink();
  if (urlToken) {
    setToken(urlToken);
    history.replaceState(null, '', '/');
  }
  if (!getToken()) return renderAuth(onAuth, { setup: await needsSetup() });

  try {
    const { user } = await api('GET', '/auth/me');
    state.user = user;
    setSignedInFlag(true);
  } catch {
    setSignedInFlag(false);
    setToken(null);
    return renderAuth(onAuth, { setup: await needsSetup() });
  }
  await enterApp();
}

// First-run detection: server reports zero human accounts.
async function needsSetup() {
  try {
    const { needs_setup } = await api('GET', '/setup');
    return !!needs_setup;
  } catch {
    return false;
  }
}

// ---- signed-in flag cookie ------------------------------------------------
// A non-auth marker readable by sibling subdomains (e.g. the marketing site
// on the apex) so they can personalize CTAs. Never holds the token itself.
function setSignedInFlag(on) {
  const parts = location.hostname.split('.');
  if (parts.length < 3) return; // localhost or bare host — nothing to share
  const domain = parts.slice(-2).join('.');
  document.cookie = on
    ? `atrium.signed_in=1; domain=.${domain}; path=/; max-age=2592000; samesite=lax`
    : `atrium.signed_in=; domain=.${domain}; path=/; max-age=0; samesite=lax`;
}

async function onAuth({ user, token }) {
  state.user = user;
  setToken(token);
  setSignedInFlag(true);
  await enterApp();
}

async function enterApp() {
  renderShell();
  // Connect the socket even with zero workspaces, so the first workspace
  // created in this session is live without a reload (bug fix #3).
  connectWs();
  wireWs();
  const { workspaces } = await api('GET', '/workspaces');
  state.workspaces = workspaces;
  if (pendingInviteCode) {
    const joined = await redeemPendingInvite();
    if (joined) { fetchRailBadges(); return; }
  }
  if (!workspaces.length) {
    renderOnboarding(actions);
    return;
  }
  const saved = Number(localStorage.getItem('atrium.workspace'));
  const first = workspaces.find(w => w.id === saved) || workspaces[0];
  await loadWorkspace(first.id);
  fetchRailBadges();
}

function renderShell() {
  $('#app').innerHTML = `
    <nav class="rail" id="rail" aria-label="Workspaces"></nav>
    <aside class="sidebar" id="sidebar"></aside>
    <div class="side-backdrop" id="side-backdrop"></div>
    <main class="main" id="main"></main>
    <section class="thread-panel glass-deep" id="thread-panel" style="display:none"></section>
  `;
  $('#side-backdrop').addEventListener('click', closeSidebarOverlay);
}

function closeSidebarOverlay() {
  $('#sidebar')?.classList.remove('open');
  $('#side-backdrop')?.classList.remove('on');
}

// ---- data loading --------------------------------------------------------------

// Monotonic generation: bumped at the start of every navigation; a stale
// result is dropped if a newer navigation began while we awaited (bug fix #5).
let navGen = 0;

async function loadWorkspace(wsId) {
  const gen = ++navGen;
  if (!$('#rail')) renderShell(); // coming from the onboarding view
  const prev = { wsId: state.workspaceId, thread: state.thread, activeChannelId: state.activeChannelId };
  state.workspaceId = wsId;
  localStorage.setItem('atrium.workspace', String(wsId));
  state.thread = null;
  state.activeChannelId = null;
  renderSidebarSkeleton(); // instant feedback while the workspace loads

  let detail, channelsRes, usersRes, emojiRes, savedRes, appsRes;
  try {
    [detail, channelsRes, usersRes, emojiRes, savedRes, appsRes] = await Promise.all([
      api('GET', `/workspaces/${wsId}`),
      api('GET', `/channels?workspace_id=${wsId}`),
      api('GET', `/users?workspace_id=${wsId}`),
      api('GET', `/workspaces/${wsId}/emoji`).catch(() => ({ emoji: [] })),
      api('GET', `/users/me/saved?workspace_id=${wsId}`).catch(() => ({ saved: [] })),
      api('GET', `/apps?workspace_id=${wsId}`).catch(() => ({ apps: [] })),
    ]);
  } catch {
    // Load failed — restore the previous view instead of leaving a blank screen.
    if (gen !== navGen) return;
    state.workspaceId = prev.wsId;
    state.thread = prev.thread;
    state.activeChannelId = prev.activeChannelId;
    if (prev.wsId) localStorage.setItem('atrium.workspace', String(prev.wsId));
    else localStorage.removeItem('atrium.workspace');
    renderRail(actions);
    renderSidebar(actions);
    toast('Failed to load workspace — check your connection');
    return;
  }
  if (gen !== navGen) return;
  state.myRole = detail.my_role;
  state.channels = channelsRes.channels;
  state.users = usersRes.users;
  // Presence doesn't federate: remote (shadow) users are always offline.
  state.presence = new Set(usersRes.users.filter(u => u.online && !u.is_remote).map(u => u.id));
  state.emojiMap = new Map((emojiRes.emoji || []).map(e => [e.name, e.url]));
  state.saved = new Map((savedRes.saved || []).map(m => [m.id, m]));
  state.apps = appsRes.apps || [];
  state.channelMembers = new Map();

  // Self-DM notepad: make sure it exists so it can sit pinned atop the DM list.
  if (!state.channels.some(c => isSelfDm(c))) {
    try {
      const { channel: selfDm } = await api('POST', '/channels/dm', { workspace_id: wsId, user_ids: [] });
      if (gen !== navGen) return;
      if (!channel(selfDm.id)) state.channels.push(selfDm);
    } catch { /* notepad is a nicety — never block workspace load */ }
  }

  renderRail(actions);
  renderSidebar(actions);

  const first = state.channels.find(c => !c.is_dm && c.is_member)
    || state.channels.find(c => !c.is_dm)
    || state.channels[0];
  if (first) await openChannel(first.id);
  if (gen !== navGen) return;
  updateTitleBadge();
}

async function openChannel(channelId, { aroundId = null } = {}) {
  const gen = ++navGen;
  state.activeChannelId = channelId;
  state.thread = null;
  renderThread();
  renderSidebar(actions);

  const c = channel(channelId);
  if (!c) return;
  // Show the shell with a loading skeleton right away when messages aren't
  // cached — channel switches feel instant even on slow links.
  if (!state.messages.has(channelId) || state.partial.has(channelId) || aroundId) {
    renderChatShell({ skeleton: true });
  }
  if (!c.is_member && !c.is_dm && !c.is_private) {
    try {
      await api('POST', `/channels/${c.id}/join`);
      c.is_member = true; // auto-join: reflect membership locally (bug fix #6)
    } catch { /* already joined */ }
  }
  const hadUnread = (c.unread_count || 0) > 0;
  const lastRead = c.last_read_id || 0;
  try {
    if (aroundId) {
      await loadMessagesAround(channelId, aroundId);
    } else if (!state.messages.has(channelId) || state.partial.has(channelId)) {
      // A cached `around` page is missing the tail — refetch fresh on re-open.
      state.partial.delete(channelId);
      await loadMessages(channelId);
    }
  } catch { /* render whatever is cached */ }
  if (gen !== navGen) return;
  setPendingJump(aroundId);
  setUnreadDivider(!aroundId && hadUnread ? lastRead : null);
  renderChatShell();
  if (window.matchMedia('(max-width: 860px)').matches) closeSidebarOverlay();
  actions.getChannelMembers(channelId); // warm the mention-autocomplete cache
  await markRead(channelId);
  if (gen !== navGen) return;
  refreshChannelState(channelId, { unread_count: 0, mention_count: 0 });
  updateTitleBadge();
}

async function loadMessages(channelId, before = null) {
  const qs = before ? `?before=${before}&limit=50` : '?limit=50';
  const { messages, has_more } = await api('GET', `/channels/${channelId}/messages${qs}`);
  const existing = state.messages.get(channelId) || [];
  state.messages.set(channelId, before ? [...messages, ...existing] : messages);
  state.hasMore.set(channelId, has_more);
}

async function loadMessagesAround(channelId, messageId) {
  const data = await api('GET', `/channels/${channelId}/messages?around=${messageId}&limit=50`);
  state.messages.set(channelId, data.messages);
  state.hasMore.set(channelId, data.has_more_before ?? data.has_more ?? false);
  if (data.has_more_after) state.partial.add(channelId);
  else state.partial.delete(channelId);
}

async function markRead(channelId) {
  const msgs = state.messages.get(channelId) || [];
  const latest = msgs[msgs.length - 1];
  if (!latest) return;
  try { await api('POST', `/channels/${channelId}/read`, { message_id: latest.id }); } catch { /* ok */ }
}

function refreshChannelState(channelId, patch) {
  const c = channel(channelId);
  if (!c) return;
  Object.assign(c, patch);
  renderSidebar(actions);
  renderRail(actions);
}

// Per-workspace rail badges: one fetch per inactive workspace after login.
async function fetchRailBadges() {
  await Promise.all(state.workspaces.map(async (ws) => {
    if (ws.id === state.workspaceId) return;
    try {
      const { channels } = await api('GET', `/channels?workspace_id=${ws.id}`);
      let unreads = 0, mentions = 0;
      for (const c of channels) {
        if (c.is_member && !c.muted) {
          unreads += c.unread_count || 0;
          mentions += c.mention_count || 0;
        }
      }
      state.railBadges.set(ws.id, { unreads, mentions });
    } catch { /* workspace may be gone */ }
  }));
  renderRail(actions);
}

// ---- websocket -----------------------------------------------------------------

let typingTimer = null;
let wsHadOpened = false;

function wireWs() {
  onWs('open', async () => {
    $('#conn-dot')?.classList.remove('off');
    // Skip the initial connect; resync only after a *re*connect (bug fix #4).
    if (!wsHadOpened) { wsHadOpened = true; return; }
    await resyncAfterReconnect();
  });
  onWs('close', () => $('#conn-dot')?.classList.add('off'));

  onWs('message.new', async ({ message: m, workspace_id: wsId }) => {
    // Event for another (inactive) workspace: bump its cached rail badge.
    // Mirrors server unread semantics: top-level messages from others only.
    if (wsId && wsId !== state.workspaceId) {
      if (m.user?.id !== state.user.id && !m.thread_id) {
        const b = state.railBadges.get(wsId) || { unreads: 0, mentions: 0 };
        b.unreads += 1;
        if ((m.mentions || []).includes(state.user.id)) b.mentions += 1;
        state.railBadges.set(wsId, b);
        renderRail(actions);
      }
      return;
    }
    const c = channel(m.channel_id);
    const mine = m.user?.id === state.user.id;

    if (!m.thread_id) {
      if (m.channel_id === state.activeChannelId) {
        upsertMessage(m);
        appendMessageDom(m);
        if (document.hasFocus()) await markRead(m.channel_id);
        else if (!mine) bumpUnread(c, m); // bug fix #7: unfocused active channel counts
      } else if (c && !mine) { // bug fix #2: WS messages carry m.user.id, not m.user_id
        bumpUnread(c, m);
      }
      if (!mine) maybeNotify(m, c);
    }

    // thread bookkeeping (single source of reply_count bumps — bug fix #8)
    if (m.thread_id) {
      const list = state.messages.get(m.channel_id) || [];
      const parent = list.find(x => x.id === m.thread_id);
      if (parent) {
        parent.reply_count = (parent.reply_count || 0) + 1;
        if (m.channel_id === state.activeChannelId) updateMessageDom(parent.id, m.channel_id, true);
      }
      if (state.thread && state.thread.parent.id === m.thread_id) {
        if (!state.thread.messages.some(x => x.id === m.id)) {
          state.thread.messages.push(m);
          refreshThreadDom();
        }
      }
    }
    updateTitleBadge();
  });

  onWs('message.updated', ({ message: m }) => {
    upsertMessage(m);
    updateMessageDom(m.id, m.channel_id);
    if (state.thread) {
      if (state.thread.parent.id === m.id) state.thread.parent = m;
      const i = state.thread.messages.findIndex(x => x.id === m.id);
      if (i >= 0) state.thread.messages[i] = m;
      refreshThreadDom();
    }
  });

  onWs('message.deleted', ({ id, channel_id, thread_id }) => {
    removeMessage(id, channel_id);
    removeMessageDom(id);

    const t = state.thread;
    if (t && t.parent.id === id) {
      // The open thread's parent was deleted — the whole thread is gone.
      state.thread = null;
      renderThread();
      return;
    }

    // Reply deletion: known from the payload's thread_id, or because the
    // reply is in the open thread's list. Keep reply_count in sync in both
    // the thread panel and the cached parent in the channel list.
    let parentId = thread_id || null;
    if (t) {
      const i = t.messages.findIndex(m => m.id === id);
      if (i >= 0) {
        t.messages.splice(i, 1);
        t.parent.reply_count = Math.max(0, (t.parent.reply_count || 0) - 1);
        parentId = parentId || t.parent.id;
        refreshThreadDom();
      }
    }
    if (parentId) {
      const parent = (state.messages.get(channel_id) || []).find(x => x.id === parentId);
      if (parent) {
        parent.reply_count = Math.max(0, (parent.reply_count || 0) - 1);
        updateMessageDom(parent.id, channel_id, true);
      }
    }
  });

  onWs('message.ephemeral', ({ channel_id, text }) => {
    const list = state.ephemeral.get(channel_id) || [];
    list.push({ id: ++ephSeq, text, at: Date.now() });
    while (list.length > 20) list.shift(); // cap ephemeral list at 20 (bug fix #10)
    state.ephemeral.set(channel_id, list);
    if (channel_id === state.activeChannelId) {
      renderMessages();
      toast('Received an ephemeral app response');
    }
  });

  onWs('typing', ({ channel_id, user_id, display_name }) => {
    if (!state.typing.has(channel_id)) state.typing.set(channel_id, new Map());
    state.typing.get(channel_id).set(user_id, { name: display_name, until: Date.now() + 3500 });
    renderTypingLine();
    if (!typingTimer) typingTimer = setInterval(pruneTyping, 1000);
  });

  onWs('presence', ({ user_id, online, away }) => {
    const u = userById(user_id);
    // Presence doesn't federate — never mark a remote (shadow) user online.
    const effective = online && !u?.is_remote;
    if (effective) state.presence.add(user_id); else state.presence.delete(user_id);
    if (u) {
      u.online = effective;
      if (away !== undefined) u.away = away;
    }
    renderSidebar(actions);
  });

  onWs('channel.created', ({ channel: raw }) => {
    // Federation mirror payloads may omit viewer fields — never render
    // undefineds; dm_key is a server-internal key, never exposed to views.
    const { dm_key, ...c } = raw;
    c.is_member = c.is_member ?? false;
    c.member_count = c.member_count ?? 1;
    c.unread_count = c.unread_count ?? 0;
    if (!channel(c.id) && c.workspace_id === state.workspaceId) {
      state.channels.push(c);
      renderSidebar(actions);
    }
  });

  onWs('channel.updated', ({ channel: c }) => {
    const existing = channel(c.id);
    if (existing) Object.assign(existing, c);
    if (c.id === state.activeChannelId) renderChatShell();
    renderSidebar(actions);
  });

  onWs('user.updated', ({ user }) => {
    const i = state.users.findIndex(u => u.id === user.id);
    if (i >= 0) state.users[i] = { ...state.users[i], ...user };
    else state.users.push(user);
    if (user.id === state.user?.id) state.user = { ...state.user, ...user };
    renderSidebar(actions);
  });

  onWs('workspace.member_joined', ({ user }) => {
    if (!userById(user.id)) {
      // bug fix #12: online comes from presence, not unconditionally true
      state.users.push({ ...user, online: state.presence.has(user.id) });
      renderSidebar(actions);
    }
  });
}

let ephSeq = 0;

function pruneTyping() {
  const nowMs = Date.now();
  let any = false;
  for (const m of state.typing.values()) {
    for (const [uid, t] of m) {
      if (t.until <= nowMs) m.delete(uid);
      else any = true;
    }
  }
  renderTypingLine();
  // bug fix #11: stop the repaint interval once no typers remain
  if (!any && typingTimer) { clearInterval(typingTimer); typingTimer = null; }
}

// Reconnect resync: refetch channels and the active channel's tail, paging
// forward until the server says there is no more (cap 10 pages defensively).
async function resyncAfterReconnect() {
  if (!state.workspaceId) return;
  try {
    const { channels } = await api('GET', `/channels?workspace_id=${state.workspaceId}`);
    state.channels = channels;
    renderSidebar(actions);
    renderRail(actions);
    if (state.activeChannelId) {
      const msgs = state.messages.get(state.activeChannelId) || [];
      let after = msgs[msgs.length - 1]?.id || null;
      if (!after) {
        const { messages: tail } = await api('GET', `/channels/${state.activeChannelId}/messages?limit=50`);
        for (const m of tail) {
          if (msgs.some(x => x.id === m.id)) continue;
          msgs.push(m);
          appendMessageDom(m);
        }
        after = msgs[msgs.length - 1]?.id || null;
      }
      // One `after=` page may be a partial window (e.g. long downtime); loop.
      for (let page = 0; after && page < 10; page++) {
        const { messages: tail, has_more: hasMore } = await api(
          'GET', `/channels/${state.activeChannelId}/messages?after=${after}&limit=100`
        );
        if (!tail.length) break;
        for (const m of tail) {
          if (msgs.some(x => x.id === m.id)) continue;
          msgs.push(m);
          appendMessageDom(m);
        }
        after = tail[tail.length - 1].id;
        // Older servers omit has_more — fall back to "a full page means maybe more".
        const maybeMore = hasMore === true || (hasMore == null && tail.length === 100);
        if (!maybeMore) break;
      }
      msgs.sort((a, b) => a.id - b.id);
      if (msgs.length && document.hasFocus()) await markRead(state.activeChannelId);
    }
    updateTitleBadge();
  } catch { /* server hiccup — next reconnect retries */ }
}

function bumpUnread(c, m) {
  if (!c || c.muted) return;
  const mentioned = (m.mentions || []).includes(state.user.id);
  refreshChannelState(c.id, {
    unread_count: (c.unread_count || 0) + 1,
    mention_count: (c.mention_count || 0) + (mentioned ? 1 : 0),
  });
}

// Browser + desktop notifications: mentions and DMs only, respecting mute and focus.
function maybeNotify(m, c) {
  if (!c || c.muted) return;
  const mentioned = (m.mentions || []).includes(state.user.id);
  if (!mentioned && !c.is_dm) return;
  if (document.hasFocus() && m.channel_id === state.activeChannelId) return;
  const author = m.user?.display_name || m.user?.username || 'New message';
  const title = c.is_dm ? author : `${author} in #${c.name}`;
  const body = (m.text || '').slice(0, 140) || '📎 Attachment';
  window.atriumDesktop?.notify(title, body);
  if (!('Notification' in window)) return;
  const show = () => {
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag: `atrium-${c.id}` });
    n.onclick = () => {
      window.focus();
      actions.openChannel(m.channel_id);
    };
  };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission === 'default') {
    Notification.requestPermission().then(show).catch(() => {});
  }
}

// ---- actions ---------------------------------------------------------------------

let lastTypingSent = 0;
let searchGen = 0;
const actions = {
  // navigation
  async switchWorkspace(id) { await loadWorkspace(id); },
  async openChannel(id) { await openChannel(id); },
  openWorkspaceModal,
  openWorkspaceMenu,
  openProfileMenu,
  openChannelBrowser,
  openDmPicker,
  openChannelMenu,
  openChannelRowMenu,
  openSaved: () => openSavedModal(),
  openAppsManager: (opts) => openAppsModal(opts),
  appsChanged(apps) {
    state.apps = apps || [];
    renderSidebar(actions);
  },
  openQuickSwitcher,
  async showActivity(anchor) { await showActivityPopover(anchor); },
  async showFiles() { await openFilesPanel(); },
  async setAway(away) {
    try {
      const { user } = await api('PATCH', '/users/me', { away });
      state.user = user;
      const i = state.users.findIndex(u => u.id === user.id);
      if (i >= 0) state.users[i] = { ...state.users[i], ...user };
      renderSidebar(actions);
      toast(away ? 'You are set to away' : 'You are back');
    } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
  },

  async workspaceAdded(ws) {
    state.workspaces.push(ws);
    await loadWorkspace(ws.id);
  },
  async refreshWorkspace() { await loadWorkspace(state.workspaceId); toast('Refreshed'); },

  async createChannel({ name, topic, is_private }) {
    const { channel: c } = await api('POST', '/channels', {
      workspace_id: state.workspaceId, name, topic, is_private,
    });
    if (!channel(c.id)) state.channels.push(c);
    await openChannel(c.id);
  },
  async joinChannel(id) {
    const { channel: c } = await api('POST', `/channels/${id}/join`);
    const existing = channel(id);
    if (existing) Object.assign(existing, c);
    renderSidebar(actions);
  },
  async openDm(userIds) {
    let c;
    try {
      ({ channel: c } = await api('POST', '/channels/dm', {
        workspace_id: state.workspaceId, user_ids: userIds,
      }));
    } catch (ex) {
      if (ex.message === 'use_external_dm') {
        toast('That user is on another server — open their profile and choose “Message externally”.');
        return;
      }
      throw ex;
    }
    const existing = channel(c.id);
    if (existing) Object.assign(existing, c);
    else state.channels.push(c);
    await openChannel(c.id);
  },
  async openDmExternal(connectionId, remoteUsername) {
    const { channel: c } = await api('POST', '/federation/dm', {
      connection_id: connectionId, remote_username: remoteUsername,
    });
    const existing = channel(c.id);
    if (existing) Object.assign(existing, c);
    else state.channels.push(c);
    await openChannel(c.id);
  },

  // messages
  async sendMessage(text, files) {
    const attachments = (files || []).map(f => ({ url: f.url, name: f.name, size: f.size, mimetype: f.mimetype }));
    const res = await api('POST', `/channels/${state.activeChannelId}/messages`, {
      text, attachments,
    });
    if (res.message) {
      upsertMessage(res.message);
      appendMessageDom(res.message);
      await markRead(state.activeChannelId);
    } else if (res.command) {
      // Slash command handled by an app — the server returns {ok, command}.
      toast(`/${res.command} sent`);
    }
  },
  async sendThreadReply(text) {
    const t = state.thread;
    if (!t) return;
    const { message } = await api('POST', `/channels/${t.channelId}/messages`, {
      text, thread_id: t.parent.id,
    });
    // The WS message.new echo may have landed first — insert only once.
    if (state.thread && state.thread.parent.id === t.parent.id
        && !state.thread.messages.some(x => x.id === message.id)) {
      state.thread.messages.push(message);
      refreshThreadDom();
    }
    // No local reply_count bump: the message.new WS echo is the single source.
  },
  async editMessage(id, text) {
    if (!text) return;
    await api('PATCH', `/messages/${id}`, { text });
  },
  async deleteMessage(id) {
    await api('DELETE', `/messages/${id}`);
  },
  async react(id, emoji) {
    await api('POST', `/messages/${id}/reactions`, { emoji });
  },
  async togglePin(id) {
    await api('POST', `/messages/${id}/pin`);
    refreshPinsCount();
  },
  async toggleSave(m) {
    const was = state.saved.has(m.id);
    const entry = { ...m, channel_name: m.channel_name ?? channel(m.channel_id)?.name };
    if (was) state.saved.delete(m.id);
    else state.saved.set(m.id, entry);
    updateMessageDom(m.id, m.channel_id);
    if (state.thread) refreshThreadDom();
    renderSidebar(actions);
    try {
      if (was) await api('DELETE', `/users/me/saved/${m.id}`);
      else await api('POST', '/users/me/saved', { message_id: m.id });
    } catch (ex) {
      if (was) state.saved.set(m.id, entry);
      else state.saved.delete(m.id);
      updateMessageDom(m.id, m.channel_id);
      if (state.thread) refreshThreadDom();
      renderSidebar(actions);
      toast(ex.message.replace(/_/g, ' '));
    }
  },
  dismissEphemeral(channelId, id) {
    const list = state.ephemeral.get(channelId) || [];
    state.ephemeral.set(channelId, list.filter(e => e.id !== id));
    if (channelId === state.activeChannelId) renderMessages();
  },
  async loadOlder() {
    const c = channel();
    const msgs = state.messages.get(c.id) || [];
    const oldest = msgs[0];
    if (!oldest) return;
    await loadMessages(c.id, oldest.id);
    renderMessages();
  },
  sendTyping: () => {
    const nowMs = Date.now();
    if (state.activeChannelId && nowMs - lastTypingSent > 1500) {
      lastTypingSent = nowMs;
      sendWs({ type: 'typing', channel_id: state.activeChannelId });
    }
  },

  async attachFiles(files) {
    try {
      return await uploadFiles(files);
    } catch (ex) {
      toast(`Upload failed: ${ex.message}`);
      return [];
    }
  },
  async uploadAvatar(file) {
    const [f] = await uploadFiles([file]);
    return f?.url || '';
  },
  async uploadEmoji(name, file) {
    const [f] = await uploadFiles([file]);
    if (!f?.url) throw new Error('upload_failed');
    await api('POST', `/workspaces/${state.workspaceId}/emoji`, { name, url: f.url });
    state.emojiMap.set(name, f.url);
  },

  // thread
  async openThread(parentMsg) {
    const { parent, messages } = await api('GET', `/messages/${parentMsg.id}/thread`);
    state.thread = { parent, messages, channelId: parent.channel_id };
    renderThread();
  },
  closeThread() {
    state.thread = null;
    renderThread();
  },

  // header extras
  async showMembers(anchor) {
    const { members } = await api('GET', `/channels/${state.activeChannelId}/members`);
    showMembersPopover(anchor, members);
  },
  async showPins(anchor) {
    const { pins } = await api('GET', `/channels/${state.activeChannelId}/pins`);
    showPinsPopover(anchor, pins);
  },
  async getPinsCount() {
    if (!state.activeChannelId) return 0;
    try {
      const { pins } = await api('GET', `/channels/${state.activeChannelId}/pins`);
      return pins.length;
    } catch { return 0; }
  },
  async doSearch(q) {
    // Monotonic generation: stale responses (slower than the next keystroke's
    // request) are dropped instead of clobbering newer results.
    const gen = ++searchGen;
    const query = q.trim();
    if (!query) return renderSearchResults('', []);
    try {
      const { results } = await api('GET', `/search?workspace_id=${state.workspaceId}&q=${encodeURIComponent(query)}`);
      if (gen !== searchGen) return;
      renderSearchResults(query, results);
    } catch (ex) {
      if (gen === searchGen) toast(`Search failed: ${ex.message.replace(/_/g, ' ')}`);
    }
  },
  async jumpToMessage(channelId, messageId, threadId = null) {
    const si = $('#search-input');
    if (si) si.value = '';
    closeModal();
    if (threadId) {
      // Thread reply hit: open the thread panel on the parent instead.
      await openChannel(channelId);
      try {
        const { parent, messages } = await api('GET', `/messages/${threadId}/thread`);
        state.thread = { parent, messages, channelId };
        renderThread();
        const node = $(`#thread-panel .msg[data-mid="${messageId}"]`);
        if (node) {
          node.scrollIntoView({ block: 'center' });
          node.classList.add('flash');
        }
      } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
      return;
    }
    await openChannel(channelId, { aroundId: messageId });
  },

  // channels
  async toggleStar(id) {
    try {
      const { starred } = await api('POST', `/channels/${id}/star`);
      const c = channel(id);
      if (!c) return;
      c.starred = starred;
      renderSidebar(actions);
      if (id === state.activeChannelId) {
        const btn = $('#star-btn');
        if (btn) {
          btn.innerHTML = icon(starred ? 'star-fill' : 'star');
          btn.classList.toggle('on', starred);
          btn.title = starred ? 'Remove from Starred' : 'Add to Starred';
          btn.setAttribute('aria-label', btn.title);
        }
      }
    } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
  },
  async toggleMute(id) {
    try {
      const { muted } = await api('POST', `/channels/${id}/mute`);
      const c = channel(id);
      if (!c) return;
      c.muted = muted;
      renderSidebar(actions);
      updateTitleBadge();
      toast(muted ? 'Muted' : 'Unmuted');
    } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
  },
  async renameChannel(id, name) {
    if (!name) return;
    const { channel: c } = await api('PATCH', `/channels/${id}`, { name });
    Object.assign(channel(id) || {}, c);
    renderSidebar(actions);
    if (id === state.activeChannelId) renderChatShell();
    toast('Channel renamed');
  },
  async editTopic(id, topic) {
    const { channel: c } = await api('PATCH', `/channels/${id}`, { topic });
    Object.assign(channel(id) || {}, c);
    renderSidebar(actions);
    if (id === state.activeChannelId) renderChatShell();
    toast('Topic updated');
  },
  async setArchived(id, archived) {
    await api('PATCH', `/channels/${id}`, { is_archived: archived });
    toast(archived ? 'Channel archived' : 'Channel unarchived');
    if (!archived) return;
    state.channels = state.channels.filter(c => c.id !== id);
    state.messages.delete(id);
    if (id === state.activeChannelId) {
      state.activeChannelId = null;
      const first = state.channels.find(c => !c.is_dm && c.is_member) || state.channels[0];
      if (first) await openChannel(first.id);
      else renderChatShell();
    }
    renderSidebar(actions);
  },
  async addMembers(id, userIds) {
    for (const uid of userIds) {
      await api('POST', `/channels/${id}/members`, { user_id: uid });
    }
    const c = channel(id);
    if (c) c.member_count = (c.member_count || 0) + userIds.length;
    state.channelMembers.delete(id);
    renderChatShell();
    toast(`Added ${userIds.length} ${userIds.length === 1 ? 'person' : 'people'}`);
  },
  async leaveChannel(id) {
    await api('POST', `/channels/${id}/leave`);
    const c = channel(id);
    if (c) {
      c.is_member = false;
      c.unread_count = 0;
      c.mention_count = 0;
    }
    state.channelMembers.delete(id);
    if (id === state.activeChannelId) {
      const first = state.channels.find(x => !x.is_dm && x.is_member && x.id !== id) || state.channels[0];
      if (first && first.id !== id) await openChannel(first.id);
    }
    renderSidebar(actions);
    toast('Left channel');
  },
  async getChannelMembers(id) {
    if (!state.channelMembers.has(id)) {
      state.channelMembers.set(id, new Set()); // reserve to avoid duplicate fetches
      try {
        const { members } = await api('GET', `/channels/${id}/members`);
        state.channelMembers.set(id, new Set(members.map(m => m.id)));
      } catch { /* leave empty */ }
    }
    return state.channelMembers.get(id);
  },

  // profile
  showProfile(anchor, userId) {
    const u = userById(userId);
    if (u) return showProfileCard(anchor, u);
    for (const list of state.messages.values()) {
      const m = list.find(x => x.user.id === userId);
      if (m) return showProfileCard(anchor, m.user);
    }
  },
  async saveProfile(patch) {
    const { user } = await api('PATCH', '/users/me', patch);
    state.user = user;
    const i = state.users.findIndex(u => u.id === user.id);
    if (i >= 0) state.users[i] = { ...state.users[i], ...user };
    renderSidebar(actions);
    toast('Profile saved');
  },
  async logout() {
    try { await api('POST', '/auth/logout'); } catch { /* token may be dead */ }
    setSignedInFlag(false);
    disconnectWs();
    setToken(null);
    location.reload();
  },
};

// Cmd+K / Ctrl+K — quick switcher, from anywhere once signed in.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!state.user || !state.workspaceId) return;
    closePopover();
    openQuickSwitcher();
  }
});

// mark read when the window regains focus
window.addEventListener('focus', () => {
  if (state.activeChannelId) {
    markRead(state.activeChannelId);
    refreshChannelState(state.activeChannelId, { unread_count: 0, mention_count: 0 });
    updateTitleBadge();
  }
});

boot();
