/**
 * Agent base class
 * Provides polling-based message watching and response handling
 */

import { Discussion } from './discussion.js'
import { MESSAGE_TYPES, OPINIONS, createResponseMessage, createErrorMessage } from './message.js'
import { spawnSync } from 'child_process'

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
    this.maxConcurrent = options.maxConcurrent || 5
    this.maxQueueSize = options.maxQueueSize || 20
    this.activeCount = 0
    this.responseQueue = []
    this.discussionTimers = new Map() // discussionId -> timer
    this.discussionLastWatched = new Map() // discussionId -> last watched timestamp
    this.discussionFailures = new Map() // discussionId -> consecutive failures
    this.localCircuitThreshold = options.localCircuitThreshold || 5
    this.localCircuitCooldownMs = options.localCircuitCooldownMs || 60000
    this.localCircuitOpenUntil = new Map() // discussionId -> open-until timestamp
    this.maxWatchedDiscussions = options.maxWatchedDiscussions || 50
    this.drainingResponseQueue = false
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

    const cleanupTimer = setInterval(() => {
      if (this.running) {
        this._cleanupEndedDiscussions()
      }
    }, 10000)  // 每 10 秒清理已结束的讨论

    this.timers.push(cleanupTimer)
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
    this.discussionTimers.clear()
    this.responseQueue = []
    console.log(`[${this.name}] Agent stopped`)
  }

  getLastActivity(discussionId) {
    const messages = this.discussion.readAll(discussionId)
    if (messages.length === 0) return 0

    const ts = messages[messages.length - 1].ts
    const parsed = Date.parse(ts || '')
    return Number.isNaN(parsed) ? 0 : parsed
  }

  _getPrioritizedActiveDiscussions() {
    const activeDiscussions = this.discussion.listAll().filter(d => d.status === 'active')

    const prioritized = activeDiscussions
      .map(d => ({
        ...d,
        lastActivity: this.getLastActivity(d.discussionId),
        lastWatched: this.discussionLastWatched.get(d.discussionId) || 0
      }))
      .sort((a, b) => {
        if (a.lastActivity !== b.lastActivity) {
          return b.lastActivity - a.lastActivity
        }
        return a.lastWatched - b.lastWatched
      })

    if (activeDiscussions.length > this.maxWatchedDiscussions) {
      console.warn(
        `[${this.name}] Warning: ${activeDiscussions.length} active discussions, limiting to ${this.maxWatchedDiscussions}`
      )
    }

    return prioritized.slice(0, this.maxWatchedDiscussions)
  }

  /**
   * Watch all active discussions
   */
  watchAllDiscussions() {
    const discussions = this._getPrioritizedActiveDiscussions()

    for (const d of discussions) {
      this.watchDiscussion(d.discussionId)
    }
  }

  /**
   * Scan for new discussions to join
   */
  scanForNewDiscussions() {
    const discussions = this._getPrioritizedActiveDiscussions()
    const prioritizedIds = new Set(discussions.map(d => d.discussionId))

    for (const watchedId of [...this.watchedDiscussions.keys()]) {
      if (prioritizedIds.has(watchedId)) {
        continue
      }

      const status = this.discussion.getStatus(watchedId)
      if (!status.exists || status.status === 'ended') {
        this._cleanupDiscussion(watchedId, status.exists ? 'ended-scan' : 'missing-scan')
        continue
      }

      // Keep in-flight responses to avoid dropping active work mid-flight.
      if (!this.responding.has(watchedId)) {
        this._cleanupDiscussion(watchedId, 'deprioritized')
      }
    }

    for (const d of discussions) {
      if (!this.watchedDiscussions.has(d.discussionId)) {
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
    this.discussionLastWatched.set(discussionId, Date.now())

    const timer = setInterval(() => {
      if (!this.running) return
      this.pollDiscussion(discussionId)
    }, this.pollInterval)

    this.timers.push(timer)
    this.discussionTimers.set(discussionId, timer)

    console.log(`[${this.name}] Watching discussion: ${discussionId}`)

    // Process any existing messages that need response
    this.processDiscussion(discussionId)
  }

  /**
   * Poll a discussion for new messages
   * @param {string} discussionId
   */
  pollDiscussion(discussionId) {
    this.discussionLastWatched.set(discussionId, Date.now())

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
    if (!status.exists || !Array.isArray(status.participants)) {
      return
    }

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
        if (!this.isExpectedResponseFlowError(err)) {
          console.error(`[${this.name}] Error responding to ${discussionId}:`, this.getResponseErrorCode(err))
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
    const maxRounds = 5  // Maximum discussion rounds
    const participants = status.participants || []
    if (!participants.includes(this.name)) return null

    // Build round attempts by participant (response/error both count as an attempt).
    // This prevents a round from stalling when a previous participant fails.
    const roundAttempts = messages
      .filter(m => m.type === MESSAGE_TYPES.RESPONSE || m.type === MESSAGE_TYPES.ERROR)
      .sort((a, b) => a.seq - b.seq)
    const attemptsByRound = new Map()

    for (const attempt of roundAttempts) {
      const round = attempt.round || 1
      if (!attemptsByRound.has(round)) {
        attemptsByRound.set(round, [])
      }
      const attemptedParticipants = attemptsByRound.get(round)
      if (participants.includes(attempt.from) && !attemptedParticipants.includes(attempt.from)) {
        attemptedParticipants.push(attempt.from)
      }
    }

    // Find the highest round with attempts
    let highestRound = 0
    for (const [round] of attemptsByRound) {
      if (round > highestRound) {
        highestRound = round
      }
    }

    const expectedParticipant = (attemptedParticipants) => participants[attemptedParticipants.length] || null
    const lastRoundAttempt = (round) =>
      roundAttempts.filter(m => (m.round || 1) === round).sort((a, b) => b.seq - a.seq)[0] || null

    // Follow-up starts a dedicated new round, but still follows turn-taking order.
    // If follow-up is explicitly targeted to another agent, we must not respond.
    const latestFollowupAny = messages
      .filter(m => m.type === MESSAGE_TYPES.FOLLOWUP)
      .sort((a, b) => b.seq - a.seq)[0]

    if (latestFollowupAny?.target && latestFollowupAny.target !== this.name) {
      return null
    }

    const latestFollowup = latestFollowupAny && this.isFollowupTargetedToMe(latestFollowupAny)
      ? latestFollowupAny
      : null

    if (latestFollowup) {
      const followupRound = latestFollowup.round || (highestRound + 1)
      const followupResponders = attemptsByRound.get(followupRound) || []
      const isExplicitTarget = Boolean(latestFollowup.target)

      // Explicitly targeted follow-up should be answered by the target agent directly.
      if (isExplicitTarget && latestFollowup.target === this.name) {
        const alreadyResponded = followupResponders.includes(this.name)
        if (!alreadyResponded) {
          return { round: followupRound, trigger: latestFollowup }
        }
        return null
      }

      const expected = expectedParticipant(followupResponders)
      if (expected === this.name) {
        const trigger = followupResponders.length === 0
          ? latestFollowup
          : lastRoundAttempt(followupRound)
        if (trigger) {
          return { round: followupRound, trigger }
        }
      }
      return null
    }

    if (highestRound === 0) {
      const startMessage = messages.find(m => m.type === MESSAGE_TYPES.START)
      if (startMessage && participants[0] === this.name) {
        return { round: 1, trigger: startMessage }
      }
      return null
    }

    const roundResponders = attemptsByRound.get(highestRound) || []
    if (roundResponders.length < participants.length) {
      const expected = expectedParticipant(roundResponders)
      if (expected === this.name) {
        const trigger = lastRoundAttempt(highestRound)
        if (trigger && highestRound <= maxRounds) {
          return { round: highestRound, trigger }
        }
      }
      return null
    }

    if (highestRound < maxRounds && participants[0] === this.name) {
      const trigger = lastRoundAttempt(highestRound)
      if (trigger) {
        return { round: highestRound + 1, trigger }
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
    for (const msg of newMessages) {
      // Update last known seq
      this.watchedDiscussions.set(discussionId, msg.seq)

      // Check if discussion ended
      if (msg.type === MESSAGE_TYPES.END) {
        this._cleanupDiscussion(discussionId, 'end-message')
        return
      }
    }

    const status = this.discussion.getStatus(discussionId)
    if (!status.exists || !Array.isArray(status.participants)) {
      return
    }

    // Re-evaluate if we should respond
    if (status.status === 'active' && status.participants.includes(this.name)) {
      const messages = this.discussion.readAll(discussionId)
      const shouldRespond = this.shouldRespondInRound(discussionId, messages, status)

      if (shouldRespond) {
        // Add a small delay to avoid race conditions
        setTimeout(() => {
          if (!this.running || !this.watchedDiscussions.has(discussionId)) {
            return
          }

          this.respondToTrigger(discussionId, shouldRespond.trigger, messages, shouldRespond.round).catch(err => {
            if (!this.isExpectedResponseFlowError(err)) {
              console.error(`[${this.name}] Error responding to ${discussionId}:`, this.getResponseErrorCode(err))
            }
          })
        }, 1000 + Math.random() * 2000)  // 1-3 seconds random delay
      }
    }
  }

  createResponseFlowError(code) {
    const err = new Error(code)
    err.code = code
    return err
  }

  getResponseErrorCode(err) {
    return err?.code || err?.message || 'UNKNOWN_RESPONSE_ERROR'
  }

  isExpectedResponseFlowError(err) {
    const code = this.getResponseErrorCode(err)
    return code === 'ALREADY_RESPONDING'
      || code === 'ALREADY_ATTEMPTED'
      || code === 'QUEUED'
      || code === 'LOCAL_CIRCUIT_OPEN'
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
    const openUntil = this.localCircuitOpenUntil.get(discussionId) || 0
    if (openUntil > Date.now()) {
      console.warn(
        `[${this.name}] Local circuit open for ${discussionId} until ${new Date(openUntil).toISOString()}, skipping`
      )
      throw this.createResponseFlowError('LOCAL_CIRCUIT_OPEN')
    }

    // Circuit window expired naturally
    if (openUntil > 0) {
      this.localCircuitOpenUntil.delete(discussionId)
    }

    if (this.activeCount >= this.maxConcurrent) {
      const alreadyQueued = this.responseQueue.some(item => item.discussionId === discussionId)
      if (!alreadyQueued) {
        if (this.responseQueue.length >= this.maxQueueSize) {
          const dropped = this.responseQueue.shift()
          if (dropped) {
            console.warn(`[${this.name}] Queue full, dropping oldest discussion: ${dropped.discussionId}`)
          }
        }

        this.responseQueue.push({ discussionId, round, queuedAt: Date.now() })
        console.log(
          `[${this.name}] Max concurrent (${this.activeCount}/${this.maxConcurrent}), queued ${discussionId}`
        )
      } else {
        console.log(`[${this.name}] Discussion ${discussionId} already queued, skipping`)
      }

      throw this.createResponseFlowError('QUEUED')
    }

    this.activeCount++

    // Safety net: ensure resources are released if subclass fails to call finalizeResponse()
    let finalized = false
    const ensureFinalized = () => {
      if (!finalized) {
        console.warn(`[${this.name}] Auto-finalizing ${discussionId} (subclass did not call finalizeResponse)`)
        this.finalizeResponse(discussionId, { success: false })
        finalized = true
      }
    }

    try {
      // Check lock - prevent concurrent responses
      if (this.responding.has(discussionId)) {
        console.log(`[${this.name}] Already responding to ${discussionId}, skipping`)
        throw this.createResponseFlowError('ALREADY_RESPONDING')
      }

      // Check if we've already attempted this round
      const attemptedRounds = this.respondedRounds.get(discussionId) || new Set()
      if (attemptedRounds.has(round)) {
        console.log(`[${this.name}] Already attempted round ${round} in ${discussionId}, skipping`)
        throw this.createResponseFlowError('ALREADY_ATTEMPTED')
      }

      // Acquire lock and mark round as attempted
      this.responding.add(discussionId)
      attemptedRounds.add(round)
      this.respondedRounds.set(discussionId, attemptedRounds)

      console.log(
        `[${this.name}] Acquired lock for ${discussionId} round ${round} (active: ${this.activeCount}/${this.maxConcurrent})`
      )

      // Return cleanup callback for subclass to call when done
      return { ensureFinalized }
    } catch (err) {
      this.activeCount = Math.max(0, this.activeCount - 1)
      this._drainResponseQueue()
      throw err
    }
  }

  finalizeResponse(discussionId, { success }) {
    this.responding.delete(discussionId)
    this.activeCount = Math.max(0, this.activeCount - 1)

    if (success) {
      this.discussionFailures.delete(discussionId)
      this.localCircuitOpenUntil.delete(discussionId)
    } else {
      const failures = (this.discussionFailures.get(discussionId) || 0) + 1
      this.discussionFailures.set(discussionId, failures)

      if (failures >= this.localCircuitThreshold) {
        const openUntil = Date.now() + this.localCircuitCooldownMs
        this.localCircuitOpenUntil.set(discussionId, openUntil)
        console.warn(
          `[${this.name}] Local circuit opened for ${discussionId} until ${new Date(openUntil).toISOString()}`
        )
      }
    }

    if (this.activeCount < this.maxConcurrent) {
      this._drainResponseQueue()
    }
  }

  _drainResponseQueue() {
    if (this.drainingResponseQueue) {
      return
    }

    this.drainingResponseQueue = true
    try {
      while (this.activeCount < this.maxConcurrent && this.responseQueue.length > 0) {
        const item = this.responseQueue.shift()
        this._tryProcessQueuedItem(item)
      }
    } finally {
      this.drainingResponseQueue = false
    }
  }

  _tryProcessQueuedItem(item) {
    if (!item?.discussionId) {
      return
    }

    const discussionId = item.discussionId
    const status = this.discussion.getStatus(discussionId)

    if (!status.exists || status.status !== 'active') {
      this._cleanupDiscussion(discussionId, 'queue-drain-ended')
      return
    }

    if (!Array.isArray(status.participants) || !status.participants.includes(this.name)) {
      return
    }

    const messages = this.discussion.readAll(discussionId)
    const shouldRespond = this.shouldRespondInRound(discussionId, messages, status)
    if (!shouldRespond) {
      return
    }

    this.respondToTrigger(discussionId, shouldRespond.trigger, messages, shouldRespond.round).catch(err => {
      if (!this.isExpectedResponseFlowError(err)) {
        console.error(`[${this.name}] Error processing queued discussion ${discussionId}:`, this.getResponseErrorCode(err))
      }
    }).finally(() => {
      // 响应完成后检查讨论是否已结束
      const status = this.discussion.getStatus(discussionId)
      if (status.status === 'ended') {
        this._cleanupDiscussion(discussionId, 'ended-after-response')
      }
    })
  }

  _cleanupDiscussion(discussionId, reason = 'manual') {
    const timer = this.discussionTimers.get(discussionId)
    if (timer) {
      clearInterval(timer)
      this.discussionTimers.delete(discussionId)
      this.timers = this.timers.filter(t => t !== timer)
    }

    this.watchedDiscussions.delete(discussionId)
    this.discussionLastWatched.delete(discussionId)
    this.pendingRetries.delete(discussionId)
    this.respondedRounds.delete(discussionId)
    this.responding.delete(discussionId)
    this.discussionFailures.delete(discussionId)
    this.localCircuitOpenUntil.delete(discussionId)
    this.responseQueue = this.responseQueue.filter(item => item.discussionId !== discussionId)

    console.log(`[${this.name}] Cleaned up discussion ${discussionId} (${reason})`)
  }

  _cleanupEndedDiscussions() {
    for (const discussionId of this.watchedDiscussions.keys()) {
      const status = this.discussion.getStatus(discussionId)
      if (!status.exists || status.status === 'ended') {
        this._cleanupDiscussion(discussionId, status.exists ? 'ended-scan' : 'missing-scan')
      }
    }
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
    const agentHeaderPattern = /^AGENT\s*:\s*(.+)$/i
    const maxHeaderProbeNonEmptyLines = 8

    let headerIndex = -1
    let headerMatch = null
    let seenNonEmptyLines = 0

    // Prefer an AGENT header found in the first few non-empty lines, allowing harmless leading noise.
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed) continue
      seenNonEmptyLines++

      const match = trimmed.match(agentHeaderPattern)
      if (match) {
        headerIndex = i
        headerMatch = match
        break
      }

      if (seenNonEmptyLines >= maxHeaderProbeNonEmptyLines) {
        break
      }
    }

    // Fallback to first explicit AGENT header anywhere in output.
    if (!headerMatch) {
      headerIndex = lines.findIndex(line => agentHeaderPattern.test(line.trim()))
      if (headerIndex >= 0) {
        headerMatch = lines[headerIndex].trim().match(agentHeaderPattern)
      }
    }

    let content = ''
    if (headerMatch) {
      const declared = headerMatch[1].trim().toLowerCase()
      if (declared !== this.name.toLowerCase()) {
        return { ok: false, reason: `agent mismatch: ${declared}`, normalizedOutput: text }
      }

      content = lines.slice(headerIndex + 1).join('\n').trim()
      if (!content) {
        return { ok: false, reason: 'empty body after AGENT header', normalizedOutput: '' }
      }
    } else {
      const nonEmptyLines = lines.map(line => line.trim()).filter(Boolean)
      const keyValueLikeLineCount = nonEmptyLines.filter(line => /^[A-Za-z0-9_.-]{1,40}\s*[:=]\s*\S+/.test(line)).length
      const looksLikeNormalAnswer =
        nonEmptyLines.length > 0 &&
        /[A-Za-z\u4e00-\u9fff]{8,}/.test(text) &&
        keyValueLikeLineCount < nonEmptyLines.length

      const diagnosticPatterns = [
        /^\s*(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/m,
        /^\s*\[(?:debug|info|warn|warning|error|trace|fatal)\]\s*/im,
        /^\s*(?:debug|info|warn|warning|error|trace|fatal)\s*[:|-]/im,
        /^\s*(?:traceback \(most recent call last\)|stack trace|caused by:|exception\b)/im,
        /^\s*at\s+\S+\s+\(.+\)\s*$/m,
        /^\s*(?:npm ERR!|node:\w+|exit code\s*[:=]\s*\d+)\b/im
      ]
      const hasDiagnosticLogs = diagnosticPatterns.some(pattern => pattern.test(text))

      if (!looksLikeNormalAnswer || hasDiagnosticLogs) {
        return { ok: false, reason: 'missing AGENT header', normalizedOutput: text }
      }

      console.warn(`[${this.name}] Missing AGENT header; accepted output via safe fallback`)
      content = text
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
      this.pendingRetries.delete(discussionId)
      this.finalizeResponse(discussionId, { success: true })
      return message
    } catch (err) {
      console.error(`[${this.name}] Failed to send response:`, err.message)
      this.finalizeResponse(discussionId, { success: false })
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
      this.finalizeResponse(discussionId, { success: false })

      return message
    } catch (err) {
      console.error(`[${this.name}] Failed to send error:`, err.message)
      this.finalizeResponse(discussionId, { success: false })
      return null
    }
  }

  /**
   * Send a "thinking" status message
   * @param {string} discussionId
   * @param {number} round
   * @param {string} [detail] - Optional detail about what the agent is doing
   */
  sendThinkingStatus(discussionId, round, detail = '') {
    try {
      const content = detail
        ? `${this.name} ${detail}`
        : `${this.name} is thinking...`

      const message = this.discussion.append(discussionId, {
        from: this.name,
        type: 'status',
        status: 'thinking',
        round,
        content
      })

      console.log(`[${this.name}] Thinking status sent (round: ${round}): ${detail || 'thinking'}`)
      return message
    } catch (err) {
      console.error(`[${this.name}] Failed to send thinking status:`, err.message)
      return null
    }
  }

  /**
   * Update thinking status with progress detail
   * @param {string} discussionId
   * @param {number} round
   * @param {string} detail
   */
  updateThinkingDetail(discussionId, round, detail) {
    try {
      this.discussion.append(discussionId, {
        from: this.name,
        type: 'status',
        status: 'thinking',
        round,
        content: `${this.name} ${detail}`
      })
    } catch (err) {
      console.error(`[${this.name}] Failed to update thinking detail:`, err.message)
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
    return this.handleRetriableError(discussionId, trigger, allMessages, errorMessage, round, 'timed out')
  }

  /**
   * Handle retriable errors with bounded retries and backoff.
   * @param {string} discussionId
   * @param {object} trigger
   * @param {object[]} allMessages
   * @param {string} errorMessage
   * @param {number} round - The round number
   * @param {string} reason - Short reason shown in status updates
   */
  async handleRetriableError(discussionId, trigger, allMessages, errorMessage, round, reason = 'failed') {
    // Get or initialize retry state
    if (!this.pendingRetries.has(discussionId)) {
      this.pendingRetries.set(discussionId, { attempts: 0, maxAttempts: 3 })  // 从 10 改为 3
    }

    const retryState = this.pendingRetries.get(discussionId)
    retryState.attempts++

    console.log(`[${this.name}] Retryable error attempt ${retryState.attempts}/${retryState.maxAttempts} for ${discussionId} (round ${round}): ${reason}`)

    if (retryState.attempts < retryState.maxAttempts) {
      // Send retry status
      this.discussion.append(discussionId, {
        from: this.name,
        type: 'status',
        status: 'retrying',
        round,
        content: `${this.name} ${reason}, retrying (${retryState.attempts}/${retryState.maxAttempts})...`
      })

      // Wait before retry (faster backoff: 5s, 10s, 20s)
      const delay = Math.min(5000 * Math.pow(2, retryState.attempts - 1), 30000)
      await new Promise(resolve => setTimeout(resolve, delay))

      // Retry - remove round from attemptedRounds to allow retry
      const attemptedRounds = this.respondedRounds.get(discussionId)
      if (attemptedRounds) {
        attemptedRounds.delete(round)
        console.log(`[${this.name}] Cleared round ${round} from attempted set for retry`)
      }
      // Release current slot/lock before next retry attempt.
      this.finalizeResponse(discussionId, { success: false })

      try {
        await this.respondToTrigger(discussionId, trigger, allMessages, round)
      } catch (err) {
        if (this.isExpectedResponseFlowError(err)) {
          console.log(`[${this.name}] Retry blocked: ${this.getResponseErrorCode(err)}`)
        } else {
          console.error(`[${this.name}] Retry failed:`, this.getResponseErrorCode(err))
        }
      }
    } else {
      // Max retries reached, send error
      console.error(`[${this.name}] Max retries reached for ${discussionId}`)
      // Allow future polling cycles to retry the same round when provider recovers.
      const attemptedRounds = this.respondedRounds.get(discussionId)
      if (attemptedRounds) {
        attemptedRounds.delete(round)
      }
      this.sendError(discussionId, `Failed after ${retryState.maxAttempts} attempts: ${errorMessage}`, round)

      // Clear retry state
      this.pendingRetries.delete(discussionId)
    }
  }

  runCommand(command, args, cwd) {
    try {
      const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        timeout: 1500,
        maxBuffer: 1024 * 1024
      })

      return {
        ok: result.status === 0,
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim()
      }
    } catch (err) {
      return {
        ok: false,
        stdout: '',
        stderr: err.message
      }
    }
  }

  isCoDevModeEnabled(status, messages = []) {
    let enabled = Boolean(status?.context?.coDevMode?.enabled || status?.context?.coDevEnabled)

    for (const msg of messages) {
      if (msg.type === MESSAGE_TYPES.MODE && (msg.key === 'co-dev' || msg.key === 'co_dev' || msg.key === 'codev')) {
        enabled = Boolean(msg.enabled)
      }
    }

    return enabled
  }

  getProjectSnapshot(workingDir) {
    if (!workingDir) {
      return 'Project Snapshot:\n- unavailable: missing working directory'
    }

    const inRepo = this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], workingDir)
    if (!inRepo.ok || inRepo.stdout !== 'true') {
      return 'Project Snapshot:\n- unavailable: working directory is not a git repository'
    }

    const branch = this.runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], workingDir)
    const head = this.runCommand('git', ['log', '-1', '--pretty=format:%h %s (%cr)'], workingDir)
    const recentCommits = this.runCommand('git', ['log', '-5', '--pretty=format:%h %s'], workingDir)
    const statusShort = this.runCommand('git', ['status', '--short', '--untracked-files=normal'], workingDir)
    const stagedStat = this.runCommand('git', ['diff', '--cached', '--shortstat'], workingDir)
    const unstagedStat = this.runCommand('git', ['diff', '--shortstat'], workingDir)
    const stagedFiles = this.runCommand('git', ['diff', '--cached', '--name-only'], workingDir)
    const unstagedFiles = this.runCommand('git', ['diff', '--name-only'], workingDir)

    const files = new Set()
    for (const line of (stagedFiles.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)) {
      files.add(line)
    }
    for (const line of (unstagedFiles.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)) {
      files.add(line)
    }
    for (const line of (statusShort.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)) {
      if (line.startsWith('?? ')) {
        files.add(line.slice(3))
      }
    }

    const changedFiles = [...files]
    const changedPreview = changedFiles.length > 0
      ? changedFiles.slice(0, 20).map(f => `  - ${f}`).join('\n')
      : '  - (none)'

    const commitPreview = recentCommits.ok && recentCommits.stdout
      ? recentCommits.stdout.split('\n').slice(0, 5).map(c => `  - ${c}`).join('\n')
      : '  - (no commit history available)'

    return [
      'Project Snapshot:',
      `- branch: ${branch.ok && branch.stdout ? branch.stdout : '(unknown)'}`,
      `- head: ${head.ok && head.stdout ? head.stdout : '(unknown)'}`,
      `- staged diff: ${stagedStat.ok && stagedStat.stdout ? stagedStat.stdout : 'none'}`,
      `- unstaged diff: ${unstagedStat.ok && unstagedStat.stdout ? unstagedStat.stdout : 'none'}`,
      `- changed files (${changedFiles.length}):`,
      changedPreview,
      '- recent commits:',
      commitPreview
    ].join('\n')
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

    // 只在明确提供了工作目录时才添加项目上下文
    const workingDir = status.context?.workingDir
    if (workingDir) {
      context += `Project Directory: ${workingDir}\n`
      context += `(If this discussion involves code or files, they may be located in this directory.)\n\n`
    }

    const coDevEnabled = this.isCoDevModeEnabled(status, messages)
    context += `Co-Development Mode: ${coDevEnabled ? 'enabled' : 'disabled'}\n`
    if (coDevEnabled && workingDir) {
      context += `Co-Development Goal:\n`
      context += `- Review the latest project changes and evaluate quality.\n`
      context += `- Propose concrete next implementation steps.\n`
      context += `- Point out issues or concerns when possible.\n\n`
      context += `Co-Development Execution Policy:\n`
      context += `- You may directly edit project files for small, reversible improvements.\n`
      context += `- Prefer minimal, focused changes instead of big refactors.\n`
      context += `- Run at least one relevant check command after edits and report the result.\n`
      context += `- Never run git commit/push/reset and do not revert unrelated local changes.\n\n`
      const snapshot = this.getProjectSnapshot(workingDir)
      context += `${snapshot}\n\n`
    } else {
      context += '\n'
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
        case MESSAGE_TYPES.MODE:
          context += `  Mode: ${msg.key} => ${msg.enabled ? 'on' : 'off'}\n`
          break
        default:
          context += `  ${JSON.stringify(msg)}\n`
      }
    }

    return context
  }
}

export { AgentBase }
