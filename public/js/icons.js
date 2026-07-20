// Inline SVG icon set — Linear-style thin strokes on a 16px grid.
// Icons are decorative: they render with aria-hidden and the owning control
// carries the accessible name (aria-label / title).

const svg = (inner, { fill = false } = {}) =>
  `<svg class="ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" ` +
  (fill
    ? `fill="currentColor" stroke="none">`
    : `fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">`) +
  `${inner}</svg>`;

export const icons = {
  attachment: svg('<path d="M13.1 7.4 8.4 12a3.1 3.1 0 0 1-4.4-4.4l5.2-5.2a2.07 2.07 0 0 1 2.93 2.93L6.9 10.5a1.04 1.04 0 0 1-1.46-1.46l4.6-4.6"/>'),
  send: svg('<path d="M13.7 2.3 7.2 8.8M13.7 2.3 9.5 13.8 7.2 8.8 2.2 6.5l11.5-4.2Z"/>'),
  'emoji-face': svg('<circle cx="8" cy="8" r="6.1"/><path d="M5.6 9.5a3.1 3.1 0 0 0 4.8 0"/><circle cx="6" cy="6.4" r=".75" fill="currentColor" stroke="none"/><circle cx="10" cy="6.4" r=".75" fill="currentColor" stroke="none"/>'),
  star: svg('<path d="m8 2 1.85 3.75 4.15.6-3 2.93.7 4.12L8 11.45 4.3 13.4l.7-4.12-3-2.93 4.15-.6L8 2Z"/>'),
  'star-fill': svg('<path d="m8 1.6 1.98 4.01 4.42.64-3.2 3.12.76 4.4L8 11.7l-3.96 2.08.76-4.41-3.2-3.12 4.42-.64L8 1.6Z"/>', { fill: true }),
  pin: svg('<path d="M6 1.8h4v3.7l2.2 2.3H3.8L6 5.5V1.8ZM8 7.8v6.4M5.8 1.8h4.4"/>'),
  users: svg('<circle cx="6" cy="5.4" r="2.45"/><path d="M1.7 13.6c.3-2.5 2-3.9 4.3-3.9s4 1.4 4.3 3.9M10.4 3.2a2.45 2.45 0 0 1 0 4.4M12 9.9c1.4.6 2.2 1.9 2.4 3.7"/>'),
  search: svg('<circle cx="7.2" cy="7.2" r="4.4"/><path d="m10.5 10.5 3.4 3.4"/>'),
  hash: svg('<path d="M6.3 2.2 4.9 13.8M11.1 2.2 9.7 13.8M2.7 5.7h10.8M2.5 10.3h10.8"/>'),
  lock: svg('<rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4"/><path d="M5.5 7V4.9a2.5 2.5 0 0 1 5 0V7"/>'),
  globe: svg('<circle cx="8" cy="8" r="6.1"/><ellipse cx="8" cy="8" rx="2.7" ry="6.1"/><path d="M1.9 8h12.2"/>'),
  plus: svg('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  'chevron-down': svg('<path d="m4.2 6.4 3.8 3.8 3.8-3.8"/>'),
  'chevron-right': svg('<path d="m6.4 4.2 3.8 3.8-3.8 3.8"/>'),
  x: svg('<path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/>'),
  check: svg('<path d="m3.2 8.6 3.3 3.3 6.3-7.4"/>'),
  trash: svg('<path d="M2.7 4.4h10.6M6.4 4.4V3.2a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.2M4.4 4.4l.5 8.1a1.4 1.4 0 0 0 1.4 1.3h3.4a1.4 1.4 0 0 0 1.4-1.3l.5-8.1M6.7 7v4M9.3 7v4"/>'),
  edit: svg('<path d="M11.2 2.6a1.66 1.66 0 0 1 2.35 2.35l-8.1 8.1-3.15.8.8-3.15 8.1-8.1ZM10 3.8l2.35 2.35"/>'),
  reply: svg('<path d="M6.4 3.6 2.5 7.4l3.9 3.8M2.5 7.4h7.1a3.6 3.6 0 0 1 3.6 3.6v1.6"/>'),
  bookmark: svg('<path d="M4.4 2.4h7.2v11.2L8 10.7l-3.6 2.9V2.4Z"/>'),
  'bookmark-fill': svg('<path d="M4.1 2.1h7.8v11.9L8 10.9 4.1 14V2.1Z"/>', { fill: true }),
  bell: svg('<path d="M8 2.1a4 4 0 0 1 4 4c0 2.9.9 3.9 1.5 4.6H2.5C3.1 10 4 9 4 6.1a4 4 0 0 1 4-4ZM6.5 12.8a1.55 1.55 0 0 0 3 0"/>'),
  'bell-off': svg('<path d="M5.2 2.9A4 4 0 0 1 12 6c0 2.2.5 3.3 1 4M10.7 10.7H2.5C3.1 10 4 9 4 6.1c0-.3 0-.6.1-.9M6.5 12.8a1.55 1.55 0 0 0 3 0M2.2 2.2l11.6 11.6"/>'),
  user: svg('<circle cx="8" cy="5.1" r="2.65"/><path d="M2.8 13.9c.6-2.7 2.7-4.1 5.2-4.1s4.6 1.4 5.2 4.1"/>'),
  settings: svg('<circle cx="8" cy="8" r="2.1"/><path d="M8 1.7v1.8M8 12.5v1.8M14.3 8h-1.8M3.5 8H1.7M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5"/>'),
  file: svg('<path d="M4.3 1.7h4.9l3.5 3.5v9.1H4.3V1.7ZM9 1.9v3.5h3.5"/>'),
  download: svg('<path d="M8 2.4v7.8M4.6 7l3.4 3.4L11.4 7M3 13.4h10"/>'),
  link: svg('<path d="m6.6 9.4 2.8-2.8M7.6 4.6l1.2-1.2a2.75 2.75 0 0 1 3.9 3.9l-1.3 1.2M8.4 11.4l-1.2 1.2a2.75 2.75 0 0 1-3.9-3.9l1.3-1.2"/>'),
  image: svg('<rect x="2.1" y="3" width="11.8" height="10" rx="1.4"/><circle cx="5.6" cy="6.4" r="1.05"/><path d="m2.4 11 3.3-2.8 2.9 2.4 2.5-2 2.7 2.4"/>'),
  message: svg('<path d="M13.6 4.4A1.6 1.6 0 0 0 12 2.8H4a1.6 1.6 0 0 0-1.6 1.6v5A1.6 1.6 0 0 0 4 11h.9v2.7L8.3 11H12a1.6 1.6 0 0 0 1.6-1.6v-5Z"/>'),
  clock: svg('<circle cx="8" cy="8" r="6.1"/><path d="M8 4.6V8l2.4 1.5"/>'),
  logout: svg('<path d="M6.2 2.5H3.4v11h2.8M10.2 5l3 3-3 3M13 8H6.6"/>'),
  dot: svg('<circle cx="8" cy="8" r="3"/>', { fill: true }),
  more: svg('<circle cx="3.4" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.6" cy="8" r="1.15"/>', { fill: true }),
  menu: svg('<path d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"/>'),
  refresh: svg('<path d="M13.4 8A5.4 5.4 0 1 1 11.8 4.2M13.5 2.2v3h-3"/>'),
  mail: svg('<rect x="2.1" y="3.4" width="11.8" height="9.2" rx="1.4"/><path d="m2.6 5.2 5.4 3.9 5.4-3.9"/>'),
  apps: svg('<rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1.1"/><rect x="9" y="2.4" width="4.6" height="4.6" rx="1.1"/><rect x="2.4" y="9" width="4.6" height="4.6" rx="1.1"/><rect x="9" y="9" width="4.6" height="4.6" rx="1.1"/>'),
  sparkle: svg('<path d="M8 1.9 9.5 5.9l4 1.5-4 1.5L8 12.9 6.5 8.9l-4-1.5 4-1.5L8 1.9Z"/><path d="M12.9 11.4v3M11.4 12.9h3"/>'),
  archive: svg('<rect x="2" y="2.6" width="12" height="3.2" rx="1"/><path d="M3.2 5.8v6.5a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.8M6.5 8.4h3"/>'),
  leave: svg('<path d="M9.8 2.5h2.8v11H9.8M6 5 3 8l3 3M3 8h6.4"/>'),
  moon: svg('<path d="M13.4 9.4A5.6 5.6 0 0 1 6.6 2.6a5.6 5.6 0 1 0 6.8 6.8Z"/>'),
  command: svg('<path d="M5.4 5.4h5.2v5.2H5.4zM5.4 5.4H4.1a1.7 1.7 0 1 1 1.7-1.7v1.7ZM10.6 5.4h1.3a1.7 1.7 0 1 0-1.7-1.7v1.7ZM5.4 10.6H4.1a1.7 1.7 0 1 0 1.7 1.7v-1.7ZM10.6 10.6h1.3a1.7 1.7 0 1 1-1.7 1.7v-1.7Z"/>'),
};

// icon('name') → svg string; unknown names render an empty placeholder box
// (visible in dev, harmless in prod).
export function icon(name) {
  return icons[name] || svg('<rect x="3" y="3" width="10" height="10" rx="2"/>');
}
