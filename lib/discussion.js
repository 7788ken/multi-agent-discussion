/**
 * Discussion file manager
 * Handles creating, reading, appending to discussion JSONL files
 */

import fs from 'fs'
import path from 'path'
import { parseMessage, serializeMessage, createStartMessage, MESSAGE_TYPES } from './message.js'

const DEFAULT_BASE_DIR = process.env.MULTI_AGENT_BASE_DIR || path.join(process.cwd(), 'discussions')

/**
 * Generate a numeric discussion ID
 * @param {string} topic
 * @returns {string}
 */
function generateDiscussionId(topic) {
  // Use timestamp-based numeric ID (last 8 digits of timestamp)
  const id = Date.now().toString().slice(-8)
  return id
}

/**
 * Discussion manager class
 */
class Discussion {
  /**
   * @param {string} [baseDir] - Base directory for discussions
   */
  constructor(baseDir = DEFAULT_BASE_DIR) {
    this.baseDir = baseDir
    this.sleepArray = new Int32Array(new SharedArrayBuffer(4))
    this.ensureDir()
  }

  ensureDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true })
    }
  }

  sleep(ms) {
    if (ms <= 0) return
    if (typeof Atomics?.wait === 'function') {
      Atomics.wait(this.sleepArray, 0, 0, ms)
      return
    }
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Fallback busy wait on runtimes without Atomics.wait.
    }
  }

  getLockFilePath(discussionId) {
    return `${this.getFilePath(discussionId)}.lock`
  }

  acquireFileLock(lockPath, options = {}) {
    const timeoutMs = options.timeoutMs || 10000
    const retryDelayMs = options.retryDelayMs || 20
    const staleMs = options.staleMs || 30000
    const start = Date.now()

    while (true) {
      try {
        const fd = fs.openSync(lockPath, 'wx')
        fs.writeFileSync(fd, `${process.pid}:${Date.now()}`, 'utf8')
        return fd
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw err
        }

        try {
          const stat = fs.statSync(lockPath)
          if (Date.now() - stat.mtimeMs > staleMs) {
            fs.unlinkSync(lockPath)
            continue
          }
        } catch {
          // Lock may have been released by another process. Retry.
        }

        if (Date.now() - start >= timeoutMs) {
          throw new Error(`Failed to acquire append lock: ${lockPath}`)
        }

        this.sleep(retryDelayMs)
      }
    }
  }

  releaseFileLock(lockPath, fd) {
    if (fd !== undefined && fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Ignore close errors on best-effort lock release.
      }
    }

    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath)
      }
    } catch {
      // Ignore unlink errors on best-effort lock release.
    }
  }

  /**
   * Get discussion file path
   * @param {string} discussionId
   * @returns {string}
   */
  getFilePath(discussionId) {
    return path.join(this.baseDir, `${discussionId}.jsonl`)
  }

  /**
   * Get result file path
   * @param {string} discussionId
   * @returns {string}
   */
  getResultFilePath(discussionId) {
    return path.join(this.baseDir, `${discussionId}-result.md`)
  }

  /**
   * Create a new discussion
   * @param {string} topic
   * @param {string[]} participants
   * @param {object} [context] - Optional context (workingDir, etc.)
   * @returns {{ discussionId: string, message: object }}
   */
  create(topic, participants = ['claude', 'codex'], context = {}) {
    const discussionId = generateDiscussionId(topic)
    const filePath = this.getFilePath(discussionId)
    const message = createStartMessage(1, topic, participants, context)

    // Write first message
    fs.writeFileSync(filePath, serializeMessage(message) + '\n', 'utf8')

    // Create initial result file
    this.updateResultFile(discussionId, topic, participants, [], 0, 'pending')

    return { discussionId, message }
  }

  /**
   * Update the result markdown file
   * @param {string} discussionId
   * @param {string} topic
   * @param {string[]} participants
   * @param {object[]} messages
   * @param {number} currentRound
   * @param {string} status
   * @param {object} [consensus]
   */
  updateResultFile(discussionId, topic, participants, messages, currentRound, status, consensus = null) {
    const resultPath = this.getResultFilePath(discussionId)

    let content = `# Discussion Result: ${topic}\n\n`
    content += `**Discussion ID:** ${discussionId}\n`
    content += `**Participants:** ${participants.join(', ')}\n`
    content += `**Status:** ${status}\n`
    content += `**Current Round:** ${currentRound}\n\n`

    // Status summary
    content += `## Round Status\n\n`
    const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)
    const respondedAgents = new Set(responses.map(r => r.from))

    for (const p of participants) {
      if (respondedAgents.has(p)) {
        content += `- ✅ **${p}**: Completed\n`
      } else {
        content += `- ⏳ **${p}**: Thinking...\n`
      }
    }
    content += `\n`

    // Discussion history
    content += `## Discussion History\n\n`
    for (const msg of messages) {
      const time = msg.ts ? new Date(msg.ts).toLocaleTimeString() : ''
      switch (msg.type) {
        case MESSAGE_TYPES.START:
          content += `### 📋 Topic\n${msg.topic}\n\n`
          break
        case MESSAGE_TYPES.RESPONSE:
          content += `### 💬 ${msg.from} (Round ${msg.round || 1}) - ${time}\n`
          content += `**Opinion:** ${msg.opinion} | **Confidence:** ${((msg.confidence || 0.7) * 100).toFixed(0)}%\n\n`
          content += `${msg.content}\n\n`
          content += `---\n\n`
          break
        case MESSAGE_TYPES.FOLLOWUP:
          content += `### ❓ User Follow-up - ${time}\n${msg.content}\n\n`
          break
        default:
          break
      }
    }

    // Consensus / Summary
    if (consensus || status === 'ended') {
      content += `## 📊 Consensus Analysis\n\n`
      if (consensus) {
        content += `- **Has Consensus:** ${consensus.hasConsensus ? 'Yes ✅' : 'No ❌'}\n`
        content += `- **Agreement Level:** ${((consensus.agreementLevel || 0) * 100).toFixed(0)}%\n`
        content += `- **Average Confidence:** ${((consensus.averageConfidence || 0) * 100).toFixed(0)}%\n\n`
        content += `**Opinion Distribution:**\n`
        content += `- Agree: ${consensus.opinions?.agree || 0}\n`
        content += `- Disagree: ${consensus.opinions?.disagree || 0}\n`
        content += `- Neutral: ${consensus.opinions?.neutral || 0}\n`
        content += `- Alternative: ${consensus.opinions?.alternative || 0}\n`
      }
    }

    // Key conclusions
    if (status === 'ended' && messages.length > 0) {
      const endMsg = messages.find(m => m.type === MESSAGE_TYPES.END)
      if (endMsg) {
        content += `## 🎯 Final Decision\n\n${endMsg.decision}\n`
      }
    } else if (status === 'active') {
      content += `## 📝 Preliminary Conclusions\n\n`
      content += `*Discussion in progress...*\n\n`

      // Extract key points from responses
      const keyPoints = this.extractKeyPoints(responses)
      if (keyPoints.agreements.length > 0 || keyPoints.divergences.length > 0) {
        if (keyPoints.agreements.length > 0) {
          content += `**Points of Agreement:**\n`
          for (const point of keyPoints.agreements) {
            content += `- ${point}\n`
          }
          content += `\n`
        }
        if (keyPoints.divergences.length > 0) {
          content += `**Points of Divergence:**\n`
          for (const point of keyPoints.divergences) {
            content += `- ${point}\n`
          }
        }
      }
    }

    fs.writeFileSync(resultPath, content, 'utf8')
  }

  /**
   * Extract key points from responses
   * @param {object[]} responses
   * @returns {{ agreements: string[], divergences: string[] }}
   */
  extractKeyPoints(responses) {
    const agreements = []
    const divergences = []

    for (const r of responses) {
      if (r.opinion === 'agree' && r.content) {
        // Extract first sentence as key point
        const firstSentence = r.content.split(/[.!。]\s*/)[0]
        if (firstSentence) {
          agreements.push(`${r.from}: ${firstSentence.substring(0, 100)}...`)
        }
      } else if ((r.opinion === 'disagree' || r.opinion === 'alternative') && r.content) {
        const firstSentence = r.content.split(/[.!。]\s*/)[0]
        if (firstSentence) {
          divergences.push(`${r.from}: ${firstSentence.substring(0, 100)}...`)
        }
      }
    }

    return { agreements, divergences }
  }

  /**
   * Append a message to discussion
   * @param {string} discussionId
   * @param {object} messageData - Message data (without seq and ts)
   * @returns {object} The created message with seq and ts
   */
  append(discussionId, messageData) {
    const filePath = this.getFilePath(discussionId)
    const lockPath = this.getLockFilePath(discussionId)

    if (!fs.existsSync(filePath)) {
      throw new Error(`Discussion not found: ${discussionId}`)
    }

    let lockFd
    let message

    try {
      lockFd = this.acquireFileLock(lockPath)

      // Get current seq inside lock to avoid concurrent duplicate seq assignment.
      const messages = this.readAll(discussionId)
      const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0
      const newSeq = lastSeq + 1
      const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)

      // Persist follow-up round so all agents target the same round number.
      let assignedRound = messageData.round
      if (messageData.type === MESSAGE_TYPES.FOLLOWUP && assignedRound === undefined) {
        const highestRound = responses.length > 0
          ? Math.max(...responses.map(r => r.round || 0))
          : 0
        assignedRound = highestRound + 1
      }

      // Create message with seq and ts
      message = {
        ...messageData,
        ...(assignedRound !== undefined ? { round: assignedRound } : {}),
        seq: newSeq,
        ts: new Date().toISOString()
      }

      fs.appendFileSync(filePath, serializeMessage(message) + '\n', 'utf8')
    } finally {
      this.releaseFileLock(lockPath, lockFd)
    }

    // Update result file after each message
    this.refreshResultFile(discussionId)

    return message
  }

  /**
   * Refresh the result file with current discussion state
   * @param {string} discussionId
   */
  refreshResultFile(discussionId) {
    const status = this.getStatus(discussionId)
    if (!status.exists) return

    const messages = this.readAll(discussionId)
    this.updateResultFile(
      discussionId,
      status.topic,
      status.participants,
      messages,
      status.currentRound,
      status.status
    )
  }

  /**
   * Read all messages from discussion
   * @param {string} discussionId
   * @returns {object[]}
   */
  readAll(discussionId) {
    const filePath = this.getFilePath(discussionId)

    if (!fs.existsSync(filePath)) {
      return []
    }

    const content = fs.readFileSync(filePath, 'utf8')
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(parseMessage)
      .filter(Boolean)
  }

  /**
   * Get discussion status
   * @param {string} discussionId
   * @returns {object}
   */
  getStatus(discussionId) {
    const messages = this.readAll(discussionId)

    if (messages.length === 0) {
      return { exists: false }
    }

    const startMsg = messages.find(m => m.type === MESSAGE_TYPES.START)
    const endMsg = messages.find(m => m.type === MESSAGE_TYPES.END)
    const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)
    const currentRound = Math.max(0, ...responses.map(m => m.round || 0))

    return {
      exists: true,
      discussionId,
      topic: startMsg?.topic,
      participants: startMsg?.participants || [],
      context: startMsg?.context || {},
      status: endMsg ? 'ended' : 'active',
      messageCount: messages.length,
      currentRound,
      startTime: startMsg?.ts,
      endTime: endMsg?.ts,
      decision: endMsg?.decision,
      consensus: endMsg?.consensus
    }
  }

  /**
   * List all discussions
   * @returns {object[]}
   */
  listAll() {
    if (!fs.existsSync(this.baseDir)) {
      return []
    }

    const files = fs.readdirSync(this.baseDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse() // Most recent first

    return files.map(f => {
      const discussionId = f.replace('.jsonl', '')
      return this.getStatus(discussionId)
    })
  }

  /**
   * Watch discussion for changes (polling based)
   * @param {string} discussionId
   * @param {function} callback - Called with (newMessages)
   * @param {object} [options]
   * @param {number} [options.interval] - Polling interval in ms
   * @returns {function} Stop watching function
   */
  watch(discussionId, callback, options = {}) {
    const interval = options.interval || 2000
    let lastCount = 0
    let stopped = false

    const poll = () => {
      if (stopped) return

      const messages = this.readAll(discussionId)
      if (messages.length > lastCount) {
        const newMessages = messages.slice(lastCount)
        callback(newMessages)
        lastCount = messages.length
      }

      setTimeout(poll, interval)
    }

    // Initial count
    lastCount = this.readAll(discussionId).length
    poll()

    return () => {
      stopped = true
    }
  }

  /**
   * Get last N messages
   * @param {string} discussionId
   * @param {number} count
   * @returns {object[]}
   */
  getLast(discussionId, count = 10) {
    const messages = this.readAll(discussionId)
    return messages.slice(-count)
  }

  /**
   * Format discussion for display
   * @param {string} discussionId
   * @returns {string}
   */
  format(discussionId) {
    const messages = this.readAll(discussionId)
    const status = this.getStatus(discussionId)

    let output = `Discussion: ${discussionId}\n`
    output += `Topic: ${status.topic}\n`
    output += `Participants: ${status.participants.join(', ')}\n`
    output += `Status: ${status.status}\n`
    output += `Messages: ${status.messageCount}\n`
    output += `\n${'='.repeat(50)}\n\n`

    for (const msg of messages) {
      const time = msg.ts ? new Date(msg.ts).toLocaleTimeString() : ''
      const prefix = `[${time}] <${msg.from}>`

      switch (msg.type) {
        case MESSAGE_TYPES.START:
          output += `${prefix}\n  Topic: ${msg.topic}\n  Participants: ${msg.participants.join(', ')}\n\n`
          break
        case MESSAGE_TYPES.RESPONSE:
          output += `${prefix} (${msg.opinion}, confidence: ${msg.confidence})\n  ${msg.content}\n\n`
          break
        case MESSAGE_TYPES.FOLLOWUP:
          output += `${prefix}\n  ${msg.content}${msg.target ? ` (to: ${msg.target})` : ''}\n\n`
          break
        case MESSAGE_TYPES.END:
          output += `${prefix}\n  Decision: ${msg.decision}\n  Consensus: ${msg.consensus}\n\n`
          break
        case MESSAGE_TYPES.ERROR:
          output += `${prefix} [ERROR]\n  ${msg.error}\n\n`
          break
        default:
          output += `${prefix}\n  ${JSON.stringify(msg)}\n\n`
      }
    }

    return output
  }
}

export {
  Discussion,
  generateDiscussionId,
  DEFAULT_BASE_DIR
}
