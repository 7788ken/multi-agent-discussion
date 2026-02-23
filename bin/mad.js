#!/usr/bin/env node

/**
 * Multi-Agent Discussion CLI
 *
 * Usage:
 *   mad new "topic" -p claude,codex --agent-max-concurrent "claude=1,codex=2"
 *   mad status <id>                     # Show discussion status
 *   mad history <id>                    # Show discussion history
 *   mad ask <id> "question"             # Ask follow-up question
 *   mad end <id> -d "decision"          # End discussion
 *   mad list                            # List all discussions
 *   mad ui [id] --port 5188             # Open local HTML UI
 */

import { Discussion } from '../lib/discussion.js'
import { Coordinator } from '../lib/coordinator.js'
import { startUiServer } from '../lib/ui-server.js'
import {
  createFollowupMessage,
  createModeMessage,
  createEndMessage,
  createResponseMessage,
  OPINIONS
} from '../lib/message.js'
import { startTui } from '../lib/tui.js'
import readline from 'readline'
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workingDir = process.cwd()
const baseDir = process.env.MULTI_AGENT_BASE_DIR || path.join(workingDir, 'discussions')
const discussion = new Discussion(baseDir)
const coordinator = new Coordinator({ baseDir })
const SUPPORTED_AUTO_RESTART_AGENTS = new Set(['claude', 'codex'])
const AGENT_MAX_CONCURRENT_FILE = 'agent-max-concurrent.json'

function printUsage() {
  console.log(`
Multi-Agent Discussion (mad) CLI

Usage:
  mad new <topic> -p <participants>    Create a new discussion (auto-enters watch mode)
  mad new <topic> --no-watch           Create discussion without watching
  mad status <id>                       Show discussion status
  mad history <id>                      Show full discussion history
  mad ask <id> <question>               Ask a follow-up question
  mad end <id> -d <decision>            End discussion with decision
  mad end all [-d <decision>]           End all active discussions
  mad list                              List all discussions
  mad watch <id>                        Watch discussion for new messages
  mad analyze <id>                      Analyze discussion for consensus
  mad summary <id>                      Generate discussion summary
  mad mode <id> co-dev <on|off>         Toggle co-development mode
  mad tui [id]                          Open full-screen terminal UI
  mad ui [id] [--port 5188]             Open local HTML UI
  mad web [id] [--port 5188]            Alias of 'mad ui'

Watch Mode Commands:
  When in watch mode (after 'mad new'), you can:
  - Type a message to ask a follow-up question
  - Type 'status' or 's' to see current status
  - Type 'analyze' or 'a' to see consensus analysis
  - Type 'end <decision>' to end the discussion
  - Type 'quit' or 'q' to exit watch mode

Options:
  -p, --participants <list>             Comma-separated list of agents (default: claude,codex)
  -d, --decision <text>                 Final decision text
  -f, --from <agent>                    Response from specific agent
  -o, --opinion <type>                  Opinion type: agree, disagree, neutral, alternative
  -c, --confidence <num>                Confidence level (0-1)
  -w, --watch                           Watch mode (default: true for 'new')
  --no-watch                            Disable auto-watch for 'new'
  --no-restart-agents                   Disable auto-restart for 'new'
  --co-dev                              Enable co-development mode for new discussion
  --no-co-dev                           Disable co-development mode for new discussion
  --agent-max-concurrent <mapping>      Per-agent max concurrency, e.g. "claude=1,codex=2"
  --port <num>                          HTTP port for UI server (default: 5188)

Examples:
  mad new "API design: REST vs GraphQL" -p claude,codex
  mad new "Implement feature X" -p claude,codex --co-dev
  mad new "Use existing agents" -p claude,codex --no-restart-agents
  mad new "Load test" -p claude,codex --agent-max-concurrent "claude=1,codex=2"
  mad status abc123-api-design
  mad ask abc123 "What about caching?"
  mad mode abc123 co-dev on
  mad analyze abc123
  mad summary abc123
  mad tui
  mad tui abc123
  mad ui
  mad ui abc123 --port 5188
  mad web abc123
  mad end abc123 -d "Using REST with GraphQL federation"
  mad end all -d "Emergency stop"
`)
}

function parseAgentMaxConcurrent(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      error: '--agent-max-concurrent requires a value, e.g. "claude=1,codex=2"'
    }
  }

  const mapping = {}
  const items = value.split(',').map(item => item.trim())

  for (const item of items) {
    if (!item) {
      return {
        ok: false,
        error: 'invalid --agent-max-concurrent format: empty item found'
      }
    }

    const pair = item.split('=')
    if (pair.length !== 2) {
      return {
        ok: false,
        error: `invalid --agent-max-concurrent item: "${item}" (expected agent=number)`
      }
    }

    const agent = pair[0].trim().toLowerCase()
    const rawMaxConcurrent = pair[1].trim()

    if (!agent) {
      return {
        ok: false,
        error: `invalid --agent-max-concurrent item: "${item}" (missing agent name)`
      }
    }

    if (!SUPPORTED_AUTO_RESTART_AGENTS.has(agent)) {
      return {
        ok: false,
        error: `unsupported agent "${agent}" in --agent-max-concurrent (supported: ${[...SUPPORTED_AUTO_RESTART_AGENTS].join(', ')})`
      }
    }

    if (Object.prototype.hasOwnProperty.call(mapping, agent)) {
      return {
        ok: false,
        error: `duplicate agent "${agent}" in --agent-max-concurrent`
      }
    }

    if (!/^\d+$/.test(rawMaxConcurrent)) {
      return {
        ok: false,
        error: `invalid max-concurrent for agent "${agent}": "${rawMaxConcurrent}" (must be a positive integer)`
      }
    }

    const maxConcurrent = parseInt(rawMaxConcurrent, 10)
    if (maxConcurrent <= 0) {
      return {
        ok: false,
        error: `invalid max-concurrent for agent "${agent}": ${maxConcurrent} (must be > 0)`
      }
    }

    mapping[agent] = maxConcurrent
  }

  return { ok: true, mapping }
}

function normalizeParticipantName(name) {
  const raw = String(name || '').trim()
  if (!raw) return ''

  const normalized = raw.toLowerCase()
  if (SUPPORTED_AUTO_RESTART_AGENTS.has(normalized)) {
    return normalized
  }

  return raw
}

function parseArgs(args) {
  const result = {
    command: null,
    topic: null,
    discussionId: null,
    question: null,
    decision: null,
    modeKey: null,
    modeValue: null,
    participants: ['claude', 'codex'],
    from: null,
    opinion: OPINIONS.NEUTRAL,
    confidence: 0.7,
    watch: null, // null = use command default, true = force watch, false = no-watch
    restartAgents: true, // default true for backward compatibility
    coDevMode: null, // null = default false for new discussions
    agentMaxConcurrent: null,
    port: 5188,
    parseError: null
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-h' || arg === '--help') {
      result.showHelp = true
      return result
    }

    if (arg === '-w' || arg === '--watch') {
      result.watch = true
      continue
    }

    if (arg === '--no-watch') {
      result.watch = false
      continue
    }

    if (arg === '--no-restart-agents') {
      result.restartAgents = false
      continue
    }

    if (arg === '--port') {
      result.port = parseInt(args[++i], 10)
      continue
    }

    if (arg === '--co-dev') {
      result.coDevMode = true
      continue
    }

    if (arg === '--no-co-dev') {
      result.coDevMode = false
      continue
    }

    if (arg === '--agent-max-concurrent') {
      const mappingValue = args[++i]
      const parsed = parseAgentMaxConcurrent(mappingValue)
      if (!parsed.ok) {
        result.parseError = parsed.error
        return result
      }
      result.agentMaxConcurrent = parsed.mapping
      continue
    }

    if (arg === '-p' || arg === '--participants') {
      result.participants = args[++i]
        .split(',')
        .map(normalizeParticipantName)
        .filter(Boolean)
      continue
    }

    if (arg === '-d' || arg === '--decision') {
      result.decision = args[++i]
      continue
    }

    if (arg === '-f' || arg === '--from') {
      result.from = args[++i]
      continue
    }

    if (arg === '-o' || arg === '--opinion') {
      result.opinion = args[++i]
      continue
    }

    if (arg === '-c' || arg === '--confidence') {
      result.confidence = parseFloat(args[++i])
      continue
    }

    // Positional arguments
    if (!result.command) {
      result.command = arg
    } else if (result.command === 'new' && !result.topic) {
      result.topic = arg
    } else if ((result.command === 'status' || result.command === 'history' || result.command === 'watch' || result.command === 'tui' || result.command === 'ui' || result.command === 'web') && !result.discussionId) {
      result.discussionId = arg
    } else if (result.command === 'ask' && !result.discussionId) {
      result.discussionId = arg
    } else if (result.command === 'ask' && !result.question) {
      result.question = arg
    } else if (result.command === 'end' && !result.discussionId) {
      result.discussionId = arg
    } else if (result.command === 'respond' && !result.discussionId) {
      result.discussionId = arg
    } else if (result.command === 'mode' && !result.discussionId) {
      result.discussionId = arg
    } else if (result.command === 'mode' && !result.modeKey) {
      result.modeKey = arg
    } else if (result.command === 'mode' && !result.modeValue) {
      result.modeValue = arg
    } else if ((result.command === 'analyze' || result.command === 'summary') && !result.discussionId) {
      result.discussionId = arg
    }
  }

  return result
}

/**
 * Parse @mention target from follow-up text.
 * Only one participant can be targeted in a single follow-up.
 * @param {string} text
 * @param {string[]} participants
 * @returns {{ ok: boolean, target: string|null, content: string, error?: string }}
 */
function parseFollowupInput(text, participants = []) {
  const content = (text || '').trim()
  const mentionRegex = /(?:^|\s)@([a-zA-Z0-9_-]+)/g
  const mentions = []
  let match

  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1].toLowerCase())
  }

  if (mentions.length === 0) {
    return { ok: true, target: null, content }
  }

  const participantMap = new Map(
    (participants || []).map(p => [String(p).toLowerCase(), p])
  )

  const matchedTargets = [...new Set(
    mentions
      .map(name => participantMap.get(name))
      .filter(Boolean)
  )]

  if (matchedTargets.length > 1) {
    return {
      ok: false,
      target: null,
      content,
      error: `同一条追问只能 @ 一个 agent，当前匹配到: ${matchedTargets.join(', ')}`
    }
  }

  if (matchedTargets.length === 0) {
    return {
      ok: false,
      target: null,
      content,
      error: `@ 目标不在当前讨论参与者中，可选: ${(participants || []).join(', ')}`
    }
  }

  return { ok: true, target: matchedTargets[0], content }
}

function parseModeToggleInput(modeKey, modeValue) {
  const key = String(modeKey || '').trim().toLowerCase()
  if (!key) {
    return { ok: false, key: null, enabled: null, error: 'mode key is required' }
  }
  if (key !== 'co-dev' && key !== 'co_dev' && key !== 'codev') {
    return { ok: false, key: null, enabled: null, error: 'only co-dev mode is supported' }
  }

  const normalizedValue = String(modeValue || '').trim().toLowerCase()
  const enabledValues = new Set(['on', 'true', '1', 'enable', 'enabled'])
  const disabledValues = new Set(['off', 'false', '0', 'disable', 'disabled'])
  if (enabledValues.has(normalizedValue)) {
    return { ok: true, key: 'co-dev', enabled: true }
  }
  if (disabledValues.has(normalizedValue)) {
    return { ok: true, key: 'co-dev', enabled: false }
  }

  return {
    ok: false,
    key: null,
    enabled: null,
    error: `invalid mode value: ${modeValue} (expected on/off)`
  }
}

function resolveCoDevModeStatus(status, messages = []) {
  let enabled = Boolean(status?.context?.coDevMode?.enabled || status?.context?.coDevEnabled)

  for (const msg of messages) {
    if (msg.type === 'mode' && (msg.key === 'co-dev' || msg.key === 'co_dev' || msg.key === 'codev')) {
      enabled = Boolean(msg.enabled)
    }
  }

  return enabled
}

function normalizeAgentMaxConcurrentConfig(config) {
  const normalized = {}
  if (!config || typeof config !== 'object') {
    return normalized
  }

  for (const [agentName, rawMaxConcurrent] of Object.entries(config)) {
    const agent = String(agentName || '').trim().toLowerCase()
    if (!SUPPORTED_AUTO_RESTART_AGENTS.has(agent)) {
      continue
    }

    let maxConcurrent = null
    if (Number.isInteger(rawMaxConcurrent)) {
      maxConcurrent = rawMaxConcurrent
    } else if (typeof rawMaxConcurrent === 'string' && /^\d+$/.test(rawMaxConcurrent.trim())) {
      maxConcurrent = parseInt(rawMaxConcurrent.trim(), 10)
    }

    if (Number.isInteger(maxConcurrent) && maxConcurrent > 0) {
      normalized[agent] = maxConcurrent
    }
  }

  return normalized
}

function readAgentMaxConcurrentConfig(baseDir) {
  const configPath = path.join(baseDir, AGENT_MAX_CONCURRENT_FILE)
  if (!fs.existsSync(configPath)) {
    return {}
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    if (!raw.trim()) {
      return {}
    }
    return normalizeAgentMaxConcurrentConfig(JSON.parse(raw))
  } catch (error) {
    console.log(`⚠️  Failed to read persisted agent max concurrency config: ${error.message}`)
    return {}
  }
}

function writeAgentMaxConcurrentConfig(baseDir, config) {
  const configPath = path.join(baseDir, AGENT_MAX_CONCURRENT_FILE)
  const normalized = normalizeAgentMaxConcurrentConfig(config)

  try {
    fs.mkdirSync(baseDir, { recursive: true })
    fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.log(`⚠️  Failed to persist agent max concurrency config: ${error.message}`)
  }
}

function mergeAgentMaxConcurrentConfig(storedConfig, overrideConfig) {
  return {
    ...normalizeAgentMaxConcurrentConfig(storedConfig),
    ...normalizeAgentMaxConcurrentConfig(overrideConfig)
  }
}

function handleNew(opts) {
  if (!opts.topic) {
    console.error('Error: topic is required')
    console.log('Usage: mad new "topic" -p claude,codex')
    process.exit(1)
  }

  // Build context with working directory
  const context = {
    workingDir,
    timestamp: new Date().toISOString(),
    coDevMode: {
      enabled: opts.coDevMode === true
    }
  }

  const { discussionId } = discussion.create(opts.topic, opts.participants, context)

  // By default we restart participant agents so they run in the current
  // working directory and pick up this discussion immediately.
  if (opts.restartAgents !== false) {
    restartAgentsForParticipants(opts.participants, context.workingDir, baseDir, opts.agentMaxConcurrent)
  } else {
    console.log('ℹ️  Skip auto-restart for participant agents (--no-restart-agents).')
  }

  console.log(`✓ Discussion created: ${discussionId}`)
  console.log(`  Topic: ${opts.topic}`)
  console.log(`  Participants: ${opts.participants.join(', ')}`)
  console.log(`  Working Dir: ${context.workingDir}`)
  console.log(`  Co-Dev Mode: ${context.coDevMode.enabled ? 'ON' : 'OFF'}`)
  console.log()

  // Auto-enter watch mode (default behavior for 'new' command)
  // watch: null or true -> enter watch mode; watch: false -> skip
  if (opts.watch !== false) {
    startInteractiveWatch(discussionId)
  } else {
    console.log(`Waiting for responses from: ${opts.participants.join(', ')}...`)
    console.log(`Run 'mad watch ${discussionId}' to enter watch mode later.`)
  }
}

/**
 * Restart agent processes for participants (best-effort).
 * @param {string[]} participants
 * @param {string} workingDir
 * @param {string} baseDir
 * @param {Record<string, number>|null} agentMaxConcurrent
 */
function restartAgentsForParticipants(participants, workingDir, baseDir, agentMaxConcurrent = null) {
  const uniqueParticipants = [...new Set(participants || [])]
  const persistedAgentMaxConcurrent = readAgentMaxConcurrentConfig(baseDir)
  const finalAgentMaxConcurrent = mergeAgentMaxConcurrentConfig(persistedAgentMaxConcurrent, agentMaxConcurrent)
  writeAgentMaxConcurrentConfig(baseDir, finalAgentMaxConcurrent)

  for (const participantName of uniqueParticipants) {
    const agentName = normalizeParticipantName(participantName)

    if (!SUPPORTED_AUTO_RESTART_AGENTS.has(agentName)) {
      console.log(`⚠️  Skip auto-restart for unsupported agent: ${agentName}`)
      continue
    }

    const agentCli = path.join(__dirname, `${agentName}-agent.js`)

    // Stop existing process with same nickname first.
    spawnSync(process.execPath, [agentCli, 'stop', agentName], {
      stdio: 'ignore'
    })

    const startArgs = [
      agentCli,
      'start',
      '--nickname', agentName,
      '--working-dir', workingDir,
      '--base-dir', baseDir
    ]
    const maxConcurrent = finalAgentMaxConcurrent?.[agentName]
    if (Number.isInteger(maxConcurrent) && maxConcurrent > 0) {
      startArgs.push('--max-concurrent', String(maxConcurrent))
    }

    const started = spawnSync(process.execPath, startArgs, {
      stdio: 'pipe',
      encoding: 'utf8',
      cwd: workingDir
    })

    if (started.status === 0) {
      console.log(`✓ Agent restarted: ${agentName} (working-dir: ${workingDir})`)
    } else {
      const err = (started.stderr || started.stdout || '').trim()
      console.log(`⚠️  Failed to restart agent ${agentName}${err ? `: ${err}` : ''}`)
    }
  }
}

/**
 * Start interactive watch mode with REPL
 * @param {string} discussionId
 */
function startInteractiveWatch(discussionId) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  let lastSeq = 0
  let stopped = false

  // Initial status
  const status = discussion.getStatus(discussionId)
  const resultFilePath = discussion.getResultFilePath(discussionId)
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`📋 Discussion: ${status.topic}`)
  console.log(`🆔 ID: ${discussionId}`)
  console.log(`👥 Participants: ${status.participants.join(', ')}`)
  console.log(`⚙️  Co-Dev Mode: ${resolveCoDevModeStatus(status, discussion.readAll(discussionId)) ? 'ON' : 'OFF'}`)
  console.log(`📁 Result File: ${resultFilePath}`)
  console.log(`${'═'.repeat(50)}`)
  console.log(`\n📝 Watch mode started. Commands:`)
  console.log(`   - Type message to ask follow-up`)
  console.log(`   - 's' or 'status' - show status with round progress`)
  console.log(`   - 'a' or 'analyze' - analyze consensus`)
  console.log(`   - 'h' or 'history' - show history`)
  console.log(`   - 'r' or 'result' - show result file path`)
  console.log(`   - 'mode co-dev on|off' - toggle co-development mode`)
  console.log(`   - 'end <decision>' - end discussion`)
  console.log(`   - 'q' or 'quit' - exit\n`)

  /**
   * Show current round status with thinking indicators
   */
  function showRoundStatus() {
    const currentStatus = discussion.getStatus(discussionId)
    const messages = discussion.readAll(discussionId)

    console.log(`\n${'─'.repeat(40)}`)
    console.log(`📊 Round ${currentStatus.currentRound || 1} Status:`)

    // Get responses in current round
    const responses = messages.filter(m =>
      m.type === 'response' && m.round === (currentStatus.currentRound || 1)
    )
    const respondedAgents = new Set(responses.map(r => r.from))

    // Get thinking status
    const thinkingStatuses = messages.filter(m =>
      m.type === 'status' && m.status === 'thinking'
    )
    const thinkingAgents = new Set(thinkingStatuses.map(s => s.from))

    for (const p of currentStatus.participants) {
      if (respondedAgents.has(p)) {
        console.log(`  ✅ ${p}: Completed`)
      } else if (thinkingAgents.has(p)) {
        console.log(`  ⏳ ${p}: Thinking...`)
      } else {
        console.log(`  ⬜ ${p}: Waiting`)
      }
    }
    console.log(`${'─'.repeat(40)}`)
  }

  // Show initial status
  showRoundStatus()

  // Poll for new messages
  const pollInterval = setInterval(() => {
    if (stopped) return
    const messages = discussion.readAll(discussionId)
    const newMessages = messages.filter(m => m.seq > lastSeq)

    for (const msg of newMessages) {
      const time = msg.ts ? new Date(msg.ts).toLocaleTimeString() : ''

      // Color based on type
      const colors = {
        response: '\x1b[32m',  // green
        followup: '\x1b[33m',  // yellow
        error: '\x1b[31m',     // red
        end: '\x1b[36m',       // cyan
        start: '\x1b[34m',     // blue
        status: '\x1b[35m'     // magenta for status messages
      }
      const reset = '\x1b[0m'
      const color = colors[msg.type] || ''

      // Handle status messages (thinking, retrying)
      if (msg.type === 'status') {
        if (msg.status === 'thinking') {
          console.log(`\n${color}[${time}] ⏳ ${msg.from}: Thinking...${reset}`)
        } else if (msg.status === 'retrying') {
          console.log(`\n${color}[${time}] 🔄 ${msg.from}: ${msg.content}${reset}`)
        }
      } else {
        console.log(`\n${color}[${time}] <${msg.from}> [${msg.type}]${reset}`)
        if (msg.content) {
          // Indent multi-line content
          console.log(msg.content.split('\n').map(l => `  ${l}`).join('\n'))
        }
        if (msg.opinion) console.log(`  Opinion: ${msg.opinion}, Confidence: ${(msg.confidence * 100).toFixed(0)}%`)
        if (msg.error) console.log(`  ERROR: ${msg.error}`)
        if (msg.decision) console.log(`  Decision: ${msg.decision}`)

        // Show round status after response
        if (msg.type === 'response') {
          showRoundStatus()
        }
      }

      lastSeq = msg.seq
    }

    // Refresh result file when there are new messages
    if (newMessages.length > 0) {
      discussion.refreshResultFile(discussionId)
    }

    // Check if discussion ended
    const currentStatus = discussion.getStatus(discussionId)
    if (currentStatus.status === 'ended') {
      console.log(`\n✅ Discussion ended. Decision: ${currentStatus.decision}`)
      console.log(`📄 Result file: ${resultFilePath}`)
      stopped = true
      clearInterval(pollInterval)
      rl.close()
    }
  }, 2000)

  // Handle user input
  rl.on('line', async (input) => {
    const trimmed = input.trim()

    if (!trimmed) return

    // Commands
    if (trimmed === 'q' || trimmed === 'quit') {
      console.log('Exiting watch mode...')
      stopped = true
      clearInterval(pollInterval)
      rl.close()
      return
    }

    if (trimmed === 's' || trimmed === 'status') {
      const s = discussion.getStatus(discussionId)
      console.log(`\n📊 Status:`)
      console.log(`   Topic: ${s.topic}`)
      console.log(`   Status: ${s.status}`)
      console.log(`   Round: ${s.currentRound}`)
      console.log(`   Messages: ${s.messageCount}`)
      console.log(`   Co-Dev Mode: ${resolveCoDevModeStatus(s, discussion.readAll(discussionId)) ? 'ON' : 'OFF'}`)
      if (s.status === 'ended') {
        console.log(`   Decision: ${s.decision}`)
      }
      showRoundStatus()
      return
    }

    if (trimmed === 'r' || trimmed === 'result') {
      console.log(`\n📄 Result file: ${resultFilePath}`)
      console.log(`   View with: cat "${resultFilePath}"`)
      console.log(`   Or open in editor: code "${resultFilePath}"`)
      return
    }

    if (trimmed === 'a' || trimmed === 'analyze') {
      const analysis = coordinator.analyzeDiscussion(discussionId)
      console.log(`\n📈 Analysis:`)
      console.log(`   Has Consensus: ${analysis.consensus.hasConsensus ? 'Yes' : 'No'}`)
      console.log(`   Agreement Level: ${(analysis.consensus.agreementLevel * 100).toFixed(0)}%`)
      console.log(`   Avg Confidence: ${(analysis.consensus.averageConfidence * 100).toFixed(0)}%`)
      return
    }

    if (trimmed === 'h' || trimmed === 'history') {
      console.log(discussion.format(discussionId))
      return
    }

    if (trimmed.startsWith('end ')) {
      const decision = trimmed.slice(4).trim()
      discussion.append(discussionId, createEndMessage(0, decision))
      console.log(`✓ Discussion ended with decision: ${decision}`)
      return
    }

    if (trimmed.startsWith('mode ')) {
      const parts = trimmed.split(/\s+/)
      if (parts.length < 3) {
        console.log('✗ Usage: mode co-dev on|off')
        return
      }
      const parsedMode = parseModeToggleInput(parts[1], parts[2])
      if (!parsedMode.ok) {
        console.log(`✗ ${parsedMode.error}`)
        return
      }
      const modeMsg = discussion.append(discussionId, createModeMessage(0, parsedMode.key, parsedMode.enabled))
      console.log(`✓ Mode updated (seq: ${modeMsg.seq}): ${parsedMode.key} ${parsedMode.enabled ? 'on' : 'off'}`)
      return
    }

    // Treat as follow-up question
    const currentStatus = discussion.getStatus(discussionId)
    const parsed = parseFollowupInput(trimmed, currentStatus.participants || [])
    if (!parsed.ok) {
      console.log(`✗ ${parsed.error}`)
      return
    }

    const msg = discussion.append(discussionId, createFollowupMessage(0, parsed.content, parsed.target))
    console.log(`✓ Follow-up sent (seq: ${msg.seq})`)
    if (parsed.target) {
      console.log(`  Target: ${parsed.target}`)
    }
  })

  rl.on('close', () => {
    stopped = true
    clearInterval(pollInterval)
  })

  // Keep process alive
  process.stdin.resume()
}

function handleStatus(opts) {
  if (!opts.discussionId) {
    console.error('Error: discussion ID is required')
    console.log('Usage: mad status <discussion-id>')
    process.exit(1)
  }

  const status = discussion.getStatus(opts.discussionId)

  if (!status.exists) {
    console.error(`Discussion not found: ${opts.discussionId}`)
    process.exit(1)
  }

  console.log(`Discussion: ${status.discussionId}`)
  console.log(`  Topic: ${status.topic}`)
  console.log(`  Status: ${status.status}`)
  console.log(`  Participants: ${status.participants.join(', ')}`)
  console.log(`  Messages: ${status.messageCount}`)
  console.log(`  Current Round: ${status.currentRound}`)
  const coDevMode = resolveCoDevModeStatus(status, discussion.readAll(opts.discussionId))
  console.log(`  Co-Dev Mode: ${coDevMode ? 'ON' : 'OFF'}`)

  if (status.status === 'ended') {
    console.log(`  Decision: ${status.decision}`)
    console.log(`  Consensus: ${status.consensus}`)
  }
}

function handleHistory(opts) {
  if (!opts.discussionId) {
    console.error('Error: discussion ID is required')
    console.log('Usage: mad history <discussion-id>')
    process.exit(1)
  }

  const status = discussion.getStatus(opts.discussionId)

  if (!status.exists) {
    console.error(`Discussion not found: ${opts.discussionId}`)
    process.exit(1)
  }

  console.log(discussion.format(opts.discussionId))
}

function handleAsk(opts) {
  if (!opts.discussionId || !opts.question) {
    console.error('Error: discussion ID and question are required')
    console.log('Usage: mad ask <discussion-id> "question"')
    process.exit(1)
  }

  const status = discussion.getStatus(opts.discussionId)
  const parsed = parseFollowupInput(opts.question, status.participants || [])
  if (!parsed.ok) {
    console.error(`Error: ${parsed.error}`)
    process.exit(1)
  }

  const message = discussion.append(opts.discussionId,
    createFollowupMessage(0, parsed.content, parsed.target)
  )

  console.log(`✓ Follow-up sent (seq: ${message.seq})`)
  console.log(`  Question: ${opts.question}`)
  if (parsed.target) {
    console.log(`  Target: ${parsed.target}`)
  }
}

function handleEnd(opts) {
  // Handle 'end all' command
  if (opts.discussionId === 'all') {
    handleEndAll(opts)
    return
  }

  if (!opts.discussionId) {
    console.error('Error: discussion ID is required')
    console.log('Usage: mad end <discussion-id> -d "decision"')
    console.log('       mad end all [-d "decision"]  # End all active discussions')
    process.exit(1)
  }

  const decision = opts.decision || 'Discussion ended by user'
  const message = discussion.append(opts.discussionId,
    createEndMessage(0, decision)
  )

  console.log(`✓ Discussion ended: ${opts.discussionId}`)
  console.log(`  Decision: ${decision}`)
}

function handleEndAll(opts) {
  const list = discussion.listAll()
  const activeDiscussions = list.filter(d => d.status === 'active')

  if (activeDiscussions.length === 0) {
    console.log('No active discussions to end.')
    return
  }

  const decision = opts.decision || 'Discussion ended by user (bulk end)'
  let ended = 0
  let failed = 0

  console.log(`Ending ${activeDiscussions.length} active discussion(s)...\n`)

  for (const d of activeDiscussions) {
    try {
      discussion.append(d.discussionId, createEndMessage(0, decision))
      console.log(`  ✓ ${d.discussionId}: ${d.topic}`)
      ended++
    } catch (err) {
      console.log(`  ✗ ${d.discussionId}: ${err.message}`)
      failed++
    }
  }

  console.log(`\n✓ Ended ${ended} discussion(s)`)
  if (failed > 0) {
    console.log(`✗ Failed to end ${failed} discussion(s)`)
  }
}

function handleList() {
  const list = discussion.listAll()

  if (list.length === 0) {
    console.log('No discussions found.')
    console.log('\nCreate a new discussion with: mad new "topic" -p claude,codex')
    return
  }

  console.log(`Found ${list.length} discussion(s):\n`)

  for (const item of list) {
    const status = item.status === 'ended' ? 'ENDED' : 'ACTIVE'
    console.log(`┌─ [${status}] ${item.topic}`)
    console.log(`│  ID: ${item.discussionId}`)
    console.log(`│  Messages: ${item.messageCount}`)
    console.log(`└─ Created: ${item.startTime ? new Date(item.startTime).toLocaleString() : 'N/A'}`)
    console.log()
  }
}

function handleWatch(opts) {
  if (!opts.discussionId) {
    console.error('Error: discussion ID is required')
    console.log('Usage: mad watch <discussion-id>')
    process.exit(1)
  }

  console.log(`Watching discussion: ${opts.discussionId}`)
  console.log('Press Ctrl+C to stop...\n')

  const stop = discussion.watch(opts.discussionId, (newMessages) => {
    for (const msg of newMessages) {
      const time = msg.ts ? new Date(msg.ts).toLocaleTimeString() : ''
      console.log(`[${time}] <${msg.from}> [${msg.type}]`)
      if (msg.content) console.log(`  ${msg.content}`)
      if (msg.error) console.log(`  ERROR: ${msg.error}`)
      console.log()
    }
  })

  process.on('SIGINT', () => {
    console.log('\nStopped watching.')
    stop()
    process.exit(0)
  })

  // Keep process alive
  setInterval(() => {}, 1000 * 60 * 60)
}

function handleRespond(opts) {
  if (!opts.discussionId || !opts.from || !opts.opinion) {
    console.error('Error: discussionId, from, and opinion are required')
    console.log('Usage: mad respond <discussion-id> -f <agent> -o <opinion> "content"')
    process.exit(1)
  }

  // Get content - the last argument that doesn't start with -
  // and isn't a value after a flag
  const args = process.argv.slice(2)
  let content = null
  const flagPattern = /^-/

  for (let i = args.indexOf(opts.discussionId) + 1; i < args.length; i++) {
    const arg = args[i]
    // Skip flags and their values
    if (flagPattern.test(arg)) {
      i++ // Skip the value too
      continue
    }
    // If we see another discussionId, skip
    if (arg === opts.discussionId) continue
    // This should be content
    content = arg
  }

  if (!content) {
    console.error('Error: response content is required')
    process.exit(1)
  }

  const status = discussion.getStatus(opts.discussionId)
  const nextRound = status.currentRound + 1

  const message = discussion.append(opts.discussionId,
    createResponseMessage(0, opts.from, nextRound, opts.opinion, content, opts.confidence)
  )

  console.log(`✓ Response added (seq: ${message.seq}, round: ${nextRound})`)
}

function handleAnalyze(opts) {
  if (!opts.discussionId) {
    console.error('Error: discussion ID is required')
    console.log('Usage: mad analyze <discussion-id>')
    process.exit(1)
  }

  const analysis = coordinator.analyzeDiscussion(opts.discussionId)

  if (!analysis.exists) {
    console.error(`Discussion not found: ${opts.discussionId}`)
    process.exit(1)
  }

  console.log(`\nDiscussion Analysis: ${opts.discussionId}`)
  console.log(`\n=== Status ===`)
  console.log(`  Topic: ${analysis.topic}`)
  console.log(`  Status: ${analysis.status}`)
  console.log(`  Current Round: ${analysis.currentRound}/${coordinator.maxRounds}`)
  console.log(`  Messages: ${analysis.messageCount}`)

  console.log(`\n=== Consensus Analysis ===`)
  const { consensus, roundStatus } = analysis
  console.log(`  Has Consensus: ${consensus.hasConsensus ? 'Yes' : 'No'}`)
  console.log(`  Agreement Level: ${(consensus.agreementLevel * 100).toFixed(0)}%`)
  console.log(`  Average Confidence: ${(consensus.averageConfidence * 100).toFixed(0)}%`)
  console.log(`  Opinions:`)
  console.log(`    - Agree: ${consensus.opinions.agree}`)
  console.log(`    - Disagree: ${consensus.opinions.disagree}`)
  console.log(`    - Neutral: ${consensus.opinions.neutral}`)
  console.log(`    - Alternative: ${consensus.opinions.alternative}`)

  console.log(`\n=== Round Status ===`)
  console.log(`  Round ${roundStatus.currentRound}`)
  console.log(`  All Responded: ${roundStatus.allResponded ? 'Yes' : 'No'}`)
  if (!roundStatus.allResponded) {
    console.log(`  Pending Agents: ${roundStatus.pendingAgents.join(', ')}`)
  }

  const intervention = coordinator.checkNeedsIntervention(opts.discussionId)
  if (intervention.needsIntervention) {
    console.log(`\n=== Intervention Needed ===`)
    console.log(`  Reason: ${intervention.reason}`)
    console.log(`  Suggested Action: ${intervention.suggestedAction}`)
  }

  console.log(`\n=== Discussion State ===`)
  console.log(`  Is Complete: ${analysis.isComplete}`)
  console.log(`  Can Advance: ${analysis.canAdvance}`)
}

function handleSummary(opts) {
  if (!opts.discussionId) {
    console.error('Error: discussion ID is required')
    console.log('Usage: mad summary <discussion-id>')
    process.exit(1)
  }

  const summary = coordinator.generateSummary(opts.discussionId)
  console.log(summary)
}

function handleMode(opts) {
  if (!opts.discussionId || !opts.modeKey || !opts.modeValue) {
    console.error('Error: discussion ID, mode key and mode value are required')
    console.log('Usage: mad mode <discussion-id> co-dev <on|off>')
    process.exit(1)
  }

  const status = discussion.getStatus(opts.discussionId)
  if (!status.exists) {
    console.error(`Discussion not found: ${opts.discussionId}`)
    process.exit(1)
  }

  if (status.status === 'ended') {
    console.error(`Discussion already ended: ${opts.discussionId}`)
    process.exit(1)
  }

  const parsedMode = parseModeToggleInput(opts.modeKey, opts.modeValue)
  if (!parsedMode.ok) {
    console.error(`Error: ${parsedMode.error}`)
    process.exit(1)
  }

  const message = discussion.append(opts.discussionId, createModeMessage(0, parsedMode.key, parsedMode.enabled))
  console.log(`✓ Mode updated (seq: ${message.seq})`)
  console.log(`  Discussion: ${opts.discussionId}`)
  console.log(`  ${parsedMode.key}: ${parsedMode.enabled ? 'on' : 'off'}`)
}

async function handleTui(opts) {
  await startTui({
    discussion,
    coordinator,
    createFollowupMessage,
    createEndMessage,
    parseFollowupInput,
    initialDiscussionId: opts.discussionId || null
  })
}

async function handleUi(opts) {
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    console.error(`Error: invalid port ${opts.port}`)
    process.exit(1)
  }

  if (opts.discussionId) {
    const status = discussion.getStatus(opts.discussionId)
    if (!status.exists) {
      console.error(`Error: discussion not found: ${opts.discussionId}`)
      process.exit(1)
    }
  }

  const serverInfo = await startUiServer({
    baseDir,
    port: opts.port
  })

  const initialPath = opts.discussionId
    ? `/?discussion=${encodeURIComponent(opts.discussionId)}`
    : '/'
  const uiUrl = `${serverInfo.url}${initialPath}`

  console.log(`✓ UI server started`)
  console.log(`  URL: ${uiUrl}`)
  console.log(`  Base Dir: ${baseDir}`)
  console.log(`  Press Ctrl+C to stop`)

  process.on('SIGINT', () => {
    serverInfo.server.close(() => {
      process.exit(0)
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const opts = parseArgs(args)

  if (opts.showHelp || args.length === 0) {
    printUsage()
    process.exit(0)
  }

  if (opts.parseError) {
    console.error(`Error: ${opts.parseError}`)
    process.exit(1)
  }

  switch (opts.command) {
    case 'new':
      handleNew(opts)
      break
    case 'status':
      handleStatus(opts)
      break
    case 'history':
      handleHistory(opts)
      break
    case 'ask':
      handleAsk(opts)
      break
    case 'end':
      handleEnd(opts)
      break
    case 'list':
      handleList()
      break
    case 'watch':
      handleWatch(opts)
      break
    case 'respond':
      handleRespond(opts)
      break
    case 'mode':
      handleMode(opts)
      break
    case 'analyze':
      handleAnalyze(opts)
      break
    case 'summary':
      handleSummary(opts)
      break
    case 'tui':
      await handleTui(opts)
      break
    case 'ui':
    case 'web':
      await handleUi(opts)
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
