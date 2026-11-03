# dsh-spawn-session

一个 DeepSeek Harness（DSH）插件，提供两个工具：

- **`spawn_session`**：让 Agent 在**指定工作区**里新建一个会话并立刻给它发第一条消息，**新会话当场出现在侧边栏对应分组里**——不用刷新、不用重启、不用手点。
- **`ask_session`**：给一个**已活着**的会话发消息，并可以选择「等它答完直接拿结果」或者「我先干别的，它答完再把我唤醒」。

## 它解决什么问题

DSH 的侧边栏按「工作区分组」展示会话。用命令行 `dsh --profile headless` 在外部进程里建的会话，宿主的运行态并不知道它，于是只能：

- 掉进「未分组」；
- 或者等重启后扫盘才发现它。

本插件把会话**创建在宿主进程内部**，因此它天然带上归属关系，并且会触发宿主已有的实时广播，所有窗口立刻看到新行。

`ask_session` 则解决另一半：会话之间原本无法互相投递消息。插件的唤醒靠宿主自己的 inbox 机制——`agent.followup()` 以 `wakeup: true` 写入 `next-turn`，空闲的 Agent 就会因此开启新一轮。

## 工作原理

一次 `spawn_session` 调用依次做七件事：

| # | 动作 | 调用 |
|---|---|---|
| 1 | 校验绝对路径 | `node:path` |
| 2 | 解析权限预设、助手预设 | `ctx.permissionPresets.resolve()` / `ctx.agentPresets.resolve()` |
| 3 | 找到或创建工作区 | `ctx.workspaceRegistry.create(path)` |
| 4 | **在宿主内创建会话** | `ctx.agents.create({ meta: { cwd, agentPreset } })` |
| 5 | 归属到该分组 | `workspace.attachSession(id)` |
| 6 | 设置权限与标题 | `ctx.permissionPresets.set()` / `ctx.sessionTitle.rename()` |
| 7 | 发送首条消息 | `agent.followup(userMessage)` |

关键在于第 4、5 步：

- 第 4 步触发 `session/created` → 宿主 `emit('api-session/added', summary)` → 广播给所有已连接窗口 → 客户端立刻 upsert 一行；
- 第 5 步修改工作区注册表 → workspace feed 推送 `upsert` 增量帧 → 该行出现在目标分组里。

## 安装

### 1. 把包加进 Profile

```powershell
dsh plugin --profile desktop add dsh-spawn-session
# 或从 GitHub 直装：
dsh plugin --profile desktop add github:Binghui-H/dsh-spawn-session
```

### 2. 登记到 bundles

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，把包名加进 `dsh.profile.bundles`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "…",
      "dsh-spawn-session"
    ]
  }
}
```

### 3. （推荐）添加权限预设

编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，追加：

```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      spawn-write:
        sandbox: workspace-write
        approval: never
        name: spawn-write
        description: 工作区内自由写入，不弹审批（spawn_session 专用）
```

> 注意 `id` 必须是 `permission`（不是 `permission-presets`）。
> 如果你的 Profile 已经自定义过 `presets`，请把 `spawn-write` 合并进现有表，而不是整段覆盖。

省略这一步也能用：插件会回退到 `workspace-write` 并打印警告，但那样新会话可能弹出审批卡片等你点，与「全自动」的初衷相悖。

### 4. 重启一次应用

插件在启动时装载。之后每次 spawn 都不需要再重启。

## 用法

工具签名：

```
spawn_session(
  workspacePath: string,   // 目标工作区的绝对路径
  prompt: string,          // 发给新会话的第一条消息
  title?: string           // 可选标题，默认取 prompt 前 40 字
)
```

返回：

```
Spawned session-xxxx in D:\path\to\workspace (permission: spawn-write).
```

对 Agent 说人话即可，例如：

- 「到 `D:\work\proj-a` 开个会话，让它把日志格式统一一下」
- 「在 cbci 组里新建一个会话，只做代码审查，别改文件」

## 会话间通信：ask_session

```
ask_session(
  sessionId: string,   // 目标会话 id（spawn_session 返回过，或在侧边栏复制）
  prompt: string,      // 发给它的消息
  wait?: boolean,      // 默认 false
  note?: string        // 可选备注，会出现在唤醒消息里
)
```

两种模式：

| 模式 | 行为 | 适合 |
|---|---|---|
| `wait: false`（默认） | 立刻返回 `queued`；目标这一轮结束时，把它的最后回复作为一条新消息投回**调用方会话**，调用方因此被唤醒、开启新一轮 | 长任务；调用方可以先结束当前轮 |
| `wait: true` | 阻塞直到目标 `turn/end`，直接返回 `answered` 和回复内容；超过 `answerTimeoutMs` 先返回 `timeout`，但仍在后台监听，目标真正结束后照样唤醒调用方 | 短任务；需要立刻拿到结果 |

返回：

```
{ sessionId: "session-xxxx", status: "answered" | "queued" | "timeout", reply?: "..." }
```

唤醒消息长这样（前缀固定，便于和真人消息区分）：

```
[dsh-spawn-session] 会话 session-xxxx 已完成。
你的备注：跑一下全量测试
它的最后回复：
测试 128 项全绿，0 失败
```

### 两个约束

1. **只能给「活着」的会话发消息**。`ctx.agents.get()` 拿不到就报错——也就是说，目标必须是由 `spawn_session` 创建的，或者当前正开在界面里的。磁盘上的冷存会话不支持（resume 会与界面里已打开的同 id 会话冲突）。
2. **不能给自己发**，也会被拒绝。

## 配置项

在 Profile patch 里针对本插件那一行配置：

```yaml
- id: spawn-session
  name: dsh-spawn-session
  config:
    agentPreset: standard              # 新会话用哪个助手预设
    permissionPreset: spawn-write      # 新会话用哪个权限预设
    fallbackPermissionPreset: workspace-write  # 找不到上面的预设时回退；设 null 则直接报错
    maxHops: 3                         # 会话互相唤醒的链式深度上限，超过则拒绝
    answerTimeoutMs: 120000            # wait:true 的阻塞预算
    watchTtlMs: 1800000                # 一次移交最多等多久（30 分钟），超时后放弃监听
```

## 已知边界

- **只覆盖“由 Agent 发起”的会话**。外部命令行创建的会话仍会进入「未分组」。
- 新会话与普通会话完全一致：会出现在侧边栏、可继续对话、可归档，消耗正常 token。
- 插件本身无网络、无文件写入逻辑，权限由被 spawn 的会话按预设决定。
- 唤醒消息是一条 **user 消息**，会出现在调用方会话的对话记录里；靠 `[dsh-spawn-session]` 前缀区分。
- 防环靠 `maxHops`（默认 3 跳）：真人发消息会把该会话的链式深度重置为 0，插件自己注入的唤醒消息不会。

## License

MIT
