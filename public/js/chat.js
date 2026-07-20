// Chat column: header, message list, composer, thread panel, search.
import { state, channel, channelTitle, isSelfDm, usersByName, userById } from './state.js';
import {
  $, $$, el, escapeHtml, escapeRe, avatarHtml, fmtTime, fmtDay, dayKey,
  renderMarkdown, fmtBytes, debounce, toast,
} from './util.js';
import { openEmojiPicker, confirmDialog, openLightbox } from './ui.js';
import { searchEmoji } from './emoji.js';
import { icon } from './icons.js';

let actions = null;
let loadingOlder = false;

export function initChat(a) { actions = a; }

const md = (text) => renderMarkdown(text, { meId: state.user.id, usersByName: usersByName(), emojiMap: state.emojiMap });

// ---- shell -----------------------------------------------------------------

export function renderChatShell({ skeleton = false } = {}) {
  const main = $('#main');
  const c = channel();
  if (!c) {
    main.innerHTML = `
      <div class="empty-state">
        <div class="glyph-ic">${icon('message')}</div>
        <h3>Nothing open</h3>
        <p>Pick a channel or start a conversation.</p>
        <button class="btn-secondary" id="es-browse">Browse channels</button>
      </div>`;
    $('#es-browse')?.addEventListener('click', () => actions.openChannelBrowser());
    return;
  }
  const isDm = !!c.is_dm;
  const selfDm = isSelfDm(c);
  main.innerHTML = `
    <div class="chat-head glass-deep hairline-top" style="border-radius:0;border-left:0;border-right:0;border-top:0">
      <button class="head-btn hamburger" id="nav-toggle" title="Toggle sidebar" aria-label="Toggle sidebar">${icon('menu')}</button>
      <button class="ch-name-btn" id="ch-name-btn" title="View members" aria-label="Channel details">
        ${selfDm ? icon('bookmark') : isDm ? '' : (c.is_private ? icon('lock') : icon('hash'))}
        <span>${escapeHtml(channelTitle(c))}</span>
        ${c.is_shared ? `<span class="share-badge" title="Shared with another workspace">${icon('globe')}</span>` : ''}
        <span class="chev">${icon('chevron-down')}</span>
      </button>
      <button class="star-btn ${c.starred ? 'on' : ''}" id="star-btn"
        title="${c.starred ? 'Remove from Starred' : 'Add to Starred'}"
        aria-label="${c.starred ? 'Remove from Starred' : 'Add to Starred'}">${icon(c.starred ? 'star-fill' : 'star')}</button>
      <div class="ch-topic">${escapeHtml(c.topic || (selfDm ? 'Your private notepad' : isDm ? 'Direct conversation' : ''))}</div>
      <button class="head-btn" id="files-btn" title="Shared files" aria-label="Shared files">${icon('file')} Files</button>
      <button class="head-btn" id="pins-btn" title="Pinned messages" aria-label="Pinned messages">${icon('pin')} <span id="pins-count"></span></button>
      <button class="head-btn" id="members-btn" title="Members" aria-label="Members">${icon('users')} ${c.member_count || ''}</button>
      ${isDm ? '' : `<button class="head-btn" id="ch-menu-btn" title="Channel settings" aria-label="Channel settings">${icon('more')}</button>`}
      <div class="head-search">
        ${icon('search')}
        <input id="search-input" placeholder="Search messages" aria-label="Search messages" />
      </div>
    </div>
    <div class="messages" id="messages"></div>
    <div class="composer-wrap">
      <div class="typing-line" id="typing-line"></div>
      <div class="composer">
        <button class="composer-btn" id="attach-btn" title="Attach files" aria-label="Attach files">${icon('attachment')}</button>
        <textarea id="composer-input" rows="1" aria-label="Message text"
          placeholder="${selfDm ? 'Jot something down…' : `Message ${isDm ? escapeHtml(channelTitle(c)) : '#' + escapeHtml(c.name)}`}"></textarea>
        <button class="composer-btn" id="emoji-btn" title="Emoji" aria-label="Insert emoji">${icon('emoji-face')}</button>
        <button class="composer-btn send" id="send-btn" title="Send" aria-label="Send message" disabled>${icon('send')}</button>
      </div>
      <div class="composer-files" id="composer-files"></div>
      <input type="file" id="file-input" multiple hidden />
      <div class="composer-suggest" id="composer-suggest" style="display:none"></div>
    </div>
    <div class="drop-overlay" id="drop-overlay" aria-hidden="true">
      <div class="drop-inner glass-deep">${icon('attachment')} Drop files to upload</div>
    </div>
  `;
  if (skeleton) renderMessagesSkeleton();
  else renderMessages();
  wireComposer();
  wireHeader();
  if (!skeleton) refreshPinsCount();
}

export function renderMessagesSkeleton() {
  const box = $('#messages');
  if (!box) return;
  box.innerHTML = [72, 45, 84, 30, 62, 50].map(w => `
    <div class="msg-skel" aria-hidden="true">
      <div class="skeleton sk-av"></div>
      <div class="sk-lines">
        <div class="skeleton sk-a"></div>
        <div class="skeleton sk-b" style="width:${w}%"></div>
      </div>
    </div>`).join('');
}

function wireHeader() {
  $('#nav-toggle')?.addEventListener('click', () => {
    $('#sidebar')?.classList.toggle('open');
    $('#side-backdrop')?.classList.toggle('on');
  });
  $('#ch-name-btn')?.addEventListener('click', (e) => actions.showMembers(e.currentTarget));
  $('#files-btn')?.addEventListener('click', () => actions.showFiles());
  $('#pins-btn')?.addEventListener('click', (e) => actions.showPins(e.currentTarget));
  $('#members-btn')?.addEventListener('click', (e) => actions.showMembers(e.currentTarget));
  $('#star-btn')?.addEventListener('click', () => actions.toggleStar(state.activeChannelId));
  $('#ch-menu-btn')?.addEventListener('click', (e) => actions.openChannelMenu(e.currentTarget));
  const input = $('#search-input');
  input?.addEventListener('input', debounce(() => actions.doSearch(input.value), 250));
  input?.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; actions.doSearch(''); } });
}

// ---- messages ---------------------------------------------------------------

// One-shot scroll targets, set by app.js before renderChatShell().
let pendingJumpId = null;
let pendingDividerAfter = null;
export function setPendingJump(messageId) { pendingJumpId = messageId; }
export function setUnreadDivider(afterId) { pendingDividerAfter = afterId; }

export function renderMessages() {
  const box = $('#messages');
  if (!box) return;
  const c = channel();
  box.innerHTML = '';
  const msgs = state.messages.get(c.id) || [];
  if (state.hasMore.get(c.id)) {
    const loader = el(`<div class="loading-line" id="older-loader">Loading older…</div>`);
    box.appendChild(loader);
  } else {
    // Start of history: a friendly channel intro instead of a hard cut.
    const self = isSelfDm(c);
    const title = self ? 'Your space'
      : c.is_dm ? `This conversation is just between you and ${escapeHtml(channelTitle(c))}`
      : `Welcome to #${escapeHtml(c.name)}`;
    const sub = self ? 'Draft messages, keep links, jot notes — only you can see this.'
      : c.is_dm ? 'Say hi 👋'
      : (c.topic ? escapeHtml(c.topic) : 'This is the very beginning of the channel. Share an update, drop a file, or set a topic to get things going.');
    box.appendChild(el(`
      <div class="channel-intro">
        <div class="ci-glyph">${self ? icon('bookmark') : c.is_dm ? icon('message') : c.is_private ? icon('lock') : icon('hash')}</div>
        <h3>${title}</h3>
        <p>${sub}</p>
      </div>`));
  }
  for (const m of msgs) {
    appendMessageNode(box, m);
  }
  for (const eph of state.ephemeral.get(c.id) || []) {
    const node = el(`
      <div class="ephemeral">
        <span class="tag">Only you can see this</span>
        <button class="eph-x" aria-label="Dismiss ephemeral message">${icon('x')}</button>
        <div>${renderMarkdown(eph.text, { emojiMap: state.emojiMap })}</div>
      </div>`);
    $('.eph-x', node).addEventListener('click', () => actions.dismissEphemeral(c.id, eph.id));
    box.appendChild(node);
  }

  if (pendingDividerAfter != null) {
    const divider = el(`<div class="unread-divider"><span>New messages</span></div>`);
    let inserted = false;
    for (const child of [...box.children]) {
      if (child._msg && child._msg.id > pendingDividerAfter) {
        box.insertBefore(divider, child);
        inserted = true;
        break;
      }
    }
    pendingDividerAfter = null;
    if (inserted) divider.scrollIntoView({ block: 'center' });
    else box.scrollTop = box.scrollHeight;
  } else if (pendingJumpId != null) {
    const node = box.querySelector(`.msg[data-mid="${pendingJumpId}"]`);
    pendingJumpId = null;
    if (node) {
      node.scrollIntoView({ block: 'center' });
      node.classList.add('flash');
    } else {
      box.scrollTop = box.scrollHeight;
    }
  } else {
    box.scrollTop = box.scrollHeight;
  }
  wireMessageScroll(box);
}

function wireMessageScroll(box) {
  box.onscroll = async () => {
    if (box.scrollTop < 80 && !loadingOlder && state.hasMore.get(channel()?.id)) {
      loadingOlder = true;
      const prevHeight = box.scrollHeight;
      try {
        await actions.loadOlder();
      } catch { /* keep the current page */ } finally {
        loadingOlder = false;
      }
      box.scrollTop = box.scrollHeight - prevHeight;
    }
  };
}

// Renders one message, grouped/compact when the previous is the same author.
function appendMessageNode(box, m, { threadView = false } = {}) {
  const prev = box.lastElementChild?._msg;
  const compact = prev && prev.user.id === m.user.id
    && m.created_at - prev.created_at < 5 * 60 * 1000
    && dayKey(prev.created_at) === dayKey(m.created_at) && !m.pinned;

  const needDivider = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
  if (needDivider && !threadView) {
    box.appendChild(el(`<div class="day-divider"><span>${fmtDay(m.created_at)}</span></div>`));
  }

  const node = buildMessageNode(m, compact, threadView);
  box.appendChild(node);
  return node;
}

function statusEmojiHtml(user) {
  const s = user?.status_emoji;
  if (!s) return '';
  const custom = s.match(/^:([a-z0-9_+-]{2,32}):$/);
  if (custom && state.emojiMap.get(custom[1])) {
    return `<img class="emoji-custom" src="${escapeHtml(state.emojiMap.get(custom[1]))}" alt="${escapeHtml(s)}">`;
  }
  return escapeHtml(s);
}

function buildMessageNode(m, compact, threadView) {
  const me = state.user;
  const isMine = m.user.id === me.id;
  const canDelete = isMine || state.myRole === 'owner' || state.myRole === 'admin';
  const saved = state.saved.has(m.id);
  const node = el(`
    <div class="msg ${compact ? 'msg-compact' : ''}" data-mid="${m.id}">
      <span class="profile-trigger" data-profile="${m.user.id}">${avatarHtml(m.user, 'md')}</span>
      <div class="msg-body">
        ${m.pinned && !compact ? `<div class="msg-pin-flag">${icon('pin')} Pinned</div>` : ''}
        <div class="msg-head">
          <span class="msg-author" data-profile="${m.user.id}">${escapeHtml(m.user.display_name || m.user.username)}${m.user.is_bot ? '<span class="bot-tag">APP</span>' : ''}</span>
          ${statusEmojiHtml(m.user) ? `<span class="msg-status">${statusEmojiHtml(m.user)}</span>` : ''}
          <span class="msg-time">${fmtTime(m.created_at)}</span>
          ${m.edited_at ? '<span class="msg-edited">(edited)</span>' : ''}
        </div>
        <div class="msg-text">${md(m.text)}</div>
        ${attachmentsHtml(m)}
        <div class="reactions"></div>
        ${!threadView && m.reply_count > 0 ? `
          <button class="thread-link" data-act="thread">
            ${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'} →
          </button>` : ''}
      </div>
      <div class="msg-actions glass-deep">
        <button data-act="react" title="React" aria-label="Add reaction">${icon('emoji-face')}</button>
        ${!threadView ? `<button data-act="thread" title="Reply in thread" aria-label="Reply in thread">${icon('reply')}</button>` : ''}
        <button data-act="save" class="${saved ? 'on' : ''}" title="${saved ? 'Remove from Saved' : 'Save for later'}"
          aria-label="${saved ? 'Remove from Saved' : 'Save for later'}">${icon(saved ? 'bookmark-fill' : 'bookmark')}</button>
        <button data-act="pin" class="${m.pinned ? 'on' : ''}" title="${m.pinned ? 'Unpin' : 'Pin'}"
          aria-label="${m.pinned ? 'Unpin message' : 'Pin message'}">${icon('pin')}</button>
        ${isMine ? `<button data-act="edit" title="Edit" aria-label="Edit message">${icon('edit')}</button>` : ''}
        ${canDelete ? `<button data-act="delete" title="Delete" aria-label="Delete message">${icon('trash')}</button>` : ''}
      </div>
    </div>
  `);
  node._msg = m;
  renderReactions(node, m);

  node.addEventListener('click', async (e) => {
    const lb = e.target.closest('[data-lightbox]');
    if (lb) {
      openLightbox(lb.dataset.lightbox, lb.alt || 'attachment');
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) {
      if (act === 'react') openEmojiPicker(e.target.closest('[data-act]'), (emoji) => actions.react(m.id, emoji));
      if (act === 'thread') actions.openThread(m);
      if (act === 'save') actions.toggleSave(m);
      if (act === 'pin') actions.togglePin(m.id);
      if (act === 'edit') startInlineEdit(node, m);
      if (act === 'delete') {
        if (await confirmDialog('Delete message?', 'This cannot be undone.')) actions.deleteMessage(m.id);
      }
      return;
    }
    if (e.target.closest('a, video, audio, .reaction, .thread-link, .msg-edit-box')) return;
    const trig = e.target.closest('[data-profile]');
    if (trig) actions.showProfile(trig, Number(trig.dataset.profile));
  });
  return node;
}

function attachmentsHtml(m) {
  if (!m.attachments?.length) return '';
  return `<div class="attachments">${m.attachments.map(a => {
    if (a.type === 'link') return linkCardHtml(a);
    const url = escapeHtml(a.url || '');
    const name = escapeHtml(a.name || 'file');
    const mime = a.mimetype || '';
    const ext = (a.name || '').split('.').pop()?.toLowerCase() || '';
    // Only same-origin uploads render inline — external media URLs could be
    // tracking pixels, so they always degrade to a plain file card.
    const local = (a.url || '').startsWith('/uploads/');
    if (local && mime.startsWith('image/')) {
      return `<img class="attachment-img" src="${url}" alt="${name}" loading="lazy" data-lightbox="${url}" />`;
    }
    if (local && (mime.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext))) {
      return `<video class="attachment-media" src="${url}" controls preload="metadata"></video>`;
    }
    if (local && (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(ext))) {
      return `<audio class="attachment-audio" src="${url}" controls preload="metadata"></audio>`;
    }
    return `<a class="attachment-file" href="${url}" target="_blank" rel="noopener">
      <span class="fa-ico">${icon('file')}</span>
      <span><span class="fname">${name}</span><br><span class="fsize">${fmtBytes(a.size || 0)}</span></span>
    </a>`;
  }).join('')}</div>`;
}

function linkCardHtml(a) {
  // Same tracking-pixel rule as file attachments: unfurl images only render
  // when the server mirrored them under /uploads/.
  const img = a.image && a.image.startsWith('/uploads/')
    ? `<img class="lc-img" src="${escapeHtml(a.image)}" alt="" loading="lazy" />` : '';
  return `<a class="link-card" href="${escapeHtml(a.url || '')}" target="_blank" rel="noopener">
    <div class="lc-main">
      ${a.site_name ? `<div class="lc-site">${escapeHtml(a.site_name)}</div>` : ''}
      ${a.title ? `<div class="lc-title">${escapeHtml(a.title)}</div>` : ''}
      ${a.description ? `<div class="lc-desc">${escapeHtml(a.description)}</div>` : ''}
    </div>
    ${img}
  </a>`;
}

function reactionChipHtml(emoji) {
  const custom = emoji.match(/^:([a-z0-9_+-]{2,32}):$/);
  if (custom && state.emojiMap.get(custom[1])) {
    return `<img class="emoji-custom" src="${escapeHtml(state.emojiMap.get(custom[1]))}" alt="${escapeHtml(emoji)}">`;
  }
  return escapeHtml(emoji);
}

function renderReactions(node, m) {
  const box = $('.reactions', node);
  if (!box) return;
  box.innerHTML = (m.reactions || []).map(r => `
    <button class="reaction ${r.users.includes(state.user.id) ? 'mine' : ''}" data-emoji="${escapeHtml(r.emoji)}"
      title="${r.users.map(id => escapeHtml(userById(id)?.display_name || userById(id)?.username || 'someone')).join(', ')}">
      ${reactionChipHtml(r.emoji)} <span class="n">${r.count}</span>
    </button>
  `).join('');
  $$('.reaction', box).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.react(m.id, btn.dataset.emoji);
    });
  });
}

function startInlineEdit(node, m) {
  const textEl = $('.msg-text', node);
  const original = m.text;
  textEl.outerHTML = `
    <div class="msg-edit-box">
      <textarea rows="3" aria-label="Edit message text">${escapeHtml(original)}</textarea>
      <div class="edit-actions">
        <button class="btn-primary" style="width:auto;padding:7px 16px" data-edit="save">Save</button>
        <button class="btn-secondary" data-edit="cancel">Cancel</button>
      </div>
    </div>`;
  const box = $('.msg-edit-box', node);
  const ta = $('textarea', box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  box.addEventListener('click', (e) => {
    const act = e.target.closest('[data-edit]')?.dataset.edit;
    if (act === 'save') actions.editMessage(m.id, ta.value.trim());
    if (act) updateMessageDom(m.id, m.channel_id); // re-render either way
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); actions.editMessage(m.id, ta.value.trim()); }
    if (e.key === 'Escape') updateMessageDom(m.id, m.channel_id, true);
  });
}

// ---- incremental DOM ops (called from WS handlers) ---------------------------

export function appendMessageDom(m) {
  const box = $('#messages');
  if (!box || !channel() || m.channel_id !== channel().id || m.thread_id) return;
  if (box.querySelector(`[data-mid="${m.id}"]`)) return; // already rendered (own send)
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  appendMessageNode(box, m);
  if (nearBottom || m.user.id === state.user.id) box.scrollTop = box.scrollHeight;
}

export function updateMessageDom(id, channelId, force = false) {
  if (!channel() || channelId !== channel().id) return;
  const m = (state.messages.get(channelId) || []).find(x => x.id === id);
  const node = $(`.msg[data-mid="${id}"]`);
  if (!m || !node) return;
  const fresh = buildMessageNode(m, node.classList.contains('msg-compact') && !force, false);
  node.replaceWith(fresh);
}

export function removeMessageDom(id) {
  $(`.msg[data-mid="${id}"]`)?.remove();
}

// ---- composer ----------------------------------------------------------------

let pendingFiles = [];
let uploadsInFlight = 0;

function wireComposer() {
  const input = $('#composer-input');
  const sendBtn = $('#send-btn');
  const fileInput = $('#file-input');
  const chanId = state.activeChannelId;
  const draftKey = `atrium.draft.${chanId}`;
  pendingFiles = [];
  uploadsInFlight = 0;

  const updateSendBtn = () => {
    const busy = uploadsInFlight > 0;
    sendBtn.disabled = busy || (!input.value.trim() && !pendingFiles.length);
    sendBtn.innerHTML = busy ? '<span class="spinner" aria-hidden="true"></span>' : icon('send');
  };
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    updateSendBtn();
  };
  const saveDraft = () => {
    if (input.value.trim()) localStorage.setItem(draftKey, input.value);
    else localStorage.removeItem(draftKey);
  };
  const insertAtCursor = (text) => {
    const s = input.selectionStart ?? input.value.length;
    const epos = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + text + input.value.slice(epos);
    const pos = s + text.length;
    input.setSelectionRange(pos, pos);
    autosize();
    saveDraft();
    input.focus();
  };

  input.value = localStorage.getItem(draftKey) || '';

  input.addEventListener('input', () => { autosize(); saveDraft(); actions.sendTyping(); refreshSuggest(input); });
  input.addEventListener('keydown', (e) => {
    if (handleSuggestKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) attachFlow(files);
  });
  sendBtn.addEventListener('click', doSend);
  $('#emoji-btn').addEventListener('click', (e) => {
    openEmojiPicker(e.currentTarget, insertAtCursor, { place: 'top', align: 'right' });
  });
  $('#attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    attachFlow(files);
  });

  // Drag & drop onto the whole chat column.
  const main = $('#main');
  let dragDepth = 0;
  const showDrop = (on) => $('#drop-overlay')?.classList.toggle('on', on);
  main.ondragenter = (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    showDrop(true);
  };
  main.ondragover = (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
  };
  main.ondragleave = () => {
    if (--dragDepth <= 0) { dragDepth = 0; showDrop(false); }
  };
  main.ondrop = (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth = 0;
    showDrop(false);
    attachFlow([...(e.dataTransfer?.files || [])]);
  };

  async function attachFlow(files) {
    if (!files.length) return;
    uploadsInFlight++;
    updateSendBtn();
    try {
      const uploaded = await actions.attachFiles(files);
      pendingFiles.push(...uploaded);
      renderFileChips();
    } finally {
      uploadsInFlight--;
      updateSendBtn();
    }
    autosize();
    input.focus();
  }

  async function doSend() {
    const text = input.value.trim();
    if (!text && !pendingFiles.length) return;
    const files = pendingFiles;
    pendingFiles = [];
    input.value = '';
    renderFileChips();
    autosize();
    localStorage.removeItem(draftKey);
    closeSuggest();
    try {
      await actions.sendMessage(text, files);
    } catch (ex) {
      input.value = text;
      pendingFiles = files;
      renderFileChips();
      autosize();
      saveDraft();
      toast(`Send failed: ${ex.message.replace(/_/g, ' ')}`);
    }
    input.focus();
  }

  autosize();
  input.focus();
}

function renderFileChips() {
  const box = $('#composer-files');
  if (!box) return;
  box.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const chip = el(`<span class="file-chip">${icon('file')} ${escapeHtml(f.name)} <button class="x" data-i="${i}" aria-label="Remove attachment">${icon('x')}</button></span>`);
    $('.x', chip).addEventListener('click', () => {
      pendingFiles.splice(i, 1);
      renderFileChips();
      $('#composer-input')?.focus();
    });
    box.appendChild(chip);
  });
}

// ---- composer autocomplete (@ mentions, :emoji:) --------------------------------

let suggest = null; // { kind, start, items, sel }

function refreshSuggest(input) {
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  // Remote usernames carry an @host segment (`name@somehost`) — allow typing it.
  const mention = upto.match(/(?:^|\s)@([A-Za-z0-9_.-]{0,31}(?:@[A-Za-z0-9_.-]{0,63})?)$/);
  const emojiM = upto.match(/(?:^|\s):([a-z0-9_+-]{2,31})$/);
  if (mention) openSuggest('mention', upto.length - mention[1].length - 1, mention[1].toLowerCase());
  else if (emojiM) openSuggest('emoji', upto.length - emojiM[1].length - 1, emojiM[1].toLowerCase());
  else closeSuggest();
}

function openSuggest(kind, start, query) {
  const c = channel();
  let items = [];
  if (kind === 'mention') {
    const broadcasts = [
      { insert: '@channel ', label: '@channel', sub: 'Notify everyone in this channel', html: `<span class="sg-emoji">${icon('users')}</span>` },
      { insert: '@here ', label: '@here', sub: 'Notify everyone online', html: `<span class="sg-emoji">${icon('bell')}</span>` },
      { insert: '@everyone ', label: '@everyone', sub: 'Notify everyone in this channel', html: `<span class="sg-emoji">${icon('users')}</span>` },
    ].filter(b => b.label.slice(1).startsWith(query));
    const memberIds = state.channelMembers.get(c?.id) || new Set();
    const users = state.users
      .filter(u => u.id !== state.user.id)
      .filter(u => !query
        || u.username.toLowerCase().includes(query)
        || (u.display_name || '').toLowerCase().includes(query))
      .sort((a, b) => {
        const am = memberIds.has(a.id) ? 0 : 1;
        const bm = memberIds.has(b.id) ? 0 : 1;
        return am - bm || a.username.localeCompare(b.username);
      })
      .slice(0, 8)
      .map(u => ({
        insert: `@${u.username} `,
        label: u.display_name || u.username,
        sub: `@${u.username}${u.is_bot ? ' · APP' : ''}`,
        html: avatarHtml(u, 'sm'),
      }));
    items = [...broadcasts, ...users];
  } else {
    const customs = [...state.emojiMap.entries()]
      .filter(([name]) => name.includes(query))
      .slice(0, 4)
      .map(([name, url]) => ({
        insert: `:${name}: `,
        label: `:${name}:`,
        sub: 'workspace',
        html: `<img class="emoji-custom" src="${escapeHtml(url)}" alt="">`,
      }));
    const builtins = searchEmoji(query, 8)
      .map(e => ({ insert: `${e.char} `, label: `:${e.name}:`, sub: e.cat, html: `<span class="sg-emoji">${e.char}</span>` }));
    items = [...customs, ...builtins];
  }
  if (!items.length) return closeSuggest();
  const keepSel = suggest && suggest.kind === kind ? Math.min(suggest.sel, items.length - 1) : 0;
  suggest = { kind, start, items, sel: keepSel };
  paintSuggest();
}

function paintSuggest() {
  const box = $('#composer-suggest');
  if (!box || !suggest) return;
  box.style.display = '';
  box.innerHTML = suggest.items.map((it, i) => `
    <button class="sg-item ${i === suggest.sel ? 'sel' : ''}" data-i="${i}">
      ${it.html || `<span class="sg-emoji">${it.icon || ''}</span>`}
      <span class="sg-label">${escapeHtml(it.label)}</span>
      <span class="sg-sub">${escapeHtml(it.sub || '')}</span>
    </button>
  `).join('');
  $$('.sg-item', box).forEach(btn => {
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); pickSuggest(Number(btn.dataset.i)); });
    btn.addEventListener('mouseenter', () => { suggest.sel = Number(btn.dataset.i); paintSuggest(); });
  });
}

function handleSuggestKey(e) {
  if (!suggest) return false;
  if (e.key === 'ArrowDown') { suggest.sel = (suggest.sel + 1) % suggest.items.length; paintSuggest(); e.preventDefault(); return true; }
  if (e.key === 'ArrowUp') { suggest.sel = (suggest.sel - 1 + suggest.items.length) % suggest.items.length; paintSuggest(); e.preventDefault(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { pickSuggest(suggest.sel); e.preventDefault(); return true; }
  if (e.key === 'Escape') { closeSuggest(); e.preventDefault(); return true; }
  return false;
}

function pickSuggest(i) {
  const input = $('#composer-input');
  const it = suggest?.items[i];
  if (!input || !it) return closeSuggest();
  const cursor = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, suggest.start) + it.insert + input.value.slice(cursor);
  const pos = suggest.start + it.insert.length;
  closeSuggest();
  input.focus();
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event('input'));
}

function closeSuggest() {
  suggest = null;
  const box = $('#composer-suggest');
  if (box) box.style.display = 'none';
}

// ---- typing indicator ----------------------------------------------------------

export function renderTypingLine() {
  const line = $('#typing-line');
  if (!line || !channel()) return;
  const typers = [...(state.typing.get(channel().id) || new Map()).values()]
    .filter(t => t.until > Date.now());
  line.textContent = typers.length === 0 ? ''
    : typers.length === 1 ? `${typers[0].name} is typing…`
    : `${typers.length} people are typing…`;
}

// ---- thread panel ----------------------------------------------------------------

export function renderThread() {
  const panel = $('#thread-panel');
  if (!panel) return;
  const t = state.thread;
  if (!t) { panel.innerHTML = ''; panel.style.display = 'none'; return; }
  // Preserve whatever the user is typing across re-renders (bug fix #9).
  const oldInput = $('#thread-input');
  const prevVal = oldInput?.value ?? '';
  const prevSel = oldInput ? [oldInput.selectionStart, oldInput.selectionEnd] : null;
  const wasFocused = oldInput && document.activeElement === oldInput;

  panel.style.display = 'flex';
  const c = channel(t.channelId);
  panel.innerHTML = `
    <div class="thread-head">
      <div>
        <h3>Thread</h3>
        <div class="sub">${c ? (c.is_dm ? channelTitle(c) : '#' + c.name) : ''}</div>
      </div>
      <button class="thread-close" id="thread-close" aria-label="Close thread">${icon('x')}</button>
    </div>
    <div class="thread-messages" id="thread-messages"></div>
    <div class="composer-wrap">
      <div class="composer">
        <textarea id="thread-input" rows="1" placeholder="Reply…" aria-label="Thread reply"></textarea>
        <button class="composer-btn send" id="thread-send" aria-label="Send reply" disabled>${icon('send')}</button>
      </div>
    </div>
  `;
  $('#thread-close').addEventListener('click', actions.closeThread);

  const box = $('#thread-messages');
  appendMessageNode(box, t.parent, { threadView: true });
  for (const m of t.messages) appendMessageNode(box, m, { threadView: true });
  box.scrollTop = box.scrollHeight;

  const input = $('#thread-input');
  const send = $('#thread-send');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    send.disabled = !input.value.trim();
  };
  if (prevVal) {
    input.value = prevVal;
    if (wasFocused) {
      input.focus();
      if (prevSel) input.setSelectionRange(prevSel[0], prevSel[1]);
    }
  }
  input.addEventListener('input', autosize);
  autosize();
  const doSend = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send.disabled = true;
    actions.sendThreadReply(text);
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
}

export function refreshThreadDom() {
  if (state.thread) renderThread();
}

// ---- pins & search rendering -----------------------------------------------------

export async function refreshPinsCount() {
  const n = await actions.getPinsCount();
  const elCount = $('#pins-count');
  if (elCount) elCount.textContent = n || '';
}

function highlightPlain(text, query) {
  const plain = query.replace(/\b(from|in):[^\s]+/gi, '').trim();
  const esc = escapeHtml(String(text || '').slice(0, 400));
  if (!plain) return esc;
  return esc.replace(new RegExp(`(${escapeRe(escapeHtml(plain))})`, 'ig'), '<mark>$1</mark>');
}

export function renderSearchResults(query, results) {
  const box = $('#messages');
  if (!box) return;
  box.onscroll = null;
  if (!query) { renderMessages(); return; }
  box.innerHTML = results.length
    ? `<div class="search-results"><div class="day-divider"><span>${results.length} result${results.length === 1 ? '' : 's'} for “${escapeHtml(query)}”</span></div></div>`
    : `<div class="empty-state" style="min-height:200px"><p>No results for “${escapeHtml(query)}”</p></div>`;
  const wrap = $('.search-results', box);
  if (!wrap) return;
  for (const r of results) {
    // Prefer the server's pre-highlighted snippet; fall back to client-side
    // highlighting on escaped plain text (never on rendered HTML).
    const body = r.snippet
      ? escapeHtml(r.snippet).replace(/&lt;(\/?)mark&gt;/g, '<$1mark>')
      : highlightPlain(r.text, query);
    const hit = el(`
      <div class="search-hit">
        <div class="ctx">${r.channel_name ? '#' + escapeHtml(r.channel_name) : 'DM'} · ${escapeHtml(r.user.display_name || r.user.username)} · ${fmtDay(r.created_at)} ${fmtTime(r.created_at)}</div>
        <div class="txt">${body}</div>
      </div>
    `);
    hit.addEventListener('click', () => actions.jumpToMessage(r.channel_id, r.id, r.thread_id || null));
    wrap.appendChild(hit);
  }
}
