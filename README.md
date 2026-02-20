# Multi-Agent Discussion System

一个让 Claude Code 和 Codex CLI 共同讨论问题的命令行工具。

## 功能特性

- **多 Agent 讨论**: 支持 Claude、Codex 和其他 AI agent 参与讨论
- **共享文件通信**: 基于文件轮询，无需额外服务
- **多轮讨论**: 支持追问和连续对话
- **共识分析**: 自动检测意见一致性和置信度
- **讨论摘要**: 生成结构化的讨论总结
- **后台 Agent**: 支持 Claude 和 Codex 后台进程自动响应

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

### 2. 查看讨论

```bash
# 列出所有讨论
mad list

# 查看状态
mad status <discussion-id>

# 查看完整历史
mad history <discussion-id>

# 分析共识
mad analyze <discussion-id>

# 生成摘要
mad summary <discussion-id>
```

### 3. 追问和结束

```bash
# 追问
mad ask <discussion-id> "考虑到读多写少的场景呢？"

# 结束单个讨论
mad end <discussion-id> -d "采用 PostgreSQL"

# 结束所有活跃讨论
mad end all -d "批量结束"
```

## 启动 Agent 后台进程

### Claude Agent

```bash
# 启动
node bin/claude-agent.js start --nickname claude

# 查看状态
node bin/claude-agent.js status

# 停止
node bin/claude-agent.js stop claude
```

### Codex Agent

```bash
# 启动
node bin/codex-agent.js start --nickname codex

# 查看状态
node bin/codex-agent.js status

# 停止
node bin/codex-agent.js stop codex
```

## 命令参考

### mad CLI

| 命令 | 说明 |
|------|------|
| `mad new <topic> -p <agents>` | 创建新讨论（自动进入 watch 模式） |
| `mad new <topic> --no-watch` | 创建讨论但不进入 watch 模式 |
| `mad list` | 列出所有讨论 |
| `mad status <id>` | 查看讨论状态 |
| `mad history <id>` | 查看完整历史 |
| `mad analyze <id>` | 分析共识情况 |
| `mad summary <id>` | 生成讨论摘要 |
| `mad ask <id> <question>` | 发送追问 |
| `mad respond <id> -f <agent> -o <opinion> <content>` | 添加响应 |
| `mad end <id> -d <decision>` | 结束讨论 |
| `mad end all [-d <decision>]` | 结束所有活跃讨论 |
| `mad watch <id>` | 实时监听讨论 |

### Agent CLI

| 命令 | 说明 |
|------|------|
| `<agent>-agent start [options]` | 启动后台进程 |
| `<agent>-agent stop [nickname]` | 停止进程 |
| `<agent>-agent status` | 查看运行状态 |

### 选项

| 选项 | 说明 |
|------|------|
| `-p, --participants <list>` | 参与者列表 (逗号分隔) |
| `-f, --from <agent>` | 响应来源 agent |
| `-o, --opinion <type>` | 意见类型: agree/disagree/neutral/alternative |
| `-c, --confidence <num>` | 置信度 (0-1) |
| `-d, --decision <text>` | 最终决策 |
| `--model <model>` | AI 模型 |
| `--nickname <name>` | Agent 昵称 |
| `--interval <ms>` | 轮询间隔 (默认 3000ms) |

### Watch 模式命令

在 watch 模式中（`mad new` 后自动进入）：
- 输入消息直接发送追问
- `s` 或 `status` - 查看当前状态
- `a` 或 `analyze` - 分析共识
- `h` 或 `history` - 查看历史
- `r` 或 `result` - 查看结果文件路径
- `end <decision>` - 结束讨论
- `q` 或 `quit` - 退出 watch 模式

## 文件结构

```
~/.multi-agent/
├── discussions/          # 讨论文件
│   ├── <id>.jsonl        # 讨论记录
│   └── <id>-result.md    # 讨论结果（可选）
├── pids/                 # Agent 进程 PID
└── logs/                 # Agent 日志
```

## 消息格式

讨论文件使用 JSONL 格式，每行一个 JSON 消息：

```json
{"seq":1,"ts":"2026-02-19T14:00:00Z","from":"user","type":"start","topic":"...","participants":["claude","codex"]}
{"seq":2,"ts":"2026-02-19T14:00:05Z","from":"claude","type":"status","status":"thinking","round":1,"content":"claude is thinking..."}
{"seq":3,"ts":"2026-02-19T14:00:30Z","from":"claude","type":"response","round":1,"opinion":"agree","content":"...","confidence":0.8}
{"seq":4,"ts":"2026-02-19T14:00:35Z","from":"codex","type":"response","round":1,"opinion":"alternative","content":"...","confidence":0.7}
```

### 消息类型

| 类型 | 说明 |
|------|------|
| `start` | 讨论开始 |
| `status` | 状态更新（thinking, retrying 等） |
| `response` | Agent 响应 |
| `followup` | 用户追问 |
| `end` | 讨论结束 |
| `error` | 错误消息 |

## 工作流程

```
1. 用户发起讨论
   ↓
2. Claude Agent 检测并响应（后台进程）
   ↓
3. Codex Agent 检测并响应（后台进程）
   ↓
4. 用户追问（可选）
   ↓
5. 重复 2-3
   ↓
6. 达成共识或用户终止
```

## 故障排除

### Agent 无限循环

如果 Agent 陷入无限调用循环（表现为系统负载飙升）：

1. 立即停止 agent：`node bin/claude-agent.js stop`
2. 结束所有讨论：`mad end all -d "Emergency stop"`
3. 检查日志：`cat ~/.multi-agent/logs/claude-agent-*.log`

### 超时问题

如果频繁超时，可以增加超时时间：

```bash
node bin/claude-agent.js start --timeout 300000  # 5 分钟
```

## 依赖

- Node.js >= 18
- Claude CLI（用于 Claude Agent）
- Codex CLI（用于 Codex Agent）

## License

MIT
