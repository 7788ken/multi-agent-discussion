# Multi-Agent Discussion System

一个让 Claude Code 和 Codex CLI 共同讨论问题的命令行工具。

## 功能特性

- **多 Agent 讨论**: 支持 Claude、Codex 和其他 AI agent 参与讨论
- **共享文件通信**: 基于文件轮询，无需额外服务
- **多轮讨论**: 支持追问和连续对话
- **共识分析**: 自动检测意见一致性和置信度
- **讨论摘要**: 生成结构化的讨论总结

## 安装

```bash
cd ~/svn/tools/multi-agent-discussion
npm install
npm link  # 可选：全局安装 mad 命令
```

## 快速开始

### 1. 创建讨论

```bash
# 使用 node 直接运行
node bin/mad.js new "数据库选型：PostgreSQL vs MySQL" -p claude,codex

# 或链接后直接使用
mad new "数据库选型：PostgreSQL vs MySQL" -p claude,codex
```

### 2. 添加响应

```bash
# Claude 响应
mad respond <discussion-id> -f claude -o agree "我推荐 PostgreSQL..." -c 0.8

# Codex 响应
mad respond <discussion-id> -f codex -o alternative "我建议 MySQL..." -c 0.75
```

### 3. 查看讨论

```bash
# 查看状态
mad status <discussion-id>

# 查看完整历史
mad history <discussion-id>

# 分析共识
mad analyze <discussion-id>

# 生成摘要
mad summary <discussion-id>
```

### 4. 追问和结束

```bash
# 追问
mad ask <discussion-id> "考虑到读多写少的场景呢？"

# 结束讨论
mad end <discussion-id> -d "采用 PostgreSQL"
```

## 启动 Codex Agent 后台进程

Codex Agent 是一个后台进程，自动监听讨论并调用 Codex CLI 生成响应。

```bash
# 启动
node bin/codex-agent.js start --nickname codex-1

# 查看状态
node bin/codex-agent.js status

# 停止
node bin/codex-agent.js stop codex-1
```

## 命令参考

### mad CLI

| 命令 | 说明 |
|------|------|
| `mad new <topic> -p <agents>` | 创建新讨论 |
| `mad list` | 列出所有讨论 |
| `mad status <id>` | 查看讨论状态 |
| `mad history <id>` | 查看完整历史 |
| `mad analyze <id>` | 分析共识情况 |
| `mad summary <id>` | 生成讨论摘要 |
| `mad ask <id> <question>` | 发送追问 |
| `mad respond <id> -f <agent> -o <opinion> <content>` | 添加响应 |
| `mad end <id> -d <decision>` | 结束讨论 |
| `mad watch <id>` | 实时监听讨论 |

### codex-agent CLI

| 命令 | 说明 |
|------|------|
| `codex-agent start [options]` | 启动后台进程 |
| `codex-agent stop [nickname]` | 停止进程 |
| `codex-agent status` | 查看运行状态 |

### 选项

| 选项 | 说明 |
|------|------|
| `-p, --participants <list>` | 参与者列表 (逗号分隔) |
| `-f, --from <agent>` | 响应来源 agent |
| `-o, --opinion <type>` | 意见类型: agree/disagree/neutral/alternative |
| `-c, --confidence <num>` | 置信度 (0-1) |
| `-d, --decision <text>` | 最终决策 |
| `--model <model>` | Codex 模型 |
| `--nickname <name>` | Agent 昵称 |

## 文件结构

```
~/.multi-agent/
├── discussions/          # 讨论文件
│   └── <id>.jsonl
├── pids/                 # Agent 进程 PID
└── logs/                 # Agent 日志
```

## 消息格式

讨论文件使用 JSONL 格式，每行一个 JSON 消息：

```json
{"seq":1,"ts":"2026-02-19T14:00:00Z","from":"user","type":"start","topic":"...","participants":["claude","codex"]}
{"seq":2,"ts":"2026-02-19T14:00:05Z","from":"claude","type":"response","round":1,"opinion":"agree","content":"...","confidence":0.8}
{"seq":3,"ts":"2026-02-19T14:00:10Z","from":"codex","type":"response","round":1,"opinion":"alternative","content":"...","confidence":0.7}
```

## 工作流程

```
1. 用户发起讨论
   ↓
2. Claude Code 检测并响应 (手动或自动)
   ↓
3. Codex Agent 检测并响应 (后台进程)
   ↓
4. 用户追问 (可选)
   ↓
5. 重复 2-3
   ↓
6. 达成共识或用户终止
```

## 与 Claude Code 集成

我可以通过以下方式参与讨论：

1. **手动响应**: 使用 `mad respond` 命令
2. **读取讨论**: 使用 `mad history` 或 `mad summary`
3. **分析共识**: 使用 `mad analyze`

示例流程：
```
用户: 发起讨论 "架构设计问题"
我: 读取讨论 → 分析问题 → 使用 mad respond 添加意见
Codex Agent: 自动检测 → 调用 codex exec → 添加意见
用户: 查看双方意见 → 决策
```

## 依赖

- Node.js >= 18
- Codex CLI (可选，用于 Codex Agent)

## License

MIT
