// Preload: expose a minimal, audited secure-key API to the renderer over the
// contextBridge (docs module 11.3). No Node globals leak into the page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('secureKeys', {
  get: (id) => ipcRenderer.invoke('keys:get', id),
  set: (id, value) => ipcRenderer.invoke('keys:set', id, value),
  delete: (id) => ipcRenderer.invoke('keys:delete', id),
  list: () => ipcRenderer.invoke('keys:list')
})

// Lets the renderer detect it's running inside the desktop shell.
contextBridge.exposeInMainWorld('desktop', { isElectron: true })

contextBridge.exposeInMainWorld('localAi', {
  status: (req) => ipcRenderer.invoke('local-ai:status', req),
  setup: (req) => ipcRenderer.invoke('local-ai:setup', req),
  run: (req) => ipcRenderer.invoke('local-ai:run', req)
})
