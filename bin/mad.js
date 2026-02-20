#!/usr/bin/env node

/**
 * Multi-Agent Discussion CLI
 *
 * Usage:
 *   mad new "topic" -p claude,codex    # Create new discussion
 *   mad status <id>                     # Show discussion status
 *   mad history <id>                    # Show discussion history
 *   mad ask <id> "question"             # Ask follow-up question
 *   mad end <id> -d "decision"          # End discussion
 *   mad list                            # List all discussions
 */

import { Discussion } from '../lib/discussion.js'
import { Coordinator } from '../lib/coordinator.js'
import {
  createFollowupMessage,
  createEndMessage,
  createResponseMessage,
  OPINIONS
} from '../lib/message.js'
import readline from 'readline'

const discussion = new Discussion()
const coordinator = new Coordinator()

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

Examples:
  mad new "API design: REST vs GraphQL" -p claude,codex
  mad status abc123-api-design
  mad ask abc123 "What about caching?"
  mad analyze abc123
  mad summary abc123
  mad end abc123 -d "Using REST with GraphQL federation"
  mad end all -d "Emergency stop"
`)
}

function parseArgs(args) {
  const result = {
    command: null,
    topic: null,
    discussionId: null,
    question: null,
    decision: null,
    participants: ['claude', 'codex'],
    from: null,
    opinion: OPINIONS.NEUTRAL,
    confidence: 0.7,
    watch: null  // null = use command default, true = force watch, false = no-watch
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

    if (arg === '-p' || arg === '--participants') {
      result.participants = args[++i].split(',').map(s => s.trim())
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
    } else if ((result.command === 'status' || result.command === 'history' || result.command === 'watch') && !result.discussionId) {
      result.discussionId = arg
    } else if (result.command === 'ask' && !result.discussionId) {
      result.discussionId = arg
    } else if (result.command === 'ask' && !result.question) {
      result.question = arg
    } else if (result.command === 'end' && !result.discussionId) {
      result.discussionId = arg
    } else if (result.command === 'respond' && !result.discussionId) {
      result.discussionId = arg
    } else if ((result.command === 'analyze' || result.command === 'summary') && !result.discussionId) {
      result.discussionId = arg
    }
  }

  return result
}

function handleNew(opts) {
  if (!opts.topic) {
    console.error('Error: topic is required')
    console.log('Usage: mad new "topic" -p claude,codex')
    process.exit(1)
  }

  // Build context with working directory
  const context = {
    workingDir: process.cwd(),
    timestamp: new Date().toISOString()
  }

  const { discussionId, message } = discussion.create(opts.topic, opts.participants, context)

  console.log(`✓ Discussion created: ${discussionId}`)
  console.log(`  Topic: ${opts.topic}`)
  console.log(`  Participants: ${opts.participants.join(', ')}`)
  console.log(`  Working Dir: ${context.workingDir}`)
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
  console.log(`📁 Result File: ${resultFilePath}`)
  console.log(`${'═'.repeat(50)}`)
  console.log(`\n📝 Watch mode started. Commands:`)
  console.log(`   - Type message to ask follow-up`)
  console.log(`   - 's' or 'status' - show status with round progress`)
  console.log(`   - 'a' or 'analyze' - analyze consensus`)
  console.log(`   - 'h' or 'history' - show history`)
  console.log(`   - 'r' or 'result' - show result file path`)
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

    // Treat as follow-up question
    const msg = discussion.append(discussionId, createFollowupMessage(0, trimmed))
    console.log(`✓ Follow-up sent (seq: ${msg.seq})`)
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

  const message = discussion.append(opts.discussionId,
    createFollowupMessage(0, opts.question)
  )

  console.log(`✓ Follow-up sent (seq: ${message.seq})`)
  console.log(`  Question: ${opts.question}`)
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

async function main() {
  const args = process.argv.slice(2)
  const opts = parseArgs(args)

  if (opts.showHelp || args.length === 0) {
    printUsage()
    process.exit(0)
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
    case 'analyze':
      handleAnalyze(opts)
      break
    case 'summary':
      handleSummary(opts)
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
