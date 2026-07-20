// Preload: the only bridge between the Atrium web app and the desktop shell.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('atriumDesktop', {
  isDesktop: true,
  setBadge: (count) => ipcRenderer.send('atrium:set-badge', count),
  notify: (title, body) => ipcRenderer.send('atrium:notify', { title, body }),
});
