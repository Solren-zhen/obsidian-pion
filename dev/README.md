# Pi Agent 开发笔记

## 目录

```
pi-agent/
├── main.js           插件本体（无构建步骤，Obsidian 直接 CommonJS 加载）
├── study-profile.js  学习人格与 skills 的生成（隔离 profile）
├── styles.css        样式（对齐 Pi Desktop 主题 token）
├── manifest.json     Obsidian 插件清单
├── data.json         设置 + 表示会话记录（运行时生成）
└── dev/              离线验证用（不会被 Obsidian 加载）
    ├── minidom.js    最小 DOM + obsidian API 桩
    ├── test.js       事件流回放 + 隔离断言（51 项）
    ├── e2e.js        真跑 pi 子进程的端到端检查
    ├── e2e-study.js  学习模式端到端（人格加载 + 日常 pi 未被触碰）
    └── legacy-data.json  v0.1.0 的真实 data.json 样本（迁移测试用）
```

`dev/` 只是开发工具：它不在 `manifest.json` 里，Obsidian 不会加载。

## 为什么要有它

`main.js` 的绝大部分逻辑是「把 pi 的 NDJSON 事件流翻译成消息列表与 DOM」。
这类代码最容易在**事件顺序**上出错（并行工具调用、思考流、多轮 turn、消息结束时
机），而不是在语法上。所以改完之后跑 `dev/test.js`：它用真实采样到的 pi 事件序列
回放，断言消息结构、diff、分组、持久化纯净度和迁移幂等性。

## 跑验证

```bash
npm run verify      # node --check main.js && node dev/test.js
npm run e2e         # 真实 pi 子进程（会调用模型，消耗 token）
npm run e2e:study   # 学习模式端到端
```

`test.js` 与 `e2e.js` 通过 `Module._resolveFilename` 把 `require('obsidian')` 重定向到
`dev/minidom.js`，因此无需安装 Obsidian 或任何 npm 依赖，只用 Node 内置模块。

改插件后请保持 `npm run verify` 全绿再交付。

## 模式隔离（v0.3.0 核心）

学习与编程共用插件、**不共用任何 pi 状态**：

| | 学习 | 编程 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `<vault>/.obsidian/pi-study` | 继承 shell 环境（即 `~/.pi/agent`） |
| `PI_CODING_AGENT_SESSION_DIR` | `.../pi-study/sessions` | 继承 shell 环境 |
| argv | 额外 `--session-dir` + `--no-skills --skill <study>/skills` | 不动 |
| 面板会话 | `mode:'study'` | `mode:'code'` |

凭据文件用 **symlink** 共享（不复制密钥）。`setupStudyProfile()` 幂等且**从不覆写**
已存在的文件——用户改过 `AGENTS.md` 后不会被打回。

dev/test.js 第 13 节验证：日常 agent 目录未被修改、凭据是 symlink、学习人格与日常隔离、
两种模式的 env 与 argv 互不泄漏。

## 为什么有构建步骤（重要）

Obsidian **只从 release 下载 `main.js` / `manifest.json` / `styles.css` 三个文件**。
如果插件在加载时 `require('./study-profile.js')`，那么在开发 vault 里能跑，
但**从社区目录安装的每个用户都会白屏崩溃**。

所以根目录的 `main.js` 是**生成物**：`dev/build.js` 把 `src/study-profile.js` 内联成
一个 IIFE（顺便解决两个文件都声明 `fs`/`path`/`os` 的重复声明冲突）。
依然没有 bundler、没有依赖，构建脚本只有 ~120 行。

- 改代码 → 改 `src/`，不要改根目录 `main.js`
- 新增模块 → 必须同时改 `dev/build.js`
- `dev/test.js` 第 15 节会在只含那三个文件的临时目录里加载产物，专门拦这个坑

## 关键约定（改代码前必读）

- **工具附着在 assistant 消息上**：`{ role:'assistant', text, thinking, tools:[...] }`。
  不要退回「顶层 tool 消息」的旧结构 —— `dev/test.js` 第 2 节会失败。
- **`message_update` 是增量的**，只带 `delta`；`message_end` 才是权威全文。
  提交消息时必须用 `message_end` 覆盖流式累积值。
- **一条 assistant 消息可以包含多个并行 tool call**：`toolcall_start` 事件本身带
  `id` / `toolName`，必须按 `id` 查找，不能"取最后一个"。
- **`runCommand` 里只有 `views[0]` 是主视图**：它驱动状态机并写入会话；其余视图只重渲染。
  否则开两个面板会把同一条回复写进会话两次。对应地，`abort()` 后
  `_aborted` 是**一次性**标志（用 `theAbortFlag()` 读取并复位），避免状态泄漏到下一次运行。
- **子进程 stdin 必须是 `ignore`**：否则非交互式 `pi -p` 会等待 stdin 挂起。
- **`data.json` 只写白名单字段**：`serializeSettings()` 负责剥离 DOM 引用。往消息对象
  上挂 `_xxx` 字段是允许的（运行时用），但不能直接 `saveData(this.settings)`。
- **迁移必须幂等**：`migrateConversations()` 每次加载都会跑，第二次不能改变结果；
  且 v5 之前的数据没有 `mode`，必须归一为 `'code'`（老会话属于编程，不是学习）。
- **每个模式至少保留一个会话**：`deleteConversation()` 删空某模式时要补一个，
  否则 `conversation` getter 会造出无主的会话。
- **不要往 vault 根写学习人格**：`AGENTS.md` 会被日常 pi 向上遍历扫到，违背隔离目标。

## 与 pi 的接口

```
pi --mode json -p --session-id <uuid> [--provider P] [--model M] \
   [--thinking L] [--tools a,b] [--append-system-prompt S] [--name N] "<prompt>"
```

事件类型见 pi 文档 `docs/json.md`：`session` / `agent_start` / `turn_start` / `turn_end` /
`message_start|update|end` / `tool_execution_start|update|end` / `agent_end` / `agent_settled`。
