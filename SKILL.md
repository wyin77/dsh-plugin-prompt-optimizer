---
name: dsh-plugin-prompt-optimizer
description: 维护、安装、自检与打包 DSH 桌面端「提示词优化」插件（包名 dsh-plugin-prompt-optimizer，version 0.1.0，安装 profile 名 desktop）。它在对话框右下角、大模型切换按钮左侧加一个星星按钮：用当前会话正在使用的模型就地改写输入框草稿并写回；首次优化成功后，星星左侧出现「重新优化」按钮。用于改动宿主半 lib/index.js 或客户端半 lib/client.js、调整加载器补丁 cordis.patch.yml、把插件安装进 DSH profile、运行 tools/verify.mjs 做加载期自检，或用 tools/pack-to-D-AI.ps1 打包到 D:\AI。
---

# dsh-plugin-prompt-optimizer

DSH（DeepSeek Harness）桌面端「提示词优化」插件。客户端不直接访问任何模型供应商：它只通过已有的、已鉴权的 Remote 连接调用宿主端方法。插件没有独立状态——提示词读自当前会话的输入框，写回同一个输入框，其余全部是局部变量。

- 宿主端暴露的远程方法只有 `promptOptimizer/optimize(request, signal)` 一个（`lib/index.js`）。
- 客户端占用 `conversation.input.right` 列表槽位，因此星星天然渲染在模型切换按钮左侧（`lib/client.js`）。

## 何时加载本 skill

- 修改宿主半 `lib/index.js`：Remote 方法、模型路由、`ctx.get("llm").stream` 调用、错误码。
- 修改客户端半 `lib/client.js`：槽位组件、远程契约声明、按钮禁用规则、locale 文案、CSS。
- 调整加载器补丁 `cordis.patch.yml` 或包清单 `package.json`（双端入口 / `dsh.client.inject`）。
- 把插件安装、启用到 DSH profile，或排查「输入框右侧没有星星」「远程服务尚未就绪」。
- 运行 `tools/verify.mjs` 做加载期自检（不需要启动 DSH）。
- 用 `tools/pack-to-D-AI.ps1` 把插件打包到 `D:\AI`，并带上 `demo.html`。

## 实际文件清单

| 路径 | 角色 |
| --- | --- |
| `package.json` | 包清单：DSH 双端入口（`.` → `lib/index.js`，`./client` → `lib/client.js`）、`dsh.bundle.patch`、`dsh.client` 注入列表、`engines.node >= 22`、两个 peerDependencies |
| `cordis.patch.yml` | 加载器补丁：`- insert:` 一条 `id: prompt-optimizer`、`name: dsh-plugin-prompt-optimizer` 的条目 |
| `lib/index.js` | 宿主端（Node）：`promptOptimizer` 服务 + `optimize(request, signal)` 远程方法 |
| `lib/client.js` | 客户端（浏览器 bundle）：星星 / 重新优化按钮 + 远程契约声明 + zh/en 文案 + CSS |
| `README.md` | 主文档（中文）：目录结构、安装与启用、功能与交互、交互流程、技术要点、权限与依赖、排错清单 |
| `tools/verify.mjs` | 加载期自检脚本：校验宿主半的 SRC 契约与一次真实调用，并在 stub loader + `node:vm` 沙箱里执行客户端半 |
| `tools/pack-to-D-AI.ps1` | 打包脚本：把插件目录压成 `D:\AI\dsh-plugin-prompt-optimizer.zip`，并把 `demo.html` 复制为 `D:\AI\dsh-plugin-prompt-optimizer-demo.html` |
| `demo.html` | 自包含演示页（无外部依赖、无需联网）：交互演示 + 优化前/后对比 + 流程说明 + 契约表；内含静态示例，不调用任何模型 |

> 注意：`README.md` 的「一、目录结构」只列了 `package.json`、`cordis.patch.yml`、`README.md`、`lib/index.js`、`lib/client.js`，并未列出 `tools/` 与 `demo.html`；`package.json` 的 `files` 数组也只有 `lib`、`cordis.patch.yml`、`package.json`。文档缺口详见最后一节。

## 宿主半契约（lib/index.js）

- 导出：`export const name = "promptOptimizer";` 与 `export function apply(ctx)`；`apply` 里 `ctx.provide("promptOptimizer", service)`，并给实例挂 `service.typertRemote = Object.freeze({ service, serviceKey: "promptOptimizer", namespace: "promptOptimizer" })`。
- 手写 SRC Remote 标记（打标在**类的原型**上）：

  ```js
  Object.defineProperty(PromptOptimizerService.prototype, "@deepseek-ai/dsh-typert-protocol/remote-methods", {
    configurable: true,
    value: { version: 1, methods: [{ method: "optimize", invocation: { kind: "direct" } }] },
  });
  ```

- 方法与参数（**硬性**）：`async optimize(request, signal)` 必须定义在类的原型上，参数只能是两个普通标识符，`signal` 必须在最后——网关通过 `Function.prototype.toString()` 解析参数名，中间件拒绝解构、默认值、剩余参数。`signal` 是取消参数，不算线上字段。
- 常量：`MAX_DRAFT_CHARS = 20000`、`MAX_OUTPUT_TOKENS = 4000`。
- 模型路由 `resolveRoute(ctx, request)`：请求里的 `provider`/`model`/`reasoningEffort` → `agent.session.requestHeader()?.config` → `agent.options`；两者都拿不到时抛 `prompt-optimizer/no-model`。
- 调用 LLM：`this.ctx.get("llm")`（本环境 `this.ctx.llm` 不可用），取不到 `llm.stream` 时抛 `prompt-optimizer/no-llm`；参数为
  `{ provider, model, messages, system, maxTokens: 4000, reasoningEffort?, sessionId?, signal? }`。
- 流式处理：拼接 `text-delta`，记录终结块 `finish` 与 `usage`；按 `finish.kind` 映射 `error` / `aborted` / `max-tokens`；对结果 `trim()`，若整体被 ``` 围栏包住则剥离；空结果抛 `prompt-optimizer/empty-result`；返回 `{ text, kind }`（有 usage 时附带 `usage`）。

### 请求字段（`request`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | `string` | **必填**，要改写的草稿；空/全空白 → `prompt-optimizer/empty-draft`；超过 20000 字符 → `prompt-optimizer/draft-too-long` |
| `kind` | `"optimize" \| "refine"` | 省略时按 `"optimize"`；其他值 → `prompt-optimizer/invalid-request` |
| `provider` / `model` | `string` | 客户端传入的当前模型；宿主端缺失时按 `sessionId` 回退 |
| `reasoningEffort` | `string` | 可选，随当前模型选择一起透传 |
| `sessionId` | `string` | 可选，用于宿主端解析模型路由 |
| `previous` | `string` | `kind: "refine"` 时由客户端自动带上：上一轮优化前的原文 |
| `note` | `string` | 预留：人工补充的修订要求（宿主端已读取，客户端从不发送） |
| `history` | `string` | 预留：会话上下文（仅供改写参考，不会续写；宿主端已读取，客户端从不发送） |

### 返回值与错误码

成功返回 `{ text: string, kind: "optimize" | "refine", usage?: object }`；Remote 层把异常包成 `{ ok: false, error: { code, message } }` 返回给客户端。

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

## 客户端半契约（lib/client.js）

- 以 `window.__ModuleLoader__.load({ id: "dsh-plugin-prompt-optimizer", factory })` 注册，**没有顶层 `import`/`export`**；只 `require` 平台种子词 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`。
- 槽位：`SLOT = "conversation.input.right"`，条目 `id: "prompt-optimizer"`，`order: 40`（`ENTRY_ID = "prompt-optimizer"`、`NS = "prompt-optimizer"`）。
- 图标取官方 primitives：`IconSparkleMedium`（星星）、`IconRefreshOutlineMedium`（重新优化）、`IconLoadingOutlineMedium`（请求中）。
- 禁用规则：
  - 草稿为空（`draft.trim() === ""`）或正在请求（`status === "running"`）时，星星禁用；
  - 输入框处于 `submitting`（正在提交）或 `adjudicating`（正在裁定）阶段时，两个按钮都禁用——这两种阶段 DSH 会拒绝任何草稿写回；
  - 重新优化按钮只在 `original` 与 `optimized` 都已记录后渲染（即至少成功优化过一次）。
- 状态与反馈：根节点 `data-prompt-optimizer="idle|running|done|error"`，成功/失败信息写在根节点 `title` 上；文案注册在 locale 命名空间 `prompt-optimizer`，内置 `zh`/`en` 两套字典。
- 当前模型读法：`sessions.binding(sessionId).session.projections.faceOf("modelSelection").getSnapshot()` 的 `next ?? lastUsed`。
- 写回：`result.ok === true` 时 `inputActions.setDraft(value.text)`；`kind === "optimize"` 时记录 `original`，每次成功都记录 `optimized`。
- `gateway/cancelled` 静默处理：状态回到 `idle`、清空消息，不报错。
- 远程契约：`parameters` 里**只列业务参数 `request`**，`cancellation: { parameter: "signal" }` 单独声明。若把 `signal` 也写进 `parameters`，`prepareInvocation` 会认为少传一个实参而直接报错。客户端 `$mount` 只校验每个参数的 `codec.mode === "strict"`，因此 `create: () => ({ parse: (value) => value })` 即足够，不需要生成 schema、不需要内联 zod。
- 挂载顺序：`await ctx.remote.$mount(TYPERT_REMOTE)` 之后再 `ctx.inject(["slots", "sessions", "locale", "connection"], …)`；`remote.promptOptimizer` 只在**点击时**通过 `root.get("remote.promptOptimizer")` 惰性解析，注册时不能提前捕获。
- 导出形状：`exports.inject = ["remote", "slots", "locale", "sessions", "connection"]`，`exports.apply = async function apply(ctx)`，并在 `ctx.effect(...)` 里挂 dispose。
- CSS：一个幂等的 `<style data-plugin-css="dsh-plugin-prompt-optimizer/PromptOptimizer.module.css">` 标签，类名 `DshPo_root` / `DshPo_btn`，只使用 `--dsw-*` token。

## 安装与启用

本机环境：DeepSeek Harness 桌面版，profile 名 `desktop`。

```powershell
# 用 Harness 自带的 CLI 安装（推荐：会同时写好依赖与 bundle 列表）
& "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add C:\Users\a2419\.dsh\plugins\dsh-plugin-prompt-optimizer
```

等价的手工方式（本插件当前采用的就是这一种）：把本目录放到 `C:\Users\a2419\.dsh\plugins\dsh-plugin-prompt-optimizer`，然后在 `C:\Users\a2419\.dsh\profiles\desktop\package.json` 里

1. `dependencies` 增加 `"dsh-plugin-prompt-optimizer": "link:C:/Users/a2419/.dsh/plugins/dsh-plugin-prompt-optimizer"`；
2. `dsh.profile.bundles` 数组增加 `"dsh-plugin-prompt-optimizer"`。

路径必须是 ASCII。不要把插件放进带中文的目录再用 `file:`/`link:` 引用：中文路径在写入 profile 清单时可能被按非 UTF-8 代码页回转，生成无法解析的 JSON，触发 Harness 的原生致命恢复（会把 `cordis.patch.yml` 备份为 `.bak-<毫秒时间戳>`，并把 `dsh.profile.bundles` 重置为只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）。

生效规则：**宿主端改动需要重启 Harness 才会生效**（加载器的插件集合在启动时组装一次）；客户端 bundle 改动刷新页面即可。

## 自检（tools/verify.mjs）

不需要启动 DSH 就能跑。仓库里没有声明任何 npm script，README 也没有记录这条命令；按 `package.json` 的 `engines.node >= 22` 用 Node 直接执行这个 ESM 脚本：

```powershell
node tools/verify.mjs
```

它检查两半：

- 宿主半：`import lib/index.js` → `name`/`apply` 形状、`apply` 只 `provide("promptOptimizer")`、`service.typertRemote` 绑定、SRC 标记（`version === 1`、`optimize` 为 `direct`）、`optimize` 的参数名恰为 `request,signal`、一次真实调用返回拼接文本、请求里不含封闭联合 `purpose`，以及 `empty-draft` / `invalid-request` / `no-model` 三个错误码。
- 客户端半：读取 `lib/client.js` 源码（确认 loader id、无顶层 import/export），在 `node:vm` 沙箱里以 stub loader 执行，再检查 `{ inject, apply }` 形状、注入列表、`$mount` 收到的 descriptor（endpoint `remote.promptOptimizer`、`cancellation.parameter === "signal"`、每个 codec 都是 `strict` 且可 `create().parse`）、槽位注册的 id 与 service 注入函数。

全部通过时打印 `ALL CHECKS PASSED` 并以 0 退出；否则打印 `<n> CHECK(S) FAILED` 并以 1 退出。

## 打包（tools/pack-to-D-AI.ps1）

脚本头注释给出的用法（源目录写死为 `$env:USERPROFILE\.dsh\plugins\dsh-plugin-prompt-optimizer`，目标写死为 `D:\AI`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\plugins\dsh-plugin-prompt-optimizer\tools\pack-to-D-AI.ps1"
```

- 先检查 4 个必需文件：`package.json`、`cordis.patch.yml`、`lib\index.js`、`lib\client.js`；缺一个就以 1 退出。
- 递归复制到 `D:\AI\.zip.parts\dsh-plugin-prompt-optimizer\`（暂存目录保留，供检查），再基于暂存目录建 zip，压缩包内根目录名就是 `dsh-plugin-prompt-optimizer/`。
- 建完 zip 后解压到临时目录逐文件比对，结构与暂存不一致就报 ERROR。
- 复制 `demo.html` → `D:\AI\dsh-plugin-prompt-optimizer-demo.html`，并检查首行是否 `<!DOCTYPE html>`（否则只 WARN）。
- 产物：`D:\AI\dsh-plugin-prompt-optimizer.zip`、`D:\AI\dsh-plugin-prompt-optimizer-demo.html`、`D:\AI\.zip.parts\`；日志 `%TEMP%\dsh-pack.log`；退出码 0 = OK（且结构校验通过），1 = 前置条件失败，2 = FAILED。
- 脚本头注释说明了它存在的原因：编写它的 agent 运行时无法 spawn 任何子进程（pwsh → `spawn ...powershell.exe ENOENT`），因此不能自己调用 zip 工具，只能由该脚本完成并自校验。

## 易错点（改代码前先看）

- `ctx.llm.stream` 的 `purpose` 是 `'compaction' | 'session-title'` 的封闭联合类型，本插件**不能传**；采样参数只支持 `temperature` / `maxTokens` / `stop`，`reasoningEffort` 可以传；每次流式调用最后必定有一个终结块 `finish`。
- 宿主服务要用 `ctx.get("llm")` 取，`this.ctx.llm` 在本环境不可用。
- `optimize` 的参数名/个数被网关按源码文本解析：改签名会让 Remote 端点整个失效，`tools/verify.mjs` 会因此失败。
- 客户端 `parameters` 只列 `request`；把 `signal` 列进去会报参数数量错（expected N argument(s)）。
- 客户端远程命名空间必须先 `$mount` 再注入，且只能在点击时解析。

## 排错

| 现象 | 检查点 |
| --- | --- |
| 输入框右侧没有星星 | 宿主端是否加载：`cordis_inspect` 查宿主服务 `promptOptimizer`；客户端查插槽 `conversation.input.right` 的占用者 `id: "prompt-optimizer"` |
| 点击星星报「远程服务尚未就绪」 | 宿主端未注册（多为改完依赖没重启 Harness）；或 `$mount` 失败 |
| 点击报参数数量错（expected N argument(s)） | `parameters` 与 `optimize(request, signal)` 的数量必须对应：**只列 `request`** |
| 应用起不来 | 看 `%TEMP%\dsh-restart.log` / `%TEMP%\dsh-repair.log`，以及 profile 下是否出现新的 `cordis.patch.yml.bak-*`、`package.json.broken-*`（原生致命恢复的痕迹） |
| 改了客户端不生效 | 刷新页面；改的是宿主端则必须重启 |

## 现有信息缺口与不一致（未在仓库中解决的问题）

- 本文件是新增的：仓库此前没有任何 `SKILL.md`，也没有关于 skill frontmatter 的约定；`name` / `description` 的形式参考的是 DSH 内置 skill 的写法。
- 没有构建、测试或 lint 入口：`package.json` 没有 `scripts` 字段；除 `tools/verify.mjs` 之外没有其他测试，也没有 CI 配置。
- 文档与打包清单不完整：`README.md` 的目录结构漏掉 `tools/verify.mjs`、`tools/pack-to-D-AI.ps1`、`demo.html`；`package.json` 的 `files` 只有 `lib`、`cordis.patch.yml`、`package.json`（同样不含 `README.md`、`tools/`、`demo.html`）——按 npm 语义发布时会丢文件，`pack-to-D-AI.ps1` 用递归复制所以不受影响。
- 错误码不一致：`README.md` 与 `lib/client.js` 用的是 `gateway/cancelled`，而 `demo.html` 的契约表写的是 `gateway/internal`；宿主没定义这两个码，只是透传网关失败码。
- 缺少常规包元数据：没有 `license`、没有 `repository`；`version` 为 `0.1.0`，`private: true`。
- 机器相关路径写死：README 的安装路径（`C:\Users\a2419\...`）、CLI 路径（`D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`）与打包脚本的 `D:\AI` 都绑定当前机器，换机器需要替换。
- `request.note` / `request.history` 在 README 中标为「预留」，但宿主端 `lib/index.js` 已经读取它们（拼成 `REVISION NOTES:` / `CONVERSATION SO FAR (context only; do not continue it):`）；客户端从不发送，因此当前实际不会触发。
- `demo.html` 的「优化结果」是页面内置的静态样例（`SAMPLES` / `FALLBACK`），不是真实模型输出；页面自己也注明「真实行为以 DSH 运行时为准」。
