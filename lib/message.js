/**
 * Message format definition for multi-agent discussion
 */

/**
 * @typedef {Object} Message
 * @property {number} seq - Sequence number (auto-incremented)
 * @property {string} ts - ISO timestamp
 * @property {string} from - Sender: 'user', 'claude', 'codex', or custom agent name
 * @property {string} type - Message type: 'start', 'response', 'followup', 'end', 'error'
 * @property {number} [round] - Discussion round number
 * @property {string} [topic] - Discussion topic (for 'start' type)
 * @property {string[]} [participants] - List of participants (for 'start' type)
 * @property {string} [opinion] - Opinion: 'agree', 'disagree', 'neutral', 'alternative'
 * @property {string} [content] - Message content
 * @property {number} [confidence] - Confidence level (0-1)
 * @property {string} [decision] - Final decision (for 'end' type)
 * @property {string} [error] - Error message (for 'error' type)
 */

const MESSAGE_TYPES = {
  START: 'start',       // Start a new discussion
  RESPONSE: 'response', // Agent response
  FOLLOWUP: 'followup', // User follow-up question
  END: 'end',           // End discussion
  ERROR: 'error'        // Error message
}

const OPINIONS = {
  AGREE: 'agree',
  DISAGREE: 'disagree',
  NEUTRAL: 'neutral',
  ALTERNATIVE: 'alternative'
}

/**
 * Create a new message
 * @param {Object} params
 * @param {number} params.seq - Sequence number
 * @param {string} params.from - Sender
 * @param {string} params.type - Message type
 * @param {Object} [params.data] - Additional data
 * @returns {Message}
 */
function createMessage({ seq, from, type, ...data }) {
  return {
    seq,
    ts: new Date().toISOString(),
    from,
    type,
    ...data
  }
}

/**
 * Create a start message
 * @param {number} seq
 * @param {string} topic
 * @param {string[]} participants
 * @param {object} [context] - Optional context (workingDir, etc.)
 * @returns {Message}
 */
function createStartMessage(seq, topic, participants, context = {}) {
  return createMessage({
    seq,
    from: 'user',
    type: MESSAGE_TYPES.START,
    topic,
    participants,
    context
  })
}

/**
 * Create a response message
 * @param {number} seq
 * @param {string} from
 * @param {number} round
 * @param {string} opinion
 * @param {string} content
 * @param {number} [confidence]
 * @returns {Message}
 */
function createResponseMessage(seq, from, round, opinion, content, confidence = 0.7) {
  return createMessage({
    seq,
    from,
    type: MESSAGE_TYPES.RESPONSE,
    round,
    opinion,
    content,
    confidence
  })
}

/**
 * Create a followup message
 * @param {number} seq
 * @param {string} content
 * @param {string} [target] - Target agent (optional)
 * @returns {Message}
 */
function createFollowupMessage(seq, content, target = null) {
  return createMessage({
    seq,
    from: 'user',
    type: MESSAGE_TYPES.FOLLOWUP,
    content,
    target
  })
}

/**
 * Create an end message
 * @param {number} seq
 * @param {string} decision
 * @param {boolean} [consensus]
 * @returns {Message}
 */
function createEndMessage(seq, decision, consensus = true) {
  return createMessage({
    seq,
    from: 'user',
    type: MESSAGE_TYPES.END,
    decision,
    consensus
  })
}

/**
 * Create an error message
 * @param {number} seq
 * @param {string} from
 * @param {string} error
 * @param {number} [round] - The round this error is for
 * @returns {Message}
 */
function createErrorMessage(seq, from, error, round) {
  const msg = createMessage({
    seq,
    from,
    type: MESSAGE_TYPES.ERROR,
    error
  })
  if (round !== undefined) {
    msg.round = round
  }
  return msg
}

/**
 * Parse a JSONL line to message object
 * @param {string} line
 * @returns {Message|null}
 */
function parseMessage(line) {
  try {
    return JSON.parse(line.trim())
  } catch {
    return null
  }
}

/**
 * Serialize message to JSONL line
 * @param {Message} message
 * @returns {string}
 */
function serializeMessage(message) {
  return JSON.stringify(message)
}

export {
  MESSAGE_TYPES,
  OPINIONS,
  createMessage,
  createStartMessage,
  createResponseMessage,
  createFollowupMessage,
  createEndMessage,
  createErrorMessage,
  parseMessage,
  serializeMessage
}
