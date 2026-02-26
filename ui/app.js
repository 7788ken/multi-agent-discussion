const state = {
  discussions: [],
  selectedId: null,
  selectedBaseDir: null,
  selectedKey: null,
  detail: null,
  settings: null,
  loading: false,
  sidebarCollapsed: false,
  panelOpen: false,
  userScrolledUp: false,  // 用户是否手动向上滚动
  eventSource: null       // SSE 连接
}

const DEFAULT_WORKING_DIR = ''  // 空字符串表示不指定工作目录

const elements = {}

function initElements() {
  elements.list = document.getElementById('discussion-list')
  elements.sidebarToggle = document.getElementById('sidebar-toggle')
  elements.btnTogglePanel = document.getElementById('btn-toggle-panel')
  elements.panelSidebar = document.getElementById('panel-sidebar')
  elements.newDiscussionBtn = document.getElementById('new-discussion-btn')
  elements.emptyState = document.getElementById('empty-state')
  elements.messagesContainer = document.getElementById('messages-container')
  elements.discussionTopic = document.getElementById('discussion-topic')
  elements.discussionRound = document.getElementById('discussion-round')
  elements.discussionParticipants = document.getElementById('discussion-participants')
  elements.discussionStatus = document.getElementById('discussion-status')
  elements.messagesArea = document.getElementById('messages-area')
  elements.followupInput = document.getElementById('followup-input')
  elements.btnSend = document.getElementById('btn-send')
  elements.detailId = document.getElementById('detail-id')
  elements.detailStatus = document.getElementById('detail-status')
  elements.detailCodev = document.getElementById('detail-codev')
  elements.consensusValue = document.getElementById('consensus-value')
  elements.agreementValue = document.getElementById('agreement-value')
  elements.confidenceValue = document.getElementById('confidence-value')
  elements.opinionRow = document.getElementById('opinion-row')
  elements.modeEnabledInput = document.getElementById('mode-enabled-input')
  elements.btnUpdateMode = document.getElementById('btn-update-mode')
  elements.decisionInput = document.getElementById('decision-input')
  elements.consensusInput = document.getElementById('consensus-input')
  elements.btnEnd = document.getElementById('btn-end')
  elements.settingsClaudeConcurrent = document.getElementById('settings-claude-concurrent')
  elements.settingsCodexConcurrent = document.getElementById('settings-codex-concurrent')
  elements.settingsRetryMaxAttempts = document.getElementById('settings-retry-max-attempts')
  elements.btnSaveSettings = document.getElementById('btn-save-settings')
  elements.settingsRestartAgents = document.getElementById('settings-restart-agents')
  elements.toast = document.getElementById('toast')
  elements.newDiscussionModal = document.getElementById('new-discussion-modal')
  elements.modalClose = document.getElementById('modal-close')
  elements.modalCancel = document.getElementById('modal-cancel')
  elements.modalCreate = document.getElementById('modal-create')
  elements.newTopic = document.getElementById('new-topic')
  elements.newParticipants = document.getElementById('new-participants')
  elements.newBaseDir = document.getElementById('new-base-dir')
  elements.newContent = document.getElementById('new-content')
  elements.newCoDev = document.getElementById('new-codev')
  elements.btnBrowsePath = document.getElementById('btn-browse-path')
  elements.fileTree = document.getElementById('file-tree')
  elements.mentionPopup = document.getElementById('mention-popup')
  elements.btnViewResult = document.getElementById('btn-view-result')
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTime(iso) {
  if (!iso) return '-'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function setLoading(flag) {
  state.loading = flag
}

function showToast(message, type = 'info') {
  elements.toast.textContent = message
  elements.toast.className = `toast ${type}`
  setTimeout(() => {
    elements.toast.className = 'toast hidden'
  }, 2500)
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`)
  }
  return data
}

function getDiscussionKey(discussionId, baseDir = '') {
  return `${baseDir || ''}::${discussionId || ''}`
}

function setSelectedDiscussion(discussionId, baseDir = null) {
  if (!discussionId) {
    state.selectedId = null
    state.selectedBaseDir = null
    state.selectedKey = null
    syncLocationWithSelection()
    return
  }

  state.selectedId = discussionId
  state.selectedBaseDir = baseDir || null
  state.selectedKey = getDiscussionKey(discussionId, state.selectedBaseDir || '')
  syncLocationWithSelection()
}

function syncLocationWithSelection() {
  if (typeof window === 'undefined' || !window.location || !window.history) {
    return
  }

  const url = new URL(window.location.href)
  if (state.selectedId) {
    url.searchParams.set('discussion', state.selectedId)
  } else {
    url.searchParams.delete('discussion')
  }

  if (state.selectedBaseDir) {
    url.searchParams.set('baseDir', state.selectedBaseDir)
  } else {
    url.searchParams.delete('baseDir')
  }

  const search = url.searchParams.toString()
  const nextUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
  window.history.replaceState(null, '', nextUrl)
}

function findSelectedDiscussionItem() {
  if (!state.selectedId) {
    return null
  }

  if (state.selectedBaseDir) {
    return state.discussions.find(item => (
      item.discussionId === state.selectedId &&
      (item.baseDir || '') === state.selectedBaseDir
    )) || null
  }

  return state.discussions.find(item => item.discussionId === state.selectedId) || null
}

function buildDiscussionApiPath(discussionId, action = null, baseDir = null) {
  const apiPath = `/api/discussions/${encodeURIComponent(discussionId)}`
  const actionPath = action ? `/${action}` : ''
  if (!baseDir) {
    return `${apiPath}${actionPath}`
  }

  const searchParams = new URLSearchParams()
  searchParams.set('baseDir', baseDir)
  return `${apiPath}${actionPath}?${searchParams.toString()}`
}

function renderDiscussionList() {
  if (state.discussions.length === 0) {
    elements.list.innerHTML = '<div class="muted" style="padding: 12px; color: var(--text-muted);">No discussions yet</div>'
    return
  }

  elements.list.innerHTML = state.discussions
    .map((item) => {
      const itemBaseDir = item.baseDir || ''
      const itemKey = getDiscussionKey(item.discussionId, itemBaseDir)
      const isActive = itemKey === state.selectedKey
      const statusClass = item.status === 'ended' ? 'ended' : ''
      return `
        <button class="discussion-item ${isActive ? 'active' : ''}" data-id="${escapeHtml(item.discussionId)}" data-base-dir="${escapeHtml(itemBaseDir)}" type="button">
          <div class="item-title">${escapeHtml(item.topic || item.discussionId)}</div>
          <div class="item-meta">
            <span class="item-badge ${statusClass}">${escapeHtml(item.status)}</span>
            <span>R${item.currentRound || 0}</span>
            <span>${item.messageCount || 0} msgs</span>
          </div>
        </button>
      `
    })
    .join('')
}

// 状态计时器
const statusTimers = new Map()

function renderMessages(detail) {
  const messages = detail.recentMessages || []
  const discussionStatus = detail.discussion?.status || 'active'

  if (messages.length === 0) {
    elements.messagesArea.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px;">No messages yet</div>'
    return
  }

  // 清除旧的计时器
  statusTimers.forEach(timer => clearInterval(timer))
  statusTimers.clear()

  // 如果讨论已结束，不显示任何 thinking/retrying 状态消息
  const isEnded = discussionStatus === 'ended'

  // 过滤状态消息：只保留每个 agent 的最新一条 thinking 消息（且讨论未结束）
  // 从后往前遍历，记录每个 agent 第一个遇到的 thinking 消息的索引
  const latestThinkingByAgent = new Map() // agent -> index

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const content = msg.content || ''
    const isThinking = msg.type === 'status' && msg.status === 'thinking' && content.includes('thinking')

    if (isThinking && !latestThinkingByAgent.has(msg.from)) {
      latestThinkingByAgent.set(msg.from, i)
    }
  }

  // 构建过滤后的消息列表
  const filteredMessages = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const content = msg.content || ''
    const isThinking = msg.type === 'status' && msg.status === 'thinking' && content.includes('thinking')
    const isRetrying = msg.type === 'status' && msg.status === 'retrying'

    // 如果讨论已结束，不显示任何 thinking/retrying 状态
    if (isEnded && (isThinking || isRetrying)) {
      continue
    }

    if (isThinking) {
      // 只保留每个 agent 最新的 thinking 消息
      if (latestThinkingByAgent.get(msg.from) === i) {
        filteredMessages.push({ ...msg, _originalIndex: i })
      }
    } else {
      // 其他消息全部保留
      filteredMessages.push({ ...msg, _originalIndex: i })
    }
  }

  elements.messagesArea.innerHTML = filteredMessages
    .map((msg) => {
      const from = msg.from || 'unknown'
      const isUser = from.toLowerCase() === 'user'
      const isStatus = msg.type === 'status'
      const avatarClass = isUser ? 'user' :
                          from.toLowerCase().includes('claude') ? 'claude' :
                          from.toLowerCase().includes('codex') ? 'codex' : 'system'
      const displayName = isUser ? 'ME' : from
      const body = msg.content || msg.decision || msg.error || '-'

      // 状态消息特殊处理
      if (isStatus) {
        const statusClass = msg.status === 'thinking' ? 'status-thinking' :
                           msg.status === 'retrying' ? 'status-retrying' : 'status-info'
        const statusIcon = msg.status === 'thinking' ? '🤔' :
                          msg.status === 'retrying' ? '🔄' : '📋'
        return `
          <div class="message status-message ${statusClass}" data-msg-index="${msg._originalIndex}" data-msg-ts="${msg.ts || ''}">
            <div class="status-card">
              <div class="status-avatar ${avatarClass}">${from.substring(0, 2).toUpperCase()}</div>
              <div class="status-content">
                <div class="status-header">
                  <span class="status-agent">${escapeHtml(displayName)}</span>
                  <span class="status-icon">${statusIcon}</span>
                </div>
                <div class="status-text">${escapeHtml(body)}</div>
                <div class="status-timer" id="timer-${msg._originalIndex}">已用时: 0秒</div>
              </div>
            </div>
          </div>
        `
      }

      return `
        <div class="message ${isUser ? 'message-user' : ''}">
          ${!isUser ? `<div class="message-avatar ${avatarClass}">${from.substring(0, 2).toUpperCase()}</div>` : ''}
          <div class="message-content">
            <div class="message-sender">
              ${escapeHtml(displayName)}
              <span class="message-type">${escapeHtml(msg.type || '-')}</span>
            </div>
            <div class="message-text">${escapeHtml(body)}</div>
            <div class="message-time">${escapeHtml(formatTime(msg.ts))}</div>
          </div>
          ${isUser ? `<div class="message-avatar ${avatarClass}">ME</div>` : ''}
        </div>
      `
    })
    .join('')

  // 为 thinking 状态启动计时器
  filteredMessages.forEach((msg) => {
    if (msg.type === 'status' && msg.status === 'thinking') {
      startStatusTimer(msg._originalIndex, msg.ts)
    }
  })

  // 只在用户没有向上滚动时才自动滚动到底部
  if (!state.userScrolledUp) {
    elements.messagesArea.scrollTop = elements.messagesArea.scrollHeight
  }
}

function startStatusTimer(index, startTime) {
  const timerEl = document.getElementById(`timer-${index}`)
  if (!timerEl) return

  const start = startTime ? new Date(startTime).getTime() : Date.now()

  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000)
    const minutes = Math.floor(elapsed / 60)
    const seconds = elapsed % 60

    if (minutes > 0) {
      timerEl.textContent = `已用时: ${minutes}分${seconds}秒`
    } else {
      timerEl.textContent = `已用时: ${seconds}秒`
    }
  }, 1000)

  statusTimers.set(index, timer)
}

function renderConsensus(detail) {
  console.log('[renderConsensus] called with detail:', detail)
  const consensus = detail.consensus || {}
  const intervention = detail.intervention || {}
  const roundStatus = detail.roundStatus || {}

  console.log('[renderConsensus] consensus:', consensus)
  console.log('[renderConsensus] intervention:', intervention)
  console.log('[renderConsensus] roundStatus:', roundStatus)

  elements.consensusValue.textContent = consensus.hasConsensus ? 'Yes' : 'No'
  elements.agreementValue.textContent = `${Math.round((consensus.agreementLevel || 0) * 100)}%`
  elements.confidenceValue.textContent = `${Math.round((consensus.averageConfidence || 0) * 100)}%`

  const opinions = consensus.opinions || {}
  elements.opinionRow.innerHTML = `
    <span>Agree: ${opinions.agree || 0}</span>
    <span>Disagree: ${opinions.disagree || 0}</span>
    <span>Neutral: ${opinions.neutral || 0}</span>
    <span>Alternative: ${opinions.alternative || 0}</span>
  `

  // 讨论收敛提示
  // 只需要 intervention.needsIntervention 为 true 且讨论状态为 active
  const canConclude =
    intervention.needsIntervention &&
    detail.discussion?.status === 'active'

  // 调试日志
  console.log('[Convergence Check]', {
    needsIntervention: intervention.needsIntervention,
    reason: intervention.reason,
    suggestedAction: intervention.suggestedAction,
    status: detail.discussion?.status,
    canConclude
  })

  if (canConclude) {
    showConvergenceHint(intervention.reason, intervention.suggestedAction)
  } else {
    hideConvergenceHint()
  }
}

function renderDetail() {
  const detail = state.detail
  if (!detail || !detail.discussion) {
    elements.emptyState.classList.remove('hidden')
    elements.messagesContainer.classList.add('hidden')
    elements.discussionStatus.textContent = ''
    return
  }

  const discussion = detail.discussion
  elements.emptyState.classList.add('hidden')
  elements.messagesContainer.classList.remove('hidden')

  elements.discussionTopic.textContent = discussion.topic || discussion.discussionId
  elements.discussionRound.textContent = `Round ${discussion.currentRound || 0}`
  elements.discussionParticipants.textContent = (discussion.participants || []).join(', ') || '-'
  elements.discussionStatus.textContent = discussion.status

  elements.detailId.textContent = discussion.discussionId.substring(0, 8)
  elements.detailStatus.textContent = discussion.status
  elements.detailStatus.style.color = discussion.status === 'ended' ? 'var(--danger)' : 'var(--accent)'

  const coDevEnabled = Boolean(detail.coDevMode?.enabled)
  elements.detailCodev.textContent = coDevEnabled ? 'ON' : 'OFF'
  elements.detailCodev.style.color = coDevEnabled ? 'var(--accent)' : 'var(--text-muted)'
  elements.modeEnabledInput.checked = coDevEnabled

  renderMessages(detail)
  renderConsensus(detail)
}

// ===== 收敛提示 =====
function showConvergenceHint(reason, action) {
  // 创建或更新提示区域
  let hint = document.getElementById('convergence-hint')
  if (!hint) {
    hint = document.createElement('div')
    hint.id = 'convergence-hint'
    hint.className = 'convergence-hint'
    // 插入到消息区域底部
    const messagesWrapper = document.querySelector('.messages-wrapper')
    if (messagesWrapper) {
      messagesWrapper.appendChild(hint)
    }
  }
  hint.innerHTML = `
    <div class="hint-content">
      <span class="hint-icon">💡</span>
      <div class="hint-text">
        <strong>${escapeHtml(reason || '讨论可能已收敛')}</strong>
        <p>${escapeHtml(action || '可以结束讨论、查看结果，也可以继续追问')}</p>
      </div>
      <div class="hint-actions">
        <button class="btn btn-primary hint-btn" id="hint-view-result" type="button">📄 查看讨论结果</button>
        <button class="btn btn-danger hint-btn" id="hint-end-discussion" type="button">✓ 结束讨论</button>
      </div>
    </div>
  `
  hint.classList.remove('hidden')

  // 绑定按钮点击事件
  const viewResultBtn = hint.querySelector('#hint-view-result')
  if (viewResultBtn) {
    viewResultBtn.addEventListener('click', handleViewResult)
  }

  const endDiscussionBtn = hint.querySelector('#hint-end-discussion')
  if (endDiscussionBtn) {
    endDiscussionBtn.addEventListener('click', handleEndDiscussionFromHint)
  }
}

function handleEndDiscussionFromHint() {
  // 使用默认值结束讨论
  if (!state.selectedId) return

  const decision = 'Consensus reached - discussion ended'
  const consensus = true

  try {
    request(buildDiscussionApiPath(state.selectedId, 'end', state.selectedBaseDir), {
      method: 'POST',
      body: JSON.stringify({ decision, consensus })
    }).then(() => {
      showToast('Discussion ended', 'success')
      hideConvergenceHint()
      loadDiscussions()
    }).catch(err => {
      showToast(err.message, 'error')
    })
  } catch (err) {
    showToast(err.message, 'error')
  }
}

function hideConvergenceHint() {
  const hint = document.getElementById('convergence-hint')
  if (hint) hint.classList.add('hidden')
}

// ===== 查看结果 =====
function handleViewResult() {
  if (!state.selectedId || !state.selectedBaseDir) return

  // 构建结果文件路径
  const resultUrl = `/api/discussions/${encodeURIComponent(state.selectedId)}/result?baseDir=${encodeURIComponent(state.selectedBaseDir)}`
  window.open(resultUrl, '_blank')
}

async function loadDiscussions() {
  setLoading(true)
  try {
    const data = await request('/api/discussions')
    state.discussions = (data.discussions || []).map(item => ({
      ...item,
      baseDir: item.baseDir || null
    }))

    if (!state.selectedId && state.discussions.length > 0) {
      const queryParams = new URLSearchParams(window.location.search)
      const queryId = queryParams.get('discussion')
      const queryBaseDir = queryParams.get('baseDir')
      if (queryId) {
        setSelectedDiscussion(queryId, queryBaseDir || null)
      } else {
        const first = state.discussions[0]
        setSelectedDiscussion(first.discussionId, first.baseDir || null)
      }
    }

    const selectedItem = findSelectedDiscussionItem()
    if (selectedItem) {
      setSelectedDiscussion(selectedItem.discussionId, selectedItem.baseDir || null)
    } else if (state.discussions.length > 0) {
      const first = state.discussions[0]
      setSelectedDiscussion(first.discussionId, first.baseDir || null)
    } else {
      setSelectedDiscussion(null)
    }

    renderDiscussionList()

    if (state.selectedId) {
      await loadDetail(state.selectedId, state.selectedBaseDir)
    } else {
      state.detail = null
      renderDetail()
    }
  } catch (err) {
    showToast(err.message, 'error')
  } finally {
    setLoading(false)
  }
}

async function loadDetail(discussionId, baseDir = null) {
  setSelectedDiscussion(discussionId, baseDir)
  renderDiscussionList()

  try {
    const detail = await request(buildDiscussionApiPath(discussionId, null, baseDir))
    state.detail = detail
    if (detail && detail.discussion && detail.discussion.discussionId) {
      setSelectedDiscussion(detail.discussion.discussionId, detail.discussion.baseDir || baseDir || null)
      renderDiscussionList()
    }
    renderDetail()
  } catch (err) {
    showToast(err.message, 'error')
  }
}

function parsePositiveIntegerInput(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

function buildManualRestartCommands(claudeConcurrent, codexConcurrent) {
  return [
    `node bin/claude-agent.js stop claude`,
    `node bin/claude-agent.js start --nickname claude --max-concurrent ${claudeConcurrent}`,
    `node bin/codex-agent.js stop codex`,
    `node bin/codex-agent.js start --nickname codex --max-concurrent ${codexConcurrent}`
  ].join('\n')
}

function hasSettingsElements() {
  return Boolean(
    elements.settingsClaudeConcurrent &&
    elements.settingsCodexConcurrent &&
    elements.settingsRetryMaxAttempts
  )
}

function renderSettings() {
  if (!state.settings || !hasSettingsElements()) return

  const claudeConcurrent = state.settings.agentMaxConcurrent?.claude
  const codexConcurrent = state.settings.agentMaxConcurrent?.codex
  const retryMaxAttempts = state.settings.retryMaxAttempts

  if (Number.isInteger(claudeConcurrent)) {
    elements.settingsClaudeConcurrent.value = String(claudeConcurrent)
  }
  if (Number.isInteger(codexConcurrent)) {
    elements.settingsCodexConcurrent.value = String(codexConcurrent)
  }

  elements.settingsRetryMaxAttempts.value = Number.isInteger(retryMaxAttempts)
    ? String(retryMaxAttempts)
    : '-'
}

async function loadSettings() {
  if (!hasSettingsElements()) return

  try {
    state.settings = await request('/api/settings')
    renderSettings()
  } catch (err) {
    showToast(`Failed to load settings: ${err.message}`, 'error')
  }
}

// ===== 侧边栏和面板控制 =====
function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed
  document.body.classList.toggle('sidebar-collapsed', state.sidebarCollapsed)
  localStorage.setItem('sidebarCollapsed', state.sidebarCollapsed)
}

function togglePanel() {
  state.panelOpen = !state.panelOpen
  elements.panelSidebar.classList.toggle('open', state.panelOpen)
  elements.btnTogglePanel.classList.toggle('active', state.panelOpen)
  localStorage.setItem('panelOpen', state.panelOpen)
}

function initSidebar() {
  const savedSidebar = localStorage.getItem('sidebarCollapsed')
  const savedPanel = localStorage.getItem('panelOpen')

  if (savedSidebar === 'true') {
    state.sidebarCollapsed = true
    document.body.classList.add('sidebar-collapsed')
  }

  if (savedPanel === 'true') {
    state.panelOpen = true
    elements.panelSidebar.classList.add('open')
    elements.btnTogglePanel.classList.add('active')
  }
}

// ===== 事件处理 =====
async function handleSendFollowup() {
  if (!state.selectedId) return

  const question = (elements.followupInput.value || '').trim()

  if (!question) {
    showToast('Please enter a follow-up question', 'error')
    return
  }

  // 解析 @mentions 来确定目标
  let target = null
  const mentionMatch = question.match(/@(claude|codex)\b/i)
  if (mentionMatch) {
    target = mentionMatch[1].toLowerCase()
  }

  try {
    await request(buildDiscussionApiPath(state.selectedId, 'followup', state.selectedBaseDir), {
      method: 'POST',
      body: JSON.stringify({ question, target })
    })
    elements.followupInput.value = ''
    elements.followupInput.style.height = 'auto'  // 重置高度
    showToast('Follow-up sent', 'success')
    await loadDiscussions()
  } catch (err) {
    showToast(err.message, 'error')
  }
}

async function handleUpdateMode() {
  if (!state.selectedId) return

  const enabled = Boolean(elements.modeEnabledInput.checked)
  try {
    await request(buildDiscussionApiPath(state.selectedId, 'mode', state.selectedBaseDir), {
      method: 'POST',
      body: JSON.stringify({ enabled })
    })
    showToast(`Co-Dev mode ${enabled ? 'enabled' : 'disabled'}`, 'success')
    await loadDiscussions()
  } catch (err) {
    showToast(err.message, 'error')
  }
}

async function handleEndDiscussion() {
  if (!state.selectedId) return

  const decision = elements.decisionInput.value.trim()
  const consensus = Boolean(elements.consensusInput.checked)

  try {
    await request(buildDiscussionApiPath(state.selectedId, 'end', state.selectedBaseDir), {
      method: 'POST',
      body: JSON.stringify({ decision, consensus })
    })
    elements.decisionInput.value = ''
    showToast('Discussion ended', 'success')
    await loadDiscussions()
  } catch (err) {
    showToast(err.message, 'error')
  }
}

// ===== 对话框控制 =====
const fileCache = {
  baseDir: null,
  files: [],
  expandedFolders: new Set()
}

function openNewDiscussionModal() {
  // 重置表单
  elements.newTopic.value = ''
  elements.newBaseDir.value = ''
  elements.newContent.value = ''
  elements.newCoDev.checked = false
  elements.fileTree.classList.add('hidden')
  const checkboxes = elements.newParticipants.querySelectorAll('input[type="checkbox"]')
  checkboxes.forEach(cb => cb.checked = cb.value === 'claude' || cb.value === 'codex')

  // 重置文件缓存
  fileCache.baseDir = null
  fileCache.files = []
  fileCache.expandedFolders.clear()

  elements.newDiscussionModal.classList.remove('hidden')
  elements.newTopic.focus()
}

function closeNewDiscussionModal() {
  elements.newDiscussionModal.classList.add('hidden')
  elements.mentionPopup.classList.add('hidden')
}

function getSelectedParticipants() {
  const checkboxes = elements.newParticipants.querySelectorAll('input[type="checkbox"]:checked')
  return Array.from(checkboxes).map(cb => cb.value)
}

// ===== 文件浏览器 =====
async function fetchFileList(path) {
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`)
    if (!res.ok) throw new Error('Failed to fetch files')
    return await res.json()
  } catch (err) {
    console.error('Failed to fetch file list:', err)
    return { files: [] }
  }
}

async function toggleFileTree() {
  if (!elements.fileTree.classList.contains('hidden')) {
    elements.fileTree.classList.add('hidden')
    return
  }

  // 默认使用服务端当前工作目录
  const basePath = elements.newBaseDir.value || DEFAULT_WORKING_DIR
  await loadFileTree(basePath)
  elements.fileTree.classList.remove('hidden')
}

async function loadFileTree(path, targetElement = null) {
  const data = await fetchFileList(path)
  fileCache.baseDir = path
  fileCache.files = data.files || []

  const container = targetElement || elements.fileTree
  container.innerHTML = ''

  // 添加返回上级选项
  if (!targetElement) {
    const parentItem = document.createElement('div')
    parentItem.className = 'file-tree-item'
    parentItem.innerHTML = '<span class="icon">📁</span><span>..</span>'
    parentItem.addEventListener('click', async () => {
      const parentPath = path.split('/').slice(0, -1).join('/') || '/'
      elements.newBaseDir.value = parentPath
      await loadFileTree(parentPath)
    })
    container.appendChild(parentItem)
  }

  // 渲染文件夹
  const folders = fileCache.files.filter(f => f.isDirectory)
  const files = fileCache.files.filter(f => !f.isDirectory)

  for (const folder of folders) {
    const item = document.createElement('div')
    item.className = 'file-tree-item folder'
    item.innerHTML = `<span class="icon">📁</span><span>${escapeHtml(folder.name)}</span>`
    // 单击选择并关闭
    item.addEventListener('click', () => {
      const newPath = `${path}/${folder.name}`
      elements.newBaseDir.value = newPath
      elements.fileTree.classList.add('hidden')
    })
    // 双击进入文件夹
    item.addEventListener('dblclick', async () => {
      const newPath = `${path}/${folder.name}`
      elements.newBaseDir.value = newPath
      await loadFileTree(newPath)
    })
    container.appendChild(item)
  }

  // 渲染文件 - 点击可选择
  for (const file of files) {
    const item = document.createElement('div')
    item.className = 'file-tree-item file'
    item.innerHTML = `<span class="icon">📄</span><span>${escapeHtml(file.name)}</span>`
    item.addEventListener('click', () => {
      // 将文件路径添加到消息中
      const filePath = `${path}/${file.name}`
      const relativePath = filePath.replace(fileCache.baseDir || path, '').replace(/^\//, '')
      const currentContent = elements.newContent.value
      elements.newContent.value = currentContent + (currentContent ? ' ' : '') + `@${relativePath}`
      elements.fileTree.classList.add('hidden')
      elements.newContent.focus()
    })
    container.appendChild(item)
  }

  // 添加"选择当前目录"按钮
  if (!targetElement) {
    const selectBtn = document.createElement('div')
    selectBtn.className = 'file-tree-item selected'
    selectBtn.innerHTML = '<span class="icon">✓</span><span>Use this folder</span>'
    selectBtn.addEventListener('click', () => {
      elements.newBaseDir.value = path
      elements.fileTree.classList.add('hidden')
    })
    container.appendChild(selectBtn)
  }
}

// ===== @ 提及文件 =====
function getMentionContext(text, cursorPos) {
  const beforeCursor = text.substring(0, cursorPos)
  const atIndex = beforeCursor.lastIndexOf('@')

  if (atIndex === -1) return null

  const afterAt = beforeCursor.substring(atIndex + 1)
  // 如果包含空格或换行，则不是有效的 @ 提及
  if (/\s/.test(afterAt)) return null

  return {
    startIndex: atIndex,
    query: afterAt.toLowerCase(),
    fullText: afterAt
  }
}

async function showMentionPopup(query) {
  if (!fileCache.baseDir) {
    elements.mentionPopup.classList.add('hidden')
    return
  }

  // 获取匹配的文件
  const files = await searchFiles(fileCache.baseDir, query)
  if (files.length === 0) {
    elements.mentionPopup.classList.add('hidden')
    return
  }

  elements.mentionPopup.innerHTML = files.slice(0, 10).map((f, i) => `
    <div class="mention-item ${f.isDirectory ? 'folder' : ''}" data-index="${i}" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(f.name)}">
      <span class="icon">${f.isDirectory ? '📁' : '📄'}</span>
      <span>${escapeHtml(f.name)}</span>
    </div>
  `).join('')

  elements.mentionPopup.classList.remove('hidden')
  elements.mentionPopup.dataset.selectedIndex = '0'
  updateMentionSelection()
}

function hideMentionPopup() {
  elements.mentionPopup.classList.add('hidden')
}

function updateMentionSelection() {
  const items = elements.mentionPopup.querySelectorAll('.mention-item')
  const selectedIndex = parseInt(elements.mentionPopup.dataset.selectedIndex || '0', 10)

  items.forEach((item, i) => {
    item.classList.toggle('active', i === selectedIndex)
  })
}

function insertMention(filePath, fileName) {
  const textarea = elements.newContent
  const text = textarea.value
  const cursorPos = textarea.selectionStart

  const context = getMentionContext(text, cursorPos)
  if (!context) return

  // 替换 @xxx 为 @filepath
  const before = text.substring(0, context.startIndex)
  const after = text.substring(cursorPos)

  // 使用相对路径（相对于 baseDir）
  const relativePath = filePath.replace(fileCache.baseDir, '').replace(/^\//, '')

  textarea.value = before + `@${relativePath}` + after

  // 移动光标到插入文本之后
  const newPos = context.startIndex + relativePath.length + 1
  textarea.setSelectionRange(newPos, newPos)
  textarea.focus()

  hideMentionPopup()
}

async function searchFiles(basePath, query) {
  try {
    const res = await fetch(`/api/files/search?path=${encodeURIComponent(basePath)}&query=${encodeURIComponent(query)}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.files || []
  } catch (err) {
    console.error('Failed to search files:', err)
    return []
  }
}

async function handleCreateDiscussion() {
  const topic = elements.newTopic.value.trim()
  const participants = getSelectedParticipants()
  const selectedWorkingDir = elements.newBaseDir.value.trim()
  const workingDir = selectedWorkingDir || DEFAULT_WORKING_DIR
  const content = elements.newContent.value.trim()
  const coDevEnabled = Boolean(elements.newCoDev?.checked)

  if (!topic) {
    showToast('Please enter a topic', 'error')
    elements.newTopic.focus()
    return
  }

  if (participants.length === 0) {
    showToast('Please select at least one participant', 'error')
    return
  }

  try {
    const body = {
      topic,
      participants,
      workingDir,
      coDevMode: { enabled: coDevEnabled }
    }

    const result = await request('/api/discussions', {
      method: 'POST',
      body: JSON.stringify(body)
    })

    closeNewDiscussionModal()
    showToast('Discussion created, starting agents...', 'success')

    // 启动 agent（传递正确的 baseDir）
    try {
      await request('/api/agents/start', {
        method: 'POST',
        body: JSON.stringify({
          workingDir,
          baseDir: result.baseDir || null,
          participants
        })
      })
    } catch (agentErr) {
      console.error('Failed to start agents:', agentErr)
    }

    await loadDiscussions()

    if (result && result.discussionId) {
      setSelectedDiscussion(result.discussionId, result.baseDir || null)
      await loadDetail(result.discussionId, result.baseDir || null)

      // 如果有初始消息，发送它
      if (content) {
        await request(buildDiscussionApiPath(result.discussionId, 'followup', result.baseDir || null), {
          method: 'POST',
          body: JSON.stringify({ question: content })
        })
        await loadDiscussions()
      }
    }
  } catch (err) {
    showToast(err.message, 'error')
  }
}

async function handleSaveSettings() {
  if (!hasSettingsElements()) return

  const claudeConcurrent = parsePositiveIntegerInput(elements.settingsClaudeConcurrent.value)
  const codexConcurrent = parsePositiveIntegerInput(elements.settingsCodexConcurrent.value)

  if (!claudeConcurrent || !codexConcurrent) {
    showToast('Concurrent must be positive integers', 'error')
    return
  }

  try {
    const payload = {
      agentMaxConcurrent: {
        claude: claudeConcurrent,
        codex: codexConcurrent
      }
    }
    const result = await request('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload)
    })

    state.settings = result
    renderSettings()
    showToast('Settings saved', 'success')
  } catch (err) {
    showToast(err.message, 'error')
  }
}

async function handleSettingsRestartAgents() {
  if (!hasSettingsElements()) return

  const claudeConcurrent = parsePositiveIntegerInput(elements.settingsClaudeConcurrent.value)
  const codexConcurrent = parsePositiveIntegerInput(elements.settingsCodexConcurrent.value)

  if (!claudeConcurrent || !codexConcurrent) {
    showToast('Concurrent must be positive integers', 'error')
    return
  }

  try {
    const payload = {
      agentMaxConcurrent: {
        claude: claudeConcurrent,
        codex: codexConcurrent
      }
    }
    const result = await request('/api/settings', {
      method: 'POST',
      body: JSON.stringify(payload)
    })

    state.settings = result
    renderSettings()

    const commands = buildManualRestartCommands(claudeConcurrent, codexConcurrent)
    let copied = false
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(commands)
        copied = true
      } catch {}
    }

    if (copied) {
      showToast('Settings saved, restart commands copied to clipboard.', 'success')
    } else {
      console.info(`Restart commands:\n${commands}`)
      showToast('Settings saved. Check console for restart commands.', 'success')
    }
  } catch (err) {
    showToast(err.message, 'error')
  }
}

function bindEvents() {
  // 侧边栏和面板
  elements.sidebarToggle.addEventListener('click', toggleSidebar)
  elements.btnTogglePanel.addEventListener('click', togglePanel)

  // 新建讨论对话框
  elements.newDiscussionBtn.addEventListener('click', openNewDiscussionModal)
  elements.modalClose.addEventListener('click', closeNewDiscussionModal)
  elements.modalCancel.addEventListener('click', closeNewDiscussionModal)
  elements.modalCreate.addEventListener('click', handleCreateDiscussion)

  // 点击遮罩关闭对话框
  elements.newDiscussionModal.addEventListener('click', (e) => {
    if (e.target === elements.newDiscussionModal) {
      closeNewDiscussionModal()
    }
  })

  // Enter 提交
  elements.newTopic.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateDiscussion()
    }
  })

  // 文件浏览器
  elements.btnBrowsePath.addEventListener('click', toggleFileTree)
  elements.newBaseDir.addEventListener('click', toggleFileTree)

  // @ 提及文件
  elements.newContent.addEventListener('input', (e) => {
    const textarea = e.target
    const context = getMentionContext(textarea.value, textarea.selectionStart)
    if (context) {
      showMentionPopup(context.query)
    } else {
      hideMentionPopup()
    }
  })

  elements.newContent.addEventListener('keydown', (e) => {
    if (!elements.mentionPopup.classList.contains('hidden')) {
      const items = elements.mentionPopup.querySelectorAll('.mention-item')
      const selectedIndex = parseInt(elements.mentionPopup.dataset.selectedIndex || '0', 10)

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        elements.mentionPopup.dataset.selectedIndex = String((selectedIndex + 1) % items.length)
        updateMentionSelection()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        elements.mentionPopup.dataset.selectedIndex = String((selectedIndex - 1 + items.length) % items.length)
        updateMentionSelection()
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selectedItem = items[selectedIndex]
        if (selectedItem) {
          insertMention(selectedItem.dataset.path, selectedItem.dataset.name)
        }
      } else if (e.key === 'Escape') {
        hideMentionPopup()
      }
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleCreateDiscussion()
    }
  })

  // 点击提及项
  elements.mentionPopup.addEventListener('click', (e) => {
    const item = e.target.closest('.mention-item')
    if (item) {
      insertMention(item.dataset.path, item.dataset.name)
    }
  })

  // 讨论列表点击
  elements.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-id]')
    if (!button) return
    const discussionId = button.dataset.id
    const baseDir = button.dataset.baseDir || null
    if (!discussionId) return
    loadDetail(discussionId, baseDir)
  })

  // 发送追问
  elements.btnSend.addEventListener('click', handleSendFollowup)

  // Command+Enter 发送
  elements.followupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSendFollowup()
    }
  })

  // 输入框自动调整高度
  elements.followupInput.addEventListener('input', () => {
    const textarea = elements.followupInput
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, parseFloat(getComputedStyle(textarea).maxHeight)) + 'px'
  })

  // 模式更新
  elements.btnUpdateMode.addEventListener('click', handleUpdateMode)

  // 结束讨论
  elements.btnEnd.addEventListener('click', handleEndDiscussion)

  // 设置
  if (elements.btnSaveSettings) {
    elements.btnSaveSettings.addEventListener('click', handleSaveSettings)
  }
  if (elements.settingsRestartAgents) {
    elements.settingsRestartAgents.addEventListener('click', handleSettingsRestartAgents)
  }

  // 查看结果按钮
  if (elements.btnViewResult) {
    elements.btnViewResult.addEventListener('click', handleViewResult)
  }
}

function bootstrap() {
  initElements()
  initSidebar()
  bindEvents()
  loadSettings()
  loadDiscussions()

  // 启动 SSE 连接
  connectSSE()

  // 监听消息区域滚动，检测用户是否向上滚动
  elements.messagesArea.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = elements.messagesArea
    // 如果距离底部超过 100px，认为用户在查看历史消息
    state.userScrolledUp = scrollHeight - scrollTop - clientHeight > 100
  })
}

// SSE 连接
function connectSSE() {
  if (state.eventSource) {
    state.eventSource.close()
  }

  try {
    state.eventSource = new EventSource('/api/events')

    state.eventSource.addEventListener('connected', () => {
      console.log('SSE connected')
    })

    state.eventSource.addEventListener('discussion-update', (event) => {
      try {
        const data = JSON.parse(event.data)
        // 如果是当前选中的讨论有更新，重新加载
        if (data.discussionId === state.selectedId) {
          loadDetail(state.selectedId, state.selectedBaseDir)
        }
        // 更新讨论列表
        loadDiscussions()
      } catch (err) {
        console.error('Failed to parse SSE data:', err)
      }
    })

    state.eventSource.onerror = () => {
      console.log('SSE connection lost, reconnecting...')
      // 5秒后重连
      setTimeout(() => {
        if (state.eventSource) {
          connectSSE()
        }
      }, 5000)
    }
  } catch (err) {
    console.error('SSE not supported, falling back to polling')
    // 降级到轮询
    setInterval(() => {
      if (!state.loading) {
        loadDiscussions()
      }
    }, 8000)
  }
}

bootstrap()
