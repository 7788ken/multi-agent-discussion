/**
 * Discussion Coordinator
 * Manages multi-round discussions, consensus detection, and decision making
 */

import { Discussion } from './discussion.js'
import { MESSAGE_TYPES, OPINIONS } from './message.js'

/**
 * Analyze discussion for consensus
 * @param {object[]} messages
 * @param {string[]} participants
 * @returns {{ hasConsensus: boolean, opinions: object, agreementLevel: number }}
 */
function analyzeConsensus(messages, participants) {
  const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)

  // Get latest response from each participant
  const latestResponses = new Map()
  for (const r of responses) {
    const existing = latestResponses.get(r.from)
    if (!existing || r.seq > existing.seq) {
      latestResponses.set(r.from, r)
    }
  }

  // Count opinions
  const opinionCounts = {
    [OPINIONS.AGREE]: 0,
    [OPINIONS.DISAGREE]: 0,
    [OPINIONS.NEUTRAL]: 0,
    [OPINIONS.ALTERNATIVE]: 0
  }

  let totalConfidence = 0
  let responseCount = 0

  for (const [agent, response] of latestResponses) {
    if (participants.includes(agent)) {
      opinionCounts[response.opinion]++
      totalConfidence += response.confidence || 0.7
      responseCount++
    }
  }

  // Calculate agreement level (0-1)
  const agreeWeight = opinionCounts[OPINIONS.AGREE] * 1
  const neutralWeight = opinionCounts[OPINIONS.NEUTRAL] * 0.5
  const alternativeWeight = opinionCounts[OPINIONS.ALTERNATIVE] * 0.3
  const disagreeWeight = opinionCounts[OPINIONS.DISAGREE] * 0

  const totalWeight = agreeWeight + neutralWeight + alternativeWeight + disagreeWeight
  const maxWeight = responseCount

  const agreementLevel = maxWeight > 0 ? totalWeight / maxWeight : 0

  // Determine if consensus exists
  const hasConsensus = agreementLevel >= 0.7 && opinionCounts[OPINIONS.DISAGREE] === 0

  return {
    hasConsensus,
    opinions: opinionCounts,
    agreementLevel,
    responseCount,
    averageConfidence: responseCount > 0 ? totalConfidence / responseCount : 0,
    latestResponses: Object.fromEntries(latestResponses)
  }
}

/**
 * Calculate next round number
 * @param {object[]} messages
 * @returns {number}
 */
function calculateNextRound(messages) {
  const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)
  if (responses.length === 0) return 1
  return Math.max(...responses.map(r => r.round || 0)) + 1
}

/**
 * Check if all participants have responded in current round
 * @param {object[]} messages
 * @param {string[]} participants
 * @returns {{ allResponded: boolean, pendingAgents: string[], currentRound: number }}
 */
function checkRoundCompletion(messages, participants) {
  const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)
  const currentRound = responses.length > 0
    ? Math.max(...responses.map(r => r.round || 0))
    : 0

  // Find agents who responded in current round
  const respondedAgents = new Set(
    responses
      .filter(r => r.round === currentRound)
      .map(r => r.from)
  )

  const pendingAgents = participants.filter(p => !respondedAgents.has(p))
  const allResponded = pendingAgents.length === 0

  return {
    allResponded,
    pendingAgents,
    currentRound
  }
}

/**
 * Discussion Coordinator class
 */
class Coordinator {
  /**
   * @param {object} options
   * @param {number} [options.maxRounds] - Maximum discussion rounds
   * @param {number} [options.consensusThreshold] - Threshold for consensus (0-1)
   * @param {number} [options.responseTimeout] - Timeout for responses in ms
   */
  constructor(options = {}) {
    this.discussion = new Discussion()
    this.maxRounds = options.maxRounds || 5
    this.consensusThreshold = options.consensusThreshold || 0.7
    this.responseTimeout = options.responseTimeout || 300000 // 5 minutes
  }

  /**
   * Create a new discussion
   * @param {string} topic
   * @param {string[]} participants
   * @returns {{ discussionId: string, message: object }}
   */
  createDiscussion(topic, participants = ['claude', 'codex']) {
    return this.discussion.create(topic, participants)
  }

  /**
   * Get discussion analysis
   * @param {string} discussionId
   * @returns {object}
   */
  analyzeDiscussion(discussionId) {
    const status = this.discussion.getStatus(discussionId)
    const messages = this.discussion.readAll(discussionId)

    if (!status.exists) {
      return { exists: false }
    }

    const consensus = analyzeConsensus(messages, status.participants)
    const roundStatus = checkRoundCompletion(messages, status.participants)

    return {
      ...status,
      consensus,
      roundStatus,
      canAdvance: roundStatus.allResponded && status.currentRound < this.maxRounds,
      isComplete: status.status === 'ended' || consensus.hasConsensus || status.currentRound >= this.maxRounds
    }
  }

  /**
   * Ask a follow-up question
   * @param {string} discussionId
   * @param {string} question
   * @param {string} [target] - Optional target agent
   * @returns {object}
   */
  askFollowup(discussionId, question, target = null) {
    const status = this.discussion.getStatus(discussionId)

    if (!status.exists) {
      throw new Error(`Discussion not found: ${discussionId}`)
    }

    if (status.status === 'ended') {
      throw new Error('Cannot ask followup on ended discussion')
    }

    return this.discussion.append(discussionId, {
      from: 'user',
      type: MESSAGE_TYPES.FOLLOWUP,
      content: question,
      target
    })
  }

  /**
   * End discussion with decision
   * @param {string} discussionId
   * @param {string} decision
   * @param {boolean} [consensus]
   * @returns {object}
   */
  endDiscussion(discussionId, decision, consensus = true) {
    const status = this.discussion.getStatus(discussionId)

    if (!status.exists) {
      throw new Error(`Discussion not found: ${discussionId}`)
    }

    return this.discussion.append(discussionId, {
      from: 'user',
      type: MESSAGE_TYPES.END,
      decision,
      consensus
    })
  }

  /**
   * Generate a summary of the discussion
   * @param {string} discussionId
   * @returns {string}
   */
  generateSummary(discussionId) {
    const analysis = this.analyzeDiscussion(discussionId)
    const messages = this.discussion.readAll(discussionId)

    if (!analysis.exists) {
      return 'Discussion not found'
    }

    let summary = `# Discussion Summary: ${analysis.topic}\n\n`
    summary += `**Participants:** ${analysis.participants.join(', ')}\n`
    summary += `**Rounds:** ${analysis.currentRound}\n`
    summary += `**Messages:** ${analysis.messageCount}\n`
    summary += `**Status:** ${analysis.status}\n\n`

    // Opinion breakdown
    summary += `## Opinion Breakdown\n\n`
    const { opinions, agreementLevel, averageConfidence } = analysis.consensus
    summary += `- Agree: ${opinions.agree}\n`
    summary += `- Disagree: ${opinions.disagree}\n`
    summary += `- Neutral: ${opinions.neutral}\n`
    summary += `- Alternative: ${opinions.alternative}\n`
    summary += `- Agreement Level: ${(agreementLevel * 100).toFixed(0)}%\n`
    summary += `- Average Confidence: ${(averageConfidence * 100).toFixed(0)}%\n\n`

    // Key points
    summary += `## Key Points\n\n`
    const responses = messages.filter(m => m.type === MESSAGE_TYPES.RESPONSE)
    for (const r of responses) {
      summary += `**${r.from}** (${r.opinion}):\n${r.content}\n\n`
    }

    if (analysis.status === 'ended') {
      summary += `## Final Decision\n\n${analysis.decision}\n`
    }

    return summary
  }

  /**
   * Check if discussion needs user intervention
   * @param {string} discussionId
   * @returns {{ needsIntervention: boolean, reason: string, suggestedAction: string }}
   */
  checkNeedsIntervention(discussionId) {
    const analysis = this.analyzeDiscussion(discussionId)

    if (!analysis.exists) {
      return { needsIntervention: false, reason: 'Discussion not found', suggestedAction: '' }
    }

    if (analysis.status === 'ended') {
      return { needsIntervention: false, reason: 'Discussion ended', suggestedAction: '' }
    }

    // Check for consensus
    if (analysis.consensus.hasConsensus) {
      return {
        needsIntervention: true,
        reason: 'Consensus reached',
        suggestedAction: 'End discussion with the agreed decision'
      }
    }

    // Check for max rounds
    if (analysis.currentRound >= this.maxRounds) {
      return {
        needsIntervention: true,
        reason: `Maximum rounds (${this.maxRounds}) reached`,
        suggestedAction: 'Review opinions and make a decision'
      }
    }

    // Check for disagreement
    if (analysis.consensus.opinions.disagree > 0) {
      return {
        needsIntervention: true,
        reason: 'Disagreement detected',
        suggestedAction: 'Ask clarifying questions or make executive decision'
      }
    }

    // Check for pending responses
    if (!analysis.roundStatus.allResponded) {
      return {
        needsIntervention: false,
        reason: `Waiting for: ${analysis.roundStatus.pendingAgents.join(', ')}`,
        suggestedAction: ''
      }
    }

    return {
      needsIntervention: false,
      reason: 'Discussion in progress',
      suggestedAction: ''
    }
  }
}

export {
  Coordinator,
  analyzeConsensus,
  calculateNextRound,
  checkRoundCompletion
}
