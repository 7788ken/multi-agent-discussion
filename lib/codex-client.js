/**
 * Codex CLI client
 * Wraps the codex exec command for non-interactive execution
 */

import { spawn, spawnSync } from 'child_process'
import { OPINIONS } from './message.js'

// Codex CLI path (prefer env override, fallback to PATH lookup command)
const CODEX_BIN = process.env.CODEX_BIN || 'codex'

/**
 * Parse Codex response to extract opinion and content
 * @param {string} response
 * @returns {{ opinion: string, content: string, confidence: number }}
 */
function parseCodexResponse(response) {
  // Try to extract structured response
  const lines = response.trim().split('\n')

  let opinion = OPINIONS.NEUTRAL
  let content = response.trim()
  let confidence = 0.7

  // Check for opinion markers
  const opinionPatterns = [
    { pattern: /\b(agree|agreed|support|推荐|支持|同意)\b/i, opinion: OPINIONS.AGREE },
    { pattern: /\b(disagree|disagreed|oppose|反对|不推荐|不同意)\b/i, opinion: OPINIONS.DISAGREE },
    { pattern: /\b(alternative|alternatively|instead|建议|或者|另一个方案)\b/i, opinion: OPINIONS.ALTERNATIVE },
    { pattern: /\b(neutral|maybe|perhaps|可能|也许|中立)\b/i, opinion: OPINIONS.NEUTRAL }
  ]

  for (const { pattern, opinion: op } of opinionPatterns) {
    if (pattern.test(response)) {
      opinion = op
      break
    }
  }

  // Try to extract confidence
  const confidenceMatch = response.match(/confidence[:\s]+(\d+(?:\.\d+)?)/i)
  if (confidenceMatch) {
    confidence = parseFloat(confidenceMatch[1])
    if (confidence > 1) confidence = confidence / 100 // Convert percentage
  }

  return { opinion, content, confidence }
}

/**
 * Build a prompt for Codex to respond to a discussion
 * @param {string} context - Discussion context
 * @param {string} agentName - This agent's name
 * @param {object} [options] - Additional options
 * @param {string} [options.workingDir] - Working directory context
 * @param {number} [options.round] - Current discussion round
 * @returns {string}
 */
function buildDiscussionPrompt(context, agentName, options = {}) {
  const { workingDir, round = 1 } = options

  let workingDirHint = ''
  if (workingDir) {
    workingDirHint = `
**IMPORTANT**: You are working in the directory: \`${workingDir}\`
Before responding, you should:
1. Read relevant files in this project (e.g., README.md, package.json, source files)
2. Use the Read tool to examine the actual project structure
3. Base your response on actual file contents, not assumptions
`
  }

  let roundHint = ''
  if (round > 1) {
    roundHint = `
**This is Round ${round} of the discussion.**
You have already responded in previous rounds. Now:
1. Read the other agents' responses carefully
2. Acknowledge points you agree with
3. Politely challenge points you disagree with
4. Build upon the discussion - don't just repeat yourself
5. Try to move toward consensus or clarify differences
`
  }

  let prompt = `You are ${agentName}, an AI assistant participating in a multi-agent discussion.
${workingDirHint}${roundHint}
Please analyze the following discussion and provide your opinion.

${context}

---

Instructions for your response:
1. The first non-empty line MUST be exactly: AGENT:${agentName}
2. Never role-play or claim to be another agent.
3. First, read relevant files from the project directory to understand context
4. Provide your honest technical opinion based on actual file contents
5. Consider all viewpoints already expressed by other agents
6. Be concise but thorough (around 100-200 words)
7. If you agree with other agents, explain why and add value
8. If you disagree, explain your reasoning respectfully
9. If you have an alternative approach, describe it
10. Try to find common ground or highlight key differences

Format your response naturally after the AGENT line. The system will automatically detect your opinion type (agree/disagree/neutral/alternative).`

  return prompt
}

/**
 * Call Codex CLI
 * @param {string} prompt
 * @param {object} options
 * @param {string} [options.model] - Model to use
 * @param {string} [options.sandbox] - Sandbox mode
 * @param {number} [options.timeout] - Timeout in ms
 * @param {string} [options.workingDir] - Working directory
 * @returns {Promise<{ ok: boolean, output?: string, error?: string }>}
 */
/**
 * Call Codex CLI
 * @param {string} prompt
 * @param {object} options
 * @param {string} [options.model] - Model to use
 * @param {string} [options.sandbox] - Sandbox mode
 * @param {number} [options.timeout] - Timeout in ms
 * @param {string} [options.workingDir] - Working directory
 * @returns {Promise<{ ok: boolean, output?: string, error?: string }>}
 */
async function callCodex(prompt, options = {}) {
  const {
    model = 'gpt-5.3-codex',  // Use the configured model
    timeout = 300000,          // 5 minutes (MCP startup + thinking takes time)
    workingDir = process.cwd()
  } = options

  // Use config file settings, just override approval for non-interactive
  const args = [
    'exec',
    '-c', 'approval=never',
    prompt
  ]

  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: workingDir,
      env: { ...process.env }
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: 'Timeout' })
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)

      if (code === 0 && stdout.trim()) {
        resolve({ ok: true, output: stdout.trim() })
      } else {
        resolve({
          ok: false,
          error: stderr.trim() || `Process exited with code ${code}`
        })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message })
    })
  })
}

/**
 * Check if codex CLI is available
 * @returns {Promise<boolean>}
 */
async function isCodexAvailable() {
  try {
    const probe = spawnSync(CODEX_BIN, ['--version'], {
      stdio: 'ignore',
      env: process.env
    })
    return !probe.error && probe.status === 0
  } catch {
    return false
  }
}

/**
 * Get the codex binary path
 * @returns {string}
 */
function getCodexBin() {
  return CODEX_BIN
}

/**
 * Check if we should use MCP instead of CLI
 * @returns {boolean}
 */
function shouldUseMCP() {
  // In environments where codex MCP server is available, prefer it
  return true
}

export {
  callCodex,
  parseCodexResponse,
  buildDiscussionPrompt,
  isCodexAvailable,
  getCodexBin,
  shouldUseMCP
}
