import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { Coordinator } from './coordinator.js'
import { Discussion } from './discussion.js'
import { createEndMessage, createFollowupMessage, createModeMessage } from './message.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.resolve(__dirname, '../ui')
const JSON_BODY_LIMIT = 1024 * 1024
const AGENT_MAX_CONCURRENT_FILE = 'agent-max-concurrent.json'
const SUPPORTED_SETTING_AGENTS = new Set(['claude', 'codex'])
const DEFAULT_AGENT_MAX_CONCURRENT = Object.freeze({
  claude: 5,
  codex: 5
})
const RETRY_MAX_ATTEMPTS = 10

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': CONTENT_TYPES['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendText(res, statusCode, text) {
  const body = String(text)
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function normalizeStaticPath(urlPath) {
  const pathname = urlPath === '/' ? '/index.html' : urlPath
  const normalized = path.normalize(pathname).replace(/^([.]{2}[/\\])+/, '')
  return normalized.startsWith(path.sep) ? normalized.slice(1) : normalized
}

function getDiscussionPayload(discussion, coordinator, discussionId) {
  const status = discussion.getStatus(discussionId)
  if (!status.exists) {
    return null
  }

  const messages = discussion.readAll(discussionId)
  const analysis = coordinator.analyzeDiscussion(discussionId)
  const intervention = coordinator.checkNeedsIntervention(discussionId)
  let coDevEnabled = Boolean(status.context?.coDevMode?.enabled || status.context?.coDevEnabled)
  for (const msg of messages) {
    if (msg.type === 'mode' && (msg.key === 'co-dev' || msg.key === 'co_dev' || msg.key === 'codev')) {
      coDevEnabled = Boolean(msg.enabled)
    }
  }

  return {
    discussion: status,
    coDevMode: { enabled: coDevEnabled },
    consensus: analysis.consensus,
    roundStatus: analysis.roundStatus,
    intervention,
    recentMessages: messages.slice(-20),
    totalMessages: messages.length
  }
}

function parsePositiveInteger(value) {
  if (Number.isInteger(value) && value > 0) {
    return value
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10)
    if (parsed > 0) {
      return parsed
    }
  }

  return null
}

function normalizeAgentMaxConcurrentConfig(config) {
  const normalized = {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return normalized
  }

  for (const [rawAgentName, rawMaxConcurrent] of Object.entries(config)) {
    const agentName = String(rawAgentName || '').trim().toLowerCase()
    if (!SUPPORTED_SETTING_AGENTS.has(agentName)) {
      continue
    }

    const parsed = parsePositiveInteger(rawMaxConcurrent)
    if (parsed !== null) {
      normalized[agentName] = parsed
    }
  }

  return normalized
}

function validateAgentMaxConcurrentInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'agentMaxConcurrent must be an object' }
  }

  const normalized = {}
  for (const [rawAgentName, rawMaxConcurrent] of Object.entries(input)) {
    const agentName = String(rawAgentName || '').trim().toLowerCase()
    if (!SUPPORTED_SETTING_AGENTS.has(agentName)) {
      return {
        ok: false,
        error: `unsupported agent "${rawAgentName}" (supported: claude, codex)`
      }
    }

    if (Object.prototype.hasOwnProperty.call(normalized, agentName)) {
      return {
        ok: false,
        error: `duplicate agent "${agentName}" in agentMaxConcurrent`
      }
    }

    const parsed = parsePositiveInteger(rawMaxConcurrent)
    if (parsed === null) {
      return {
        ok: false,
        error: `invalid max-concurrent for agent "${agentName}" (must be a positive integer)`
      }
    }

    normalized[agentName] = parsed
  }

  return { ok: true, mapping: normalized }
}

function readAgentMaxConcurrentConfig(baseDir) {
  const configPath = path.join(baseDir, AGENT_MAX_CONCURRENT_FILE)
  if (!fs.existsSync(configPath)) {
    return {}
  }

  let raw = ''
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch {
    return {}
  }

  if (!raw.trim()) {
    return {}
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  return normalizeAgentMaxConcurrentConfig(parsed)
}

function writeAgentMaxConcurrentConfig(baseDir, config) {
  const configPath = path.join(baseDir, AGENT_MAX_CONCURRENT_FILE)
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const normalized = normalizeAgentMaxConcurrentConfig(config)

  fs.mkdirSync(baseDir, { recursive: true })
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmpPath, configPath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}

function getSettingsPayload(baseDir) {
  const stored = readAgentMaxConcurrentConfig(baseDir)
  return {
    agentMaxConcurrent: {
      ...DEFAULT_AGENT_MAX_CONCURRENT,
      ...stored
    },
    retryMaxAttempts: RETRY_MAX_ATTEMPTS
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > JSON_BODY_LIMIT) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })

    req.on('error', reject)
  })
}

function serveStatic(req, res, pathname) {
  const relativePath = normalizeStaticPath(pathname)
  const filePath = path.join(UI_DIR, relativePath)

  if (!filePath.startsWith(UI_DIR)) {
    sendText(res, 403, 'Forbidden')
    return
  }

  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'Not Found')
    return
  }

  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    sendText(res, 404, 'Not Found')
    return
  }

  const ext = path.extname(filePath)
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60'
  })
  fs.createReadStream(filePath).pipe(res)
}

async function handleApi(req, res, pathname, discussion, coordinator, settingsBaseDir) {
  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      try {
        sendJson(res, 200, getSettingsPayload(settingsBaseDir))
      } catch (err) {
        sendJson(res, 500, { error: err.message || 'Failed to read settings' })
      }
      return true
    }

    if (req.method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { error: err.message })
        return true
      }

      const validation = validateAgentMaxConcurrentInput(body.agentMaxConcurrent)
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.error })
        return true
      }

      try {
        writeAgentMaxConcurrentConfig(settingsBaseDir, validation.mapping)
        sendJson(res, 200, {
          agentMaxConcurrent: {
            ...DEFAULT_AGENT_MAX_CONCURRENT,
            ...validation.mapping
          },
          retryMaxAttempts: RETRY_MAX_ATTEMPTS
        })
      } catch (err) {
        sendJson(res, 500, { error: err.message || 'Failed to persist settings' })
      }
      return true
    }

    sendJson(res, 405, { error: 'Method Not Allowed' })
    return true
  }

  // P0: Create new discussion API
  if (req.method === 'POST' && pathname === '/api/discussions') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
      return true
    }

    const topic = String(body.topic || '').trim()
    if (!topic) {
      sendJson(res, 400, { error: 'topic is required' })
      return true
    }

    // Normalize participants: trim + dedupe + non-empty
    let participants = Array.isArray(body.participants) ? body.participants : ['claude', 'codex']
    participants = [...new Set(participants.map(p => String(p ?? '').trim()).filter(Boolean))]
    if (participants.length === 0) {
      participants = ['claude', 'codex']
    }

    const requestedWorkingDir = typeof body.workingDir === 'string' ? body.workingDir.trim() : ''
    const coDevEnabled = typeof body.coDevMode?.enabled === 'boolean'
      ? body.coDevMode.enabled
      : typeof body.coDevEnabled === 'boolean'
        ? body.coDevEnabled
        : false

    try {
      const result = discussion.create(topic, participants, {
        workingDir: requestedWorkingDir || process.cwd(),
        timestamp: new Date().toISOString(),
        coDevMode: { enabled: coDevEnabled }
      })
      sendJson(res, 201, result)
      return true
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Failed to create discussion' })
      return true
    }
  }

  if (req.method === 'GET' && pathname === '/api/discussions') {
    const list = discussion.listAll().map(item => ({
      discussionId: item.discussionId,
      topic: item.topic,
      status: item.status,
      currentRound: item.currentRound,
      participants: item.participants,
      messageCount: item.messageCount,
      startTime: item.startTime,
      endTime: item.endTime
    }))

    sendJson(res, 200, { discussions: list })
    return true
  }

  const match = pathname.match(/^\/api\/discussions\/([^/]+)(?:\/(followup|end|mode))?$/)
  if (!match) {
    return false
  }

  const discussionId = decodeURIComponent(match[1])
  const action = match[2] || null

  if (!action && req.method === 'GET') {
    const payload = getDiscussionPayload(discussion, coordinator, discussionId)
    if (!payload) {
      sendJson(res, 404, { error: `Discussion not found: ${discussionId}` })
      return true
    }

    sendJson(res, 200, payload)
    return true
  }

  if (action === 'followup' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
      return true
    }

    const status = discussion.getStatus(discussionId)
    if (!status.exists) {
      sendJson(res, 404, { error: `Discussion not found: ${discussionId}` })
      return true
    }

    if (status.status === 'ended') {
      sendJson(res, 409, { error: 'Discussion already ended' })
      return true
    }

    const question = String(body.question || '').trim()
    if (!question) {
      sendJson(res, 400, { error: 'question is required' })
      return true
    }

    const target = body.target ? String(body.target).trim() : null
    if (target && !status.participants.includes(target)) {
      sendJson(res, 400, { error: `target must be one of: ${status.participants.join(', ')}` })
      return true
    }

    const message = discussion.append(
      discussionId,
      createFollowupMessage(0, question, target || null)
    )

    sendJson(res, 201, { ok: true, message })
    return true
  }

  if (action === 'end' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
      return true
    }

    const status = discussion.getStatus(discussionId)
    if (!status.exists) {
      sendJson(res, 404, { error: `Discussion not found: ${discussionId}` })
      return true
    }

    if (status.status === 'ended') {
      sendJson(res, 409, { error: 'Discussion already ended' })
      return true
    }

    const decision = String(body.decision || '').trim() || 'Discussion ended by user'
    const consensus = body.consensus !== false

    const message = discussion.append(
      discussionId,
      createEndMessage(0, decision, consensus)
    )

    sendJson(res, 201, { ok: true, message })
    return true
  }

  if (action === 'mode' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
      return true
    }

    const status = discussion.getStatus(discussionId)
    if (!status.exists) {
      sendJson(res, 404, { error: `Discussion not found: ${discussionId}` })
      return true
    }

    if (status.status === 'ended') {
      sendJson(res, 409, { error: 'Discussion already ended' })
      return true
    }

    let enabled
    if (typeof body.enabled === 'boolean') {
      enabled = body.enabled
    } else {
      const value = String(body.enabled ?? '').trim().toLowerCase()
      if (['on', 'true', '1', 'enable', 'enabled'].includes(value)) {
        enabled = true
      } else if (['off', 'false', '0', 'disable', 'disabled'].includes(value)) {
        enabled = false
      } else {
        sendJson(res, 400, { error: 'enabled must be boolean or on/off' })
        return true
      }
    }

    const message = discussion.append(
      discussionId,
      createModeMessage(0, 'co-dev', enabled)
    )

    sendJson(res, 201, { ok: true, message })
    return true
  }

  sendJson(res, 405, { error: 'Method Not Allowed' })
  return true
}

async function startUiServer(options = {}) {
  const baseDir = options.baseDir
  const port = Number(options.port || 5188)
  const host = options.host || '127.0.0.1'

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`)
  }

  const discussion = new Discussion(baseDir)
  const coordinator = new Coordinator({ baseDir })

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      const pathname = url.pathname

      if (pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, pathname, discussion, coordinator, discussion.baseDir)
        if (!handled) {
          sendJson(res, 404, { error: 'Not Found' })
        }
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed')
        return
      }

      serveStatic(req, res, pathname)
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Internal Server Error' })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`
  }
}

export {
  startUiServer
}
