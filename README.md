# dsh-spawn-session

一个 DeepSeek Harness（DSH）插件：让 Agent 在**指定工作区**里新建一个会话并立刻给它发第一条消息，**新会话当场出现在侧边栏对应分组里**——不用刷新、不用重启、不用手点。

## 它解决什么问题

DSH 的侧边栏按「工作区分组」展示会话。用命令行 `dsh --profile headless` 在外部进程里建的会话，宿主的运行态并不知道它，于是只能：

- 掉进「未分组」；
- 或者等重启后扫盘才发现它。

本插件把会话**创建在宿主进程内部**，因此它天然带上归属关系，并且会触发宿主已有的实时广播，所有窗口立刻看到新行。

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
dsh plugin --profile desktop add github:Binghui-H/dsh-dsh-spawn-session
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

## 配置项

在 Profile patch 里针对本插件那一行配置：

```yaml
- id: spawn-session
  name: dsh-spawn-session
  config:
    agentPreset: standard              # 新会话用哪个助手预设
    permissionPreset: spawn-write      # 新会话用哪个权限预设
    fallbackPermissionPreset: workspace-write  # 找不到上面的预设时回退；设 null 则直接报错
```

## 已知边界

- **只覆盖“由 Agent 发起”的会话**。外部命令行创建的会话仍会进入「未分组」。
- 新会话与普通会话完全一致：会出现在侧边栏、可继续对话、可归档，消耗正常 token。
- 插件本身无网络、无文件写入逻辑，权限由被 spawn 的会话按预设决定。

## License

MIT
