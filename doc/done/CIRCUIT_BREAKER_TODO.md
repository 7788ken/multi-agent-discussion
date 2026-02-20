# 熔断机制实施计划

## 背景
上次启动了 400+ 个 agent 进程，需要增加熔断机制防止资源爆炸。

## 讨论共识

> 基于 claude 和 codex 的多轮讨论 (Discussion ID: 60449709)，达成以下核心共识：

### 关键发现
1. **Phase 4 应提升到高优先级** - `agent-base.js:285-287` 收到 END 消息后只打印日志返回，timer 不会解绑，导致**永久性资源泄漏**
2. **队列化需要双上限** - 避免"并发爆炸"转成"内存爆炸"
3. **子进程终止应渐进式** - `SIGTERM → 短等待 → SIGKILL` 更稳定
4. **Phase 5 应审慎** - 系统已有 `maxAttempts:3`，全局熔断可能误伤健康讨论

### 修正后的优先级
| 批次 | Phase | 说明 |
|------|-------|------|
| 第一批（立即实施） | 1 + 2 + 4 | 核心防护三件套，防止资源爆炸 |
| 第二批（性能优化） | 3 | 活跃度排序，避免饥饿 |
| 第三批（观察后决策） | 5 | 优先局部熔断，全局熔断作为最后手段 |

---

## 风险分析

### 当前已有保护
| 机制 | 位置 | 作用 |
|------|------|------|
| `responding` 锁 | agent-base.js:28,334 | 防止同一 discussion 并发处理 |
| `respondedRounds` | agent-base.js:27,340 | 防止重复处理同一轮次 |
| `maxAttempts: 3` | agent-base.js:437 | 限制重试次数 |
| PID 检查 | claude-agent.js:182-191 | 防止同 nickname 重复启动 |

### 潜在风险点
| 风险 | 场景 | 当前状态 | 优先级 |
|------|------|----------|--------|
| 多 discussion 并发 | 监控 N 个活跃讨论，每个都触发响应 | ⚠️ 无限制 | 高 |
| 子进程泄漏 | `callClaude`/`callCodex` 超时后 kill 不彻底 | ⚠️ 需验证 | 高 |
| **Timer 永久泄漏** | 收到 END 消息不解绑 timer，持续轮询 | ⚠️ **已确认** | **高** |
| 轮次风暴 | followup 触发快速响应，无间隔控制 | ⚠️ 仅有 100-400ms 延迟 | 中 |
| 内存累积 | `watchedDiscussions`/`respondedRounds` 无清理 | ⚠️ 无上限 | 中 |

---

## 实施任务

### 🔴 Phase 1：全局并发限制 + 队列双上限（高优先级）

**[讨论共识改进]** 使用队列模式 + 双上限设计，避免丢失讨论

- [x] **T1.1** 在 `AgentBase` 构造函数添加并发控制和队列参数
  ```javascript
  this.maxConcurrent = options.maxConcurrent || 5   // 同时处理的最大 discussion 数
  this.maxQueueSize = options.maxQueueSize || 20    // 队列上限
  this.activeCount = 0                               // 当前活跃处理数
  this.responseQueue = []                            // 待处理队列
  ```

- [x] **T1.2** 在 `respondToTrigger` 入口添加队列化逻辑
  ```javascript
  if (this.activeCount >= this.maxConcurrent) {
    if (this.responseQueue.length >= this.maxQueueSize) {
      // FIFO 丢弃最旧的请求
      const dropped = this.responseQueue.shift()
      console.log(`[${this.name}] Queue full, dropping oldest: ${dropped.discussionId}`)
    }
    this.responseQueue.push({ discussionId, round })
    console.log(`[${this.name}] Max concurrent (${this.activeCount}/${this.maxConcurrent}), queued`)
    return
  }
  this.activeCount++
  ```

- [x] **T1.3** 队列按 `discussionId` 去重，避免同一讨论挤满队列
  ```javascript
  // 入队前检查是否已在队列中
  const alreadyQueued = this.responseQueue.some(item => item.discussionId === discussionId)
  if (alreadyQueued) {
    console.log(`[${this.name}] Discussion ${discussionId} already queued, skipping`)
    return
  }
  ```

- [x] **T1.4** 在响应完成（成功/失败）后递减计数并处理队列
  ```javascript
  this.activeCount--
  // 从队列取下一个处理
  if (this.responseQueue.length > 0 && this.activeCount < this.maxConcurrent) {
    const next = this.responseQueue.shift()
    this._processDiscussion(next.discussionId, next.round)
  }
  ```

- [x] **T1.5** 添加 CLI 参数 `--max-concurrent` 和 `--max-queue-size`

**文件**：`lib/agent-base.js`，`bin/claude-agent.js`，`bin/codex-agent.js`

---

### 🔴 Phase 2：子进程渐进式终止（高优先级）

**[讨论共识改进]** 使用 `SIGTERM → 短等待 → SIGKILL` 渐进式终止，并加 `settled` 防重

- [x] **T2.1** 修改 `callClaude` 超时处理（渐进式强杀）
  ```javascript
  let settled = false

  const timer = setTimeout(() => {
    if (settled) return
    settled = true

    console.log(`[${this.name}] Child process timeout, sending SIGTERM...`)
    child.kill('SIGTERM')

    // 3 秒后如果还没退出，强制 SIGKILL
    setTimeout(() => {
      if (!child.killed) {
        console.log(`[${this.name}] Child still alive, sending SIGKILL...`)
        child.kill('SIGKILL')
      }
    }, 3000)

    resolve({ ok: false, error: 'Timeout' })
  }, timeout)

  child.on('close', () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    // ... 正常处理
  })

  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    console.log(`[${this.name}] Child process exited: ${signal || code}`)
  })
  ```

- [x] **T2.2** 修改 `callCodex` 超时处理（同上）

- [x] **T2.3** 添加进程退出指标记录（用于后续监控）

**文件**：`lib/claude-client.js:161-163`，`lib/codex-client.js:160-162`

---

### 🟡 Phase 3：讨论数量上限 + 活跃度排序（中优先级）

**[讨论共识改进]** 按活跃度排序 + 轮转补偿，避免讨论饥饿

- [x] **T3.1** 添加常量和活跃度追踪
  ```javascript
  const MAX_WATCHED_DISCUSSIONS = 50
  this.discussionLastWatched = new Map() // discussionId -> timestamp
  ```

- [x] **T3.2** 修改 `watchAllDiscussions` 实现活跃度排序
  ```javascript
  const discussions = this.discussion.listAll()
    .filter(d => d.status === 'active')
    .map(d => ({
      ...d,
      lastActivity: this.getLastActivity(d.discussionId),  // 新增方法
      lastWatched: this.discussionLastWatched.get(d.discussionId) || 0
    }))
    .sort((a, b) => {
      // 优先级: 最近活跃 > 长时间未监控
      if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity
      return a.lastWatched - b.lastWatched  // 未监控久的优先
    })
    .slice(0, MAX_WATCHED_DISCUSSIONS)
  ```

- [x] **T3.3** 添加日志提示达到上限
  ```javascript
  if (activeDiscussions.length > MAX_WATCHED_DISCUSSIONS) {
    console.log(`[${this.name}] Warning: ${activeDiscussions.length} active discussions, limiting to ${MAX_WATCHED_DISCUSSIONS}`)
  }
  ```

**文件**：`lib/agent-base.js:66-74`

---

### 🔴 Phase 4：状态清理 + Timer 解绑（高优先级）

**[讨论共识关键点]** Timer 永久泄漏是严重问题，必须与 Phase 1+2 同批实施

- [x] **T4.1** 添加 `discussionTimers` 映射追踪
  ```javascript
  this.discussionTimers = new Map() // discussionId -> timerId
  ```

- [x] **T4.2** 在 `watchDiscussion` 中记录 timer
  ```javascript
  const timer = setInterval(...)
  this.timers.push(timer)
  this.discussionTimers.set(discussionId, timer)  // 新增
  ```

- [x] **T4.3** 在 `onNewMessages` 中处理 END 消息时显式解绑 timer
  ```javascript
  if (msg.type === MESSAGE_TYPES.END) {
    console.log(`[${this.name}] Discussion ${discussionId} ended, cleaning up...`)

    // 显式解绑 timer
    const timer = this.discussionTimers.get(discussionId)
    if (timer) {
      clearInterval(timer)
      this.discussionTimers.delete(discussionId)
    }

    // 清理所有相关状态
    this.watchedDiscussions.delete(discussionId)
    this.respondedRounds.delete(discussionId)
    this.pendingRetries.delete(discussionId)
    this.responding.delete(discussionId)

    return
  }
  ```

- [x] **T4.4** 添加定期清理方法 `_cleanupEndedDiscussions`
  ```javascript
  _cleanupEndedDiscussions() {
    for (const [id, _] of this.watchedDiscussions) {
      const status = this.discussion.getStatus(id)
      if (status.status === 'ended' || !status.exists) {
        // 复用 T4.3 的清理逻辑
        this._cleanupDiscussion(id)
        console.log(`[${this.name}] Cleaned up ended discussion: ${id}`)
      }
    }
  }
  ```

- [x] **T4.5** 在 `start()` 中注册清理定时器
  ```javascript
  const cleanupTimer = setInterval(() => {
    if (this.running) {
      this._cleanupEndedDiscussions()
    }
  }, 60000)  // 每分钟清理一次
  this.timers.push(cleanupTimer)
  ```

**文件**：`lib/agent-base.js`

---

### 🟢 Phase 5：局部熔断优先（观察后决策）

**[讨论共识]** 先做局部熔断，收集指标后再决定是否需要全局熔断

- [x] **T5.1** 添加按 discussion 的失败计数（局部熔断）
  ```javascript
  this.discussionFailures = new Map() // discussionId -> failureCount
  this.localCircuitThreshold = 5     // 单个 discussion 连续失败次数
  ```

- [x] **T5.2** 在失败时递增特定 discussion 的失败计数
  ```javascript
  // 失败时
  const failures = (this.discussionFailures.get(discussionId) || 0) + 1
  this.discussionFailures.set(discussionId, failures)

  if (failures >= this.localCircuitThreshold) {
    console.log(`[${this.name}] Local circuit breaker triggered for ${discussionId}`)
    // 暂停该 discussion 的响应一段时间
  }
  ```

- [x] **T5.3** 在成功时重置特定 discussion 的失败计数
  ```javascript
  this.discussionFailures.delete(discussionId)
  ```

- [ ] **T5.4** （可选）收集指标数据后，再评估是否需要全局熔断

**文件**：`lib/agent-base.js`

---

## 验证清单

- [x] 测试并发限制：启动 agent 后发送 10 个 followup，确认最多同时处理 `maxConcurrent` 个
- [x] 测试队列去重：对同一 discussion 快速发送多个 followup，确认队列中只有一个
- [x] 测试队列溢出：发送超过 `maxQueueSize` 个请求，确认 FIFO 丢弃生效
- [x] 测试子进程终止：设置超短 timeout，确认 `SIGTERM → SIGKILL` 渐进式终止
- [x] 测试 Timer 解绑：结束讨论后确认对应 timer 被清除（不再轮询）
- [x] 测试讨论上限：缩规模自动化验证监控上限逻辑（`maxWatchedDiscussions`）
- [x] 测试活跃度排序：确认最近活跃的讨论优先被监控
- [x] 测试状态清理：自动化调用 `_cleanupEndedDiscussions` 验证结束讨论状态可清理
- [x] 测试局部熔断：模拟特定 discussion 连续失败，确认该 discussion 被暂停

### 验证记录（2026-02-20）

- `node --check lib/agent-base.js`
- `node --check lib/claude-client.js`
- `node --check lib/codex-client.js`
- `node --check bin/claude-agent.js`
- `node --check bin/codex-agent.js`
- `node --input-type=module`（自动化烟测：并发上限、队列去重/溢出、Timer 解绑、局部熔断）
- `CLAUDE_BIN=<fake-cli> node --input-type=module`（超时链路：`SIGTERM -> SIGKILL`）
- `CODEX_BIN=<fake-cli> node --input-type=module`（超时链路：`SIGTERM -> SIGKILL`）
- `node --input-type=module`（活跃度排序 + `_cleanupEndedDiscussions` 清理）
- `node --input-type=module`（扫描阶段上限回归：去优先级讨论回收，防止长期运行超上限）

---

## 实施顺序

```
┌─────────────────────────────────────────────────────────┐
│  第一批：核心防护三件套（立即实施，防止资源爆炸）           │
│  ├── Phase 1: 队列双上限 + 去重                          │
│  ├── Phase 2: 渐进式强杀 + settled 防重                  │
│  └── Phase 4: Timer 解绑 + 状态清理                      │
├─────────────────────────────────────────────────────────┤
│  第二批：性能优化（第一批验证后实施）                      │
│  └── Phase 3: 活跃度排序 + 轮转补偿                       │
├─────────────────────────────────────────────────────────┤
│  第三批：观察后决策（收集指标后评估）                      │
│  └── Phase 5: 局部熔断优先，全局熔断作为最后手段           │
└─────────────────────────────────────────────────────────┘
```

---

## 预估工作量

| Phase | 复杂度 | 预估时间 | 优先级 |
|-------|--------|----------|--------|
| Phase 1 | 中 | 45 min | 🔴 高 |
| Phase 2 | 中 | 30 min | 🔴 高 |
| Phase 4 | 中 | 30 min | 🔴 高 |
| Phase 3 | 中 | 30 min | 🟡 中 |
| Phase 5 | 中 | 30 min | 🟢 低 |
| **总计** | | **~3 小时** | |

---

## 参考文档

- Discussion ID: 60449709 - 熔断机制实施计划的必要性和可行性讨论
- 参与者: claude, codex
- 共识轮次: 5 轮讨论后达成全面共识
