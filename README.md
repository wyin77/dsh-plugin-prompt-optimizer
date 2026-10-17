# dsh-plugin-prompt-optimizer

DeepSeek Harness 桌面端「提示词优化」插件。在对话框右下角、切换大模型按钮的**左侧**加一个**小星星**按钮：点击后调用**当前会话正在使用的模型**，把输入框里已有的提示词改写得更清晰、更可执行，并写回输入框；首次优化之后，星星左侧会出现一个**重新优化**按钮（螺旋箭头），在原结果基础上再改进一次。

- 客户端不直接访问任何模型供应商：它只通过已有的、已鉴权的 Remote 连接调用宿主端方法。
- 没有任何独立状态：提示词读自当前会话的输入框，写回同一个输入框，其余全部是局部变量。

---

## 一、目录结构

```
dsh-plugin-prompt-optimizer/
├── package.json          # 包清单：DSH 双端入口 + 客户端依赖声明
├── cordis.patch.yml      # 加载器补丁：插入一条 id 为 prompt-optimizer 的条目
├── README.md             # 本文件
└── lib/
    ├── index.js          # 宿主端（Node）：promptOptimizer 服务 + optimize(request, signal) 远程方法
    └── client.js         # 客户端（浏览器）：星星 / 重新优化按钮 + 远程契约声明
```

安装到 DSH 之后，宿主端还会被 pnpm 链接到 profile 的 `node_modules` 下（如
`C:\Users\a2419\.dsh\profiles\desktop\node_modules\dsh-plugin-prompt-optimizer\`），
那里会多出 pnpm 生成的 `.modules.yaml`/锁文件相关内容，以及真实运行需要的 `node_modules`；插件本身仍然只有上面这几个文件。

## 二、安装与启用

本机环境：DeepSeek Harness 桌面版，profile 名 `desktop`。

```powershell
# 用 Harness 自带的 CLI 安装（推荐：会同时写好依赖与 bundle 列表）
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add C:\Users\a2419\.dsh\plugins\dsh-plugin-prompt-optimizer
```

等价的手工方式（本插件当前采用的就是这一种）：把本目录放到
`C:\Users\a2419\.dsh\plugins\dsh-plugin-prompt-optimizer`，然后在
`C:\Users\a2419\.dsh\profiles\desktop\package.json` 里

1. `dependencies` 增加 `"dsh-plugin-prompt-optimizer": "link:C:/Users/a2419/.dsh/plugins/dsh-plugin-prompt-optimizer"`；
2. `dsh.profile.bundles` 数组增加 `"dsh-plugin-prompt-optimizer"`。

> ⚠️ 路径必须是 ASCII。**不要把插件放进带中文的目录再用 `file:`/`link:` 引用**：
> 中文路径在写入 profile 清单时可能被按非 UTF-8 代码页回转，生成无法解析的 JSON，
> 触发 Harness 的原生致命恢复（会把 `cordis.patch.yml` 备份为 `.bak-<毫秒时间戳>`，
> 并把 `dsh.profile.bundles` 重置为只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）。

**宿主端改动需要重启 Harness 才会生效**（加载器的插件集合在启动时组装一次）；
客户端 bundle 改动刷新页面即可。

## 三、功能与交互

| 位置 | 控件 | 行为 |
| --- | --- | --- |
| `conversation.input.right` 插槽（模型切换按钮左侧） | 星星（`IconSparkleMedium`） | 读取当前输入框草稿 → 让当前模型改写 → `inputActions.setDraft()` 写回 |
| 星星左侧（仅首次优化成功后出现） | 重新优化（`IconRefreshOutlineMedium`） | 把已优化文本连同上一版原文一起送给模型，做第二轮改进 |

禁用规则：

- 草稿为空（`draft.trim() === ""`）或正在请求时，星星禁用；
- 输入框处于 `submitting`（正在提交）或 `adjudicating`（正在裁定）阶段时，两个按钮都禁用——这两种阶段 DSH 会拒绝任何草稿写回；
- 重新优化按钮只在 `original` 与 `optimized` 都已记录后渲染（即至少成功优化过一次）。

过程与结果反馈：请求中图标替换为 `IconLoadingOutlineMedium`；成功/失败信息写在根节点的 `title` 上
（`data-prompt-optimizer="idle|running|done|error"` 便于排查）。文案通过 `locale` 命名空间
`prompt-optimizer` 注册，内置 `zh`/`en`。

## 四、交互流程

```
用户在输入框输入草稿
        │ 点击 ✨
        ▼
lib/client.js  PromptOptimizer.run("optimize")
  ├─ useInput(s => s).draft                    ← 读草稿（InputState）
  ├─ sessions.binding(sessionId)
  │    .session.projections.faceOf("modelSelection").getSnapshot()
  │    → snapshot.next ?? snapshot.lastUsed    ← 当前会话正在用的模型
  ├─ remote.promptOptimizer.optimize({ text, kind, provider, model, reasoningEffort, sessionId })
  │        │  （已鉴权的 /api Remote 调用）
  │        ▼
  │   lib/index.js  PromptOptimizerService.optimize(request, signal)
  │     ├─ validateRequest(request)            非空、≤20000 字符、kind ∈ {optimize, refine}
  │     ├─ resolveRoute(ctx, request)          请求里的模型 → Agents 会话请求头 → agent.options
  │     ├─ ctx.get("llm").stream({ provider, model, messages, system, maxTokens: 4000, reasoningEffort?, sessionId?, signal })
  │     └─ 拼接 text-delta，按 finish.kind 映射错误，剥离整体代码围栏，返回 { text, kind, usage? }
  └─ result.ok === true → inputActions.setDraft(value.text)   ← 写回输入框（仍可继续编辑）
                          setOriginal(text) / setOptimized(value.text) → 出现「重新优化」
```

### 请求字段（`request`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | `string` | **必填**，要改写的草稿；空/全空白 → `prompt-optimizer/empty-draft`；超过 20000 字符 → `prompt-optimizer/draft-too-long` |
| `kind` | `"optimize" \| "refine"` | 省略时按 `"optimize"`；其他值 → `prompt-optimizer/invalid-request` |
| `provider` / `model` | `string` | 客户端传入的当前模型；宿主端缺失时按 `sessionId` 回退 |
| `reasoningEffort` | `string` | 可选，随当前模型选择一起透传 |
| `sessionId` | `string` | 可选，用于宿主端解析模型路由 |
| `previous` | `string` | `kind: "refine"` 时由客户端自动带上：上一轮优化前的原文 |
| `note` | `string` | 预留：人工补充的修订要求 |
| `history` | `string` | 预留：会话上下文（仅供改写参考，不会续写） |

### 返回值

成功返回 `{ text: string, kind: "optimize" | "refine", usage?: object }`；
Remote 层把异常包成 `{ ok: false, error: { code, message } }` 返回给客户端。

### 错误码

| 错误码 | 含义 |
| --- | --- |
| `prompt-optimizer/invalid-request` | `request` 不是对象，或 `kind` 非法 |
| `prompt-optimizer/empty-draft` | 草稿为空 |
| `prompt-optimizer/draft-too-long` | 草稿超过 20000 字符 |
| `prompt-optimizer/no-model` | 既没有请求里的 `provider`/`model`，也无法从会话解析出模型 |
| `prompt-optimizer/no-llm` | 宿主端取不到 `llm` 服务 |
| `prompt-optimizer/model-error` | 模型报错（具体码沿用 `finish.failure.code`） |
| `prompt-optimizer/aborted` | 请求被取消 |
| `prompt-optimizer/max-tokens` | 输出触到 `maxTokens` 上限 |
| `prompt-optimizer/empty-result` | 模型返回空文本 |
| `gateway/cancelled` | 网关侧取消（客户端静默处理，不弹错） |

## 五、技术要点

**宿主端暴露远程方法的机制（SRC 反射式 Remote，无需代码生成、无需 zod）：**

1. `optimize` 必须定义在**类的原型**上，且参数只能是**两个普通标识符**、`signal` **必须在最后**——
   网关通过 `Function.prototype.toString()` 解析参数名（中间件拒绝解构、默认值、剩余参数）。
2. 在原型上手工打标：`Object.defineProperty(PromptOptimizerService.prototype, "@deepseek-ai/dsh-typert-protocol/remote-methods", { value: { version: 1, methods: [{ method: "optimize", invocation: { kind: "direct" } }] } })`。
3. 实例上挂协议绑定：`service.typertRemote = Object.freeze({ service, serviceKey: "promptOptimizer", namespace: "promptOptimizer" })`，然后
   `ctx.provide("promptOptimizer", service)`。网关据此认领端点 `promptOptimizer/optimize`。
4. `signal` 是**取消参数**，不算线上字段：网关自己把调用方的 `AbortSignal` 追加为最后一个实参。

**客户端契约**要点（与宿主端一一对应）：

- 客户端 `$mount` 只校验每个参数的 `codec.mode === "strict"`，因此一个六行的
  `{ parse: v => v }` 就足够，**不需要生成 schema，也不需要内联 zod**。
- `parameters` 里**只列业务参数 `request`**；`cancellation: { parameter: "signal" }` 单独声明。
  如果把 `signal` 也写进 `parameters`，`prepareInvocation` 会认为少传一个实参而直接报错。
- 远程命名空间必须先 `$mount` 再注入，且只在**点击时**惰性解析：

  ```js
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
  ctx.inject(["slots", "sessions", "locale", "connection"], (scope) => { /* … */ });
  // 组件内：root.get("remote.promptOptimizer") —— 注册时不能提前捕获
  ```

**LLM 调用的硬性约束（`ctx.llm.stream`）：**

- `purpose` 是 `'compaction' | 'session-title'` 的**封闭联合类型**，本插件**不能传**。
- 采样参数只支持 `temperature` / `maxTokens` / `stop`；`reasoningEffort` 可以传。
- 每次流式调用最后必定有一个终结块 `finish`，失败时 `finish.kind` 为 `error`/`aborted`，需要主动抛错。
- 插件取宿主服务要用 `ctx.get("llm")`（`this.ctx.llm` 在本环境不可用）。

## 六、权限与依赖

- 宿主端被 `ctx.provide` 暴露出去的业务面**只有** `optimize` 一个方法；
- 声明了两个对等依赖：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-llm ^0.2.0-rc.1`；
- 客户端 bundle 只 `require` 平台种子词 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`，
  其余包（locale / api-gateway / connection / ui-conversation）通过 `dsh.client.inject` 声明为启动图边。

## 七、排错清单

| 现象 | 检查点 |
| --- | --- |
| 输入框右侧没有星星 | 宿主端是否加载：`cordis_inspect` 查宿主服务 `promptOptimizer`；客户端查插槽 `conversation.input.right` 的占用者 `id: "prompt-optimizer"` |
| 点击星星报「远程服务尚未就绪」 | 宿主端未注册（多为改完依赖没重启 Harness）；或 `$mount` 失败 |
| 点击报参数数量错（expected N argument(s)） | `parameters` 与 `optimize(request, signal)` 的数量必须对应：**只列 `request`** |
| 应用起不来 | 看 `%TEMP%\dsh-restart.log` / `%TEMP%\dsh-repair.log`，以及 profile 下是否出现新的 `cordis.patch.yml.bak-*`、`package.json.broken-*`（原生致命恢复的痕迹） |
| 改了客户端不生效 | 刷新页面；改的是宿主端则必须重启 |
