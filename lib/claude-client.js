/**
 * Claude API client
 * Direct API calls for non-interactive Claude responses
 */

import { spawn, spawnSync } from 'child_process'
import { OPINIONS } from './message.js'

// Claude CLI path (prefer env override, fallback to PATH lookup command)
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'

/**
 * Parse Claude response to extract opinion and content
 * @param {string} response
 * @returns {{ opinion: string, content: string, confidence: number }}
 */
function parseClaudeResponse(response) {
  // Similar logic to codex response parsing
  const lines = response.trim().split('\n')

  let opinion = OPINIONS.NEUTRAL
  let content = response.trim()
  let confidence = 0.7

  // Check for opinion markers
  const opinionPatterns = [
    { pattern: /\b(agree|agreed|support|推荐|支持|同意|完全同意)\b/i, opinion: OPINIONS.AGREE },
    { pattern: /\b(disagree|disagreed|oppose|反对|不推荐|不同意)\b/i, opinion: OPINIONS.DISAGREE },
    { pattern: /\b(alternative|alternatively|instead|建议|或者|另一个方案|我认为)\b/i, opinion: OPINIONS.ALTERNATIVE },
    { pattern: /\b(neutral|maybe|perhaps|可能|也许|中立|保留意见)\b/i, opinion: OPINIONS.NEUTRAL }
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
    if (confidence > 1) confidence = confidence / 100
  }

  return { opinion, content, confidence }
}

/**
 * Build a prompt for Claude to respond to a discussion
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
 * Call Claude CLI (spawns a new process with clean environment)
 * @param {string} prompt
 * @param {object} options
 * @param {string} [options.model] - Model to use
 * @param {number} [options.timeout] - Timeout in ms
 * @param {string} [options.workingDir] - Working directory
 * @returns {Promise<{ ok: boolean, output?: string, error?: string }>}
 */
async function callClaude(prompt, options = {}) {
  const {
    model = 'sonnet',
    timeout = 180000,
    workingDir = process.cwd()
  } = options

  const args = [
    '-p',
    '--model', model,
    '--no-session-persistence',
    '--dangerously-skip-permissions',
    prompt
  ]

  return new Promise((resolve) => {
    // Create a clean environment to avoid nested session detection
    const cleanEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      USER: process.env.USER,
      TERM: process.env.TERM,
      // Clear CLAUDECODE to allow nested call
      CLAUDECODE: '',
    }

    const child = spawn(CLAUDE_BIN, args, {
      cwd: workingDir,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let sentSigkill = false
    let exited = false
    let timeoutTimer = null
    let graceTimer = null
    let exitCode = null
    let exitSignal = null

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
    }

    const resolveOnce = (result) => {
      if (settled) return
      settled = true
      clearTimers()
      resolve(result)
    }

    const logExitMetrics = (eventName) => {
      console.log(
        `[claude-client] child ${eventName}: code=${exitCode === null ? 'null' : exitCode}, signal=${exitSignal || 'null'}, timeout=${timedOut}, sigkill=${sentSigkill}`
      )
    }

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')

      graceTimer = setTimeout(() => {
        if (!exited) {
          try {
            sentSigkill = child.kill('SIGKILL') || sentSigkill
          } catch {}
        }
        resolveOnce({ ok: false, error: 'Timeout' })
      }, 3000)
    }, timeout)

    child.on('exit', (code, signal) => {
      exited = true
      exitCode = code
      exitSignal = signal
      clearTimers()
      logExitMetrics('exit')
    })

    child.on('close', (code, signal) => {
      exited = true
      exitCode = code
      exitSignal = signal
      clearTimers()
      logExitMetrics('close')

      if (timedOut) {
        resolveOnce({ ok: false, error: 'Timeout' })
        return
      }

      if (code === 0 && stdout.trim()) {
        resolveOnce({ ok: true, output: stdout.trim() })
      } else {
        resolveOnce({
          ok: false,
          error: stderr.trim() || `Process exited with code ${code}`
        })
      }
    })

    child.on('error', (err) => {
      clearTimers()
      logExitMetrics('error')
      if (timedOut) {
        resolveOnce({ ok: false, error: 'Timeout' })
        return
      }
      resolveOnce({ ok: false, error: err.message })
    })
  })
}

/**
 * Check if Claude CLI is available
 * @returns {Promise<boolean>}
 */
async function isClaudeAvailable() {
  try {
    const probe = spawnSync(CLAUDE_BIN, ['--version'], {
      stdio: 'ignore',
      env: process.env
    })
    return !probe.error && probe.status === 0
  } catch {
    return false
  }
}

/**
 * Get the Claude binary path
 * @returns {string}
 */
function getClaudeBin() {
  return CLAUDE_BIN
}

export {
  callClaude,
  parseClaudeResponse,
  buildDiscussionPrompt,
  isClaudeAvailable,
  getClaudeBin
}
