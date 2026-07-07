// Electron main process (docs module 11). Reuses the exact apps/web renderer:
// in dev it loads the Vite dev server; when packaged it loads the static build
// from dist/. Adds an OS-keychain-backed secure key store over IPC so desktop
// users don't keep MaaS keys in plain IndexedDB.
//
// CommonJS (.cjs) on purpose: the repo is "type": "module", and this keeps the
// main/preload entry points working regardless of Electron's ESM support.
const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'

// --- secure key store ------------------------------------------------------
// Encrypted-at-rest via OS keychain (safeStorage). Falls back to plaintext only
// when the platform has no keychain (e.g. bare Linux) so dev still works; the
// stored shape records which mode was used.
function storePath() {
  return path.join(app.getPath('userData'), 'secure-keys.json')
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeStore(obj) {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true })
    fs.writeFileSync(storePath(), JSON.stringify(obj), 'utf8')
  } catch (e) {
    console.error('[secureKeys] write failed', e)
  }
}

function encryptAvailable() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function registerKeyIpc() {
  ipcMain.handle('keys:get', (_e, id) => {
    if (typeof id !== 'string') return null
    const rec = readStore()[id]
    if (!rec) return null
    if (rec.enc && encryptAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(rec.v, 'base64'))
      } catch {
        return null
      }
    }
    return rec.enc ? null : rec.v // encrypted blob but keychain now unavailable
  })

  ipcMain.handle('keys:set', (_e, id, value) => {
    if (typeof id !== 'string' || typeof value !== 'string') return false
    const store = readStore()
    if (encryptAvailable()) {
      store[id] = { enc: true, v: safeStorage.encryptString(value).toString('base64') }
    } else {
      store[id] = { enc: false, v: value }
    }
    writeStore(store)
    return true
  })

  ipcMain.handle('keys:delete', (_e, id) => {
    const store = readStore()
    delete store[id]
    writeStore(store)
    return true
  })

  ipcMain.handle('keys:list', () => Object.keys(readStore()))
}

// --- window ----------------------------------------------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#faf7f0',
    title: 'Thinking Pal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload needs ipcRenderer
    }
  })

  // Open external links in the OS browser, not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  if (app.isPackaged) {
    void win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  } else {
    void win.loadURL(DEV_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  }
}

app.whenReady().then(() => {
  registerKeyIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
