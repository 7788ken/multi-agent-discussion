/**
 * Terminal UI for multi-agent discussions.
 * Uses only Node.js built-in APIs and ANSI escape sequences.
 */

const REFRESH_INTERVAL_MS = 2000
const MAX_RECENT_MESSAGES = 10

const ANSI = {
  reset: '\x1b[0m',
  clear: '\x1b[2J',
  home: '\x1b[H',
  altScreenOn: '\x1b[?1049h',
  altScreenOff: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h'
}

function pad(text, width) {
  if (width <= 0) return ''
  const str = String(text ?? '')
  if (str.length >= width) return str
  return str + ' '.repeat(width - str.length)
}

function truncate(text, width) {
  if (width <= 0) return ''
  const str = String(text ?? '')
  if (str.length <= width) return pad(str, width)
  if (width === 1) return '…'
  return `${str.slice(0, width - 1)}…`
}

function normalizeSingleLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function wrapText(text, width, maxLines = Number.POSITIVE_INFINITY) {
  if (width <= 0 || maxLines <= 0) return []

  const source = String(text ?? '').trim()
  if (!source) return ['']

  const words = source.split(/\s+/)
  const lines = []
  let current = ''

  for (const word of words) {
    if (lines.length >= maxLines) break

    if (word.length > width) {
      if (current) {
        lines.push(current)
        current = ''
      }
      let remain = word
      while (remain.length > width && lines.length < maxLines) {
        lines.push(remain.slice(0, width))
        remain = remain.slice(width)
      }
      if (remain && lines.length < maxLines) {
        current = remain
      }
      continue
    }

    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= width) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current)
  }

  if (lines.length === 0) {
    lines.push(source.slice(0, width))
  }

  return lines.slice(0, maxLines)
}

function formatTime(ts) {
  if (!ts) return '--:--:--'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString()
}

function formatDateTime(ts) {
  if (!ts) return 'N/A'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'N/A'
  return d.toLocaleString()
}

function isPrintable(input) {
  if (!input) return false
  return !/[\x00-\x1F\x7F]/.test(input)
}

function splitKeys(input) {
  const keys = []
  const text = String(input ?? '')

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x1b') {
      const seq = text.slice(i, i + 3)
      if (seq === '\x1b[A' || seq === '\x1b[B') {
        keys.push(seq)
        i += 2
        continue
      }
      keys.push('\x1b')
      continue
    }
    keys.push(text[i])
  }

  return keys
}

/**
 * Start interactive full-screen terminal UI.
 *
 * @param {object} opts
 * @param {import('./discussion.js').Discussion} opts.discussion
 * @param {import('./coordinator.js').Coordinator} opts.coordinator
 * @param {Function} opts.createFollowupMessage
 * @param {Function} opts.createEndMessage
 * @param {Function} opts.parseFollowupInput
 * @param {string|null} [opts.initialDiscussionId]
 * @returns {Promise<void>}
 */
function startTui(opts) {
  const {
    discussion,
    coordinator,
    createFollowupMessage,
    createEndMessage,
    parseFollowupInput,
    initialDiscussionId = null
  } = opts

  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new Error('mad tui requires an interactive TTY terminal'))
      return
    }

    const state = {
      discussions: [],
      selectedIndex: -1,
      selectedId: initialDiscussionId,
      selectedStatus: null,
      selectedMessages: [],
      selectedAnalysis: null,
      notice: initialDiscussionId
        ? `Initial selection: ${initialDiscussionId}`
        : 'Ready',
      inputMode: null, // { type: "followup" | "end", value: string }
      lastRefreshAt: null
    }

    let refreshTimer = null
    let closed = false

    const cleanup = () => {
      if (closed) return
      closed = true

      if (refreshTimer) {
        clearInterval(refreshTimer)
      }

      process.stdin.off('data', onKey)
      process.stdout.off('resize', onResize)
      process.off('SIGINT', onSigint)

      process.stdin.setRawMode(false)
      process.stdin.pause()

      process.stdout.write(`${ANSI.reset}${ANSI.showCursor}${ANSI.altScreenOff}`)
      resolve()
    }

    const failAndClose = (err) => {
      if (!closed) {
        process.stdout.write(`${ANSI.reset}${ANSI.showCursor}${ANSI.altScreenOff}`)
      }
      reject(err)
    }

    const setNotice = (text) => {
      state.notice = text
    }

    const refreshSelection = () => {
      const list = discussion.listAll()
      state.discussions = list

      if (list.length === 0) {
        state.selectedIndex = -1
        state.selectedId = null
        state.selectedStatus = null
        state.selectedMessages = []
        state.selectedAnalysis = null
        state.lastRefreshAt = new Date().toISOString()
        return
      }

      if (state.selectedId) {
        const found = list.findIndex(item => item.discussionId === state.selectedId)
        if (found >= 0) {
          state.selectedIndex = found
        } else {
          state.selectedIndex = 0
          state.selectedId = list[0].discussionId
        }
      } else {
        state.selectedIndex = 0
        state.selectedId = list[0].discussionId
      }

      const selected = list[state.selectedIndex]
      state.selectedId = selected.discussionId
      state.selectedStatus = discussion.getStatus(state.selectedId)
      state.selectedMessages = discussion.readAll(state.selectedId)
      state.selectedAnalysis = coordinator.analyzeDiscussion(state.selectedId)
      state.lastRefreshAt = new Date().toISOString()
    }

    const moveSelection = (delta) => {
      if (state.discussions.length === 0) return

      const next = Math.max(
        0,
        Math.min(state.discussions.length - 1, state.selectedIndex + delta)
      )
      if (next === state.selectedIndex) return

      state.selectedIndex = next
      state.selectedId = state.discussions[next].discussionId
      refreshSelection()
      render()
    }

    const submitInput = () => {
      if (!state.inputMode || !state.selectedId) return
      const value = state.inputMode.value.trim()

      if (!value) {
        setNotice('Input cancelled: empty text')
        state.inputMode = null
        render()
        return
      }

      try {
        if (state.inputMode.type === 'followup') {
          if (!state.selectedStatus || state.selectedStatus.status === 'ended') {
            setNotice('Cannot ask follow-up on ended discussion')
            state.inputMode = null
            render()
            return
          }

          const parsed = parseFollowupInput(value, state.selectedStatus.participants || [])
          if (!parsed.ok) {
            setNotice(parsed.error || 'Invalid follow-up input')
            render()
            return
          }

          discussion.append(
            state.selectedId,
            createFollowupMessage(0, parsed.content, parsed.target)
          )
          setNotice(parsed.target
            ? `Follow-up sent to @${parsed.target}`
            : 'Follow-up sent')
        } else if (state.inputMode.type === 'end') {
          discussion.append(
            state.selectedId,
            createEndMessage(0, value)
          )
          setNotice(`Discussion ${state.selectedId} ended`)
        }
      } catch (err) {
        setNotice(`Operation failed: ${err.message}`)
      } finally {
        state.inputMode = null
        refreshSelection()
        render()
      }
    }

    const runAnalyze = () => {
      if (!state.selectedId) {
        setNotice('No discussion selected')
        render()
        return
      }

      const analysis = coordinator.analyzeDiscussion(state.selectedId)
      if (!analysis.exists) {
        setNotice('Selected discussion not found')
        render()
        return
      }

      state.selectedAnalysis = analysis
      setNotice(
        `Consensus ${Math.round(analysis.consensus.agreementLevel * 100)}%, ` +
        `avg confidence ${Math.round(analysis.consensus.averageConfidence * 100)}%`
      )
      render()
    }

    const buildListPanel = (width, height) => {
      const lines = [truncate(` Discussions (${state.discussions.length})`, width)]
      const visibleRows = Math.max(0, height - 1)

      if (state.discussions.length === 0) {
        lines.push(truncate(' No discussions found. Create with: mad new "<topic>"', width))
        while (lines.length < height) lines.push(' '.repeat(width))
        return lines
      }

      const half = Math.floor(visibleRows / 2)
      let start = Math.max(0, state.selectedIndex - half)
      if (start + visibleRows > state.discussions.length) {
        start = Math.max(0, state.discussions.length - visibleRows)
      }

      for (let row = 0; row < visibleRows; row++) {
        const idx = start + row
        if (idx >= state.discussions.length) {
          lines.push(' '.repeat(width))
          continue
        }

        const item = state.discussions[idx]
        const marker = idx === state.selectedIndex ? '>' : ' '
        const status = item.status === 'ended' ? 'E' : 'A'
        const line = `${marker}[${status}] ${item.discussionId} ${normalizeSingleLine(item.topic)}`
        lines.push(truncate(line, width))
      }

      return lines.slice(0, height)
    }

    const buildRoundStatusLines = (width) => {
      const lines = []
      const status = state.selectedStatus
      const messages = state.selectedMessages
      const analysis = state.selectedAnalysis

      if (!status) {
        lines.push(truncate(' -', width))
        return lines
      }

      const participants = status.participants || []
      const currentRound = analysis?.roundStatus?.currentRound ?? status.currentRound ?? 0

      const respondedAgents = new Set(
        messages
          .filter(msg => msg.type === 'response' && (msg.round || 0) === currentRound)
          .map(msg => msg.from)
      )

      const thinkingAgents = new Set(
        messages
          .filter(msg => msg.type === 'status' && msg.status === 'thinking')
          .map(msg => msg.from)
      )

      for (const agent of participants) {
        let mark = 'pending'
        if (respondedAgents.has(agent)) {
          mark = 'done'
        } else if (thinkingAgents.has(agent)) {
          mark = 'thinking'
        }
        lines.push(truncate(` - ${agent}: ${mark}`, width))
      }

      if (analysis?.roundStatus && !analysis.roundStatus.allResponded) {
        lines.push(truncate(` Pending: ${analysis.roundStatus.pendingAgents.join(', ')}`, width))
      }

      return lines
    }

    const buildMessagesLines = (width, maxLines) => {
      const lines = []
      if (!state.selectedMessages || state.selectedMessages.length === 0) {
        lines.push(truncate(' (no messages)', width))
        return lines
      }

      const recent = state.selectedMessages.slice(-MAX_RECENT_MESSAGES)
      for (const msg of recent) {
        if (lines.length >= maxLines) break
        const header = `[${formatTime(msg.ts)}] ${msg.from}/${msg.type}`
        const body = normalizeSingleLine(msg.content || msg.decision || msg.error || msg.status || '')
        const merged = body ? `${header} ${body}` : header
        const wrapped = wrapText(merged, width, 2)
        for (const line of wrapped) {
          if (lines.length >= maxLines) break
          lines.push(truncate(line, width))
        }
      }

      return lines
    }

    const buildDetailPanel = (width, height) => {
      const lines = []
      const status = state.selectedStatus

      if (!status || !state.selectedId) {
        lines.push(truncate(' Discussion', width))
        lines.push(truncate(' Select a discussion with ↑/↓', width))
        while (lines.length < height) lines.push(' '.repeat(width))
        return lines
      }

      lines.push(truncate(` Discussion ${state.selectedId}`, width))
      for (const line of wrapText(`Topic: ${status.topic || '-'}`, width, 2)) {
        lines.push(truncate(line, width))
      }
      lines.push(truncate(
        `Status: ${status.status}  Round: ${status.currentRound}  Messages: ${status.messageCount}`,
        width
      ))
      lines.push(truncate(`Participants: ${(status.participants || []).join(', ') || '-'}`, width))
      lines.push(truncate(`Started: ${formatDateTime(status.startTime)}`, width))
      lines.push(' '.repeat(width))
      lines.push(truncate(' Current Round Status', width))

      const roundLines = buildRoundStatusLines(width)
      for (const line of roundLines) {
        lines.push(line)
      }

      lines.push(' '.repeat(width))
      lines.push(truncate(' Recent Messages', width))

      const remaining = Math.max(0, height - lines.length)
      const messageLines = buildMessagesLines(width, remaining)
      for (const line of messageLines) {
        lines.push(line)
      }

      while (lines.length < height) {
        lines.push(' '.repeat(width))
      }

      return lines.slice(0, height)
    }

    const buildFooterLine = (width) => {
      if (!state.inputMode) {
        return truncate(`Status: ${state.notice}`, width)
      }

      const prompt = state.inputMode.type === 'followup'
        ? 'Follow-up > '
        : 'End decision > '
      return truncate(`${prompt}${state.inputMode.value}`, width)
    }

    const render = () => {
      if (closed) return

      const columns = process.stdout.columns || 120
      const rows = process.stdout.rows || 40

      if (columns < 60 || rows < 12) {
        const compact = [
          'mad tui requires at least 60x12 terminal size.',
          `Current: ${columns}x${rows}`,
          'Resize terminal or press q to quit.'
        ]
        const output = compact.map(line => truncate(line, columns)).join('\n')
        process.stdout.write(`${ANSI.home}${ANSI.clear}${output}`)
        return
      }

      let leftWidth = Math.max(28, Math.floor(columns * 0.35))
      if (leftWidth > columns - 30) {
        leftWidth = Math.max(20, columns - 30)
      }
      const rightWidth = Math.max(10, columns - leftWidth - 1)
      const bodyRows = Math.max(6, rows - 4)

      const listLines = buildListPanel(leftWidth, bodyRows)
      const detailLines = buildDetailPanel(rightWidth, bodyRows)

      const header = truncate(
        `mad tui | selected: ${state.selectedId || '-'} | refresh: ${formatDateTime(state.lastRefreshAt)}`,
        columns
      )
      const subHeader = truncate(
        `Discussions: ${state.discussions.length}`,
        columns
      )
      const footer = buildFooterLine(columns)
      const help = truncate(
        'Keys: ↑/↓ select  r refresh  a analyze  f follow-up  e end  q quit',
        columns
      )

      const lines = [header, subHeader]
      for (let i = 0; i < bodyRows; i++) {
        const left = listLines[i] || ' '.repeat(leftWidth)
        const right = detailLines[i] || ' '.repeat(rightWidth)
        lines.push(`${left}│${right}`)
      }
      lines.push(footer)
      lines.push(help)

      process.stdout.write(`${ANSI.home}${ANSI.clear}${lines.join('\n')}`)
    }

    const onResize = () => {
      render()
    }

    const onSigint = () => {
      cleanup()
    }

    const onInputModeKey = (key) => {
      if (key === '\u0003') {
        cleanup()
        return
      }

      if (key === '\x1b') {
        state.inputMode = null
        setNotice('Input cancelled')
        render()
        return
      }

      if (key === '\r' || key === '\n') {
        submitInput()
        return
      }

      if (key === '\x7f' || key === '\b') {
        state.inputMode.value = state.inputMode.value.slice(0, -1)
        render()
        return
      }

      if (isPrintable(key)) {
        state.inputMode.value += key
        render()
      }
    }

    const onNormalModeKey = (key) => {
      if (key === '\u0003' || key === 'q') {
        cleanup()
        return
      }

      if (key === '\x1b[A' || key === 'k') {
        moveSelection(-1)
        return
      }

      if (key === '\x1b[B' || key === 'j') {
        moveSelection(1)
        return
      }

      if (key === 'r') {
        refreshSelection()
        setNotice(`Refreshed at ${formatTime(state.lastRefreshAt)}`)
        render()
        return
      }

      if (key === 'a') {
        runAnalyze()
        return
      }

      if (key === 'f') {
        if (!state.selectedId) {
          setNotice('No discussion selected')
        } else if (state.selectedStatus?.status === 'ended') {
          setNotice('Selected discussion already ended')
        } else {
          state.inputMode = { type: 'followup', value: '' }
        }
        render()
        return
      }

      if (key === 'e') {
        if (!state.selectedId) {
          setNotice('No discussion selected')
        } else {
          state.inputMode = { type: 'end', value: '' }
        }
        render()
      }
    }

    const onKey = (buf) => {
      const rawInput = buf.toString('utf8')
      const keys = splitKeys(rawInput)

      for (const key of keys) {
        if (closed) return

        if (state.inputMode) {
          onInputModeKey(key)
        } else {
          onNormalModeKey(key)
        }
      }
    }

    try {
      process.stdout.write(`${ANSI.altScreenOn}${ANSI.hideCursor}${ANSI.clear}${ANSI.home}`)
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on('data', onKey)
      process.stdout.on('resize', onResize)
      process.on('SIGINT', onSigint)

      refreshSelection()
      if (initialDiscussionId && state.selectedId !== initialDiscussionId) {
        setNotice(`Initial discussion not found: ${initialDiscussionId}`)
      }
      render()

      refreshTimer = setInterval(() => {
        if (state.inputMode) return
        refreshSelection()
        render()
      }, REFRESH_INTERVAL_MS)
    } catch (err) {
      failAndClose(err)
    }
  })
}

export {
  startTui
}
