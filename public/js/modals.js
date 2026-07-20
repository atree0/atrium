// Concrete dialogs: auth, workspaces, channel browser, DM picker, profile,
// invites, saved messages, federation, channel management, custom emoji,
// and the app manager (webhooks, slash commands, event subscriptions).
import { state, channel, channelTitle, isOnline, presenceClass, userById } from './state.js';
import { $, $$, el, escapeHtml, avatarHtml, toast, fmtTime, fmtDay, fmtBytes, timeAgo } from './util.js';
import { openModal, closeModal, openPopover, closePopover, confirmDialog, openEmojiPicker, openLightbox } from './ui.js';
import { api } from './api.js';
import { icon } from './icons.js';

let actions = null;
export function initModals(a) { actions = a; }

const isAdmin = () => ['owner', 'admin'].includes(state.myRole);

// ---- auth view --------------------------------------------------------------

export function renderAuth(onSuccess, { setup = false } = {}) {
  const app = $('#app');
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card glass-deep">
        <div class="auth-logo"><img class="logo-mark" src="/logo.svg" alt="" /><h1>Atrium</h1></div>
        <p class="auth-sub">${setup
          ? 'Welcome. Create the first account to set up your Atrium server.'
          : 'Team chat, refined. Self-hosted, open source, extensible.'}</p>
        <div class="auth-tabs">
          <button class="${setup ? '' : 'active'}" data-tab="login">Sign in</button>
          <button class="${setup ? 'active' : ''}" data-tab="register">Create account</button>
        </div>
        <form id="auth-form">
          <div class="field" id="f-username">
            <label>Username</label>
            <input name="username" autocomplete="username" placeholder="ada" required />
          </div>
          <div class="field" id="f-email" style="display:none">
            <label>Email (optional)</label>
            <input name="email" type="email" placeholder="ada@example.com" />
          </div>
          <div class="field" id="f-display" style="display:none">
            <label>Display name (optional)</label>
            <input name="display_name" placeholder="Ada Lovelace" />
          </div>
          <div class="field">
            <label>Password</label>
            <input name="password" type="password" autocomplete="current-password" placeholder="••••••••" required />
          </div>
          <button class="btn-primary" type="submit" id="auth-submit">${setup ? 'Set up Atrium' : 'Sign in'}</button>
          <p class="form-error" id="auth-error"></p>
        </form>
      </div>
    </div>
  `;
  let mode = setup ? 'register' : 'login';
  $('#f-email').style.display = setup ? '' : 'none';
  $('#f-display').style.display = setup ? '' : 'none';
  $$('.auth-tabs button', app).forEach(btn => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.tab;
      $$('.auth-tabs button', app).forEach(b => b.classList.toggle('active', b === btn));
      $('#f-email').style.display = mode === 'register' ? '' : 'none';
      $('#f-display').style.display = mode === 'register' ? '' : 'none';
      $('#auth-submit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
    });
  });
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const err = $('#auth-error');
    err.textContent = '';
    try {
      const payload = Object.fromEntries(form.entries());
      const data = await api('POST', `/auth/${mode}`, payload);
      onSuccess(data);
    } catch (ex) {
      err.textContent = ex.message.replace(/_/g, ' ');
    }
  });
}

// ---- onboarding (signed in, zero workspaces) ----------------------------------

export function renderOnboarding(actions) {
  const app = $('#app');
  const name = escapeHtml(state.user.display_name || state.user.username);
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="onboard glass-deep">
        <div class="auth-logo"><img class="logo-mark" src="/logo.svg" alt="" /><h1>Atrium</h1></div>
        <p class="auth-sub">Welcome, ${name}. Get your team in here — start a new workspace, or join an existing one with an invite code.</p>
        <div class="onboard-cards">
          <button class="onboard-card" id="ob-create">
            <span class="ob-glyph">${icon('sparkle')}</span>
            <span class="ob-title">Create a workspace</span>
            <span class="ob-sub">A home for your team — channels, DMs, apps, federation.</span>
            <span class="ob-cta">Get started →</span>
          </button>
          <div class="onboard-card">
            <span class="ob-glyph">${icon('link')}</span>
            <span class="ob-title">Join a workspace</span>
            <span class="ob-sub">Have an invite code from your team? Enter it here.</span>
            <div class="ob-join-row">
              <input id="ob-code" placeholder="Invite code" autocomplete="off" />
              <button class="btn-primary" style="width:auto;padding:9px 18px" id="ob-join">Join</button>
            </div>
            <p class="form-error" id="ob-error"></p>
          </div>
        </div>
        <div class="ob-foot">Signed in as <b>${name}</b> · <a href="#" id="ob-logout">Sign out</a></div>
      </div>
    </div>
  `;
  $('#ob-create').addEventListener('click', openWorkspaceModal);
  const join = async () => {
    const code = $('#ob-code').value.trim();
    if (!code) return;
    $('#ob-error').textContent = '';
    try {
      const { workspace } = await api('POST', '/workspaces/join', { code });
      toast(`Joined ${workspace.name}`);
      await actions.workspaceAdded(workspace);
    } catch (ex) {
      $('#ob-error').textContent = ex.message.replace(/_/g, ' ');
    }
  };
  $('#ob-join').addEventListener('click', join);
  $('#ob-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('#ob-logout').addEventListener('click', (e) => { e.preventDefault(); actions.logout(); });
}

// ---- workspace create / join ---------------------------------------------------

export function openWorkspaceModal() {
  const modal = openModal(`
    <h2>Add a workspace</h2>
    <p class="modal-sub">Create a new workspace, or join one with an invite code.</p>
    <div class="auth-tabs" style="margin-bottom:16px">
      <button class="active" data-tab="create">Create</button>
      <button data-tab="join">Join</button>
    </div>
    <div id="tab-create">
      <div class="field"><label>Workspace name</label><input id="ws-name" placeholder="Acme Inc." maxlength="80" /></div>
      <button class="btn-primary" id="ws-create-btn">Create workspace</button>
    </div>
    <div id="tab-join" style="display:none">
      <div class="field"><label>Invite code</label><input id="ws-invite" placeholder="e.g. 9f2b…" /></div>
      <button class="btn-primary" id="ws-join-btn">Join workspace</button>
    </div>
    <p class="form-error" id="ws-error"></p>
  `);
  $$('.auth-tabs button', modal).forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.auth-tabs button', modal).forEach(b => b.classList.toggle('active', b === btn));
      $('#tab-create', modal).style.display = btn.dataset.tab === 'create' ? '' : 'none';
      $('#tab-join', modal).style.display = btn.dataset.tab === 'join' ? '' : 'none';
    });
  });
  $('#ws-create-btn', modal).addEventListener('click', async () => {
    try {
      const name = $('#ws-name', modal).value.trim();
      if (!name) return;
      const { workspace } = await api('POST', '/workspaces', { name });
      closeModal();
      await actions.workspaceAdded(workspace);
    } catch (ex) { $('#ws-error', modal).textContent = ex.message; }
  });
  $('#ws-join-btn', modal).addEventListener('click', async () => {
    try {
      const code = $('#ws-invite', modal).value.trim();
      if (!code) return;
      const { workspace } = await api('POST', '/workspaces/join', { code });
      closeModal();
      await actions.workspaceAdded(workspace);
      toast(`Joined ${workspace.name}`);
    } catch (ex) { $('#ws-error', modal).textContent = ex.message.replace(/_/g, ' '); }
  });
}

// ---- workspace menu / invite -----------------------------------------------------

export function openWorkspaceMenu(anchor) {
  const pop = openPopover(anchor, `
    <button class="popover-item" data-act="invite">${icon('mail')} Invite people</button>
    <button class="popover-item" data-act="emoji">${icon('emoji-face')} Add emoji</button>
    <button class="popover-item" data-act="federation">${icon('globe')} Connect workspace…</button>
    <button class="popover-item" data-act="apps">${icon('apps')} Apps & integrations</button>
    <div class="popover-sep"></div>
    <button class="popover-item" data-act="refresh">${icon('refresh')} Refresh</button>
  `);
  pop.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closePopover();
    if (act === 'invite') openInviteModal();
    if (act === 'emoji') openEmojiModal();
    if (act === 'federation') openFederationModal();
    if (act === 'apps') openAppsModal();
    if (act === 'refresh') actions.refreshWorkspace();
  });
}

export function openInviteModal() {
  const isAdmin = ['owner', 'admin'].includes(state.myRole);
  const modal = openModal(`
    <h2>Invite people</h2>
    <p class="modal-sub">Share an invite link — anyone with it can join this workspace.</p>
    <div class="auth-tabs" style="margin-bottom:14px">
      <button class="active" data-preset="infinite">Infinite use</button>
      <button data-preset="once">One-time use</button>
      <button data-preset="custom">Custom</button>
    </div>
    <div id="inv-custom" style="display:none">
      <div class="field"><label>Expires in (hours, 0 = never)</label><input id="inv-exp" type="number" value="0" min="0" /></div>
      <div class="field"><label>Max uses (0 = unlimited)</label><input id="inv-uses" type="number" value="0" min="0" /></div>
    </div>
    <button class="btn-primary" id="inv-make">Create invite link</button>
    <div id="inv-result" style="display:none;margin-top:14px">
      <div class="secret-row"><code id="inv-link"></code><button class="copy-btn" id="inv-copy">Copy</button></div>
    </div>
    <div id="inv-admin" style="display:none">
      <div class="popover-sep" style="margin:16px 0"></div>
      <div class="popover-head">Active invite links</div>
      <div class="modal-list" id="inv-list" style="max-height:180px;overflow-y:auto"></div>
      <div class="popover-sep" style="margin:16px 0"></div>
      <div class="popover-head">Allowed email domains</div>
      <p class="modal-sub" style="margin-bottom:8px">Anyone who signs up with an email at these domains joins this workspace automatically. Comma-separated, e.g. <code>acme.com, acme.io</code>.</p>
      <div style="display:flex;gap:8px">
        <input id="inv-domains" placeholder="acme.com" style="flex:1;padding:8px 10px;border-radius:7px;background:var(--bg-0);border:1px solid var(--border);outline:none;font-size:13px;color:var(--text-1)" />
        <button class="btn-secondary" id="inv-domains-save">Save</button>
      </div>
      <p class="form-error" id="inv-domains-err"></p>
    </div>
  `, { width: 520 });

  // Presets: infinite (max_uses 0, no expiry), once (max_uses 1), custom.
  let preset = 'infinite';
  $$('.auth-tabs button', modal).forEach(btn => {
    btn.addEventListener('click', () => {
      preset = btn.dataset.preset;
      $$('.auth-tabs button', modal).forEach(b => b.classList.toggle('active', b === btn));
      $('#inv-custom', modal).style.display = preset === 'custom' ? '' : 'none';
    });
  });

  const refreshList = async () => {
    if (!isAdmin) return;
    const { invites } = await api('GET', `/workspaces/${state.workspaceId}/invites`);
    $('#inv-admin', modal).style.display = '';
    const list = $('#inv-list', modal);
    list.innerHTML = invites.length ? invites.map(i => `
      <div class="secret-row">
        <span style="width:78px;color:var(--text-3)">${i.max_uses === 0 ? 'infinite' : `${i.uses}/${i.max_uses} used`}</span>
        <code>${escapeHtml(location.origin + i.url)}</code>
        <button class="copy-btn" data-copy="${escapeHtml(location.origin + i.url)}">Copy</button>
        <button class="copy-btn" data-revoke="${escapeHtml(i.code)}" style="color:var(--danger)">Revoke</button>
      </div>
    `).join('') : '<p class="modal-sub" style="margin:0">No active invites.</p>';
  };

  $('#inv-make', modal).addEventListener('click', async () => {
    const body = preset === 'once'
      ? { max_uses: 1 }
      : preset === 'custom'
        ? {
          expires_in_hours: Number($('#inv-exp', modal).value) || 0,
          max_uses: Number($('#inv-uses', modal).value) || 0,
        }
        : {};
    const { invite } = await api('POST', `/workspaces/${state.workspaceId}/invites`, body);
    const link = `${location.origin}${invite.url}`;
    $('#inv-result', modal).style.display = '';
    $('#inv-link', modal).textContent = link;
    $('#inv-copy', modal).onclick = () => { navigator.clipboard.writeText(link); toast('Invite link copied'); };
    refreshList();
  });

  if (isAdmin) {
    const current = state.workspaces.find(w => w.id === state.workspaceId);
    $('#inv-domains', modal).value = (current?.allowed_domains || '').split(',').filter(Boolean).join(', ');
    $('#inv-domains-save', modal).addEventListener('click', async () => {
      $('#inv-domains-err', modal).textContent = '';
      try {
        const { workspace } = await api('PATCH', `/workspaces/${state.workspaceId}`, {
          allowed_domains: $('#inv-domains', modal).value,
        });
        Object.assign(current, workspace);
        toast('Allowed domains saved');
      } catch (ex) {
        $('#inv-domains-err', modal).textContent = ex.message.replace(/_/g, ' ');
      }
    });
    refreshList();
  }

  modal.addEventListener('click', async (e) => {
    const copyVal = e.target.closest('[data-copy]')?.dataset.copy;
    if (copyVal) { navigator.clipboard.writeText(copyVal); toast('Copied'); return; }
    const code = e.target.closest('[data-revoke]')?.dataset.revoke;
    if (code) {
      await api('DELETE', `/workspaces/${state.workspaceId}/invites/${code}`);
      toast('Invite revoked');
      refreshList();
    }
  });
}

// ---- custom emoji ----------------------------------------------------------------

export function openEmojiModal() {
  const modal = openModal(`
    <h2>Add workspace emoji</h2>
    <p class="modal-sub">Upload an image; everyone can use it via <code>:name:</code>.</p>
    <div class="field"><label>Emoji name</label><input id="em-name" placeholder="party_parrot" maxlength="32" /></div>
    <div class="field"><label>Image</label><input type="file" id="em-file" accept="image/*" /></div>
    <p class="form-error" id="em-error"></p>
    <div class="modal-actions">
      <button class="btn-secondary" id="em-cancel">Cancel</button>
      <button class="btn-primary" style="width:auto;padding:9px 20px" id="em-save">Add emoji</button>
    </div>
  `);
  $('#em-cancel', modal).addEventListener('click', closeModal);
  $('#em-save', modal).addEventListener('click', async () => {
    const err = $('#em-error', modal);
    err.textContent = '';
    const name = $('#em-name', modal).value.trim().toLowerCase();
    const file = $('#em-file', modal).files[0];
    if (!/^[a-z0-9_+-]{2,32}$/.test(name)) { err.textContent = 'Name: 2–32 chars of a-z 0-9 _ + -'; return; }
    if (!file) { err.textContent = 'Pick an image first.'; return; }
    try {
      await actions.uploadEmoji(name, file);
      closeModal();
      toast(`:${name}: added`);
    } catch (ex) { err.textContent = ex.message.replace(/_/g, ' '); }
  });
}

// ---- profile ---------------------------------------------------------------------

export function openProfileMenu(anchor) {
  const me = state.user;
  const status = `${me.status_emoji || ''} ${me.status_text || ''}`.trim();
  const pop = openPopover(anchor, `
    <div class="popover-head">${escapeHtml(me.display_name || me.username)} · ${me.away ? 'Away' : 'Active'}</div>
    <button class="popover-item" data-act="status">${icon('emoji-face')} ${status ? `Update status` : 'Set a status'}</button>
    <button class="popover-item" data-act="away">${icon(me.away ? 'dot' : 'moon')} Set yourself ${me.away ? 'active' : 'away'}</button>
    <div class="popover-sep"></div>
    <button class="popover-item" data-act="profile">${icon('user')} Edit profile</button>
    <div class="popover-sep"></div>
    <button class="popover-item danger" data-act="logout">${icon('logout')} Sign out</button>
  `, { place: 'top' });
  pop.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closePopover();
    if (act === 'status') openStatusModal();
    if (act === 'away') actions.setAway(!me.away);
    if (act === 'profile') openProfileModal();
    if (act === 'logout') actions.logout();
  });
}

// ---- status ----------------------------------------------------------------------

const STATUS_PRESETS = [
  ['📅', 'In a meeting'], ['🌴', 'Vacationing'], ['🤒', 'Out sick'],
  ['🏠', 'Working remotely'], ['🎧', 'Heads down'],
];

export function openStatusModal() {
  const u = state.user;
  const modal = openModal(`
    <h2>Set a status</h2>
    <p class="modal-sub">Shows next to your name everywhere until you clear it.</p>
    <div class="status-row">
      <button class="status-emoji-btn" id="st-emoji" aria-label="Pick a status emoji">${u.status_emoji ? escapeHtml(u.status_emoji) : icon('emoji-face')}</button>
      <input id="st-text" placeholder="What's happening?" maxlength="120" value="${escapeHtml(u.status_text || '')}" />
    </div>
    <div class="status-presets">
      ${STATUS_PRESETS.map(([e, t], i) => `<button class="status-preset" data-preset="${i}">${e} ${escapeHtml(t)}</button>`).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" id="st-clear">Clear status</button>
      <button class="btn-primary" style="width:auto;padding:9px 20px" id="st-save">Save</button>
    </div>
  `);
  let emoji = u.status_emoji || '';
  $('#st-emoji', modal).addEventListener('click', (e) => {
    openEmojiPicker(e.currentTarget, (picked) => {
      emoji = picked;
      $('#st-emoji', modal).textContent = picked;
      $('#st-text', modal).focus();
    });
  });
  $$('.status-preset', modal).forEach(btn => {
    btn.addEventListener('click', () => {
      const [e, t] = STATUS_PRESETS[Number(btn.dataset.preset)];
      emoji = e;
      $('#st-emoji', modal).textContent = e;
      $('#st-text', modal).value = t;
    });
  });
  $('#st-save', modal).addEventListener('click', async () => {
    await actions.saveProfile({ status_emoji: emoji, status_text: $('#st-text', modal).value.trim() });
    closeModal();
  });
  $('#st-clear', modal).addEventListener('click', async () => {
    await actions.saveProfile({ status_emoji: '', status_text: '' });
    closeModal();
  });
}

export function openProfileModal() {
  const u = state.user;
  const modal = openModal(`
    <h2>Your profile</h2>
    <p class="modal-sub">How you appear across workspaces.</p>
    <div class="field"><label>Display name</label><input id="p-name" value="${escapeHtml(u.display_name || '')}" maxlength="80" /></div>
    <div class="field"><label>Status</label><input id="p-status" value="${escapeHtml(u.status_text || '')}" maxlength="120" placeholder="🌴 On vacation" /></div>
    <div class="field"><label>Avatar</label>
      <div style="display:flex;align-items:center;gap:10px">
        <span id="p-avatar-preview">${avatarHtml(u, 'lg')}</span>
        <input type="file" id="p-avatar" accept="image/*" />
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" id="p-cancel">Cancel</button>
      <button class="btn-primary" style="width:auto;padding:9px 20px" id="p-save">Save</button>
    </div>
  `);
  let avatarUrl = u.avatar_url || '';
  $('#p-avatar', modal).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    avatarUrl = await actions.uploadAvatar(file);
    $('#p-avatar-preview', modal).innerHTML = `<div class="avatar lg"><img src="${escapeHtml(avatarUrl)}"></div>`;
  });
  $('#p-cancel', modal).addEventListener('click', closeModal);
  $('#p-save', modal).addEventListener('click', async () => {
    await actions.saveProfile({
      display_name: $('#p-name', modal).value.trim(),
      status_text: $('#p-status', modal).value.trim(),
      avatar_url: avatarUrl,
    });
    closeModal();
  });
}

// ---- profile card popover -----------------------------------------------------------

export function showProfileCard(anchor, user) {
  if (!user) return;
  // Presence doesn't federate — remote users always render as offline.
  const known = userById(user.id) || user;
  const pcls = presenceClass(known);
  const presenceLabel = pcls === 'on' ? 'Active' : pcls === 'away' ? 'Away' : 'Offline';
  let remoteHost = null;
  if (user.is_remote && user.remote_url) {
    try { remoteHost = new URL(user.remote_url).host; } catch { remoteHost = user.remote_url; }
  }
  const status = `${known.status_emoji || ''} ${known.status_text || ''}`.trim();
  const dmBtn = user.is_remote
    ? '<button class="btn-primary" style="margin-top:10px" id="pc-dm-ext">Message externally</button>'
    : '<button class="btn-primary" style="margin-top:10px" id="pc-dm">Message</button>';
  const pop = openPopover(anchor, `
    <div class="profile-card">
      ${avatarHtml(user, 'xl')}
      <div class="pc-name">${escapeHtml(user.display_name || user.username)}${user.is_bot ? ' <span class="pill">APP</span>' : ''}</div>
      <div class="pc-user">@${escapeHtml(user.username)}</div>
      ${status ? `<div class="pc-status">${escapeHtml(status)}</div>` : ''}
      ${remoteHost ? `<div class="pc-remote" title="Home server">${icon('globe')} ${escapeHtml(remoteHost)}</div>` : ''}
      <div class="pc-online"><span class="presence-dot ${pcls}"></span> ${presenceLabel}</div>
      ${user.id !== state.user.id && !user.is_bot ? dmBtn : ''}
    </div>
  `);
  $('#pc-dm', pop)?.addEventListener('click', () => {
    closePopover();
    actions.openDm([user.id]);
  });
  $('#pc-dm-ext', pop)?.addEventListener('click', async () => {
    closePopover();
    try {
      const { connections } = await api('GET', `/federation/connections?workspace_id=${state.workspaceId}`);
      const conn = (connections || []).find(cn => {
        if (cn.status !== 'active') return false;
        try { return new URL(cn.remote_url).host === remoteHost; } catch { return cn.remote_url === user.remote_url; }
      });
      if (!conn) {
        toast(`No active connection to ${remoteHost || 'that server'} — an admin can add one via “Connect workspace…”.`);
        return;
      }
      // Remote usernames look like `name@host`; the federation DM endpoint
      // wants just the remote-local part.
      await actions.openDmExternal(conn.id, user.username.split('@')[0]);
    } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
  });
}

// ---- channel browser -----------------------------------------------------------------

export async function openChannelBrowser() {
  const modal = openModal(`
    <h2>Channels</h2>
    <p class="modal-sub">Join an existing channel or create a new one.</p>
    <div class="modal-list" id="ch-list"><div class="loading-line">Loading…</div></div>
    <div class="popover-sep"></div>
    <div class="field"><label>New channel name</label><input id="ch-name" placeholder="e.g. design-crit" maxlength="80" /></div>
    <div class="field"><label>Topic (optional)</label><input id="ch-topic" maxlength="250" /></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--text-2)">
      <input type="checkbox" id="ch-private" style="width:auto" /> Private channel
    </label>
    <div class="modal-actions">
      <button class="btn-secondary" id="ch-close">Close</button>
      <button class="btn-primary" style="width:auto;padding:9px 20px" id="ch-create">Create channel</button>
    </div>
  `, { width: 520 });
  $('#ch-close', modal).addEventListener('click', closeModal);
  $('#ch-create', modal).addEventListener('click', async () => {
    const name = $('#ch-name', modal).value.trim();
    if (!name) return;
    try {
      await actions.createChannel({
        name, topic: $('#ch-topic', modal).value.trim(),
        is_private: $('#ch-private', modal).checked,
      });
      closeModal();
    } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
  });
  await refreshChannelList(modal);
}

async function refreshChannelList(modal) {
  const list = $('#ch-list', modal);
  if (!list) return;
  // Sharing is possible whenever at least one connection is active — even for
  // a channel still flagged is_shared whose connection was deleted (re-share).
  let hasActiveConnection = false;
  try {
    const { connections } = await api('GET', `/federation/connections?workspace_id=${state.workspaceId}`);
    hasActiveConnection = (connections || []).some(cn => cn.status === 'active');
  } catch { /* federation unavailable */ }
  const channels = state.channels.filter(c => !c.is_dm);
  list.innerHTML = channels.map(c => `
    <div class="app-card" style="display:flex;align-items:center;gap:10px;padding:9px 13px">
      <span style="opacity:.7;display:flex">${c.is_private ? icon('lock') : icon('hash')}</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:650;font-size:13px">${escapeHtml(c.name)}${c.is_shared ? ` <span class="share-badge" title="Shared with another workspace">${icon('globe')}</span>` : ''}</div>
        ${c.topic ? `<div style="font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.topic)}</div>` : ''}
      </div>
      <span style="font-size:11px;color:var(--text-3)">${c.member_count} members</span>
      ${isAdmin() && hasActiveConnection ? `<button class="btn-secondary" style="padding:5px 12px;font-size:11.5px" data-share="${c.id}">Share…</button>` : ''}
      ${c.is_member
        ? '<span class="pill">joined</span>'
        : `<button class="btn-secondary" style="padding:5px 12px;font-size:11.5px" data-join="${c.id}" ${c.is_private ? 'disabled title="Private"' : ''}>Join</button>`}
    </div>
  `).join('');
  $$('[data-join]', list).forEach(btn => {
    btn.addEventListener('click', async () => {
      await actions.joinChannel(Number(btn.dataset.join));
      await refreshChannelList(modal);
    });
  });
  $$('[data-share]', list).forEach(btn => {
    btn.addEventListener('click', () => openSharePopover(btn, Number(btn.dataset.share), modal));
  });
}

async function openSharePopover(anchor, channelId, modal) {
  let connections = [];
  try {
    ({ connections } = await api('GET', `/federation/connections?workspace_id=${state.workspaceId}`));
  } catch { /* federation unavailable */ }
  const pop = openPopover(anchor, connections.length
    ? `<div class="popover-head">Share channel to…</div>` + connections.map(cn => `
        <button class="popover-item" data-conn="${cn.id}">
          ${icon('globe')} ${escapeHtml(cn.remote_workspace_name || cn.remote_url)}
          <span style="color:var(--text-3);font-size:11px">${escapeHtml(cn.status || '')}</span>
        </button>`).join('')
    : '<div class="popover-item" style="cursor:default;color:var(--text-3)">No active connections.<br>Use “Connect workspace…” first.</div>');
  pop.addEventListener('click', async (e) => {
    const id = Number(e.target.closest('[data-conn]')?.dataset.conn);
    if (!id) return;
    closePopover();
    try {
      await api('POST', '/federation/share', { connection_id: id, channel_id: channelId });
      const c = state.channels.find(x => x.id === channelId);
      if (c) c.is_shared = true;
      toast('Channel shared');
      if (modal) await refreshChannelList(modal);
    } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
  });
}

// ---- DM picker -------------------------------------------------------------------------

export function openDmPicker() {
  // Shadow (remote) users are excluded: ordinary DMs to them are rejected
  // server-side — use their profile card's "Message externally" instead.
  const others = state.users.filter(u => u.id !== state.user.id && !u.is_bot && !u.is_remote);
  const modal = openModal(`
    <h2>Direct message</h2>
    <p class="modal-sub">Pick one person, or several for a group DM.</p>
    <div class="modal-list" style="max-height:320px;overflow-y:auto">
      ${others.map(u => `
        <label class="app-card" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer">
          <input type="checkbox" value="${u.id}" style="width:auto" />
          ${avatarHtml(u, 'sm')}
          <span style="font-size:13px;font-weight:600">${escapeHtml(u.display_name || u.username)}</span>
          <span style="font-size:11px;color:var(--text-3)">@${escapeHtml(u.username)}</span>
        </label>
      `).join('') || '<p class="modal-sub">No other members yet — invite people first.</p>'}
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" id="dm-cancel">Cancel</button>
      <button class="btn-primary" style="width:auto;padding:9px 20px" id="dm-open">Open</button>
    </div>
    <div id="dm-ext" style="display:none;width:100%">
      <div class="popover-sep"></div>
      <div class="popover-head" style="padding-left:0">External user (federated)</div>
      <div style="display:flex;gap:6px">
        <input id="dm-ext-name" placeholder="username" style="flex:1" />
        <select id="dm-ext-conn" style="flex:1"></select>
        <button class="btn-secondary" id="dm-ext-open">Open</button>
      </div>
      <p class="form-error" id="dm-ext-error"></p>
    </div>
  `);
  $('#dm-cancel', modal).addEventListener('click', closeModal);
  $('#dm-open', modal).addEventListener('click', async () => {
    const ids = $$('input[type=checkbox]:checked', modal).map(i => Number(i.value));
    if (!ids.length) return;
    closeModal();
    await actions.openDm(ids);
  });

  // External (federated) DM: hidden entirely when federation isn't available.
  (async () => {
    let connections = [];
    try {
      ({ connections } = await api('GET', `/federation/connections?workspace_id=${state.workspaceId}`));
    } catch { return; }
    connections = (connections || []).filter(cn => cn.status === 'active');
    if (!connections.length) return;
    $('#dm-ext', modal).style.display = '';
    $('#dm-ext-conn', modal).innerHTML = connections.map(cn =>
      `<option value="${cn.id}">${escapeHtml(cn.remote_workspace_name || cn.remote_url)}</option>`).join('');
    $('#dm-ext-open', modal).addEventListener('click', async () => {
      const username = $('#dm-ext-name', modal).value.trim().replace(/^@/, '');
      if (!username) return;
      try {
        closeModal();
        await actions.openDmExternal(Number($('#dm-ext-conn', modal).value), username);
      } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
    });
  })();
}

// ---- saved messages ----------------------------------------------------------------------

export function openSavedModal() {
  const modal = openModal(`
    <h2>Saved messages</h2>
    <p class="modal-sub">Only you can see these.</p>
    <div class="modal-list" id="saved-list"></div>
  `, { width: 540 });
  renderSavedList(modal);
}

function renderSavedList(modal) {
  const list = $('#saved-list', modal);
  if (!list) return;
  const saved = [...state.saved.values()].sort((a, b) => b.id - a.id);
  if (!saved.length) {
    list.innerHTML = `<p class="modal-sub">Nothing saved yet. Hover a message and choose the ${icon('bookmark')} bookmark.</p>`;
    return;
  }
  list.innerHTML = '';
  for (const m of saved) {
    const card = el(`
      <div class="app-card saved-card">
        ${avatarHtml(m.user, 'sm')}
        <div class="sc-body">
          <div class="sc-meta">${escapeHtml(m.user?.display_name || m.user?.username || '')} · ${m.channel_name ? '#' + escapeHtml(m.channel_name) : 'DM'} · ${fmtDay(m.created_at)} ${fmtTime(m.created_at)}</div>
          <div class="sc-text">${escapeHtml((m.text || '📎 Attachment').slice(0, 220))}</div>
        </div>
        <div class="sc-actions">
          <button class="copy-btn" data-x="jump">Jump</button>
          <button class="copy-btn" data-x="remove" style="color:#ff6961">Remove</button>
        </div>
      </div>`);
    card.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'jump') {
        closeModal();
        actions.jumpToMessage(m.channel_id, m.id, m.thread_id || null);
      }
      if (x === 'remove') {
        await actions.toggleSave(m);
        renderSavedList(modal);
      }
    });
    list.appendChild(card);
  }
}

// ---- federation ----------------------------------------------------------------------------

export function openFederationModal() {
  const modal = openModal(`
    <h2>Connect workspace</h2>
    <p class="modal-sub">Link with a workspace on another Atrium server to share channels and DM external users.</p>
    <div class="auth-tabs" style="margin-bottom:16px">
      <button class="active" data-tab="create">Create invite</button>
      <button data-tab="redeem">Redeem invite</button>
    </div>
    <div id="fed-create">
      <p class="modal-sub" style="margin-bottom:10px">Generate a code and share it with an admin on the other server.</p>
      <button class="btn-primary" id="fed-gen">Generate invite code</button>
      <div id="fed-code-row" style="display:none;margin-top:12px">
        <div class="secret-row"><code id="fed-code"></code><button class="copy-btn" id="fed-copy">Copy</button></div>
      </div>
    </div>
    <div id="fed-redeem" style="display:none">
      <div class="field"><label>Remote server URL</label><input id="fed-url" placeholder="https://atrium.example.com" /></div>
      <div class="field"><label>Invite code</label><input id="fed-inv" placeholder="Code from the other server" /></div>
      <button class="btn-primary" id="fed-connect">Connect</button>
    </div>
    <p class="form-error" id="fed-error"></p>
    <div class="popover-sep"></div>
    <div class="popover-head" style="padding-left:0">Active connections</div>
    <div class="modal-list" id="fed-list"></div>
  `, { width: 520 });

  $$('.auth-tabs button', modal).forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.auth-tabs button', modal).forEach(b => b.classList.toggle('active', b === btn));
      $('#fed-create', modal).style.display = btn.dataset.tab === 'create' ? '' : 'none';
      $('#fed-redeem', modal).style.display = btn.dataset.tab === 'redeem' ? '' : 'none';
    });
  });

  const err = (msg) => { $('#fed-error', modal).textContent = msg; };
  $('#fed-gen', modal).addEventListener('click', async () => {
    err('');
    try {
      const { code } = await api('POST', '/federation/invites', { workspace_id: state.workspaceId });
      $('#fed-code-row', modal).style.display = '';
      $('#fed-code', modal).textContent = code;
      $('#fed-copy', modal).addEventListener('click', () => {
        navigator.clipboard.writeText(code);
        toast('Invite code copied');
      });
    } catch (ex) { err(ex.message.replace(/_/g, ' ')); }
  });
  $('#fed-connect', modal).addEventListener('click', async () => {
    err('');
    const remote_url = $('#fed-url', modal).value.trim();
    const code = $('#fed-inv', modal).value.trim();
    if (!remote_url || !code) { err('Both fields are required.'); return; }
    try {
      await api('POST', '/federation/connect', { code, remote_url, workspace_id: state.workspaceId });
      toast('Workspace connected');
      await refreshConnections(modal);
    } catch (ex) { err(ex.message.replace(/_/g, ' ')); }
  });
  refreshConnections(modal);
}

async function refreshConnections(modal) {
  const list = $('#fed-list', modal);
  if (!list) return;
  let connections = [];
  try {
    ({ connections } = await api('GET', `/federation/connections?workspace_id=${state.workspaceId}`));
  } catch {
    list.innerHTML = '<p class="modal-sub">Federation is not available on this server.</p>';
    return;
  }
  list.innerHTML = connections.length ? connections.map(cn => `
    <div class="app-card" style="display:flex;align-items:center;gap:10px;padding:9px 13px">
      <span style="display:flex;color:var(--text-2)">${icon('globe')}</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:650;font-size:13px">${escapeHtml(cn.remote_workspace_name || 'Remote workspace')}</div>
        <div style="font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cn.remote_url)}</div>
      </div>
      <span class="pill">${escapeHtml(cn.status || 'unknown')}</span>
    </div>
  `).join('') : '<p class="modal-sub">No connections yet.</p>';
}

// ---- channel management ----------------------------------------------------------------------

export function openChannelRowMenu(anchor, channelId) {
  const c = channel(channelId);
  if (!c) return;
  const pop = openPopover(anchor, `
    <button class="popover-item" data-act="star">${c.starred ? `${icon('star-fill')} Remove from Starred` : `${icon('star')} Star`}</button>
    <button class="popover-item" data-act="mute">${c.muted ? `${icon('bell')} Unmute` : `${icon('bell-off')} Mute`}</button>
  `);
  pop.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closePopover();
    if (act === 'star') actions.toggleStar(c.id);
    if (act === 'mute') actions.toggleMute(c.id);
  });
}

export function openChannelMenu(anchor) {
  const c = channel();
  if (!c || c.is_dm) {
    // DMs only get mute/star via the sidebar row menu.
    return;
  }
  const canRename = isAdmin() || c.created_by === state.user.id;
  const pop = openPopover(anchor, `
    ${canRename ? `<button class="popover-item" data-act="rename">${icon('edit')} Rename channel</button>` : ''}
    <button class="popover-item" data-act="topic">${icon('message')} Edit topic</button>
    ${c.is_private ? `<button class="popover-item" data-act="add">${icon('users')} Add people</button>` : ''}
    ${isAdmin() ? `<button class="popover-item" data-act="archive">${icon('archive')} ${c.is_archived ? 'Unarchive channel' : 'Archive channel'}</button>` : ''}
    <div class="popover-sep"></div>
    <button class="popover-item danger" data-act="leave">${icon('leave')} Leave channel</button>
  `, { align: 'right' });
  pop.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closePopover();
    if (act === 'rename') openTextPrompt('Rename channel', 'Channel name', c.name, (v) => actions.renameChannel(c.id, v));
    if (act === 'topic') openTextPrompt('Edit topic', 'Topic', c.topic || '', (v) => actions.editTopic(c.id, v));
    if (act === 'add') openAddPeopleModal(c);
    if (act === 'archive') actions.setArchived(c.id, !c.is_archived);
    if (act === 'leave') {
      confirmDialog(`Leave #${c.name}?`, 'You will no longer see messages or get notifications.')
        .then(ok => ok && actions.leaveChannel(c.id));
    }
  });
}

function openTextPrompt(title, label, initial, onSubmit) {
  const modal = openModal(`
    <h2>${escapeHtml(title)}</h2>
    <div class="field"><label>${escapeHtml(label)}</label><input id="tp-val" value="${escapeHtml(initial)}" maxlength="250" /></div>
    <p class="form-error" id="tp-error"></p>
    <div class="modal-actions">
      <button class="btn-secondary" id="tp-cancel">Cancel</button>
      <button class="btn-primary" style="width:auto;padding:9px 20px" id="tp-save">Save</button>
    </div>
  `);
  $('#tp-cancel', modal).addEventListener('click', closeModal);
  $('#tp-save', modal).addEventListener('click', async () => {
    try {
      await onSubmit($('#tp-val', modal).value.trim());
      closeModal();
    } catch (ex) { $('#tp-error', modal).textContent = ex.message.replace(/_/g, ' '); }
  });
}

async function openAddPeopleModal(c) {
  const modal = openModal(`
    <h2>Add people to #${escapeHtml(c.name)}</h2>
    <p class="modal-sub">Select workspace members (including bot apps) to add.</p>
    <div class="modal-list" id="ap-list" style="max-height:320px;overflow-y:auto"><div class="loading-line">Loading…</div></div>
    <p class="form-error" id="ap-error"></p>
    <div class="modal-actions">
      <button class="btn-secondary" id="ap-cancel">Cancel</button>
      <button class="btn-primary" style="width:auto;padding:9px 20px" id="ap-add">Add</button>
    </div>
  `);
  $('#ap-cancel', modal).addEventListener('click', closeModal);
  let memberIds = new Set();
  try {
    const { members } = await api('GET', `/channels/${c.id}/members`);
    memberIds = new Set(members.map(m => m.id));
  } catch { /* fall back to empty */ }
  const candidates = state.users.filter(u => !memberIds.has(u.id));
  const list = $('#ap-list', modal);
  list.innerHTML = candidates.length ? candidates.map(u => `
    <label class="app-card" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer">
      <input type="checkbox" value="${u.id}" style="width:auto" />
      ${avatarHtml(u, 'sm')}
      <span style="font-size:13px;font-weight:600">${escapeHtml(u.display_name || u.username)}</span>
      <span style="font-size:11px;color:var(--text-3)">@${escapeHtml(u.username)}</span>
      ${u.is_bot ? '<span class="pill">APP</span>' : ''}
    </label>
  `).join('') : '<p class="modal-sub">Everyone is already here.</p>';
  $('#ap-add', modal).addEventListener('click', async () => {
    const ids = $$('input[type=checkbox]:checked', list).map(i => Number(i.value));
    if (!ids.length) return;
    try {
      await actions.addMembers(c.id, ids);
      closeModal();
    } catch (ex) { $('#ap-error', modal).textContent = ex.message.replace(/_/g, ' '); }
  });
}

// ---- members & pins popovers --------------------------------------------------------------

// Rich member directory for the open channel: searchable, with presence,
// roles, and (for non-DM channels) an "Add people" shortcut.
export function showMembersPopover(anchor, members) {
  const c = channel();
  const canAdd = c && !c.is_dm;
  const pop = openPopover(anchor, `
    <div class="members-pop">
      <div class="mp-head">${icon('users')} Members <span class="n">${members.length}</span></div>
      <div class="members-search"><input id="mp-search" placeholder="Find members" aria-label="Find members" /></div>
      <div class="members-list" id="mp-list"></div>
      ${canAdd ? `<button class="mp-add" id="mp-add">${icon('plus')} Add people</button>` : ''}
    </div>
  `, { align: 'right' });

  const roleLabel = (m) => m.is_bot ? 'app' : (m.role === 'owner' || m.role === 'admin' ? m.role : '');
  const paint = (q = '') => {
    const list = $('#mp-list', pop);
    if (!list) return;
    const hits = members.filter(m => !q
      || m.username.toLowerCase().includes(q)
      || (m.display_name || '').toLowerCase().includes(q));
    list.innerHTML = hits.map(m => `
      <button class="member-row" data-u="${m.id}">
        <span class="member-av">${avatarHtml(m, 'sm')}<span class="presence-dot ${presenceClass(m)}"></span></span>
        <span style="min-width:0;flex:1">
          <span class="m-name">${escapeHtml(m.display_name || m.username)}${m.status_emoji ? ` ${escapeHtml(m.status_emoji)}` : ''}</span><br>
          <span class="m-user">@${escapeHtml(m.username)}${m.away ? ' · Away' : ''}</span>
        </span>
        ${roleLabel(m) ? `<span class="m-role">${roleLabel(m)}</span>` : ''}
      </button>
    `).join('') || '<div class="act-empty" style="padding:14px">No matches.</div>';
    $$('.member-row', list).forEach(row => {
      row.addEventListener('click', () => {
        const u = members.find(m => m.id === Number(row.dataset.u));
        showProfileCard(row, userById(u.id) || u);
      });
    });
  };
  paint();
  const search = $('#mp-search', pop);
  search?.addEventListener('input', () => paint(search.value.trim().toLowerCase()));
  $('#mp-add', pop)?.addEventListener('click', () => {
    closePopover();
    openAddPeopleModal(c);
  });
}

export function showPinsPopover(anchor, pins) {
  const pop = openPopover(anchor, `
    <div class="popover-head">${icon('pin')} Pinned messages</div>
    ${pins.length ? pins.map(p => `
      <button class="popover-item" style="align-items:flex-start" data-pin="${p.id}" data-ch="${p.channel_id}">
        ${avatarHtml(p.user, 'sm')}
        <div style="min-width:0;text-align:left">
          <div style="font-size:11px;color:var(--text-3)">${escapeHtml(p.user.display_name || p.user.username)} · ${fmtDay(p.created_at)}</div>
          <div style="font-size:12.5px;white-space:pre-wrap;word-break:break-word">${escapeHtml(p.text.slice(0, 200))}</div>
        </div>
      </button>
    `).join('') : '<div class="popover-item" style="cursor:default;color:var(--text-3)">Nothing pinned yet. Hover a message and choose the pin.</div>'}
  `, { align: 'right' });
  pop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pin]');
    if (!btn) return;
    closePopover();
    actions.jumpToMessage(Number(btn.dataset.ch), Number(btn.dataset.pin));
  });
}

// ---- files panel ----------------------------------------------------------------------------

export async function openFilesPanel() {
  const c = channel();
  if (!c) return;
  const title = c.is_dm ? escapeHtml(channelTitle(c)) : '#' + escapeHtml(c.name);
  const modal = openModal(`
    <h2>Files</h2>
    <p class="modal-sub">Everything shared in ${title}.</p>
    <div id="files-body"><div class="loading-line">Loading…</div></div>
  `, { width: 640 });
  let files = [];
  try {
    ({ files } = await api('GET', `/channels/${c.id}/files`));
  } catch (ex) {
    const body = $('#files-body', modal);
    if (body) body.innerHTML = `<p class="form-error">Couldn’t load files: ${escapeHtml(ex.message.replace(/_/g, ' '))}</p>`;
    return;
  }
  const body = $('#files-body', modal);
  if (!body) return; // modal was closed while loading
  if (!files.length) {
    body.innerHTML = `
      <div class="act-empty" style="padding:34px 16px">
        ${icon('file')}
        <div>No files yet.<br>Drag a file into the conversation or use the ${icon('attachment')} button to share one.</div>
      </div>`;
    return;
  }
  const isImg = (f) => (f.mimetype || '').startsWith('image/') && (f.url || '').startsWith('/uploads/');
  const imgs = files.filter(isImg);
  const docs = files.filter(f => !isImg(f));
  const meta = (f) => `${fmtBytes(f.size || 0)} · ${escapeHtml(f.uploader?.display_name || f.uploader?.username || '')} · ${fmtDay(f.created_at)}`;
  body.innerHTML = `
    ${imgs.length ? `
      <div class="popover-head" style="padding-left:0">Images · ${imgs.length}</div>
      <div class="files-grid">
        ${imgs.map((f, i) => `
          <button class="file-tile" data-img="${i}" title="${escapeHtml(f.name)} — ${meta(f)}" aria-label="Open ${escapeHtml(f.name)}">
            <img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.name)}" loading="lazy" />
            <span class="ft-name">${escapeHtml(f.name)}</span>
          </button>`).join('')}
      </div>` : ''}
    ${docs.length ? `
      <div class="popover-head" style="padding-left:0">Documents · ${docs.length}</div>
      <div class="file-rows">
        ${docs.map(f => `
          <a class="file-row" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">
            <span class="fr-ico">${icon((f.mimetype || '').startsWith('image/') ? 'image' : 'file')}</span>
            <span class="fr-main">
              <span class="fr-name">${escapeHtml(f.name)}</span>
              <span class="fr-meta">${meta(f)}</span>
            </span>
            <span class="fr-dl" title="Download" aria-hidden="true">${icon('download')}</span>
          </a>`).join('')}
      </div>` : ''}
  `;
  $$('.file-tile', body).forEach(tile => {
    tile.addEventListener('click', () => {
      const f = imgs[Number(tile.dataset.img)];
      if (f) openLightbox(f.url, f.name);
    });
  });
}

// ---- activity (mentions) --------------------------------------------------------------------

export async function showActivityPopover(anchor) {
  const pop = openPopover(anchor, `
    <div class="activity-pop">
      <div class="ap-head">${icon('bell')} Activity</div>
      <div class="activity-list" id="act-list"><div class="loading-line">Loading…</div></div>
    </div>
  `);
  let mentions = [];
  try {
    ({ mentions } = await api('GET', `/users/me/mentions?workspace_id=${state.workspaceId}&limit=20`));
  } catch { /* render empty below */ }
  const list = $('#act-list', pop);
  if (!list) return; // popover closed while loading
  if (!mentions.length) {
    list.innerHTML = `
      <div class="act-empty">
        ${icon('bell-off')}
        <div>You're all caught up.<br>When someone @mentions you, it lands here.</div>
      </div>`;
    return;
  }
  list.innerHTML = mentions.map((m, i) => `
    <button class="act-item" data-i="${i}">
      ${avatarHtml(m.user, 'sm')}
      <span class="ai-body">
        <span class="ai-meta"><b>${escapeHtml(m.user?.display_name || m.user?.username || '')}</b>
          ${m.channel_is_dm ? 'in a DM' : `in #${escapeHtml(m.channel_name || '')}`} · ${timeAgo(m.created_at)}</span>
        <span class="ai-text">${escapeHtml((m.text || '📎 Attachment').slice(0, 180))}</span>
      </span>
    </button>
  `).join('');
  $$('.act-item', list).forEach(btn => {
    btn.addEventListener('click', () => {
      const m = mentions[Number(btn.dataset.i)];
      closePopover();
      actions.jumpToMessage(m.channel_id, m.id, m.thread_id || null);
    });
  });
}

// ---- quick switcher (Cmd+K) -----------------------------------------------------------------

// Simple fuzzy scorer: prefix > substring > in-order subsequence.
function fuzzyScore(text, q) {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1 + idx / 100;
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti < 0) return Infinity;
    ti++;
  }
  return 3;
}

export function openQuickSwitcher() {
  const root = $('#modal-root');
  closeModal();
  closePopover();

  const entries = [];
  for (const c of state.channels.filter(x => !x.is_dm && !x.is_archived)) {
    entries.push({
      key: c.name, ico: c.is_private ? 'lock' : 'hash', label: c.name,
      sub: c.is_member ? 'Channel' : 'Channel · not joined',
      go: () => actions.openChannel(c.id),
    });
  }
  const dmUserIds = new Set();
  for (const c of state.channels.filter(x => x.is_dm)) {
    for (const u of c.dm_users || []) dmUserIds.add(u.id);
    entries.push({
      key: channelTitle(c), ico: 'message', label: channelTitle(c), sub: 'Direct message',
      go: () => actions.openChannel(c.id),
    });
  }
  for (const u of state.users) {
    if (u.id === state.user.id || u.is_remote || dmUserIds.has(u.id)) continue;
    entries.push({
      key: `${u.display_name || ''} ${u.username}`, ico: 'user',
      label: u.display_name || u.username, sub: `@${u.username}${u.is_bot ? ' · APP' : ''}`,
      go: () => actions.openDm([u.id]),
    });
  }

  const backdrop = el(`
    <div class="modal-backdrop cmdk-backdrop">
      <div class="cmdk" role="dialog" aria-modal="true" aria-label="Quick switcher">
        <div class="cmdk-head">
          ${icon('search')}
          <input class="cmdk-input" id="cmdk-input" placeholder="Jump to a channel, DM, or person…"
            aria-label="Jump to a channel, DM, or person" autocomplete="off" spellcheck="false" />
        </div>
        <div class="cmdk-list" id="cmdk-list" role="listbox"></div>
        <div class="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> dismiss</span>
        </div>
      </div>
    </div>`);
  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  backdrop._cleanup = () => document.removeEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  root.appendChild(backdrop);

  const input = $('#cmdk-input', backdrop);
  const list = $('#cmdk-list', backdrop);
  let hits = [];
  let sel = 0;

  const paint = () => {
    if (!hits.length) {
      list.innerHTML = '<div class="cmdk-empty">No matches. Try a channel or person’s name.</div>';
      return;
    }
    list.innerHTML = hits.map((h, i) => `
      <button class="cmdk-item ${i === sel ? 'sel' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}">
        <span class="ck-ico">${icon(h.ico)}</span>
        <span class="ck-label">${escapeHtml(h.label)}</span>
        <span class="ck-sub">${escapeHtml(h.sub)}</span>
      </button>
    `).join('');
    list.querySelector('.cmdk-item.sel')?.scrollIntoView({ block: 'nearest' });
    $$('.cmdk-item', list).forEach(btn => {
      btn.addEventListener('click', () => pick(Number(btn.dataset.i)));
      btn.addEventListener('mousemove', () => {
        if (sel !== Number(btn.dataset.i)) { sel = Number(btn.dataset.i); paint(); }
      });
    });
  };

  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    hits = !q
      ? entries.slice(0, 12)
      : entries
        .map(e => ({ e, s: fuzzyScore(e.key, q) }))
        .filter(x => x.s !== Infinity)
        .sort((a, b) => a.s - b.s || a.e.label.localeCompare(b.e.label))
        .slice(0, 12)
        .map(x => x.e);
    sel = 0;
    paint();
  };

  const pick = (i) => {
    const h = hits[i];
    if (!h) return;
    closeModal();
    h.go();
  };

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(hits.length, 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + hits.length) % Math.max(hits.length, 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  });
  refresh();
  requestAnimationFrame(() => input.focus());
}

// ---- apps manager ---------------------------------------------------------------------------

export async function openAppsModal({ create = false } = {}) {
  const modal = openModal(`
    <h2>Apps & integrations</h2>
    <p class="modal-sub">Bots, webhooks, slash commands and event subscriptions for this workspace. See <code>docs/APPS.md</code>.</p>
    <div class="modal-list" id="apps-list"><div class="loading-line">Loading…</div></div>
    <div class="popover-sep"></div>
    <div class="field"><label>New app name</label><input id="app-name" maxlength="80" placeholder="Deploybot" /></div>
    <div class="field"><label>Request URL (events & slash commands endpoint)</label><input id="app-url" placeholder="https://example.com/atrium/events" /></div>
    <button class="btn-primary" id="app-create">Create app</button>
    <p class="form-error" id="app-error"></p>
  `, { width: 560 });
  if (create) requestAnimationFrame(() => $('#app-name', modal)?.focus());
  $('#app-create', modal).addEventListener('click', async () => {
    try {
      const name = $('#app-name', modal).value.trim();
      if (!name) return;
      await api('POST', '/apps', {
        workspace_id: state.workspaceId, name,
        request_url: $('#app-url', modal).value.trim(),
      });
      $('#app-name', modal).value = '';
      await refreshAppsList(modal);
      toast('App created');
    } catch (ex) { $('#app-error', modal).textContent = ex.message.replace(/_/g, ' '); }
  });
  await refreshAppsList(modal);
}

async function refreshAppsList(modal) {
  const list = $('#apps-list', modal);
  if (!list) return;
  const { apps } = await api('GET', `/apps?workspace_id=${state.workspaceId}`);
  actions.appsChanged(apps); // keep the sidebar Apps section in sync
  if (!apps.length) {
    list.innerHTML = '<p class="modal-sub">No apps yet. Create one below to get a bot token.</p>';
    return;
  }
  list.innerHTML = '';
  for (const app of apps) {
    const card = el(`
      <div class="app-card">
        <div class="app-head">
          <span class="app-name">${escapeHtml(app.name)}</span>
          <span class="pill">@${escapeHtml(app.bot_username)}</span>
          <button class="copy-btn" data-x="expand">Manage</button>
          <button class="copy-btn" data-x="delete" style="color:#ff6961">Delete</button>
        </div>
        <div class="app-detail" style="display:none;margin-top:10px">
          ${app.bot_token ? `
            <div class="secret-row"><span style="width:92px;color:var(--text-3)">Bot token</span><code>${escapeHtml(app.bot_token)}</code><button class="copy-btn" data-copy="${escapeHtml(app.bot_token)}">Copy</button></div>
            <div class="secret-row"><span style="width:92px;color:var(--text-3)">Signing secret</span><code>${escapeHtml(app.signing_secret)}</code><button class="copy-btn" data-copy="${escapeHtml(app.signing_secret)}">Copy</button></div>
          ` : '<p class="modal-sub" style="margin:4px 0">Tokens hidden — only the creator and workspace admins can see them.</p>'}
          <div class="popover-sep"></div>
          <div style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Incoming webhook</div>
          <div style="display:flex;gap:6px">
            <select id="wh-channel-${app.id}" style="flex:1"></select>
            <button class="btn-secondary" data-x="add-webhook" style="font-size:11.5px">Add</button>
          </div>
          <div class="popover-sep"></div>
          <div style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Slash command</div>
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <input id="sc-name-${app.id}" placeholder="/deploy" style="width:110px" />
            <input id="sc-url-${app.id}" placeholder="https://…" style="flex:1" />
            <button class="btn-secondary" data-x="add-command" style="font-size:11.5px">Add</button>
          </div>
          <div class="popover-sep"></div>
          <div style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Event subscriptions</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px" id="subs-${app.id}"></div>
        </div>
      </div>
    `);

    // channel select
    const select = $(`#wh-channel-${app.id}`, card);
    select.innerHTML = state.channels.filter(c => !c.is_dm)
      .map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
    select.style.cssText = 'padding:6px 9px;border-radius:8px;background:rgba(0,0,0,.28);border:1px solid var(--hairline);font-size:12px';

    // event subscription pills — toggle: DELETE when active, POST when not.
    const EVENTS = ['message.channels', 'message.im', 'reaction.added', 'channel.created', 'app_mention'];
    const subsBox = $(`#subs-${app.id}`, card);
    const renderSubs = async () => {
      const { subscriptions } = await api('GET', `/apps/${app.id}/subscriptions`);
      subsBox.innerHTML = EVENTS.map(ev => {
        const on = subscriptions.includes(ev);
        return `<button class="copy-btn" data-sub="${ev}" style="${on ? 'background:var(--accent-soft);border-color:rgba(10,132,255,.5);color:#9ccbff' : ''}">${ev}</button>`;
      }).join('');
      $$('[data-sub]', subsBox).forEach(btn => {
        btn.addEventListener('click', async () => {
          const on = subscriptions.includes(btn.dataset.sub);
          if (on) await api('DELETE', `/apps/${app.id}/subscriptions/${encodeURIComponent(btn.dataset.sub)}`);
          else await api('POST', `/apps/${app.id}/subscriptions`, { event: btn.dataset.sub });
          await renderSubs();
        });
      });
    };

    card.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      const copyVal = e.target.closest('[data-copy]')?.dataset.copy;
      if (copyVal) { navigator.clipboard.writeText(copyVal); toast('Copied'); return; }
      if (x === 'expand') {
        const detail = $('.app-detail', card);
        const open = detail.style.display !== 'none';
        detail.style.display = open ? 'none' : '';
        if (!open) renderSubs();
      }
      if (x === 'delete') {
        if (await confirmDialog(`Delete ${app.name}?`, 'Its bot, tokens, webhooks and commands stop working immediately.')) {
          await api('DELETE', `/apps/${app.id}`);
          await refreshAppsList(modal);
        }
      }
      if (x === 'add-webhook') {
        const { webhook } = await api('POST', `/apps/${app.id}/webhooks`, { channel_id: Number(select.value) });
        toast('Webhook created');
        const row = el(`<div class="secret-row"><span style="width:92px;color:var(--text-3)">Webhook</span><code>${location.origin}${webhook.url}</code><button class="copy-btn" data-copy="${location.origin}${webhook.url}">Copy</button></div>`);
        select.closest('.app-detail').insertBefore(row, select.parentElement);
      }
      if (x === 'add-command') {
        const cmd = $(`#sc-name-${app.id}`, card).value.trim();
        const url = $(`#sc-url-${app.id}`, card).value.trim();
        try {
          await api('POST', `/apps/${app.id}/commands`, { command: cmd, url });
          toast(`/${cmd.replace(/^\//, '')} registered`);
        } catch (ex) { toast(ex.message.replace(/_/g, ' ')); }
      }
    });
    list.appendChild(card);
  }
}
