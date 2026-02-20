/**
 * Agent base class
 * Provides polling-based message watching and response handling
 */

import { Discussion } from './discussion.js'
import { MESSAGE_TYPES, OPINIONS, createResponseMessage, createErrorMessage } from './message.js'

/**
 * Base class for discussion agents
 */
class AgentBase {
  /**
   * @param {object} options
   * @param {string} options.name - Agent name
   * @param {number} [options.pollInterval] - Polling interval in ms
   * @param {string} [options.baseDir] - Discussion base directory
   */
  constructor(options) {
    this.name = options.name
    this.pollInterval = options.pollInterval || 2000
    this.discussion = new Discussion(options.baseDir)
    this.running = false
    this.timers = []
    this.watchedDiscussions = new Map() // discussionId -> lastSeq
    this.pendingRetries = new Map() // discussionId -> { attempts, maxAttempts }
    this.respondedRounds = new Map() // discussionId -> Set of rounds we've attempted
    this.responding = new Set() // discussionIds currently being processed (lock)
  }

  /**
   * Start the agent
   */
  async start() {
    this.running = true
    console.log(`[${this.name}] Agent started`)

    // Start watching all active discussions
    this.watchAllDiscussions()

    // Start periodic scan for new discussions
    const scanTimer = setInterval(() => {
      if (this.running) {
        this.scanForNewDiscussions()
      }
    }, this.pollInterval * 2)

    this.timers.push(scanTimer)
  }

  /**
   * Stop the agent
   */
  stop() {
    this.running = false
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers = []
    console.log(`[${this.name}] Agent stopped`)
  }

  /**
   * Watch all active discussions
   */
  watchAllDiscussions() {
    const discussions = this.discussion.listAll()

    for (const d of discussions) {
      if (d.status === 'active') {
        this.watchDiscussion(d.discussionId)
      }
    }
  }

  /**
   * Scan for new discussions to join
   */
  scanForNewDiscussions() {
    const discussions = this.discussion.listAll()

    for (const d of discussions) {
      if (d.status === 'active' && !this.watchedDiscussions.has(d.discussionId)) {
        this.watchDiscussion(d.discussionId)
      }
    }
  }

  /**
   * Watch a specific discussion
   * @param {string} discussionId
   */
  watchDiscussion(discussionId) {
    if (this.watchedDiscussions.has(discussionId)) {
      return
    }

    // Get current last seq
    const messages = this.discussion.readAll(discussionId)
    const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0

    this.watchedDiscussions.set(discussionId, lastSeq)

    const timer = setInterval(() => {
      if (!this.running) return
      this.pollDiscussion(discussionId)
    }, this.pollInterval)

    this.timers.push(timer)

    console.log(`[${this.name}] Watching discussion: ${discussionId}`)

    // Process any existing messages that need response
    this.processDiscussion(discussionId)
  }

  /**
   * Poll a discussion for new messages
   * @param {string} discussionId
   */
  pollDiscussion(discussionId) {
    const lastKnownSeq = this.watchedDiscussions.get(discussionId) || 0
    const messages = this.discussion.readAll(discussionId)
    const currentLastSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0

    if (currentLastSeq > lastKnownSeq) {
      const newMessages = messages.filter(m => m.seq > lastKnownSeq)
      this.watchedDiscussions.set(discussionId, currentLastSeq)
      this.onNewMessages(discussionId, newMessages)
    }
  }

  /**
   * Process a discussion to check if we need to respond
   * @param {string} discussionId
   */
  processDiscussion(discussionId) {
    const status = this.discussion.getStatus(discussionId)

    // Check if we are a participant
    if (!status.participants.includes(this.name)) {
      console.log(`[${this.name}] Not a participant in ${discussionId}, skipping`)
      return
    }

    // Don't respond to ended discussions
    if (status.status === 'ended') {
      return
    }

    const messages = this.discussion.readAll(discussionId)

    // Check if we should respond in current round
    const shouldRespond = this.shouldRespondInRound(discussionId, messages, status)

    if (shouldRespond) {
      console.log(`[${this.name}] Should respond in round ${shouldRespond.round} of ${discussionId}`)
      this.respondToTrigger(discussionId, shouldRespond.trigger, messages, shouldRespond.round).catch(err => {
        if (err.message !== 'ALREADY_RESPONDING' && err.message !== 'ALREADY_ATTEMPTED') {
          console.error(`[${this.name}] Error responding to ${discussionId}:`, err.message)
        }
      })
    }
  }

  /**
   * Determine if we should respond in the current round
   * @param {string} discussionId
   * @param {object[]} messages
   * @param {object} status
   * @returns {{ round: number, trigger: object } | null }
   */
  shouldRespondInRound(discussionId, messages, status) {
    const currentRound = status.currentRound || 0
    const maxRounds = 5  // Maximum discussion rounds

    // Get all responses grouped by round
    const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)
    const responsesByRound = new Map()

    for (const r of responses) {
      const round = r.round || 1
      if (!responsesByRound.has(round)) {
        responsesByRound.set(round, new Set())
      }
      responsesByRound.get(round).add(r.from)
    }

    // Find the highest round with responses
    let highestRound = 0
    for (const [round, agents] of responsesByRound) {
      if (round > highestRound) {
        highestRound = round
      }
    }

    const latestFollowupAny = messages
      .filter(m => m.type === MESSAGE_TYPES.FOLLOWUP)
      .sort((a, b) => b.seq - a.seq)[0]

    if (latestFollowupAny?.target && latestFollowupAny.target !== this.name) {
      return null
    }

    // Follow-up should start a dedicated new round immediately.
    // Round number is persisted on follow-up message; fallback to highestRound + 1.
    const latestFollowup = messages
      .filter(m => m.type === MESSAGE_TYPES.FOLLOWUP && this.isFollowupTargetedToMe(m))
      .sort((a, b) => b.seq - a.seq)[0]

    if (latestFollowup) {
      const followupRound = latestFollowup.round || (highestRound + 1)
      const followupResponses = responsesByRound.get(followupRound) || new Set()

      if (!followupResponses.has(this.name)) {
        return { round: followupRound, trigger: latestFollowup }
      }
    }

    // Check if we've responded in the highest round
    const respondedInHighestRound = responsesByRound.get(highestRound)?.has(this.name)

    if (highestRound === 0) {
      // No responses yet - this is round 1
      const startMessage = messages.find(m => m.type === MESSAGE_TYPES.START)
      if (startMessage) {
        return { round: 1, trigger: startMessage }
      }
    } else if (!respondedInHighestRound) {
      // We haven't responded in current round yet
      // Check if all other participants have responded (or timeout)
      const roundResponses = responsesByRound.get(highestRound) || new Set()
      const allParticipants = new Set(status.participants)

      // Check if everyone has responded in this round
      const allResponded = status.participants.every(p => roundResponses.has(p))

      if (allResponded || roundResponses.size >= status.participants.length - 1) {
        // Everyone else responded, or it's our turn
        // Use the last response as trigger
        const lastResponse = responses
          .filter(r => r.round === highestRound)
          .sort((a, b) => b.seq - a.seq)[0]

        if (lastResponse && highestRound < maxRounds) {
          return { round: highestRound, trigger: lastResponse }
        }
      }
    } else {
      // We've responded in current round, check if we should start next round
      const allResponded = status.participants.every(p =>
        responsesByRound.get(highestRound)?.has(p)
      )

      if (allResponded && highestRound < maxRounds) {
        // All participants responded, start next round
        const lastResponse = responses
          .filter(r => r.round === highestRound)
          .sort((a, b) => b.seq - a.seq)[0]

        if (lastResponse) {
          return { round: highestRound + 1, trigger: lastResponse }
        }
      }
    }

    return null
  }

  /**
   * Handle new messages
   * @param {string} discussionId
   * @param {object[]} newMessages
   */
  onNewMessages(discussionId, newMessages) {
    const followupMessage = [...newMessages]
      .reverse()
      .find(msg => msg.type === MESSAGE_TYPES.FOLLOWUP && this.isFollowupTargetedToMe(msg))

    for (const msg of newMessages) {
      // Update last known seq
      this.watchedDiscussions.set(discussionId, msg.seq)

      // Check if discussion ended
      if (msg.type === MESSAGE_TYPES.END) {
        console.log(`[${this.name}] Discussion ${discussionId} ended`)
        return
      }
    }

    const status = this.discussion.getStatus(discussionId)

    // Explicit trigger for follow-up: start a fresh round quickly instead of waiting for old round completion.
    if (followupMessage && status.status === 'active' && status.participants.includes(this.name)) {
      const messages = this.discussion.readAll(discussionId)
      const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)
      const highestRound = responses.length > 0
        ? Math.max(...responses.map(r => r.round || 0))
        : 0
      const followupRound = followupMessage.round || (highestRound + 1)
      setTimeout(() => {
        const messages = this.discussion.readAll(discussionId)
        this.respondToTrigger(discussionId, followupMessage, messages, followupRound).catch(err => {
          if (err.message !== 'ALREADY_RESPONDING' && err.message !== 'ALREADY_ATTEMPTED') {
            console.error(`[${this.name}] Error responding to follow-up in ${discussionId}:`, err.message)
          }
        })
      }, 100 + Math.random() * 400)
      return
    }

    // Re-evaluate if we should respond
    if (status.status === 'active' && status.participants.includes(this.name)) {
      const messages = this.discussion.readAll(discussionId)
      const shouldRespond = this.shouldRespondInRound(discussionId, messages, status)

      if (shouldRespond) {
        // Add a small delay to avoid race conditions
        setTimeout(() => {
          this.respondToTrigger(discussionId, shouldRespond.trigger, messages, shouldRespond.round).catch(err => {
            if (err.message !== 'ALREADY_RESPONDING' && err.message !== 'ALREADY_ATTEMPTED') {
              console.error(`[${this.name}] Error responding to ${discussionId}:`, err.message)
            }
          })
        }, 1000 + Math.random() * 2000)  // 1-3 seconds random delay
      }
    }
  }

  /**
   * Respond to a discussion trigger (start or followup)
   * Override this method in subclasses - MUST call super first
   *
   * @param {string} discussionId
   * @param {object} trigger - The message to respond to
   * @param {object[]} allMessages - All messages in the discussion
   * @param {number} round - The round number to respond to
   * @returns {boolean} true if should proceed, false if should skip
   */
  async respondToTrigger(discussionId, trigger, allMessages, round) {
    // Check lock - prevent concurrent responses
    if (this.responding.has(discussionId)) {
      console.log(`[${this.name}] Already responding to ${discussionId}, skipping`)
      throw new Error('ALREADY_RESPONDING')  // Signal caller to stop
    }

    // Check if we've already attempted this round
    const attemptedRounds = this.respondedRounds.get(discussionId) || new Set()
    if (attemptedRounds.has(round)) {
      console.log(`[${this.name}] Already attempted round ${round} in ${discussionId}, skipping`)
      throw new Error('ALREADY_ATTEMPTED')  // Signal caller to stop
    }

    // Acquire lock and mark round as attempted
    this.responding.add(discussionId)
    attemptedRounds.add(round)
    this.respondedRounds.set(discussionId, attemptedRounds)

    console.log(`[${this.name}] Acquired lock for ${discussionId} round ${round}`)
    // Note: Lock release is now the responsibility of subclasses after completion
  }

  isFollowupTargetedToMe(message) {
    return !message?.target || message.target === this.name
  }

  escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  validateAgentOutput(rawOutput) {
    const text = `${rawOutput || ''}`.trim()
    if (!text) {
      return { ok: false, reason: 'empty response', normalizedOutput: '' }
    }

    const lines = text.split('\n')
    const firstIndex = lines.findIndex(line => line.trim().length > 0)
    const firstLine = firstIndex >= 0 ? lines[firstIndex].trim() : ''
    const headerMatch = firstLine.match(/^AGENT\s*:\s*(.+)$/i)
    if (!headerMatch) {
      return { ok: false, reason: 'missing AGENT header', normalizedOutput: text }
    }

    const declared = headerMatch[1].trim().toLowerCase()
    if (declared !== this.name.toLowerCase()) {
      return { ok: false, reason: `agent mismatch: ${declared}`, normalizedOutput: text }
    }

    const content = lines.slice(firstIndex + 1).join('\n').trim()
    if (!content) {
      return { ok: false, reason: 'empty body after AGENT header', normalizedOutput: '' }
    }

    const self = this.escapeRegex(this.name)
    const selfContradiction = new RegExp(`与\\s*${self}\\s*不同|different\\s+from\\s+${self}`, 'i')
    if (selfContradiction.test(content)) {
      return { ok: false, reason: 'self-contradictory identity phrase', normalizedOutput: content }
    }

    const knownAgents = ['claude', 'codex'].filter(agent => agent !== this.name.toLowerCase())
    for (const other of knownAgents) {
      const otherEsc = this.escapeRegex(other)
      const otherIdentityClaim = new RegExp(`(?:^|\\n|\\s)(?:我是|i\\s+am)\\s*${otherEsc}(?:\\b|\\s|[，,。.!:：])`, 'i')
      if (otherIdentityClaim.test(content)) {
        return { ok: false, reason: `claimed other identity: ${other}`, normalizedOutput: content }
      }
    }

    return { ok: true, reason: '', normalizedOutput: content }
  }

  applyConsensusClosure(content, opinion, discussionId) {
    if (opinion !== OPINIONS.AGREE) return content
    if (!content || /本次讨论可以进行结论/.test(content)) return content

    const status = this.discussion.getStatus(discussionId)
    const counterpart = (status.participants || []).find(p => p !== this.name) || '对方'
    const closure = `我同意对方(${counterpart})的意见，本次讨论可以进行结论，由用户进行最终整理。`
    return `${content.trim()}\n\n${closure}`
  }

  /**
   * Send a response message
   * @param {string} discussionId
   * @param {number} round
   * @param {string} opinion
   * @param {string} content
   * @param {number} [confidence]
   */
  sendResponse(discussionId, round, opinion, content, confidence = 0.7) {
    try {
      const message = this.discussion.append(discussionId,
        createResponseMessage(0, this.name, round, opinion, content, confidence)
      )

      console.log(`[${this.name}] Response sent (seq: ${message.seq}, round: ${round})`)
      return message
    } catch (err) {
      console.error(`[${this.name}] Failed to send response:`, err.message)
      return null
    }
  }

  /**
   * Send an error message
   * @param {string} discussionId
   * @param {string} error
   * @param {number} [round] - The round this error is for
   */
  sendError(discussionId, error, round) {
    try {
      const message = this.discussion.append(discussionId,
        createErrorMessage(0, this.name, error, round)
      )

      console.log(`[${this.name}] Error sent (seq: ${message.seq})`)

      // Clear retry state
      this.pendingRetries.delete(discussionId)
      // Clear responding lock
      this.responding.delete(discussionId)

      return message
    } catch (err) {
      console.error(`[${this.name}] Failed to send error:`, err.message)
      return null
    }
  }

  /**
   * Send a "thinking" status message
   * @param {string} discussionId
   * @param {number} round
   */
  sendThinkingStatus(discussionId, round) {
    try {
      const message = this.discussion.append(discussionId, {
        from: this.name,
        type: 'status',
        status: 'thinking',
        round,
        content: `${this.name} is thinking...`
      })

      console.log(`[${this.name}] Thinking status sent (round: ${round})`)
      return message
    } catch (err) {
      console.error(`[${this.name}] Failed to send thinking status:`, err.message)
      return null
    }
  }

  /**
   * Handle timeout with retry logic
   * @param {string} discussionId
   * @param {object} trigger
   * @param {object[]} allMessages
   * @param {string} errorMessage
   * @param {number} round - The round number
   */
  async handleTimeoutWithRetry(discussionId, trigger, allMessages, errorMessage, round) {
    // Get or initialize retry state
    if (!this.pendingRetries.has(discussionId)) {
      this.pendingRetries.set(discussionId, { attempts: 0, maxAttempts: 3 })
    }

    const retryState = this.pendingRetries.get(discussionId)
    retryState.attempts++

    console.log(`[${this.name}] Timeout attempt ${retryState.attempts}/${retryState.maxAttempts} for ${discussionId} (round ${round})`)

    if (retryState.attempts < retryState.maxAttempts) {
      // Send retry status
      this.discussion.append(discussionId, {
        from: this.name,
        type: 'status',
        status: 'retrying',
        round,
        content: `${this.name} timed out, retrying (${retryState.attempts}/${retryState.maxAttempts})...`
      })

      // Wait before retry (exponential backoff)
      const delay = Math.min(30000 * Math.pow(2, retryState.attempts - 1), 120000)
      await new Promise(resolve => setTimeout(resolve, delay))

      // Retry - remove round from attemptedRounds to allow retry
      const attemptedRounds = this.respondedRounds.get(discussionId)
      if (attemptedRounds) {
        attemptedRounds.delete(round)
        console.log(`[${this.name}] Cleared round ${round} from attempted set for retry`)
      }
      // Also clear responding lock if held
      this.responding.delete(discussionId)

      try {
        await this.respondToTrigger(discussionId, trigger, allMessages, round)
      } catch (err) {
        if (err.message === 'ALREADY_RESPONDING' || err.message === 'ALREADY_ATTEMPTED') {
          console.log(`[${this.name}] Retry blocked: ${err.message}`)
        } else {
          console.error(`[${this.name}] Retry failed:`, err.message)
        }
      }
    } else {
      // Max retries reached, send error
      console.error(`[${this.name}] Max retries reached for ${discussionId}`)
      this.sendError(discussionId, `Failed after ${retryState.maxAttempts} attempts: ${errorMessage}`, round)

      // Clear retry state
      this.pendingRetries.delete(discussionId)
    }
  }

  /**
   * Format discussion context for LLM prompt
   * @param {string} discussionId
   * @param {object[]} messages
   * @returns {string}
   */
  formatContextForLLM(discussionId, messages) {
    const status = this.discussion.getStatus(discussionId)
    let context = `Discussion: ${status.topic}\n\n`
    context += `Participants: ${status.participants.join(', ')}\n\n`

    // Add working directory context if available
    if (status.context?.workingDir) {
      context += `Working Directory: ${status.context.workingDir}\n`
      context += `(This is the project directory where the discussion was created. Consider this context when responding.)\n\n`
    }

    context += `Messages:\n`

    for (const msg of messages) {
      const time = msg.ts ? new Date(msg.ts).toLocaleTimeString() : ''
      context += `\n[${time}] ${msg.from} (${msg.type}):\n`

      switch (msg.type) {
        case MESSAGE_TYPES.START:
          context += `  Topic: ${msg.topic}\n`
          break
        case MESSAGE_TYPES.RESPONSE:
          context += `  Opinion: ${msg.opinion}\n`
          context += `  Confidence: ${msg.confidence}\n`
          context += `  Content: ${msg.content}\n`
          break
        case MESSAGE_TYPES.FOLLOWUP:
          context += `  Question: ${msg.content}\n`
          break
        default:
          context += `  ${JSON.stringify(msg)}\n`
      }
    }

    return context
  }
}

export { AgentBase }
