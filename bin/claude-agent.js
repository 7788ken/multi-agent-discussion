#!/usr/bin/env node

/**
 * Claude Agent - Background process that participates in discussions
 *
 * Usage:
 *   claude-agent start [--model sonnet] [--nickname claude]
 *   claude-agent stop
 *   claude-agent status
 */

import { AgentBase } from '../lib/agent-base.js'
import { callClaude, parseClaudeResponse, buildDiscussionPrompt, isClaudeAvailable } from '../lib/claude-client.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PID_DIR = path.join(process.env.HOME, '.multi-agent', 'pids')
const LOG_DIR = path.join(process.env.HOME, '.multi-agent', 'logs')

function ensureDirs() {
  if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true })
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
}

/**
 * Claude Agent class
 */
class ClaudeAgent extends AgentBase {
  constructor(options = {}) {
    super({
      name: options.nickname || 'claude',
      pollInterval: options.pollInterval || 3000,
      baseDir: options.baseDir,
      maxConcurrent: options.maxConcurrent,
      maxQueueSize: options.maxQueueSize
    })

    this.model = options.model || 'sonnet'
    this.timeout = options.timeout || 60000  // 60 秒（之前是 180 秒）
    this.defaultWorkingDir = options.workingDir || ''
  }

  /**
   * Respond to a discussion trigger using Claude CLI
   */
  async respondToTrigger(discussionId, trigger, allMessages, round) {
    // Call base class for lock and round-dedup checks
    await super.respondToTrigger(discussionId, trigger, allMessages, round)

    console.log(`[${this.name}] Processing trigger in ${discussionId} (round ${round})...`)

    // Get discussion status to extract workingDir from context
    const status = this.discussion.getStatus(discussionId)
    const workingDir = status.context?.workingDir || this.defaultWorkingDir

    // Send initial thinking status with detail
    this.sendThinkingStatus(discussionId, round, 'is preparing to respond...')

    // Build context for Claude
    this.updateThinkingDetail(discussionId, round, 'is analyzing the discussion context...')
    const context = this.formatContextForLLM(discussionId, allMessages)
    const prompt = buildDiscussionPrompt(context, this.name, { workingDir, round })

    // Call Claude with the discussion's working directory
    this.updateThinkingDetail(discussionId, round, `is calling ${this.model} API...`)
    console.log(`[${this.name}] Calling Claude (${this.model}) in ${workingDir || 'no working dir'} for round ${round}...`)
    const result = await callClaude(prompt, {
      model: this.model,
      timeout: this.timeout,
      workingDir,
      discussionId
    })

    if (!result.ok) {
      console.error(`[${this.name}] Claude call failed:`, result.error)

      // Release lock before retry/error handling
      this.responding.delete(discussionId)

      // Handle timeout with retry
      if (result.error === 'Timeout' || result.error.includes('Timeout')) {
        await this.handleTimeoutWithRetry(discussionId, trigger, allMessages, result.error, round)
      } else {
        this.sendError(discussionId, `Claude error: ${result.error}`, round)
      }
      return
    }

    // Parse response
    this.updateThinkingDetail(discussionId, round, 'is processing the response...')
    let normalizedOutput = result.output
    let identityCheck = this.validateAgentOutput(normalizedOutput)
    if (!identityCheck.ok) {
      console.warn(`[${this.name}] Identity validation failed (${identityCheck.reason}), retrying once...`)
      try {
        this.discussion.append(discussionId, {
          from: this.name,
          type: 'status',
          status: 'retrying',
          round,
          content: `${this.name} detected identity mismatch, retrying once...`
        })
      } catch {}

      const retryResult = await callClaude(prompt, {
        model: this.model,
        timeout: this.timeout,
        workingDir
      })

      if (!retryResult.ok) {
        console.error(`[${this.name}] Claude retry failed:`, retryResult.error)
        this.responding.delete(discussionId)
        if (retryResult.error === 'Timeout' || retryResult.error.includes('Timeout')) {
          await this.handleTimeoutWithRetry(discussionId, trigger, allMessages, retryResult.error, round)
        } else {
          this.sendError(discussionId, `Claude retry error: ${retryResult.error}`, round)
        }
        return
      }

      normalizedOutput = retryResult.output
      identityCheck = this.validateAgentOutput(normalizedOutput)
      if (!identityCheck.ok) {
        this.responding.delete(discussionId)
        this.sendError(discussionId, `Identity validation failed after retry: ${identityCheck.reason}`, round)
        return
      }
    }

    // Release lock on success
    this.responding.delete(discussionId)

    // Parse response
    const { opinion, content, confidence } = parseClaudeResponse(identityCheck.normalizedOutput)
    const finalContent = this.applyConsensusClosure(content, opinion, discussionId)

    // Clear retry state on success
    this.pendingRetries?.delete(discussionId)

    // Send response
    this.sendResponse(discussionId, round, opinion, finalContent, confidence)
  }
}

function printUsage() {
  console.log(`
Claude Agent - Background process for multi-agent discussions

Usage:
  claude-agent start [options]           Start the agent
  claude-agent stop [nickname]           Stop the agent
  claude-agent status                    Show agent status

Options:
  --model <model>                       Claude model (default: sonnet)
  --nickname <name>                     Agent nickname (default: claude)
  --interval <ms>                       Polling interval (default: 3000)
  --max-concurrent <n>                  Max concurrent responses (default: 5)
  --max-queue-size <n>                  Max queued responses (default: 20)
  --working-dir <dir>                   Working directory for Claude
  --base-dir <dir>                      Discussion directory (default: <working-dir>/discussions)

Examples:
  claude-agent start --nickname claude
  claude-agent start --model opus --nickname smart-claude
  claude-agent stop claude
`)
}

function parseArgs(args) {
  const result = {
    command: null,
    model: 'sonnet',
    nickname: 'claude',
    interval: 3000,
    maxConcurrent: 5,
    maxQueueSize: 20,
    workingDir: process.cwd(),
    baseDir: null,
    showHelp: false
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-h' || arg === '--help') {
      result.showHelp = true
      return result
    }

    if (arg === '--model') {
      result.model = args[++i]
      continue
    }

    if (arg === '--nickname') {
      result.nickname = args[++i]
      continue
    }

    if (arg === '--interval') {
      result.interval = parseInt(args[++i], 10)
      continue
    }

    if (arg === '--max-concurrent') {
      result.maxConcurrent = parseInt(args[++i], 10)
      continue
    }

    if (arg === '--max-queue-size') {
      result.maxQueueSize = parseInt(args[++i], 10)
      continue
    }

    if (arg === '--working-dir') {
      result.workingDir = args[++i]
      continue
    }

    if (arg === '--base-dir') {
      result.baseDir = args[++i]
      continue
    }

    if (!result.command) {
      result.command = arg
    }
  }

  if (!result.baseDir) {
    result.baseDir = path.join(result.workingDir, 'discussions')
  }

  return result
}

function normalizeWorkingDir(workingDir) {
  const resolved = path.resolve(workingDir || process.cwd())
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function getWorkingDirHash(workingDir) {
  return crypto.createHash('sha1').update(normalizeWorkingDir(workingDir)).digest('hex').slice(0, 12)
}

function getPidFile(nickname, workingDir) {
  return path.join(PID_DIR, `claude-agent-${nickname}-${getWorkingDirHash(workingDir)}.pid`)
}

function getLegacyPidFile(nickname) {
  return path.join(PID_DIR, `claude-agent-${nickname}.pid`)
}

function readPid(pidFile) {
  if (!fs.existsSync(pidFile)) return null
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseWorkingDirFromCommand(commandLine) {
  const match = commandLine.match(/--working-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/)
  if (!match) return null
  return match[1] || match[2] || match[3] || null
}

function isLegacyPidForWorkingDir(pid, workingDir) {
  try {
    const commandLine = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim()
    const processWorkingDir = parseWorkingDirFromCommand(commandLine)
    if (!processWorkingDir) return false
    return normalizeWorkingDir(processWorkingDir) === normalizeWorkingDir(workingDir)
  } catch {
    return false
  }
}

function parsePidFileMeta(file) {
  const scoped = file.match(/^claude-agent-(.+)-([a-f0-9]{12})\.pid$/)
  if (scoped) {
    return {
      nickname: scoped[1],
      scopeLabel: `wd:${scoped[2]}`
    }
  }

  const legacy = file.match(/^claude-agent-(.+)\.pid$/)
  if (legacy) {
    return {
      nickname: legacy[1],
      scopeLabel: 'legacy'
    }
  }

  return null
}

function getLogFile(nickname) {
  return path.join(LOG_DIR, `claude-agent-${nickname}.log`)
}

async function handleStart(opts) {
  ensureDirs()

  const pidFile = getPidFile(opts.nickname, opts.workingDir)
  const legacyPidFile = getLegacyPidFile(opts.nickname)

  // Check if already running
  const scopedPid = readPid(pidFile)
  if (scopedPid && isPidRunning(scopedPid)) {
    console.log(`Claude agent already running (pid: ${scopedPid}, nickname: ${opts.nickname})`)
    return
  }
  if (fs.existsSync(pidFile) && !scopedPid) {
    fs.rmSync(pidFile, { force: true })
  }
  if (scopedPid && !isPidRunning(scopedPid)) {
    fs.rmSync(pidFile, { force: true })
  }

  const legacyPid = readPid(legacyPidFile)
  if (legacyPid && isPidRunning(legacyPid)) {
    if (isLegacyPidForWorkingDir(legacyPid, opts.workingDir)) {
      console.log(`Claude agent already running (pid: ${legacyPid}, nickname: ${opts.nickname}, legacy pid)`)
      return
    }
  } else if (fs.existsSync(legacyPidFile)) {
    fs.rmSync(legacyPidFile, { force: true })
  }

  // Check if Claude is available
  console.log('Checking Claude CLI availability...')
  const available = await isClaudeAvailable()
  if (!available) {
    console.error('Error: Claude CLI is not available.')
    process.exit(1)
  }

  console.log('Claude CLI is available.')

  // Start daemon
  const logFile = getLogFile(opts.nickname)
  const args = [
    __dirname + '/claude-agent.js',
    '_run',
    '--model', opts.model,
    '--nickname', opts.nickname,
    '--interval', String(opts.interval),
    '--max-concurrent', String(opts.maxConcurrent),
    '--max-queue-size', String(opts.maxQueueSize),
    '--working-dir', opts.workingDir,
    '--base-dir', opts.baseDir
  ]

  const { spawn } = await import('child_process')
  const logStream = fs.openSync(logFile, 'a')

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    cwd: opts.workingDir
  })

  child.unref()

  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8')

  console.log(`✓ Claude agent started`)
  console.log(`  PID: ${child.pid}`)
  console.log(`  Nickname: ${opts.nickname}`)
  console.log(`  Model: ${opts.model}`)
  console.log(`  Log: ${logFile}`)
}

function handleStop(opts) {
  ensureDirs()

  const nickname = opts.nickname || 'claude'
  const pidFile = getPidFile(nickname, opts.workingDir)
  const legacyPidFile = getLegacyPidFile(nickname)
  let stopped = false

  const scopedPid = readPid(pidFile)
  if (scopedPid && isPidRunning(scopedPid)) {
    try {
      process.kill(scopedPid, 'SIGTERM')
      console.log(`✓ Stopped claude agent (pid: ${scopedPid}, nickname: ${nickname})`)
    } catch {
      console.log(`Claude agent not running (pid: ${scopedPid})`)
    }
    stopped = true
  }
  if (fs.existsSync(pidFile)) {
    fs.rmSync(pidFile, { force: true })
  }

  const legacyPid = readPid(legacyPidFile)
  if (legacyPid && isPidRunning(legacyPid) && isLegacyPidForWorkingDir(legacyPid, opts.workingDir)) {
    try {
      process.kill(legacyPid, 'SIGTERM')
      console.log(`✓ Stopped claude agent (pid: ${legacyPid}, nickname: ${nickname}, legacy pid)`)
    } catch {
      console.log(`Claude agent not running (pid: ${legacyPid})`)
    }
    stopped = true
    fs.rmSync(legacyPidFile, { force: true })
  } else if (legacyPid && !isPidRunning(legacyPid)) {
    fs.rmSync(legacyPidFile, { force: true })
  }

  if (!stopped) {
    console.log(`No claude agent running with nickname: ${nickname} in working dir: ${normalizeWorkingDir(opts.workingDir)}`)
  }
}

function handleStatus(opts) {
  ensureDirs()

  const files = fs.readdirSync(PID_DIR).filter(f => f.startsWith('claude-agent-') && f.endsWith('.pid'))

  if (files.length === 0) {
    console.log('No claude agents running.')
    return
  }

  console.log(`Found ${files.length} claude agent(s):\n`)

  for (const file of files) {
    const meta = parsePidFileMeta(file)
    if (!meta) continue

    const pidFile = path.join(PID_DIR, file)
    const pid = readPid(pidFile)
    if (!pid) {
      fs.rmSync(pidFile, { force: true })
      continue
    }

    let status = 'stopped'
    if (isPidRunning(pid)) status = 'running'

    console.log(`  [${status.toUpperCase()}] ${meta.nickname} (${meta.scopeLabel}, pid: ${pid})`)
  }
}

async function runAgent(opts) {
  const agent = new ClaudeAgent({
    model: opts.model,
    nickname: opts.nickname,
    pollInterval: opts.interval,
    maxConcurrent: opts.maxConcurrent,
    maxQueueSize: opts.maxQueueSize,
    workingDir: opts.workingDir,
    baseDir: opts.baseDir
  })

  ensureDirs()
  const pidFile = getPidFile(opts.nickname, opts.workingDir)
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8')

  process.on('exit', () => {
    try { fs.rmSync(pidFile, { force: true }) } catch {}
  })

  process.on('SIGINT', () => {
    console.log(`\n[${opts.nickname}] Received SIGINT, shutting down...`)
    agent.stop()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log(`\n[${opts.nickname}] Received SIGTERM, shutting down...`)
    agent.stop()
    process.exit(0)
  })

  await agent.start()
  setInterval(() => {}, 1000 * 60 * 60)
}

async function main() {
  const args = process.argv.slice(2)
  const opts = parseArgs(args)

  if (opts.showHelp) {
    printUsage()
    process.exit(0)
  }

  if (opts.command === '_run') {
    await runAgent(opts)
    return
  }

  if (!opts.command) {
    printUsage()
    process.exit(1)
  }

  switch (opts.command) {
    case 'start':
      await handleStart(opts)
      break
    case 'stop':
      handleStop(opts)
      break
    case 'status':
      handleStatus(opts)
      break
    default:
      console.error(`Unknown command: ${opts.command}`)
      printUsage()
      process.exit(1)
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
