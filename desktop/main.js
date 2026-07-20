// Atrium desktop — Electron shell for macOS.
// Loads any Atrium server (default http://localhost:3000) in a real mac window
// with native traffic lights, dock unread badge, and desktop notifications.
import { app, BrowserWindow, shell, ipcMain, Notification, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_URL = process.env.ATRIUM_URL || 'http://localhost:3000';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    title: 'Atrium',
    titleBarStyle: 'hiddenInset',      // real mac traffic lights over the content
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0b0d16',
    vibrancy: 'under-window',           // native macOS translucency behind the glass UI
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(SERVER_URL);

  // External links open in the browser, not in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

// ---- bridge from the web app -----------------------------------------------

// Unread count -> dock badge.
ipcMain.on('atrium:set-badge', (_e, count) => {
  const n = Number(count) || 0;
  app.dock?.setBadge(n > 0 ? String(n) : '');
});

// Web notification -> native macOS notification (uses the page's own icon/title).
ipcMain.on('atrium:notify', (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title || 'Atrium'), body: String(body || '') });
  n.on('click', () => { win?.show(); win?.focus(); });
  n.show();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => { win?.show(); win?.focus(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
