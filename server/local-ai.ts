import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type LocalRuntime = 'codex' | 'claude-code' | 'cursor'

export interface LocalAiRequest {
  runtime: LocalRuntime
  command?: string
  model?: string
  system: string
  userText: string
}

const activeSetups = new Set<ChildProcessWithoutNullStreams>()

export async function checkLocalRuntime(runtime: LocalRuntime, command?: string, model?: string) {
  const cmd = commandFor(runtime, command)
  const version = await runProcess(cmd, ['--version'], '', 8000)
  if (version.code !== 0) {
    return {
      ok: false,
      error: setupMessage(runtime, cmd, version.stderr || version.stdout || 'Command not found')
    }
  }
  if (runtime === 'cursor') {
    return {
      ok: false,
      error: 'Cursor local runtime is not available yet. Install a non-interactive Cursor CLI/agent command and set it as the command before using this model.'
    }
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
    if (!probe.text.trim() || /login|auth|unauthorized|not authenticated/i.test(probe.text)) {
      return { ok: false, error: setupMessage(runtime, cmd, probe.text) }
    }
  }
  return { ok: true, version: version.stdout.trim() || version.stderr.trim() }
}

export async function setupLocalRuntime(runtime: LocalRuntime, command?: string) {
  const cmd = commandFor(runtime, command)
  const version = await runProcess(cmd, ['--version'], '', 8000)
  if (version.code !== 0) return { ok: false, error: setupMessage(runtime, cmd, version.stderr || version.stdout || 'Command not found') }
  if (runtime === 'codex') return startInteractiveSetup(cmd, ['login', '--device-auth'], runtime)
  if (runtime === 'claude-code') return startInteractiveSetup(cmd, ['setup-token'], runtime)
  return {
    ok: false,
    error: 'Cursor local setup is not automated yet. Install and authorize a non-interactive Cursor CLI/agent command, then configure that command here.'
  }
}

export async function runLocalAi(req: LocalAiRequest, timeoutMs = 120000): Promise<{ text: string }> {
  const cmd = commandFor(req.runtime, req.command)
  if (req.runtime === 'codex') return runCodex(cmd, req, timeoutMs)
  if (req.runtime === 'claude-code') return runClaude(cmd, req, timeoutMs)
  throw new Error('Cursor local runtime is not available yet. Install a non-interactive Cursor CLI/agent command before using this model.')
}

function startInteractiveSetup(cmd: string, args: string[], runtime: LocalRuntime): Promise<{ ok: boolean; message: string; url?: string; code?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    activeSetups.add(child)
    let output = ''
    let settled = false
    const finish = (payload: { ok: boolean; message: string; url?: string; code?: string; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }
    const inspect = () => {
      const plain = stripAnsi(output)
      const url = plain.match(/https?:\/\/\S+/)?.[0]
      const code = plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0]
      if (url) void openExternalUrl(url)
      if (runtime === 'codex' && url && code) {
        finish({
          ok: true,
          url,
          code,
          message: `Browser sign-in opened. Enter code ${code}, finish authorization, then click "Check again".`
        })
      } else if (runtime === 'claude-code' && (url || /token|browser|login|sign in/i.test(plain))) {
        finish({
          ok: true,
          url,
          message: url
            ? 'Browser sign-in opened. Finish authorization, then click "Check again".'
            : `${plain.slice(0, 800)}\n\nFinish authorization, then click "Check again".`
        })
      }
    }
    const timer = setTimeout(() => {
      const plain = stripAnsi(output).trim()
      finish({
        ok: false,
        error: plain || setupMessage(runtime, cmd, 'The setup command did not return a browser sign-in link in time.'),
        message: plain || ''
      })
    }, 10000)
    child.stdout.on('data', (d) => {
      output += String(d)
      inspect()
    })
    child.stderr.on('data', (d) => {
      output += String(d)
      inspect()
    })
    child.on('error', (e) => {
      activeSetups.delete(child)
      finish({ ok: false, error: e.message, message: '' })
    })
    child.on('close', () => {
      activeSetups.delete(child)
      if (!settled) {
        const plain = stripAnsi(output).trim()
        finish({ ok: false, error: plain || setupMessage(runtime, cmd, 'Setup exited before returning a sign-in link.'), message: plain })
      }
    })
  })
}

function stripAnsi(s: string) {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function openExternalUrl(url: string): Promise<void> {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  return new Promise((resolve) => {
    const child = spawn(opener, args, { stdio: 'ignore', detached: true })
    child.on('error', () => resolve())
    child.unref()
    resolve()
  })
}

async function runCodex(cmd: string, req: LocalAiRequest, timeoutMs: number) {
  const dir = await mkdtemp(path.join(tmpdir(), 'thinking-pal-codex-'))
  const outFile = path.join(dir, 'last-message.txt')
  try {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '-C', process.cwd(),
      '--output-last-message', outFile
    ]
    if (req.model) args.push('--model', req.model)
    args.push(promptText(req.system, req.userText))
    const result = await runProcess(cmd, args, '', timeoutMs)
    let text = ''
    try {
      text = await readFile(outFile, 'utf8')
    } catch {
      text = result.stdout
    }
    if (result.code !== 0 && !text.trim()) throw new Error(setupMessage(req.runtime, cmd, result.stderr || result.stdout))
    return { text: text.trim() || result.stdout.trim() || result.stderr.trim() }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function runClaude(cmd: string, req: LocalAiRequest, timeoutMs: number) {
  const args = ['-p', '--output-format', 'text', '--permission-mode', 'dontAsk', '--system-prompt', req.system]
  if (req.model) args.push('--model', req.model)
  args.push(req.userText)
  const result = await runProcess(cmd, args, '', timeoutMs)
  if (result.code !== 0) throw new Error(setupMessage(req.runtime, cmd, result.stderr || result.stdout))
  return { text: result.stdout.trim() }
}

function commandFor(runtime: LocalRuntime, command?: string) {
  if (command?.trim()) return command.trim()
  if (runtime === 'claude-code') return 'claude'
  if (runtime === 'cursor') return 'cursor'
  return 'codex'
}

function promptText(system: string, userText: string) {
  return `System instructions:\n${system}\n\nUser/context:\n${userText}`
}

function setupMessage(runtime: LocalRuntime, command: string, detail: string) {
  const clean = detail.trim().slice(0, 1200)
  if (runtime === 'codex') {
    return `Codex local is not ready. Run "${command} login" in Terminal, finish authorization, then try this model again.${clean ? `\n\n${clean}` : ''}`
  }
  if (runtime === 'claude-code') {
    return `Claude Code local is not ready. Run "${command} setup-token" or "${command}" in Terminal, finish authorization, then try this model again.${clean ? `\n\n${clean}` : ''}`
  }
  return `Cursor local is not ready. Install and authorize a non-interactive Cursor CLI/agent command, then configure that command here.${clean ? `\n\n${clean}` : ''}`
}

function runProcess(cmd: string, args: string[], input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
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
