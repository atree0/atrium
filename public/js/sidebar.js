// Workspace rail + channel sidebar rendering.
import { state, workspace, channelTitle, isSelfDm, presenceClass, userById, totalUnread } from './state.js';
import { $, el, escapeHtml, avatarHtml, gradientFor, initials } from './util.js';
import { icon } from './icons.js';

// Total unread mentions across every workspace — powers the rail bell badge.
export function totalMentions() {
  let n = totalUnread().mentions;
  for (const [wsId, b] of state.railBadges) {
    if (wsId !== state.workspaceId) n += b.mentions || 0;
  }
  return n;
}

export function renderRail(actions) {
  const rail = $('#rail');
  if (!rail) return;
  rail.innerHTML = '';

  // Activity bell: recent mentions of me, across the workspace.
  const mentions = totalMentions();
  const bell = el(`
    <button class="rail-btn" id="rail-bell" title="Activity" aria-label="Activity — mentions of you">
      ${icon('bell')}${mentions ? `<span class="badge">${mentions > 99 ? '99+' : mentions}</span>` : ''}
    </button>
  `);
  bell.addEventListener('click', (e) => actions.showActivity(e.currentTarget));
  rail.appendChild(bell);
  rail.appendChild(el('<div class="rail-sep" aria-hidden="true"></div>'));

  for (const ws of state.workspaces) {
    const active = ws.id === state.workspaceId;
    // The active workspace's badge tracks live state; others use the snapshot
    // fetched after login (feature: per-workspace rail badges).
    const t = active ? totalUnread() : (state.railBadges.get(ws.id) || { unreads: 0, mentions: 0 });
    const n = t.mentions || t.unreads;
    const btn = el(`
      <button class="rail-item ${active ? 'active' : ''}" data-ws="${ws.id}" style="${gradientFor(ws.id)}"
        title="${escapeHtml(ws.name)}" aria-label="${escapeHtml(ws.name)} workspace">
        ${escapeHtml(initials(ws.name))}${n ? `<span class="badge ${t.mentions ? '' : 'dim'}">${n > 99 ? '99+' : n}</span>` : ''}
      </button>
    `);
    btn.addEventListener('click', () => actions.switchWorkspace(ws.id));
    rail.appendChild(btn);
  }
  const add = el(`<button class="rail-add" title="Create or join a workspace" aria-label="Create or join a workspace">${icon('plus')}</button>`);
  add.addEventListener('click', actions.openWorkspaceModal);
  rail.appendChild(add);
}

export function renderSidebarSkeleton() {
  const side = $('#sidebar');
  if (!side) return;
  side.innerHTML = `
    <div class="sidebar-head"><h2 class="skeleton" style="height:14px;width:120px"></h2></div>
    <div class="side-skel" aria-hidden="true">
      ${[90, 70, 110, 60, 95, 75, 55, 100].map(w => `<div class="skeleton" style="width:${w}%"></div>`).join('')}
    </div>
  `;
}

export function renderSidebar(actions) {
  const side = $('#sidebar');
  if (!side) return;
  const ws = workspace();
  if (!ws) { side.innerHTML = ''; return; }

  const starred = state.channels.filter(c => c.starred);
  const channels = state.channels.filter(c => !c.is_dm && !c.starred);
  const selfDm = state.channels.find(c => isSelfDm(c) && !c.starred);
  const dms = state.channels.filter(c => c.is_dm && !c.starred && c !== selfDm);
  const me = state.user;

  side.innerHTML = `
    <div class="sidebar-head">
      <span class="connection-dot" id="conn-dot" title="Connection status"></span>
      <h2>${escapeHtml(ws.name)}</h2>
      <button class="ws-menu-btn" id="ws-menu" title="Workspace menu" aria-label="Workspace menu">${icon('more')}</button>
    </div>
    <button class="side-item saved-row" id="saved-row" aria-label="Saved messages">
      ${icon('bookmark')}
      <span class="name">Saved</span>
      ${state.saved.size ? `<span class="count dim">${state.saved.size}</span>` : ''}
    </button>
    <div class="sidebar-scroll">
      <div class="side-section" id="starred-section" style="display:${starred.length ? '' : 'none'}">
        <div class="side-section-head">Starred</div>
        <div id="starred-list"></div>
      </div>
      <div class="side-section">
        <div class="side-section-head">Channels
          <button class="add-btn" id="browse-channels" title="Browse & create channels" aria-label="Browse channels">${icon('plus')}</button>
        </div>
        <div id="channel-list"></div>
      </div>
      <div class="side-section">
        <div class="side-section-head">Direct messages
          <button class="add-btn" id="new-dm" title="New direct message" aria-label="New direct message">${icon('plus')}</button>
        </div>
        <div id="dm-list"></div>
      </div>
      <div class="side-section">
        <div class="side-section-head">Apps</div>
        <div id="apps-list"></div>
      </div>
    </div>
    <div class="sidebar-foot">
      <span class="me-presence">${avatarHtml(me, 'sm')}<span class="presence-dot ${me.away ? 'away' : 'on'}"></span></span>
      <div style="min-width:0;flex:1">
        <div class="me-name">${escapeHtml(me.display_name || me.username)}</div>
        <div class="me-status">${escapeHtml(`${me.status_emoji || ''} ${me.status_text || (me.away ? 'Away' : 'Active')}`.trim())}</div>
      </div>
      <button class="ws-menu-btn" id="me-menu" title="You" aria-label="Your profile menu">${icon('more')}</button>
    </div>
  `;

  const starredList = $('#starred-list', side);
  for (const c of starred) starredList.appendChild(c.is_dm ? dmRow(c, actions) : channelRow(c, actions));
  const list = $('#channel-list', side);
  for (const c of channels) list.appendChild(channelRow(c, actions));
  const dmList = $('#dm-list', side);
  if (selfDm) dmList.appendChild(dmRow(selfDm, actions)); // notepad pinned on top
  for (const c of dms) dmList.appendChild(dmRow(c, actions));

  // Apps: workspace apps + a create shortcut.
  const appsList = $('#apps-list', side);
  for (const app of state.apps || []) {
    const row = el(`
      <button class="side-item" aria-label="${escapeHtml(app.name)} app">
        ${icon('apps')}
        <span class="name">${escapeHtml(app.name)}</span>
        <span class="app-tag">APP</span>
      </button>
    `);
    row.addEventListener('click', () => actions.openAppsManager());
    appsList.appendChild(row);
  }
  const makeApp = el(`
    <button class="side-item subtle-add" id="make-app" aria-label="Make an app">
      ${icon('plus')}
      <span class="name">Make an app</span>
    </button>
  `);
  makeApp.addEventListener('click', () => actions.openAppsManager({ create: true }));
  appsList.appendChild(makeApp);

  $('#ws-menu', side).addEventListener('click', (e) => actions.openWorkspaceMenu(e.currentTarget));
  $('#me-menu', side).addEventListener('click', (e) => actions.openProfileMenu(e.currentTarget));
  $('#browse-channels', side).addEventListener('click', actions.openChannelBrowser);
  $('#new-dm', side).addEventListener('click', actions.openDmPicker);
  $('#saved-row', side).addEventListener('click', actions.openSaved);
}

function wireRowMenu(row, c, actions) {
  row.addEventListener('click', () => actions.openChannel(c.id));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    actions.openChannelRowMenu(row, c.id);
  });
  $('.row-menu', row)?.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.openChannelRowMenu(row, c.id);
  });
}

function channelRow(c, actions) {
  const active = c.id === state.activeChannelId;
  const unread = c.is_member && c.unread_count > 0 && !active && !c.muted;
  const row = el(`
    <button class="side-item ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${c.muted ? 'muted' : ''}" data-ch="${c.id}">
      ${c.is_private ? icon('lock') : icon('hash')}
      <span class="name">${escapeHtml(c.name)}</span>
      ${c.is_shared ? `<span class="share-badge" title="Shared with another workspace">${icon('globe')}</span>` : ''}
      ${c.muted ? `<span class="mute-ico" title="Muted">${icon('bell-off')}</span>` : ''}
      ${c.is_member ? '' : '<span style="font-size:10px;opacity:.55">not joined</span>'}
      ${unread ? `<span class="count ${c.mention_count ? '' : 'dim'}">${c.unread_count}</span>` : ''}
      <span class="row-menu" role="button" tabindex="0" aria-label="Channel options" title="More">${icon('more')}</span>
    </button>
  `);
  wireRowMenu(row, c, actions);
  return row;
}

function dmRow(c, actions) {
  const active = c.id === state.activeChannelId;
  const unread = c.unread_count > 0 && !active && !c.muted;
  const self = isSelfDm(c);
  const other = (c.dm_users || []).find(u => u.id !== state.user.id) || c.dm_users?.[0];
  const known = other ? (userById(other.id) || other) : null;
  const external = (c.dm_users || []).some(u => u.is_remote);
  const row = el(`
    <button class="side-item ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${c.muted ? 'muted' : ''}" data-ch="${c.id}">
      ${self ? `<span class="self-ic" title="Your notes">${icon('bookmark')}</span>`
        : `<span class="presence-dot ${presenceClass(known)}"></span>`}
      <span class="name">${escapeHtml(channelTitle(c))}</span>
      ${external ? `<span class="share-badge" title="External user">${icon('globe')}</span>` : ''}
      ${c.muted ? `<span class="mute-ico" title="Muted">${icon('bell-off')}</span>` : ''}
      ${unread ? `<span class="count">${c.unread_count}</span>` : ''}
      <span class="row-menu" role="button" tabindex="0" aria-label="Conversation options" title="More">${icon('more')}</span>
    </button>
  `);
  wireRowMenu(row, c, actions);
  return row;
}
