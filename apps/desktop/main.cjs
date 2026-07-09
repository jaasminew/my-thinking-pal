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
const os = require('node:os')
const { spawn } = require('node:child_process')

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

function registerLocalAiIpc() {
  ipcMain.handle('local-ai:status', async (_e, req) => {
    try {
      return await checkLocalRuntime(req)
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) }
    }
  })

  ipcMain.handle('local-ai:run', async (_e, req) => {
    try {
      return await runLocalAi(req)
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) }
    }
  })

  ipcMain.handle('local-ai:setup', async (_e, req) => {
    try {
      return await setupLocalRuntime(req)
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) }
    }
  })
}

async function checkLocalRuntime(req) {
  const runtime = req && req.runtime
  const cmd = commandFor(runtime, req && req.command)
  const version = await runProcess(cmd, ['--version'], '', 8000)
  if (version.code !== 0) return { ok: false, error: setupMessage(runtime, cmd, version.stderr || version.stdout || 'Command not found') }
  if (runtime === 'cursor') {
    return { ok: false, error: 'Cursor local runtime is not available yet. Install a non-interactive Cursor CLI/agent command and set it as the command before using this model.' }
  }
  if (runtime === 'codex') {
    const doctor = await runProcess(cmd, ['doctor', '--summary', '--no-color', '--ascii'], '', 30000)
    const text = `${doctor.stdout}\n${doctor.stderr}`
    if (!/auth\s+auth is configured/i.test(text)) {
      return { ok: false, error: setupMessage(runtime, cmd, text) }
    }
  } else if (runtime === 'claude-code') {
    const probe = await runLocalAi({
      runtime,
      command: cmd,
      model: '',
      system: 'Reply with exactly: ok',
      userText: 'ok'
    }, 45000)
    if (probe.error) return { ok: false, error: probe.error }
    if (!String(probe.text || '').trim() || /login|auth|unauthorized|not authenticated/i.test(String(probe.text || ''))) {
      return { ok: false, error: setupMessage(runtime, cmd, String(probe.text || '')) }
    }
  }
  return { ok: true, version: version.stdout.trim() || version.stderr.trim() }
}

async function runLocalAi(req, timeoutMs = 120000) {
  const runtime = req && req.runtime
  const cmd = commandFor(runtime, req && req.command)
  if (runtime === 'codex') return runCodex(cmd, req, timeoutMs)
  if (runtime === 'claude-code') return runClaude(cmd, req, timeoutMs)
  return { error: 'Cursor local runtime is not available yet. Install a non-interactive Cursor CLI/agent command before using this model.' }
}

function setupLocalRuntime(req) {
  const runtime = req && req.runtime
  const cmd = commandFor(runtime, req && req.command)
  if (runtime === 'codex') return startInteractiveSetup(cmd, ['login', '--device-auth'], runtime)
  if (runtime === 'claude-code') return startInteractiveSetup(cmd, ['setup-token'], runtime)
  return Promise.resolve({
    ok: false,
    error: 'Cursor local setup is not automated yet. Install and authorize a non-interactive Cursor CLI/agent command, then configure that command here.'
  })
}

function startInteractiveSetup(cmd, args, runtime) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }
    const inspect = () => {
      const plain = stripAnsi(output)
      const url = (plain.match(/https?:\/\/\S+/) || [])[0]
      const code = (plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/) || [])[0]
      if (url) void shell.openExternal(url)
      if (runtime === 'codex' && url && code) {
        finish({ ok: true, url, code, message: `Browser sign-in opened. Enter code ${code}, finish authorization, then click "Check again".` })
      } else if (runtime === 'claude-code' && (url || /token|browser|login|sign in/i.test(plain))) {
        finish({
          ok: true,
          url,
          message: url ? 'Browser sign-in opened. Finish authorization, then click "Check again".' : `${plain.slice(0, 800)}\n\nFinish authorization, then click "Check again".`
        })
      }
    }
    const timer = setTimeout(() => {
      const plain = stripAnsi(output).trim()
      finish({ ok: false, error: plain || setupMessage(runtime, cmd, 'The setup command did not return a browser sign-in link in time.'), message: plain || '' })
    }, 10000)
    child.stdout.on('data', (d) => {
      output += String(d)
      inspect()
    })
    child.stderr.on('data', (d) => {
      output += String(d)
      inspect()
    })
    child.on('error', (e) => finish({ ok: false, error: e.message, message: '' }))
    child.on('close', () => {
      if (!settled) {
        const plain = stripAnsi(output).trim()
        finish({ ok: false, error: plain || setupMessage(runtime, cmd, 'Setup exited before returning a sign-in link.'), message: plain })
      }
    })
  })
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

async function runCodex(cmd, req, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-pal-codex-'))
  const outFile = path.join(dir, 'last-message.txt')
  try {
    const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', process.cwd(), '--output-last-message', outFile]
    if (req && req.model) args.push('--model', req.model)
    args.push(promptText(req && req.system, req && req.userText))
    const result = await runProcess(cmd, args, '', timeoutMs)
    let text = ''
    try {
      text = fs.readFileSync(outFile, 'utf8')
    } catch {
      text = result.stdout
    }
    if (result.code !== 0 && !text.trim()) return { error: setupMessage(req && req.runtime, cmd, result.stderr || result.stdout) }
    return { text: text.trim() || result.stdout.trim() || result.stderr.trim() }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function runClaude(cmd, req, timeoutMs) {
  const args = ['-p', '--output-format', 'text', '--permission-mode', 'dontAsk', '--system-prompt', String(req && req.system || '')]
  if (req && req.model) args.push('--model', req.model)
  args.push(String(req && req.userText || ''))
  const result = await runProcess(cmd, args, '', timeoutMs)
  if (result.code !== 0) return { error: setupMessage(req && req.runtime, cmd, result.stderr || result.stdout) }
  return { text: result.stdout.trim() }
}

function commandFor(runtime, command) {
  if (command && String(command).trim()) return String(command).trim()
  if (runtime === 'claude-code') return 'claude'
  if (runtime === 'cursor') return 'cursor'
  return 'codex'
}

function promptText(system, userText) {
  return `System instructions:\n${String(system || '')}\n\nUser/context:\n${String(userText || '')}`
}

function setupMessage(runtime, command, detail) {
  const clean = String(detail || '').trim().slice(0, 1200)
  if (runtime === 'codex') return `Codex local is not ready. Run "${command} login" in Terminal, finish authorization, then try this model again.${clean ? `\n\n${clean}` : ''}`
  if (runtime === 'claude-code') return `Claude Code local is not ready. Run "${command} setup-token" or "${command}" in Terminal, finish authorization, then try this model again.${clean ? `\n\n${clean}` : ''}`
  return `Cursor local is not ready. Install and authorize a non-interactive Cursor CLI/agent command, then configure that command here.${clean ? `\n\n${clean}` : ''}`
}

function runProcess(cmd, args, input, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr || e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    if (input) child.stdin.write(input)
    child.stdin.end()
  })
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
  registerLocalAiIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
