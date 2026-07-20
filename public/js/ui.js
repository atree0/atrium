// UI primitives: modal dialogs, anchored popovers, emoji picker, lightbox.
import { $, el, escapeHtml } from './util.js';
import { EMOJI_CATEGORIES, searchEmoji } from './emoji.js';
import { state } from './state.js';
import { icon } from './icons.js';

// ---- modal ---------------------------------------------------------------

export function openModal(contentHtml, { width = 480 } = {}) {
  const root = $('#modal-root');
  closeModal();
  const backdrop = el(`
    <div class="modal-backdrop">
      <div class="modal glass-deep" role="dialog" aria-modal="true" style="width:${width}px"></div>
    </div>`);
  const modal = $('.modal', backdrop);
  modal.innerHTML = contentHtml;
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', onKey);
  backdrop._cleanup = () => document.removeEventListener('keydown', onKey);
  // Consistent keyboard behavior: Enter in a text input submits via the
  // modal's primary button (textareas keep Enter for newlines/send).
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      const primary = $('.btn-primary', modal);
      if (primary) { e.preventDefault(); primary.click(); }
    }
  });
  root.appendChild(backdrop);
  requestAnimationFrame(() => $('input, textarea, select', modal)?.focus());
  return modal;
}

export function closeModal() {
  const root = $('#modal-root');
  $('.modal-backdrop', root)?._cleanup?.();
  root.innerHTML = '';
}

// ---- popover --------------------------------------------------------------

let closeCurrentPopover = null;

export function openPopover(anchor, contentHtml, { align = 'left', place = 'bottom' } = {}) {
  closePopover();
  const root = $('#popover-root');
  const pop = el(`<div class="popover glass-deep">${contentHtml}</div>`);
  root.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = align === 'right' ? r.right - pw : r.left;
  let top = place === 'top' ? r.top - ph - 8 : r.bottom + 8;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  const onDoc = (e) => { if (!pop.contains(e.target)) closePopover(); };
  const onEsc = (e) => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
  }, 0);
  closeCurrentPopover = () => {
    document.removeEventListener('mousedown', onDoc);
    document.removeEventListener('keydown', onEsc);
    pop.remove();
    closeCurrentPopover = null;
  };
  return pop;
}

export function closePopover() { closeCurrentPopover?.(); }

// ---- emoji picker ----------------------------------------------------------

function customEmojiSections() {
  if (!state.emojiMap.size) return '';
  const imgs = [...state.emojiMap.entries()].map(([name, url]) => `
    <button data-custom="${escapeHtml(name)}" aria-label=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:">
      <img class="emoji-custom" src="${escapeHtml(url)}" alt=":${escapeHtml(name)}:">
    </button>`).join('');
  return `<div class="popover-head" data-cat="Workspace">Workspace</div><div class="emoji-grid" data-grid="Workspace">${imgs}</div>`;
}

export function openEmojiPicker(anchor, onPick, opts = {}) {
  // Build the full grid up front so the popover measures its real height.
  const allHtml = customEmojiSections() + EMOJI_CATEGORIES.map(([cat, items]) => `
    <div class="popover-head" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</div>
    <div class="emoji-grid" data-grid="${escapeHtml(cat)}">
      ${items.map(([name, char]) =>
        `<button data-emoji="${char}" aria-label=":${name}:" title=":${name}:">${char}</button>`).join('')}
    </div>
  `).join('');
  const pop = openPopover(anchor, `
    <div class="emoji-picker">
      <input class="emoji-search" placeholder="Search all emoji" aria-label="Search emoji" />
      <div class="emoji-scroll" id="emoji-scroll">${allHtml}</div>
    </div>
  `, opts);
  pop.style.width = '330px';
  const scroll = $('#emoji-scroll', pop);
  const search = $('.emoji-search', pop);

  const renderAll = () => { scroll.innerHTML = allHtml; };

  const renderSearch = (q) => {
    const hits = searchEmoji(q, 48);
    const customs = [...state.emojiMap.entries()].filter(([name]) => name.includes(q.toLowerCase()));
    scroll.innerHTML = `
      ${customs.length ? `
        <div class="popover-head">Workspace</div>
        <div class="emoji-grid">${customs.map(([name, url]) => `
          <button data-custom="${escapeHtml(name)}" title=":${escapeHtml(name)}:">
            <img class="emoji-custom" src="${escapeHtml(url)}" alt=":${escapeHtml(name)}:">
          </button>`).join('')}
        </div>` : ''}
      <div class="popover-head">Results</div>
      <div class="emoji-grid">
        ${hits.map(e => `<button data-emoji="${e.char}" aria-label=":${e.name}:" title=":${e.name}:">${e.char}</button>`).join('')}
      </div>
      ${hits.length || customs.length ? '' : '<p class="modal-sub" style="margin:10px">No emoji found.</p>'}
    `;
  };

  renderAll();
  search.addEventListener('input', () => {
    const q = search.value.trim();
    if (q) renderSearch(q); else renderAll();
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
  pop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-emoji], [data-custom]');
    if (!btn) return;
    onPick(btn.dataset.emoji || `:${btn.dataset.custom}:`);
    closePopover();
  });
  requestAnimationFrame(() => search.focus());
}

// ---- lightbox ----------------------------------------------------------------

export function openLightbox(src, alt = '') {
  const ov = el(`
    <div class="lightbox" role="dialog" aria-modal="true" aria-label="Image preview">
      <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />
      <button class="lb-close" aria-label="Close preview">${icon('x')}</button>
    </div>`);
  const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.lb-close')) close(); });
  document.body.appendChild(ov);
}

// ---- confirm dialog --------------------------------------------------------

export function confirmDialog(title, sub, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h2>${escapeHtml(title)}</h2>
      <p class="modal-sub">${escapeHtml(sub)}</p>
      <div class="modal-actions">
        <button class="btn-secondary" data-x="cancel">Cancel</button>
        <button class="btn-danger" data-x="ok">${escapeHtml(confirmLabel)}</button>
      </div>
    `);
    modal.addEventListener('click', (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (!x) return;
      closeModal();
      resolve(x === 'ok');
    });
  });
}
