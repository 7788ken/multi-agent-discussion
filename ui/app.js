const state = {
  discussions: [],
  selectedId: null,
  detail: null,
  loading: false
}

const elements = {
  list: document.getElementById('discussion-list'),
  count: document.getElementById('discussions-count'),
  refreshBtn: document.getElementById('refresh-btn'),
  newDiscussionBtn: document.getElementById('new-discussion-btn'),
  emptyState: document.getElementById('empty-state'),
  detailContent: document.getElementById('detail-content'),
  detailTopic: document.getElementById('detail-topic'),
  detailStatus: document.getElementById('detail-status'),
  detailId: document.getElementById('detail-id'),
  detailRound: document.getElementById('detail-round'),
  detailParticipants: document.getElementById('detail-participants'),
  detailCodev: document.getElementById('detail-codev'),
  consensusBox: document.getElementById('consensus-box'),
  recentMessages: document.getElementById('recent-messages'),
  modeForm: document.getElementById('mode-form'),
  modeEnabledInput: document.getElementById('mode-enabled-input'),
  followupForm: document.getElementById('followup-form'),
  followupInput: document.getElementById('followup-input'),
  followupTarget: document.getElementById('followup-target'),
  endForm: document.getElementById('end-form'),
  decisionInput: document.getElementById('decision-input'),
  consensusInput: document.getElementById('consensus-input'),
  toast: document.getElementById('toast')
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
  elements.refreshBtn.disabled = flag
}

function showToast(message, type = 'info') {
  elements.toast.textContent = message
  elements.toast.className = `toast ${type}`
  setTimeout(() => {
    elements.toast.className = 'toast hidden'
  }, 2200)
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

function getStatusClass(status) {
  return status === 'ended' ? 'ended' : 'active'
}

function renderDiscussionList() {
  elements.count.textContent = String(state.discussions.length)

  if (state.discussions.length === 0) {
    elements.list.innerHTML = '<div class="muted">暂无讨论</div>'
    return
  }

  elements.list.innerHTML = state.discussions
    .map((item) => {
      const activeClass = item.discussionId === state.selectedId ? 'item active' : 'item'
      return `
        <button class="${activeClass}" data-id="${escapeHtml(item.discussionId)}" type="button">
          <div class="item-title">${escapeHtml(item.topic || item.discussionId)}</div>
          <div class="item-meta">
            <span class="badge ${getStatusClass(item.status)}">${escapeHtml(item.status)}</span>
            <span>Round ${item.currentRound || 0}</span>
            <span>${item.messageCount || 0} 条</span>
          </div>
        </button>
      `
    })
    .join('')
}

function renderConsensus(detail) {
  const consensus = detail.consensus || {}
  const opinions = consensus.opinions || {}

  elements.consensusBox.innerHTML = `
    <div class="consensus-main">
      <div class="consensus-item">
        <span class="meta-label">是否达成共识</span>
        <span class="meta-value">${consensus.hasConsensus ? '是' : '否'}</span>
      </div>
      <div class="consensus-item">
        <span class="meta-label">一致度</span>
        <span class="meta-value">${Math.round((consensus.agreementLevel || 0) * 100)}%</span>
      </div>
      <div class="consensus-item">
        <span class="meta-label">平均置信度</span>
        <span class="meta-value">${Math.round((consensus.averageConfidence || 0) * 100)}%</span>
      </div>
    </div>
    <div class="opinion-list">
      <span>Agree: ${opinions.agree || 0}</span>
      <span>Disagree: ${opinions.disagree || 0}</span>
      <span>Neutral: ${opinions.neutral || 0}</span>
      <span>Alternative: ${opinions.alternative || 0}</span>
    </div>
  `
}

function renderRecentMessages(detail) {
  const messages = detail.recentMessages || []

  if (messages.length === 0) {
    elements.recentMessages.innerHTML = '<div class="muted">暂无消息</div>'
    return
  }

  elements.recentMessages.innerHTML = messages
    .slice()
    .reverse()
    .map((msg) => {
      const body = msg.content || msg.decision || msg.error || '-'
      return `
        <article class="message-card">
          <div class="message-head">
            <span class="msg-from">${escapeHtml(msg.from || '-')}</span>
            <span class="msg-type">${escapeHtml(msg.type || '-')}</span>
            <span class="msg-time">${escapeHtml(formatTime(msg.ts))}</span>
          </div>
          <p class="message-body">${escapeHtml(body)}</p>
        </article>
      `
    })
    .join('')
}

function updateFollowupTargets(participants = []) {
  const options = ['<option value="">全部参与者</option>']
  for (const participant of participants) {
    options.push(`<option value="${escapeHtml(participant)}">${escapeHtml(participant)}</option>`)
  }
  elements.followupTarget.innerHTML = options.join('')
}

function renderDetail() {
  const detail = state.detail
  if (!detail || !detail.discussion) {
    elements.emptyState.classList.remove('hidden')
    elements.detailContent.classList.add('hidden')
    return
  }

  const discussion = detail.discussion
  elements.emptyState.classList.add('hidden')
  elements.detailContent.classList.remove('hidden')

  elements.detailTopic.textContent = discussion.topic || discussion.discussionId
  elements.detailStatus.textContent = discussion.status
  elements.detailStatus.className = `badge ${getStatusClass(discussion.status)}`
  elements.detailId.textContent = discussion.discussionId
  elements.detailRound.textContent = String(discussion.currentRound || 0)
  elements.detailParticipants.textContent = (discussion.participants || []).join(', ') || '-'
  const coDevEnabled = Boolean(detail.coDevMode?.enabled)
  elements.detailCodev.textContent = coDevEnabled ? 'ON' : 'OFF'
  elements.modeEnabledInput.checked = coDevEnabled

  updateFollowupTargets(discussion.participants || [])
  renderConsensus(detail)
  renderRecentMessages(detail)
}

async function loadDiscussions() {
  setLoading(true)
  try {
    const data = await request('/api/discussions')
    state.discussions = data.discussions || []

    if (!state.selectedId && state.discussions.length > 0) {
      const queryId = new URLSearchParams(window.location.search).get('discussion')
      state.selectedId = queryId || state.discussions[0].discussionId
    }

    if (
      state.selectedId &&
      !state.discussions.some((item) => item.discussionId === state.selectedId)
    ) {
      state.selectedId = state.discussions[0]?.discussionId || null
    }

    renderDiscussionList()

    if (state.selectedId) {
      await loadDetail(state.selectedId)
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

async function loadDetail(discussionId) {
  state.selectedId = discussionId
  renderDiscussionList()

  try {
    const detail = await request(`/api/discussions/${encodeURIComponent(discussionId)}`)
    state.detail = detail
    renderDetail()
  } catch (err) {
    showToast(err.message, 'error')
  }
}

async function handleFollowupSubmit(event) {
  event.preventDefault()
  if (!state.selectedId) return

  const question = elements.followupInput.value.trim()
  const target = elements.followupTarget.value || null
  if (!question) {
    showToast('请输入追问内容', 'error')
    return
  }

  try {
    await request(`/api/discussions/${encodeURIComponent(state.selectedId)}/followup`, {
      method: 'POST',
      body: JSON.stringify({ question, target })
    })
    elements.followupInput.value = ''
    showToast('追问已发送', 'success')
    await loadDiscussions()
  } catch (err) {
    showToast(err.message, 'error')
  }
}

async function handleModeSubmit(event) {
  event.preventDefault()
  if (!state.selectedId) return

  const enabled = Boolean(elements.modeEnabledInput.checked)
  try {
    await request(`/api/discussions/${encodeURIComponent(state.selectedId)}/mode`, {
      method: 'POST',
      body: JSON.stringify({ enabled })
    })
    showToast(`协作推进模式已${enabled ? '开启' : '关闭'}`, 'success')
    await loadDiscussions()
  } catch (err) {
    showToast(err.message, 'error')
  }
}

async function handleEndSubmit(event) {
  event.preventDefault()
  if (!state.selectedId) return

  const decision = elements.decisionInput.value.trim()
  const consensus = Boolean(elements.consensusInput.checked)

  try {
    await request(`/api/discussions/${encodeURIComponent(state.selectedId)}/end`, {
      method: 'POST',
      body: JSON.stringify({ decision, consensus })
    })
    elements.decisionInput.value = ''
    showToast('讨论已结束', 'success')
    await loadDiscussions()
  } catch (err) {
    showToast(err.message, 'error')
  }
}

async function handleNewDiscussion() {
  const topic = prompt('请输入讨论主题：')
  if (!topic || !topic.trim()) {
    return
  }

  try {
    const result = await request('/api/discussions', {
      method: 'POST',
      body: JSON.stringify({
        topic: topic.trim(),
        participants: ['claude', 'codex']
      })
    })
    showToast('讨论已创建', 'success')
    await loadDiscussions()
    if (result && result.discussionId) {
      state.selectedId = result.discussionId
      await loadDetail(result.discussionId)
    }
  } catch (err) {
    showToast(err.message, 'error')
  }
}

function bindEvents() {
  elements.refreshBtn.addEventListener('click', () => {
    loadDiscussions()
  })

  elements.newDiscussionBtn.addEventListener('click', handleNewDiscussion)

  elements.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-id]')
    if (!button) return
    const discussionId = button.dataset.id
    if (!discussionId) return
    loadDetail(discussionId)
  })

  elements.followupForm.addEventListener('submit', handleFollowupSubmit)
  elements.endForm.addEventListener('submit', handleEndSubmit)
  elements.modeForm.addEventListener('submit', handleModeSubmit)
}

function bootstrap() {
  bindEvents()
  loadDiscussions()
  setInterval(() => {
    if (!state.loading) {
      loadDiscussions()
    }
  }, 8000)
}

bootstrap()
