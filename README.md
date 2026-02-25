# Multi-Agent Discussion System

一个让 Claude Code 和 Codex CLI 共同讨论问题的命令行工具。

## 功能特性

- **多 Agent 讨论**: 支持 Claude、Codex 和其他 AI agent 参与讨论
- **共享文件通信**: 基于文件轮询，无需额外服务
- **多轮讨论**: 支持追问和连续对话
- **共识分析**: 自动检测意见一致性和置信度
- **讨论摘要**: 生成结构化的讨论总结
- **后台 Agent**: 支持 Claude 和 Codex 后台进程自动响应
- **增强 HTML 界面**: 本地网页管理讨论，支持新建对话框、文件浏览、@ 提及、Agent 并发配置
- **协作推进模式（可开关）**: 基于项目最新改动互评、找风险，并可直接落地小改动后反馈验证结果

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

# 创建讨论并开启协作推进模式
mad new "这个模块下一步怎么改更稳妥?" -p claude,codex --co-dev
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

# 打开本地 HTML 界面（默认端口 5188）
mad ui
mad ui <discussion-id> --port 5188
mad web <discussion-id>  # ui 别名

# 开启/关闭协作推进模式
mad mode <discussion-id> co-dev on
mad mode <discussion-id> co-dev off

# 说明：co-dev 开启后，agent 会结合项目快照给建议，并通常直接提交小范围代码改动（不 commit/push）
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
| `mad mode <id> co-dev <on\|off>` | 切换协作推进模式 |
| `mad tui [id]` | 打开全屏 TUI（讨论列表/状态/消息/快捷操作） |
| `mad ui [id] [--port 5188]` | 打开本地 HTML 界面 |
| `mad web [id] [--port 5188]` | `mad ui` 别名 |

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
| `--co-dev` | 创建讨论时开启协作推进模式 |
| `--no-co-dev` | 创建讨论时关闭协作推进模式（默认） |
| `--port <num>` | UI 服务端口（默认 5188） |
| `--model <model>` | AI 模型 |
| `--nickname <name>` | Agent 昵称 |
| `--interval <ms>` | 轮询间隔 (默认 3000ms) |

## HTML UI 使用指南

### 启动界面

```bash
mad ui              # 启动 UI 服务器（默认端口 5188）
mad ui --port 8080  # 自定义端口
```

### 界面功能

#### 左侧栏 - 讨论列表
- **可折叠侧边栏**: 点击 ☰ 按钮折叠/展开
- **讨论列表**: 显示所有讨论的状态、轮次、消息数
- **新建讨论**: 点击 "+ New discussion" 按钮

#### 中间区 - 消息面板
- **消息流**: 按时间倒序显示最近 20 条消息
- **追问输入框**: 底部输入框发送追问（支持 @ 提及 agent）
- **URL 状态同步**: 刷新后保持当前选中的讨论

#### 右侧栏 - 设置面板（可展开）
点击 ⚙️ 按钮展开设置面板：

1. **讨论信息**: 显示 ID、状态、Co-Dev 模式
2. **共识分析**: 可视化显示一致性、置信度、意见分布
3. **Co-Dev 模式**: 开关协作推进模式
4. **结束讨论**: 输入决策并结束讨论
5. **Agent 设置**:
   - 调整 Claude/Codex 并发限制
   - 点击 "Save & Copy Restart Commands" 自动复制重启命令
   - 在终端粘贴执行即可应用新配置

### 新建讨论对话框

点击 "+ New discussion" 后：

1. **输入话题**: 必填项
2. **选择参与者**: 默认勾选 Claude 和 Codex
3. **Co-Dev 模式**（可选）:
   - 勾选 "Enable Co-Dev Mode" 以在创建时开启协作推进模式
4. **选择项目路径**（可选）:
   - 点击 "Browse" 或输入框浏览文件系统
   - 选择项目根目录
   - Agent 将在该目录下工作（映射到 `workingDir`）
   - 未选择时默认使用启动 `mad ui` 的当前目录
5. **初始消息**（可选）:
   - 输入 `@` 触发文件提及功能
   - 使用方向键选择文件
   - Enter/Tab 确认选择
   - 支持 Ctrl+Enter 快速提交

### API 端点

`mad ui` 启动后提供以下 REST API：

- `GET /api/discussions` - 列出所有讨论
- `GET /api/discussions/:id` - 获取讨论详情
- `POST /api/discussions` - 创建新讨论（body: `{"topic":"...","participants":["claude","codex"],"workingDir":".","coDevMode":{"enabled":true}}`）
- `POST /api/discussions/:id/followup` - 发送追问（body: `{"question": "...", "target": "claude"}`）
- `POST /api/discussions/:id/end` - 结束讨论（body: `{"decision": "...", "consensus": true}`）
- `POST /api/discussions/:id/mode` - 切换模式（body: `{"enabled": true}`）
- `GET /api/settings` - 获取设置
- `POST /api/settings` - 更新设置（body: `{"agentMaxConcurrent": {"claude": 5, "codex": 5}}`）
- `GET /api/files?path=...` - 浏览文件系统
- `GET /api/files/search?path=...&query=...` - 搜索文件
- `POST /api/agents/start` - 启动 agent 进程
- `GET /api/agents/status` - 查询运行中的 agent

### Watch 模式命令

在 watch 模式中（`mad new` 后自动进入）：
- 输入消息直接发送追问
- `s` 或 `status` - 查看当前状态
- `a` 或 `analyze` - 分析共识
- `h` 或 `history` - 查看历史
- `r` 或 `result` - 查看结果文件路径
- `mode co-dev on|off` - 切换协作推进模式
- `end <decision>` - 结束讨论
- `q` 或 `quit` - 退出 watch 模式

### TUI 模式快捷键

在 `mad tui` 模式中：
- `↑` / `↓`（或 `k` / `j`）- 切换讨论
- `r` - 刷新数据
- `a` - 分析当前讨论
- `f` - 输入并发送追问（支持 `@agent`）
- `e` - 输入并结束讨论
- `q` - 退出 TUI

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
| `mode` | 模式切换（如 co-dev on/off） |
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
