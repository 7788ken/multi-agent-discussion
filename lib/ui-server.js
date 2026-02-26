import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync, spawn } from 'child_process'
import { Coordinator } from './coordinator.js'
import { Discussion } from './discussion.js'
import { getRoots as getDiscussionRoots, normalizeRootPath } from './discussion-roots.js'
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

function getDiscussionPayload(discussion, coordinator, discussionId, baseDir = null) {
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
    discussion: {
      ...status,
      ...(baseDir ? { baseDir } : {})
    },
    coDevMode: { enabled: coDevEnabled },
    consensus: analysis.consensus,
    roundStatus: analysis.roundStatus,
    intervention,
    recentMessages: messages.slice(-20),
    totalMessages: messages.length
  }
}

function toPathKey(baseDir) {
  if (typeof baseDir !== 'string') {
    return ''
  }
  return process.platform === 'win32' ? baseDir.toLowerCase() : baseDir
}

function createDiscussionLocator(primaryDiscussion, primaryCoordinator) {
  const entries = new Map()
  entries.set(primaryDiscussion.baseDir, {
    baseDir: primaryDiscussion.baseDir,
    discussion: primaryDiscussion,
    coordinator: primaryCoordinator
  })

  function isRegisteredRoot(normalizedBaseDir) {
    const targetKey = toPathKey(normalizedBaseDir)
    if (targetKey === toPathKey(primaryDiscussion.baseDir)) {
      return true
    }

    for (const root of getDiscussionRoots()) {
      const normalized = normalizeRootPath(root)
      if (!normalized) {
        continue
      }
      if (toPathKey(normalized) === targetKey) {
        return true
      }
    }

    return false
  }

  function getServices(baseDir, options = {}) {
    const normalizedBaseDir = normalizeRootPath(baseDir)
    if (!normalizedBaseDir) {
      return null
    }

    const existing = entries.get(normalizedBaseDir)
    if (existing) {
      return existing
    }

    if (!isRegisteredRoot(normalizedBaseDir)) {
      return null
    }

    if (!options.createIfMissing && !fs.existsSync(normalizedBaseDir)) {
      return null
    }

    const discussion = new Discussion(normalizedBaseDir)
    const coordinator = new Coordinator({ baseDir: normalizedBaseDir })
    const next = {
      baseDir: normalizedBaseDir,
      discussion,
      coordinator
    }
    entries.set(normalizedBaseDir, next)
    return next
  }

  function listRoots() {
    const seen = new Set()
    const roots = []
    const candidates = [
      primaryDiscussion.baseDir,
      ...getDiscussionRoots(),
      ...entries.keys()
    ]

    for (const candidate of candidates) {
      const normalizedBaseDir = normalizeRootPath(candidate)
      if (!normalizedBaseDir) {
        continue
      }

      const key = toPathKey(normalizedBaseDir)
      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      roots.push(normalizedBaseDir)
    }

    return roots
  }

  function listAllDiscussions() {
    const items = []

    for (const baseDir of listRoots()) {
      const services = getServices(baseDir, { createIfMissing: false })
      if (!services) {
        continue
      }

      for (const discussionStatus of services.discussion.listAll()) {
        if (!discussionStatus.exists) {
          continue
        }

        items.push({
          discussionId: discussionStatus.discussionId,
          topic: discussionStatus.topic,
          status: discussionStatus.status,
          currentRound: discussionStatus.currentRound,
          participants: discussionStatus.participants,
          messageCount: discussionStatus.messageCount,
          startTime: discussionStatus.startTime,
          endTime: discussionStatus.endTime,
          lastModified: discussionStatus.lastModified,
          baseDir: services.baseDir
        })
      }
    }

    items.sort((a, b) => {
      const aTs = Date.parse(a.startTime || '') || 0
      const bTs = Date.parse(b.startTime || '') || 0
      if (aTs !== bTs) {
        return bTs - aTs
      }
      return String(b.discussionId || '').localeCompare(String(a.discussionId || ''))
    })

    return items
  }

  function findDiscussionMatches(discussionId) {
    const matches = []

    for (const root of listRoots()) {
      const services = getServices(root, { createIfMissing: false })
      if (!services) {
        continue
      }

      const status = services.discussion.getStatus(discussionId)
      if (!status.exists) {
        continue
      }

      matches.push({
        ...services,
        status
      })
    }

    return matches
  }

  function findDiscussion(discussionId, baseDir = null) {
    if (baseDir) {
      const services = getServices(baseDir, { createIfMissing: false })
      if (!services) {
        return null
      }

      const status = services.discussion.getStatus(discussionId)
      if (!status.exists) {
        return null
      }

      return {
        ...services,
        status
      }
    }

    return findDiscussionMatches(discussionId)[0] || null
  }

  return {
    primaryBaseDir: primaryDiscussion.baseDir,
    primaryDiscussion,
    primaryCoordinator,
    getServices,
    listAllDiscussions,
    findDiscussionMatches,
    findDiscussion
  }
}

function parseBaseDirQuery(searchParams) {
  if (!searchParams || typeof searchParams.get !== 'function') {
    return null
  }
  return normalizeRootPath(searchParams.get('baseDir'))
}

function resolveDiscussionTarget(discussionLocator, discussionId, requestedBaseDir = null) {
  if (requestedBaseDir) {
    const target = discussionLocator.findDiscussion(discussionId, requestedBaseDir)
    if (!target) {
      return { kind: 'not_found' }
    }
    return { kind: 'ok', target }
  }

  const matches = discussionLocator.findDiscussionMatches(discussionId)
  if (matches.length === 0) {
    return { kind: 'not_found' }
  }

  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: matches.map((item) => ({
        discussionId: item.status.discussionId,
        topic: item.status.topic,
        baseDir: item.baseDir
      }))
    }
  }

  return { kind: 'ok', target: matches[0] }
}

function sendDiscussionResolutionError(res, discussionId, resolution) {
  if (!resolution || resolution.kind === 'not_found') {
    sendJson(res, 404, { error: `Discussion not found: ${discussionId}` })
    return
  }

  if (resolution.kind === 'ambiguous') {
    sendJson(res, 409, {
      error: `Discussion ID ${discussionId} exists in multiple base directories; please provide baseDir`,
      discussionId,
      candidates: resolution.candidates
    })
    return
  }

  sendJson(res, 500, { error: 'Unexpected discussion resolution error' })
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

/**
 * 为指定目录启动 agent（如果尚未运行）
 * @param {string} workingDir - 工作目录
 * @param {string} baseDir - 讨论文件存储目录
 * @param {string[]} participants - 参与者列表
 * @param {string} settingsBaseDir - 设置文件目录
 */
function startAgentsForDirectory(workingDir, baseDir, participants, settingsBaseDir) {
  const resolvedWorkingDir = path.resolve(workingDir)
  const resolvedBaseDir = baseDir ? path.resolve(baseDir) : path.join(resolvedWorkingDir, 'discussions')

  // 读取并发设置
  const config = readAgentMaxConcurrentConfig(settingsBaseDir)
  const claudeConcurrent = config.claude || DEFAULT_AGENT_MAX_CONCURRENT.claude
  const codexConcurrent = config.codex || DEFAULT_AGENT_MAX_CONCURRENT.codex

  // 检查已经运行中的 agent
  const runningAgents = new Map()
  try {
    const output = execSync(
      'ps aux | grep -E "(claude-agent|codex-agent)" | grep -v grep',
      { encoding: 'utf-8', shell: '/bin/bash' }
    )
    const lines = output.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const workDirMatch = line.match(/--working-dir\s+(\S+)/)
      const agentMatch = line.match(/(claude-agent|codex-agent)\.js/)
      if (workDirMatch && agentMatch) {
        const agentWorkDir = workDirMatch[1]
        const agentName = agentMatch[1].replace('-agent', '')
        runningAgents.set(`${agentName}:${path.resolve(agentWorkDir)}`, true)
      }
    }
  } catch {
    // 没有运行中的 agent
  }

  // 启动需要的 agent
  if (participants.includes('claude')) {
    const key = `claude:${resolvedWorkingDir}`
    if (!runningAgents.has(key)) {
      const args = [
        'bin/claude-agent.js', 'start',
        '--nickname', 'claude',
        '--working-dir', resolvedWorkingDir,
        '--base-dir', resolvedBaseDir,
        '--max-concurrent', String(claudeConcurrent)
      ]
      const child = spawn('node', args, {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd()
      })
      child.unref()
      console.log(`[ui-server] Started claude agent for ${resolvedWorkingDir}`)
    }
  }

  if (participants.includes('codex')) {
    const key = `codex:${resolvedWorkingDir}`
    if (!runningAgents.has(key)) {
      const args = [
        'bin/codex-agent.js', 'start',
        '--nickname', 'codex',
        '--working-dir', resolvedWorkingDir,
        '--base-dir', resolvedBaseDir,
        '--max-concurrent', String(codexConcurrent)
      ]
      const child = spawn('node', args, {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd()
      })
      child.unref()
      console.log(`[ui-server] Started codex agent for ${resolvedWorkingDir}`)
    }
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

async function handleApi(req, res, url, discussionLocator, settingsBaseDir) {
  const pathname = url.pathname
  const requestedBaseDir = parseBaseDirQuery(url.searchParams)

  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      try {
        sendJson(res, 200, {
          ...getSettingsPayload(settingsBaseDir),
          primaryBaseDir: discussionLocator.primaryBaseDir
        })
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

  // Agent 启动 API
  if (pathname === '/api/agents/start' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
      return true
    }

    const { workingDir, baseDir, participants = [] } = body
    if (!workingDir) {
      sendJson(res, 400, { error: 'workingDir is required' })
      return true
    }

    const resolvedWorkingDir = path.resolve(workingDir)
    const resolvedBaseDir = baseDir ? path.resolve(baseDir) : path.join(resolvedWorkingDir, 'discussions')

    // 读取并发设置
    const config = readAgentMaxConcurrentConfig(settingsBaseDir)
    const claudeConcurrent = config.claude || DEFAULT_AGENT_MAX_CONCURRENT.claude
    const codexConcurrent = config.codex || DEFAULT_AGENT_MAX_CONCURRENT.codex

    // 检查已经运行中的 agent
    const runningAgents = new Map()
    try {
      const { execSync } = await import('child_process')
      const output = execSync('ps aux | grep -E "(claude-agent|codex-agent)" | grep -v grep', {
        encoding: 'utf-8',
        shell: '/bin/bash'
      })
      const lines = output.trim().split('\n').filter(Boolean)
      for (const line of lines) {
        const workDirMatch = line.match(/--working-dir\s+(\S+)/)
        const agentMatch = line.match(/(claude-agent|codex-agent)\.js/)
        if (workDirMatch && agentMatch) {
          const agentWorkDir = workDirMatch[1]
          const agentName = agentMatch[1].replace('-agent', '')
          runningAgents.set(`${agentName}:${path.resolve(agentWorkDir)}`, true)
        }
      }
    } catch {
      // 没有运行中的 agent
    }

    const results = []

    // 启动 claude agent
    if (participants.includes('claude')) {
      const key = `claude:${resolvedWorkingDir}`
      if (runningAgents.has(key)) {
        results.push({ agent: 'claude', status: 'already_running' })
      } else {
        try {
          const { spawn } = await import('child_process')
          const args = [
            'bin/claude-agent.js', 'start',
            '--nickname', 'claude',
            '--working-dir', resolvedWorkingDir,
            '--base-dir', resolvedBaseDir,
            '--max-concurrent', String(claudeConcurrent)
          ]
          const child = spawn('node', args, {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd()
          })
          child.unref()
          results.push({ agent: 'claude', status: 'started' })
        } catch (err) {
          results.push({ agent: 'claude', status: 'error', error: err.message })
        }
      }
    }

    // 启动 codex agent
    if (participants.includes('codex')) {
      const key = `codex:${resolvedWorkingDir}`
      if (runningAgents.has(key)) {
        results.push({ agent: 'codex', status: 'already_running' })
      } else {
        try {
          const { spawn } = await import('child_process')
          const args = [
            'bin/codex-agent.js', 'start',
            '--nickname', 'codex',
            '--working-dir', resolvedWorkingDir,
            '--base-dir', resolvedBaseDir,
            '--max-concurrent', String(codexConcurrent)
          ]
          const child = spawn('node', args, {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd()
          })
          child.unref()
          results.push({ agent: 'codex', status: 'started' })
        } catch (err) {
          results.push({ agent: 'codex', status: 'error', error: err.message })
        }
      }
    }

    sendJson(res, 200, { results })
    return true
  }

  // Agent 状态 API
  if (pathname === '/api/agents/status' && req.method === 'GET') {
    const workingDir = url.searchParams.get('workingDir')
    const results = []

    // 检查运行中的 agent
    try {
      const { execSync } = await import('child_process')
      const output = execSync('ps aux | grep -E "(claude-agent|codex-agent)" | grep -v grep', {
        encoding: 'utf-8',
        shell: '/bin/bash'
      })

      const lines = output.trim().split('\n').filter(Boolean)
      for (const line of lines) {
        const match = line.match(/--working-dir\s+(\S+)/)
        const agentMatch = line.match(/(claude-agent|codex-agent)\.js/)
        if (match && agentMatch) {
          results.push({
            agent: agentMatch[1].replace('-agent', ''),
            workingDir: match[1],
            running: true
          })
        }
      }
    } catch {
      // 没有运行中的 agent
    }

    sendJson(res, 200, { agents: results })
    return true
  }

  // Agent 停止 API - 停止指定目录的 agent
  if (pathname === '/api/agents/stop' && req.method === 'POST') {
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
      return true
    }

    const { workingDir, baseDir } = body
    const targetDir = workingDir || baseDir

    if (!targetDir) {
      sendJson(res, 400, { error: 'workingDir or baseDir is required' })
      return true
    }

    const resolvedTargetDir = path.resolve(targetDir)
    const results = []
    const stoppedPids = []

    try {
      const { execSync } = await import('child_process')
      const output = execSync('ps aux | grep -E "(claude-agent|codex-agent)" | grep -v grep', {
        encoding: 'utf-8',
        shell: '/bin/bash'
      })

      const lines = output.trim().split('\n').filter(Boolean)
      for (const line of lines) {
        const workDirMatch = line.match(/--working-dir\s+(\S+)/)
        const agentMatch = line.match(/(claude-agent|codex-agent)\.js/)
        const pidMatch = line.match(/^\s*\S+\s+(\d+)/)

        if (workDirMatch && agentMatch && pidMatch) {
          const agentWorkDir = workDirMatch[1]
          const agentName = agentMatch[1].replace('-agent', '')
          const pid = parseInt(pidMatch[1], 10)

          // 检查是否是目标目录的 agent
          if (path.resolve(agentWorkDir) === resolvedTargetDir) {
            try {
              process.kill(pid, 'SIGTERM')
              stoppedPids.push(pid)
              results.push({ agent: agentName, pid, status: 'stopped' })
            } catch (err) {
              results.push({ agent: agentName, pid, status: 'error', error: err.message })
            }
          }
        }
      }
    } catch {
      // 没有运行中的 agent
    }

    sendJson(res, 200, { results, stoppedPids })
    return true
  }

  // SSE 事件流 - 讨论更新
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })

    // 发送初始连接消息
    res.write('event: connected\ndata: {"status":"ok"}\n\n')

    // 定期发送心跳
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n')
    }, 15000)

    // 监听讨论变化
    let lastCheck = Date.now()
    const checkInterval = setInterval(() => {
      try {
        // 获取所有讨论并检查更新
        const discussions = discussionLocator.listAllDiscussions()
        const now = Date.now()

        for (const d of discussions) {
          // listAllDiscussions 返回的是状态对象，直接使用
          if (d.lastModified && d.lastModified > lastCheck) {
            res.write(`event: discussion-update\ndata: ${JSON.stringify({
              discussionId: d.discussionId,
              baseDir: d.baseDir,
              status: d.status,
              currentRound: d.currentRound,
              messageCount: d.messageCount
            })}\n\n`)
          }
        }
        lastCheck = now
      } catch (err) {
        console.error('SSE check error:', err)
      }
    }, 2000)

    // 清理
    req.on('close', () => {
      clearInterval(heartbeat)
      clearInterval(checkInterval)
    })

    return true
  }

  // 文件浏览 API
  if (pathname === '/api/files' && req.method === 'GET') {
    const dirPath = url.searchParams.get('path') || '.'
    try {
      const resolvedPath = path.resolve(dirPath)
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })
      const files = entries
        .map(entry => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          path: path.join(resolvedPath, entry.name)
        }))
        .filter(f => !f.name.startsWith('.')) // 隐藏文件过滤
        .sort((a, b) => {
          // 文件夹优先
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })
      sendJson(res, 200, { path: resolvedPath, files })
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to read directory' })
    }
    return true
  }

  // 文件搜索 API
  if (pathname === '/api/files/search' && req.method === 'GET') {
    const basePath = url.searchParams.get('path') || '.'
    const query = (url.searchParams.get('query') || '').toLowerCase()
    try {
      const resolvedPath = path.resolve(basePath)
      const results = []

      function searchDir(dir, depth = 0) {
        if (depth > 3) return // 限制搜索深度
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (entry.name.toLowerCase().includes(query)) {
                results.push({ name: entry.name, path: fullPath, isDirectory: true })
              }
              searchDir(fullPath, depth + 1)
            } else {
              if (entry.name.toLowerCase().includes(query)) {
                results.push({ name: entry.name, path: fullPath, isDirectory: false })
              }
            }
            if (results.length >= 50) return // 限制结果数量
          }
        } catch {}
      }

      searchDir(resolvedPath)
      sendJson(res, 200, { files: results.slice(0, 50) })
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to search files' })
    }
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
      // Resolve workingDir: if it's '.' or empty, use the discussion base directory
      let resolvedWorkingDir = requestedWorkingDir
      if (!resolvedWorkingDir || resolvedWorkingDir === '.') {
        resolvedWorkingDir = discussionLocator.primaryBaseDir
      }

      const result = discussionLocator.primaryDiscussion.create(topic, participants, {
        workingDir: resolvedWorkingDir,
        timestamp: new Date().toISOString(),
        coDevMode: { enabled: coDevEnabled }
      })

      // 自动为该目录启动 agent（如果尚未运行）
      const baseDir = discussionLocator.primaryBaseDir
      startAgentsForDirectory(resolvedWorkingDir, baseDir, participants, settingsBaseDir)

      sendJson(res, 201, {
        ...result,
        baseDir
      })
      return true
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Failed to create discussion' })
      return true
    }
  }

  if (req.method === 'GET' && pathname === '/api/discussions') {
    const list = discussionLocator.listAllDiscussions()

    sendJson(res, 200, { discussions: list })
    return true
  }

  // 结果文件 API
  const resultMatch = pathname.match(/^\/api\/discussions\/([^/]+)\/result$/)
  if (resultMatch && req.method === 'GET') {
    const discussionId = decodeURIComponent(resultMatch[1])

    const resolution = resolveDiscussionTarget(discussionLocator, discussionId, requestedBaseDir)
    if (resolution.kind !== 'ok') {
      sendDiscussionResolutionError(res, discussionId, resolution)
      return true
    }

    const resultPath = resolution.target.discussion.getResultFilePath(discussionId)

    if (!fs.existsSync(resultPath)) {
      sendJson(res, 404, { error: 'Result file not found' })
      return true
    }

    // 返回 markdown 内容，设置正确的 Content-Type
    const content = fs.readFileSync(resultPath, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `inline; filename="${discussionId}-result.md"`
    })
    res.end(content)
    return true
  }

  const match = pathname.match(/^\/api\/discussions\/([^/]+)(?:\/(followup|end|mode))?$/)
  if (!match) {
    return false
  }

  const discussionId = decodeURIComponent(match[1])
  const action = match[2] || null

  if (!action && req.method === 'GET') {
    const resolution = resolveDiscussionTarget(discussionLocator, discussionId, requestedBaseDir)
    if (resolution.kind !== 'ok') {
      sendDiscussionResolutionError(res, discussionId, resolution)
      return true
    }

    const target = resolution.target
    const payload = getDiscussionPayload(target.discussion, target.coordinator, discussionId, target.baseDir)
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

    const resolution = resolveDiscussionTarget(discussionLocator, discussionId, requestedBaseDir)
    if (resolution.kind !== 'ok') {
      sendDiscussionResolutionError(res, discussionId, resolution)
      return true
    }

    const resolvedDiscussion = resolution.target
    const status = resolvedDiscussion.status
    if (status.status === 'ended') {
      sendJson(res, 409, { error: 'Discussion already ended' })
      return true
    }

    const question = String(body.question || '').trim()
    if (!question) {
      sendJson(res, 400, { error: 'question is required' })
      return true
    }

    const followupTarget = body.target ? String(body.target).trim() : null
    if (followupTarget && !status.participants.includes(followupTarget)) {
      sendJson(res, 400, { error: `target must be one of: ${status.participants.join(', ')}` })
      return true
    }

    const message = resolvedDiscussion.discussion.append(
      discussionId,
      createFollowupMessage(0, question, followupTarget || null)
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

    const resolution = resolveDiscussionTarget(discussionLocator, discussionId, requestedBaseDir)
    if (resolution.kind !== 'ok') {
      sendDiscussionResolutionError(res, discussionId, resolution)
      return true
    }

    const target = resolution.target
    const status = target.status
    if (status.status === 'ended') {
      sendJson(res, 409, { error: 'Discussion already ended' })
      return true
    }

    const decision = String(body.decision || '').trim() || 'Discussion ended by user'
    const consensus = body.consensus !== false

    const message = target.discussion.append(
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

    const resolution = resolveDiscussionTarget(discussionLocator, discussionId, requestedBaseDir)
    if (resolution.kind !== 'ok') {
      sendDiscussionResolutionError(res, discussionId, resolution)
      return true
    }

    const target = resolution.target
    const status = target.status
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

    const message = target.discussion.append(
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
  const coordinator = new Coordinator({ baseDir: discussion.baseDir })
  const discussionLocator = createDiscussionLocator(discussion, coordinator)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      const pathname = url.pathname

      if (pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url, discussionLocator, discussion.baseDir)
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
