#!/usr/bin/env node

/**
 * Codex Agent - Background process that participates in discussions
 *
 * Usage:
 *   codex-agent start [--model gpt-5.3] [--nickname codex-1]
 *   codex-agent stop
 *   codex-agent status
 */

import { AgentBase } from '../lib/agent-base.js'
import { callCodex, parseCodexResponse, buildDiscussionPrompt, isCodexAvailable } from '../lib/codex-client.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PID_DIR = path.join(process.env.HOME, '.multi-agent', 'pids')
const LOG_DIR = path.join(process.env.HOME, '.multi-agent', 'logs')

function ensureDirs() {
  if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true })
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
}

/**
 * Codex Agent class
 */
class CodexAgent extends AgentBase {
  constructor(options = {}) {
    super({
      name: options.nickname || 'codex',
      pollInterval: options.pollInterval || 3000,
      baseDir: options.baseDir,
      maxConcurrent: options.maxConcurrent,
      maxQueueSize: options.maxQueueSize
    })

    this.model = options.model || 'gpt-5.3'
    this.reasoningEffort = options.reasoningEffort || 'xhigh'
    this.sandbox = options.sandbox || 'workspace-write'
    this.timeout = options.timeout || 300000  // 5 minutes (MCP startup + thinking takes time)
    this.defaultWorkingDir = options.workingDir || process.cwd()
  }

  /**
   * Respond to a discussion trigger using Codex CLI
   */
  async respondToTrigger(discussionId, trigger, allMessages, round) {
    // Call base class for lock and round-dedup checks
    await super.respondToTrigger(discussionId, trigger, allMessages, round)

    console.log(`[${this.name}] Processing trigger in ${discussionId} (round ${round})...`)

    // Get discussion status to extract workingDir from context
    const status = this.discussion.getStatus(discussionId)
    const workingDir = status.context?.workingDir || this.defaultWorkingDir

    // Send thinking status
    this.sendThinkingStatus(discussionId, round)

    // Build context for Codex
    const context = this.formatContextForLLM(discussionId, allMessages)
    const prompt = buildDiscussionPrompt(context, this.name, { workingDir, round })

    // Call Codex with the discussion's working directory
    console.log(`[${this.name}] Calling Codex (${this.model}) in ${workingDir} for round ${round}...`)
    const result = await callCodex(prompt, {
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      sandbox: this.sandbox,
      timeout: this.timeout,
      workingDir
    })

    if (!result.ok) {
      console.error(`[${this.name}] Codex call failed:`, result.error)

      // Release lock before retry/error handling
      this.responding.delete(discussionId)

      // Handle timeout with retry
      if (result.error === 'Timeout' || result.error.includes('Timeout')) {
        await this.handleTimeoutWithRetry(discussionId, trigger, allMessages, result.error, round)
      } else {
        this.sendError(discussionId, `Codex error: ${result.error}`, round)
      }
      return
    }

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

      const retryResult = await callCodex(prompt, {
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        sandbox: this.sandbox,
        timeout: this.timeout,
        workingDir
      })

      if (!retryResult.ok) {
        console.error(`[${this.name}] Codex retry failed:`, retryResult.error)
        this.responding.delete(discussionId)
        if (retryResult.error === 'Timeout' || retryResult.error.includes('Timeout')) {
          await this.handleTimeoutWithRetry(discussionId, trigger, allMessages, retryResult.error, round)
        } else {
          this.sendError(discussionId, `Codex retry error: ${retryResult.error}`, round)
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
    const { opinion, content, confidence } = parseCodexResponse(identityCheck.normalizedOutput)
    const finalContent = this.applyConsensusClosure(content, opinion, discussionId)

    // Clear retry state on success
    this.pendingRetries?.delete(discussionId)

    // Send response
    this.sendResponse(discussionId, round, opinion, finalContent, confidence)
  }
}

function printUsage() {
  console.log(`
Codex Agent - Background process for multi-agent discussions

Usage:
  codex-agent start [options]           Start the agent
  codex-agent stop [nickname]           Stop the agent
  codex-agent status                    Show agent status

Options:
  --model <model>                       Codex model (default: gpt-5.3)
  --reasoning-effort <level>            Reasoning effort (default: xhigh)
  --nickname <name>                     Agent nickname (default: codex)
  --interval <ms>                       Polling interval (default: 3000)
  --max-concurrent <n>                  Max concurrent responses (default: 5)
  --max-queue-size <n>                  Max queued responses (default: 20)
  --working-dir <dir>                   Working directory for Codex

Examples:
  codex-agent start --nickname codex-1
  codex-agent start --model o3 --nickname smart-codex
  codex-agent stop codex-1
`)
}

function parseArgs(args) {
  const result = {
    command: null,
    model: 'gpt-5.3',
    reasoningEffort: 'xhigh',
    nickname: 'codex',
    interval: 3000,
    maxConcurrent: 5,
    maxQueueSize: 20,
    workingDir: process.cwd(),
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

    if (arg === '--reasoning-effort') {
      result.reasoningEffort = args[++i]
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

    if (!result.command) {
      result.command = arg
    }
  }

  return result
}

function getPidFile(nickname) {
  return path.join(PID_DIR, `codex-agent-${nickname}.pid`)
}

function getLogFile(nickname) {
  return path.join(LOG_DIR, `codex-agent-${nickname}.log`)
}

async function handleStart(opts) {
  ensureDirs()

  const pidFile = getPidFile(opts.nickname)

  // Check if already running
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    try {
      process.kill(pid, 0) // Check if process exists
      console.log(`Codex agent already running (pid: ${pid}, nickname: ${opts.nickname})`)
      return
    } catch {
      // Process not running, clean up
      fs.rmSync(pidFile, { force: true })
    }
  }

  // Check if codex is available
  console.log('Checking Codex CLI availability...')
  const available = await isCodexAvailable()
  if (!available) {
    console.error('Error: Codex CLI is not available. Please install it first.')
    console.error('Run: npm install -g @openai/codex')
    process.exit(1)
  }

  console.log('Codex CLI is available.')

  // Start daemon
  const logFile = getLogFile(opts.nickname)
  const args = [
    __dirname + '/codex-agent.js',
    '_run',
    '--model', opts.model,
    '--reasoning-effort', opts.reasoningEffort,
    '--nickname', opts.nickname,
    '--interval', String(opts.interval),
    '--max-concurrent', String(opts.maxConcurrent),
    '--max-queue-size', String(opts.maxQueueSize),
    '--working-dir', opts.workingDir
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

  console.log(`✓ Codex agent started`)
  console.log(`  PID: ${child.pid}`)
  console.log(`  Nickname: ${opts.nickname}`)
  console.log(`  Model: ${opts.model}`)
  console.log(`  Reasoning Effort: ${opts.reasoningEffort}`)
  console.log(`  Log: ${logFile}`)
}

function handleStop(opts) {
  ensureDirs()

  const nickname = opts.nickname || 'codex'
  const pidFile = getPidFile(nickname)

  if (!fs.existsSync(pidFile)) {
    console.log(`No codex agent running with nickname: ${nickname}`)
    return
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)

  try {
    process.kill(pid, 'SIGTERM')
    console.log(`✓ Stopped codex agent (pid: ${pid}, nickname: ${nickname})`)
  } catch {
    console.log(`Codex agent not running (pid: ${pid})`)
  }

  fs.rmSync(pidFile, { force: true })
}

function handleStatus(opts) {
  ensureDirs()

  const files = fs.readdirSync(PID_DIR).filter(f => f.startsWith('codex-agent-') && f.endsWith('.pid'))

  if (files.length === 0) {
    console.log('No codex agents running.')
    return
  }

  console.log(`Found ${files.length} codex agent(s):\n`)

  for (const file of files) {
    const nickname = file.replace('codex-agent-', '').replace('.pid', '')
    const pidFile = path.join(PID_DIR, file)
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)

    let status = 'stopped'
    try {
      process.kill(pid, 0)
      status = 'running'
    } catch {
      // Process not running
    }

    console.log(`  [${status.toUpperCase()}] ${nickname} (pid: ${pid})`)
  }
}

async function runAgent(opts) {
  // This is called when running as a daemon
  const agent = new CodexAgent({
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    nickname: opts.nickname,
    pollInterval: opts.interval,
    maxConcurrent: opts.maxConcurrent,
    maxQueueSize: opts.maxQueueSize,
    workingDir: opts.workingDir
  })

  // Write PID
  ensureDirs()
  const pidFile = getPidFile(opts.nickname)
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8')

  // Cleanup on exit
  process.on('exit', () => {
    try {
      fs.rmSync(pidFile, { force: true })
    } catch {}
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

  // Start agent
  await agent.start()

  // Keep process alive
  setInterval(() => {}, 1000 * 60 * 60)
}

async function main() {
  const args = process.argv.slice(2)
  const opts = parseArgs(args)

  if (opts.showHelp) {
    printUsage()
    process.exit(0)
  }

  // Internal run command (used when daemonizing)
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
