# Multi-Agent Discussion 系统

**状态**: ✅ 已完成

**完成日期**: 2026-02-20

## 完成情况

所有 4 个阶段已完成实现：

| 阶段 | 内容 | 状态 |
|------|------|------|
| Stage 1 | 基础框架 | ✅ 完成 |
| Stage 2 | Codex Agent | ✅ 完成 |
| Stage 3 | 讨论协调 | ✅ 完成 |
| Stage 4 | Claude 集成 | ✅ 完成 |

## 额外实现

在原计划基础上，还实现了：

1. **Claude Agent 后台进程** (`bin/claude-agent.js`)
2. **Watch 模式** - 创建讨论后自动进入交互模式
3. **`mad end all`** - 批量结束所有活跃讨论
4. **无限循环修复** - 添加锁机制和轮次追踪防止死循环
5. **结果文件** - 自动生成 `<id>-result.md` 摘要文件

## Context

用户希望实现 Claude Code 和 Codex CLI 的"群聊"讨论功能：
- 不依赖 ufoo（已卸载/残留）
- 使用共享文件 + 轮询的简单通信方式
- 支持完整的多轮讨论，直到达成共识或用户终止
- 实现位置：`~/svn/tools/multi-agent-discussion/`

## 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    共享文件系统                              │
│                                                              │
│  discussion.jsonl ◄─────────────────────────────────────┐  │
│       │                                                  │  │
│       ▼                                                  │  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │  │
│  │   用户 CLI   │  │ Claude Code  │  │  Codex Agent   │  │  │
│  │  (发起讨论)  │  │  (MCP 工具)  │  │   (后台进程)   │◄─┘  │
│  └──────────────┘  └──────────────┘  └────────────────┘     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. 共享文件格式

**位置**: `~/.multi-agent/discussions/<topic-id>.jsonl`

**消息格式**:
```json
{"seq":1,"ts":"2026-02-19T14:00:00Z","from":"user","type":"start","topic":"API设计","participants":["claude","codex"]}
{"seq":2,"ts":"2026-02-19T14:00:05Z","from":"claude","type":"response","round":1,"opinion":"agree","content":"我认为...","confidence":0.8}
{"seq":3,"ts":"2026-02-19T14:00:10Z","from":"codex","type":"response","round":1,"opinion":"alternative","content":"我建议...","confidence":0.7}
{"seq":4,"ts":"2026-02-19T14:00:15Z","from":"user","type":"followup","content":"Codex 能详细说说你的方案吗？"}
```

### 2. 目录结构

```
~/svn/tools/multi-agent-discussion/
├── bin/
│   ├── mad                    # 主命令
│   └── codex-agent            # Codex 后台进程
├── lib/
│   ├── discussion.js          # 讨论管理器
│   ├── message.js             # 消息格式处理
│   ├── agent-base.js          # Agent 基类
│   ├── claude-client.js       # Claude Code 集成
│   └── codex-client.js        # Codex CLI 集成
├── package.json
└── README.md
```

### 3. Codex Agent 后台进程

**功能**:
- 轮询 `discussion.jsonl` 文件变化
- 检测到新消息时调用 `codex exec`
- 将 Codex 响应追加到文件

**启动方式**:
```bash
mad start-codex [--model gpt-5-codex] [--nickname codex-1]
```

### 4. 讨论 CLI

```bash
# 发起新讨论
mad new "API 设计方案讨论" --participants claude,codex

# 查看讨论状态
mad status <topic-id>

# 发送追问
mad ask <topic-id> "Codex 你能详细说明吗？"

# 结束讨论
mad end <topic-id> --decision "采用 REST 方案"

# 查看讨论历史
mad history <topic-id>
```

## 讨论流程

### 典型交互

```
1. 用户发起讨论
   $ mad new "是否迁移到 GraphQL？" --participants claude,codex
   → 创建 discussion-001.jsonl
   → 写入 start 消息
   → 通知 Claude 和 Codex

2. Claude Code 响应 (我主动参与)
   → 我轮询检测到新讨论
   → 分析问题并给出意见
   → 写入 response 消息

3. Codex Agent 响应 (后台进程)
   → codex-agent 轮询检测到新讨论
   → 调用 codex exec
   → 写入 response 消息

4. 用户追问
   $ mad ask discussion-001 "Codex 你的方案有什么缺点？"
   → 写入 followup 消息
   → 等待响应

5. 多轮讨论继续...

6. 达成共识或用户终止
   $ mad end discussion-001 --decision "暂不迁移，继续使用 REST"
   → 写入 end 消息
   → 归档讨论
```

## 实现计划

### Stage 1: 基础框架

**目标**: 建立共享文件通信机制

**文件**:
- `lib/message.js` - 消息格式定义
- `lib/discussion.js` - 讨论文件管理（创建、追加、轮询）
- `bin/mad` - CLI 入口

**功能**:
- `mad new` - 创建讨论
- `mad status` - 查看状态
- `mad history` - 查看历史

### Stage 2: Codex Agent

**目标**: 实现 Codex 后台进程

**文件**:
- `lib/agent-base.js` - Agent 基类（轮询逻辑）
- `lib/codex-client.js` - Codex CLI 调用封装
- `bin/codex-agent` - 独立进程入口

**功能**:
- 轮询讨论文件
- 调用 `codex exec` 生成响应
- 追加响应到文件

### Stage 3: 讨论协调

**目标**: 实现多轮讨论逻辑

**文件**:
- `lib/coordinator.js` - 讨论协调器
- 更新 CLI 添加 `mad ask`, `mad end`

**功能**:
- 追问机制
- 共识检测
- 讨论归档

### Stage 4: Claude 集成

**目标**: 让我能主动参与讨论

**方式**:
- 创建一个 skill: `/mad` 或 `/discuss`
- 我通过 MCP 工具读写讨论文件
- 自动检测并响应新讨论

## 使用示例

### 场景 1: 架构决策

```bash
# 终端 1: 启动 Codex agent
cd ~/svn/tools/multi-agent-discussion
./bin/codex-agent start

# 终端 2: 发起讨论
./bin/mad new "数据库选型：PostgreSQL vs MySQL" -p claude,codex

# 终端 3: 在 Claude Code 中
# 我会自动检测到讨论并响应

# 追问
./bin/mad ask discussion-001 "考虑到我们的读多写少场景呢？"

# 结束
./bin/mad end discussion-001 -d "采用 PostgreSQL，利用其读性能优势"
```

### 场景 2: 代码审查

```bash
# 发起审查讨论
./bin/mad new "审查 auth.ts 的安全性" -p claude,codex

# 我会先分析代码，然后 Codex 也会给出意见
# 两者对比后，用户做最终决策
```

## 验证方式

```bash
# 1. 测试基础功能
./bin/mad new "测试讨论" -p claude,codex
cat ~/.multi-agent/discussions/*.jsonl

# 2. 测试 Codex agent
./bin/codex-agent start &
sleep 5
# 检查是否有响应写入

# 3. 测试多轮
./bin/mad ask discussion-001 "继续讨论..."
./bin/mad history discussion-001
```

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 文件冲突 | 使用原子写入（rename） |
| 轮询延迟 | 可配置轮询间隔（默认 2s） |
| Codex 超时 | 设置 timeout，失败时写入 error 消息 |
| 讨论无限循环 | 设置最大轮数（默认 5） |

## 时间估算

- Stage 1 (基础框架): 1-2 小时
- Stage 2 (Codex Agent): 2-3 小时
- Stage 3 (讨论协调): 1-2 小时
- Stage 4 (Claude 集成): 1 小时

**总计**: 5-8 小时
