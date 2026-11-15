# 实现：dsh-vcs-panel

本文记录实现契约：Host 路由、输入校验、命令执行、后端接口、数据形状、
Client 构建与状态、图布局，以及复用与来源。

## Host

### 注册与路由

Host 半是普通 Node 插件：

```js
export const inject = ['connection', 'sessions', 'subprocess', 'fs']
```

`apply` 读取 `normalizeConfig`，只有字面量 `enabled: false` 关闭；关闭时不注册任何路由。
这是 Host 路由开关；移除页签要在 Plugins 里关闭 bundle。
六条路由都是 GET，通过 `ctx.connection.fetch.register` 注册在 DSH 的认证栅栏内。
插件生命周期由一个 `AbortController` 管理，请求 signal 与它组合；取消的请求保留 `AbortError`，
不转成 JSON 错误。

| 路由 | 查询 | 应答 |
| --- | --- | --- |
| `GET /api/vcs.repositories` | `sessionId` | `cwd`、`repositories[]`（含 `vcs` 与 `capabilities`）、`truncated` |
| `GET /api/vcs.status` | `sessionId`、`repo` | `repo`、`vcs`、`capabilities`，以及后端的 `branch`/`workingCopy`、`groups`、`total`、`truncated`、`defaultNode` |
| `GET /api/vcs.untracked` | `sessionId`、`repo`、`path`（以 `/` 结尾） | `path`、`entries[]`、`truncated` |
| `GET /api/vcs.diff` | `sessionId`、`repo`、`scope`、`path`、`oldPath?`、`rev?` | `VcsFileDiff` |
| `GET /api/vcs.log` | `sessionId`、`repo`、`ref`、`limit`、`skip` | `commits[]`、`truncated`、`nextSkip` |
| `GET /api/vcs.commit` | `sessionId`、`repo`、`sha` | `commit`（元数据与 `files[]`）、`truncated`；不含 patch |

`vcs.untracked` 只在后端的 `untracked` 能力为真时可用。
数值上限见“上限”一节。

### 请求校验与仓库发现

- `sessionId` 必须命中 `ctx.sessions.get`，并带有字符串 `header.cwd`；否则返回 `no-session` / `no-cwd`。
- `repo` 必须命中 `discoverRepositories` 的结果（`sameRepoPath`），不能只凭请求字符串打开目录。
- 仓库标记来自 `VCS_BACKENDS`：`.jj`（Jujutsu）优先于 `.git`；`lstat` 检查标记，不跟随最终组件，
  因此 linked worktree 的 `.git` 文件与 submodule 也能发现。
- 从工作目录向上最多 64 层找最近的标记；再扫描工作目录下一层带标记的子目录，忽略 `node_modules`，
  不递归；结果按 `REPOSITORY_MAX` 截断。
- 所有返回的根路径先经 `ctx.fs.resolve` + `processPath` 规范化；子目录的 canonical path 必须仍在工作目录内，
  符号链接不能扩大白名单。
- `validateRelPath` 拒绝绝对路径、反斜杠、空段、`.`、`..`、`-` 开头以及控制字符。
  Git 侧再包一层 `:(literal)` pathspec，Jujutsu 侧用 `file:"..."` fileset，避免路径被解释成选项或通配。
- 提交 id 先按 7–64 位十六进制校验；Git 用 `rev-parse --verify <sha>^{commit}` 解析为完整 id 后才继续；
  Jujutsu 只接受 `@` 或十六进制 id。
- 文件读取前用 `containPath` 在组合文件系统上 `realpath`，并要求结果位于仓库根内。

错误统一为 `{ error: { code, message } }`，`message` 不携带宿主绝对路径、原始命令或堆栈：

| code | HTTP |
| --- | --- |
| `bad-request` | 400 |
| `no-session` / `no-cwd` | 409 |
| `not-a-repo` | 400 |
| `not-found` | 404 |
| `vcs-missing` | 503 |
| `timeout` | 503 |
| `output-too-large` | 413 |
| `internal` | 500 |

### 命令执行

两个后端共用一个 `CommandRunner`（`lib/command.js`）：

- argv 由调用方用固定字符串与已验证值拼成，不经过 shell。
- 环境清理为 `LC_ALL=C`，各后端再声明可继承的变量；仓库自身配置不能重定向输出、打开编辑器或取锁。
- 单条命令 30 s 截止；stdout 上限 8 MB；stderr 只保留尾部 16 KB；终止宽限 2 s。
  stdout 超限通过 `lossy` 报告，转成 `output-too-large`，不悄悄截断。
- Git 固定 `-c core.quotepath=false`，环境为 `GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、
  `GIT_OPTIONAL_LOCKS=0`；比较调用点再加 `--no-pager`、`--no-ext-diff`、`--no-color`、`-U3`
  与 literal pathspec。
- Jujutsu 固定 `--color=never`、`--no-pager`，环境为 `JJ_EDITOR=true`；
  除快照外的读取都带 `--ignore-working-copy`。

### 后端接口与能力

每个后端实现 `require`、`status`、`log`、`commit`、`diff`，可选实现 `untracked`，并暴露 `capabilities`。
新增后端只需注册标记、实现这些方法与能力对象；Client 不按后端名称分支。

| 能力 | Git | Jujutsu |
| --- | --- | --- |
| `workingCopy` | `row` | `commit` |
| `workingCopyNode` | `null` | `@` |
| `staging` | `true` | `false` |
| `untracked` | `true` | `false` |
| `changeId` | `false` | `true` |
| `aheadBehind` | `true` | `false` |
| `snapshots` | `false` | `true` |
| `ranges` | `HEAD` / `all` | `@` / `all` |
| `defaultRange` | `HEAD` | `@` |

### 两个后端的读取差异

Git：

- status 由 `git status --porcelain=v2 -z --branch --untracked-files=normal` 与两次 `diff --numstat -z`
  （index 与工作区）组成；按 XY 拆成 staged/unstaged/untracked。同一文件两侧都改时两组各出现一次；
  冲突两侧都为 `U`。
- diff 的 `scope`：`staged` 对 `HEAD`，`unstaged` 对 index，`untracked` 按新文件合成，
  `commit` 对第一父提交（root 对空树）。重命名同时给 `oldPath` 与 `path`；只给一个路径按新增或删除读取。
- log 用 `--topo-order --decorate=full`，字段以 NUL 分隔；空仓库的 `HEAD` 读取当成空历史而不是失败。
- commit 用 `show -s` 取元数据；`diff-tree` 对 merge 用第一父，对 root 用 `--root`。
- Git 的 `Binary files differ`、numstat 的 `-`、超过字节/行数上限分别归为 `binary` / `oversized`。

Jujutsu：

- 读取先快照：`jj log --no-graph -r @ -T commit_id` 在每次刷新（status）执行一次；
  其他读取复用结果并带 `--ignore-working-copy`；并发快照共享同一个 promise，失败时清掉缓存。
- status 返回 `workingCopy`（提交 id、变更 id、父提交、refs、subject、作者/时间、empty/conflict、summary）
  与 `defaultNode: '@'`；没有 staged/unstaged/untracked 分组。
- log 用 `::@ ~ root()` 或 `all() ~ root()`，模板每行输出一个 JSON 对象。
- commit/diff 用 Jujutsu 模板输出 JSON；diff 用 `jj diff --git -r <rev>`，文件集用 `file:"..."`；
  提交内不存在的文件返回 `not-found`。
- Jujutsu 的 `--git` 输出可能包含 NUL 或 U+FFFD；任一出现即按二进制处理。

## 上限

这些是当前实现的上限。数据超限时返回 `oversized`、`truncated` 或截断提示；命令超时或超限返回结构化错误。

| 项目 | 上限 | 执行位置 |
| --- | --- | --- |
| 每个会话列出的仓库 | 50 | 仓库发现 |
| 每组状态文件数（Git） | 500 | status |
| 每个提交详情的文件数 | 500 | commit |
| 展开未跟踪目录的条目（Git） | 500 | untracked |
| 单文件渲染的 diff 行数 | 5,000 | Host diff；`FileDiff` 的 `MAX_RENDERED_LINES` |
| 默认展开的 diff | 单文件不超过 1,000 行改动；每个节点累计到 20,000 行 | Client `defaultFolds` |
| 变更树行高 | 28px（分组、目录、文件统一） | `.vcs-tree` |
| 左右对比的单栏回退宽度 | 640px | Client `SPLIT_MIN_WIDTH` |
| 同时进行的 diff 请求 | 4 | Client 请求队列 |
| diff 输出 | 2 MB | Host diff |
| 每页提交 | 300 | log |
| 最多加载提交 | 10,000 | log |
| 单次后端命令 | 30 秒，stdout 8 MB | `CommandRunner` |
| Jujutsu 快照 | 每次刷新一次 | Jujutsu 后端 |

变更树目前不虚拟化行：所有可见行一次渲染，diff 本体按需加载。数百个文件全部收起时的滚动表现见 `TODO.md`。

## 数据形状

```ts
type RefKind = 'head' | 'branch' | 'bookmark' | 'remote' | 'tag'
// Git：current 表示 HEAD 指向的分支（`HEAD -> main`），分离头指针时才有 head
// Jujutsu：本地书签为 bookmark，远程书签为 remote（名字形如 main@origin）
type Ref = { name: string; kind: RefKind; current?: true; conflict?: true }

type CommitNode = {
  sha: string
  changeId?: string // Jujutsu：稳定的变更 ID
  parents: string[]
  refs: Ref[]
  author: string
  authorTime: number
  subject: string
  workingCopy?: boolean // 该提交是后端的工作副本
  empty?: boolean
  conflict?: boolean
}

type CommitDetail = CommitNode & {
  committer?: string
  committerTime?: number
  message?: string
  files: FileEntry[]
}

type TimelineNode =
  | { kind: 'worktree'; changed: number; added: number; deleted: number } // workingCopy: 'row'
  | { kind: 'commit'; commit: CommitNode } // 普通提交，或 workingCopy: 'commit' 的 @

type FileEntry = {
  path: string
  origPath?: string // 重命名/复制的源路径
  status: string // M、A、D、R、U、?
  added: number | null
  deleted: number | null
  binary?: boolean
  directory?: boolean // 未展开的未跟踪目录
  conflict?: boolean
}

type FileGroup = { id: 'staged' | 'unstaged' | 'untracked' | 'commit'; entries: FileEntry[] }

type DiffTarget = {
  scope: 'staged' | 'unstaged' | 'untracked' | 'commit'
  path: string
  oldPath?: string // vcs.diff 的查询参数，取自 FileEntry.origPath
  rev?: string // scope 为 commit 时必填；Jujutsu 的 @ 也用它
}

type VcsCapabilities = {
  id: string
  name: string
  workingCopy: 'row' | 'commit'
  workingCopyNode: string | null
  staging: boolean
  untracked: boolean
  changeId: boolean
  aheadBehind: boolean
  snapshots: boolean
  ranges: { value: string; label: string; title: string }[]
  defaultRange: string
}

type VcsHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[] // 保留 +/-/空格 前缀
}

type VcsFileDiff =
  | { kind: 'text'; path: string; before: boolean; after: boolean; hunks: VcsHunk[]; coarse?: boolean }
  | { kind: 'binary'; path: string }
  | { kind: 'oversized'; path: string }

// 客户端在应答之外还有 loading / missing / error 三种展示状态
type VcsDiffView = 'loading' | 'missing' | 'error' | VcsFileDiff
```

路由应答：

```ts
type RepositoryInfo = {
  path: string
  name: string
  enclosing: boolean
  vcs: string
  capabilities: VcsCapabilities
}
type RepositoriesAnswer = {
  cwd: string
  repositories: RepositoryInfo[]
  truncated: boolean
}

type BranchInfo = {
  name: string | null
  oid: string | null
  detached: boolean
  unborn: boolean
  upstream: string | null
  ahead: number
  behind: number
}
type WorkingCopyInfo = {
  node: string
  commitId: string
  changeId?: string
  parents: string[]
  refs: Ref[]
  subject: string
  author: string
  authorTime: number
  empty?: boolean
  conflict?: boolean
  summary: { changed: number; added: number; deleted: number }
}
type StatusAnswer = {
  repo: { path: string; name: string }
  vcs: string
  capabilities: VcsCapabilities
  defaultNode: string
  branch: BranchInfo | null
  workingCopy?: WorkingCopyInfo
  groups: Partial<Record<'staged' | 'unstaged' | 'untracked', FileEntry[]>>
  total: number
  truncated: boolean
}

type UntrackedAnswer = {
  path: string
  entries: { name: string; path: string; type: 'file' | 'directory' }[]
  truncated: boolean
}
type LogAnswer = {
  commits: CommitNode[]
  truncated: boolean
  nextSkip: number | null
}
type CommitAnswer = {
  commit: CommitDetail
  truncated: boolean
}
```

## Client

### 构建

`src/client/entry.jsx` 由 esbuild 打成 CommonJS bundle；只有 `react`、`react/jsx-runtime` 保持 external，
由宿主模块表提供。CSS 以文本导入，挂载时注入一个 `<style>`，类名统一使用 `vcs-` 前缀。
`scripts/build.mjs` 再加上 `window.__ModuleLoader__.load({ id, factory })` 包装，输出单文件 `client.js`；
`--check` 比较重新构建的结果。`client.js` 是产物，不手改。

### 注册与本地化

- `entry.jsx` inject `['slots', 'locale', 'uiConversation']`；`ctx.slots.inject('conversation.view', ...)` 注册
  `id: 'vcs'`、`order: 20`；同一 `apply` 里注册每轮改动的 Conversation 定义与 turn-tail 入口（见下一节）。
- `locale` NS 为 `vcs`，八种语言字典在 `src/client/locales.js`；没有字典时回退英文。
  日期、相对时间与数字分组走 `format.js`，语言切换后随视图重新渲染。
- 插件展示信息（标题与描述）在 `locale/*.json`。

### 对话结束的入口

- turn-tail 入口注册为 `id: 'dsh-vcs-panel'`、`order: -10`、`locale: 'vcs'`，只在该轮有文件改动时渲染一个图标，位置在交付卡片之前。
- 改动证据来自 `turn.js` 的 `createTurnChangesDefinition()`（kind `vcs-changes`，无 view target）：
  匹配 `turn/start`、`workspace/changes`、`tool/call` 与 `surfaceOp === 'append'` 的 `tool/result`。
  记录器按 git 工作树或文件工具捕获的 `workspace/changes` 覆盖 shell 与同一工作区内的子代理改动；
  `write`、`edit`、`apply_patch` 与改写型 `str_replace_editor` 的成功结果覆盖记录器未覆盖的编辑。两者任一成立即显示图标。
  定义通过 `buildLocationData` 在 Turn Location 上发布 `{ changed: true }`；Location 数据键必须等于定义 kind，因此键为 `vcs-changes`，与 kind 共用同一个常量。
- 视图切换借用 `conversation.session` 槽位声明的 Conversation store：`ctx.slots.entries('conversation.session')`
  找到带 `setView` 动作的 handle，turn-tail 入口以同一个 handle 注册，从而拿到同一实例的 `actions`；
  点击时先 `ctx.uiConversation.binding(sessionId).activate('vcs')`，再 `actions.openView('vcs', 'turn-tail')`（没有该动作时退回 `setView`）；
  `openView` 留下 `viewRequest`，`VcsView` 挂载后在 effect 里聚焦根节点并 `completeViewRequest()`，键盘落点不会掉到 `body`。
  这是本插件唯一依赖宿主内部槽位 store 的地方；`conversation.session` 尚未注册时，入口等待该槽位的注册再挂载，始终找不到 store 或视图动作时入口不出现，面板其余部分不受影响。
- `cordis.patch.yml` 只插入插件行，不改宿主插件配置。宿主卡片由样式表规则
  `[data-turn-tail] [data-changed-files] { display: none !important; }` 隐藏：记录器、摘要、交付卡片与本机打开保持原样。
  `workspace-changes` 的 `maxFiles` 必须在 1 以上（`apply` 拒绝 0），所以不能通过清空摘要来隐藏卡片；
  该规则依赖宿主卡片上的 `data-changed-files` 与 turn-tail 根上的 `data-turn-tail`，标记变化时卡片重新出现，删除规则即恢复。

### 全局视图快捷键

- 命令在 `ctx.inject(['shortcuts', 'sessions'])` 的范围内注册，id 为 `vcs.view.toggle`，出现在 DSH 的 Settings → Shortcuts 并可按设备重绑定。`package.json` 的 `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-shortcuts`；顶层的 `inject` 不增加快捷键服务，缺少该服务时面板其余部分照常注册。
- 默认键位在 `src/client/shortcuts.js`：`desktop:macos`、`desktop:windows`、`desktop:linux`、`web:macos`、`web:windows` 都是 `{ code: 'KeyG', modifiers: ['primary', 'shift'] }`；`web:linux` 不设默认。注册失败（未来宿主的默认键位冲突）时回退为无默认命令，用户仍可在设置里绑定。
- `regions` 为 page/editable/terminal，`modals` 为空。Desktop 原生输入优先于模态，所以 `resolve` 在模态打开时返回 pass，不切换被遮住的视图；Web 由宿主在 `resolve` 之前拦截。
- 视图记忆由 `createViewRegistry()` 提供：按会话记录 `view` 与最近一个非 VCS 视图；返回目标不在当前 `conversation.view` 注册表时回退 `chat`。同一会话第一次挂载在 VCS（例如刷新后）时，上一个视图按 `chat` 处理。
- 桥接条目注册到 `conversation.session.header.utilities`，id 为 `dsh-vcs-panel:view-bridge`，不渲染内容。它声明 Conversation store handle，所以拿到与 Conversation 壳相同的 store 实例与绑定 actions；`useStore(state => state.view)` 跟踪选择，`useLayoutEffect` 在绘制前发布，卸载时只在 actions 仍是当前实例时释放。
- 切换方向：进入 VCS 用 `binding.activate('vcs')` + `actions.openView('vcs', 'shortcut')`，复用 `VcsView` 的焦点请求；返回用 `binding.activate(view)` + `actions.setView(view)` + `completeViewRequest()`。最后一步清掉视图可能未消费的聚焦请求，避免返回后留下指向 VCS 的陈旧 `viewRequest`。
- 当前会话按 `retainedBy.mainView > 0` 识别，与 Workspace 快捷键一致。没有会话、桥接尚未挂载或主面板遮住对话时 `resolve` 返回 pass，不消耗按键；`blocked` 的原因不会显示给用户，所以不使用它。
- 不新增 Host 路由，也不触碰仓库。

### 视图错误边界

- Conversation View 在 DSH 的 slot 条目里渲染。条目在渲染或生命周期中抛错时，DSH 的 `SlotErrorBoundary` 会把该条目记为 abdicated 并永久跳过，页面只剩空白，且没有面板内的恢复入口。
- `ViewErrorBoundary` 位于视图条目内部，捕获 `VcsView` 的错误并渲染 `view.crashed` 重试面。失败记录写入 `sessionStorage` 的 `vcs:last-error`：`time`、`message`、截断到 12,000 字符的 `stack` 与 `componentStack`。存储不可用或已满时只损失诊断。
- 重试只重置边界状态并重新挂载 `VcsView`，不改动持久化状态，因此仍从原选中节点与阅读位置恢复。错误捕获在面板内完成，DSH 的槽位条目保持注册。

### 状态与持久化

- `sessionStorage` key 为 `vcs:<sessionId>`；状态字段：`repo`、`node`、`nodeChosen`、`ref`、
  `dirs`、`collapsed`、`folds`、`anchor`、`split`、`wrap`、`sidebarWidth`、`timelineScroll`。
- `dirs` 记可加载未跟踪目录的展开；`collapsed` 记分组与目录的收起；`folds` 记文件的显式折叠；
  `anchor` 是 `{ key, offset }`：key 可以是分组、目录或文件行键，offset 是从行顶算起的像素。
- 行键前缀白名单是 `staged|`、`unstaged|`、`commit|`；旧版本的 `untracked|...` 键在读取时丢弃，
  旧锚点回到默认位置，不报错也不残留。
- 读取时 `sanitizeState` 丢弃不认识的值；存储失败只损失恢复，不影响面板。
- 仓库切换在内存里按仓库记住选中节点、目录折叠与范围；页面刷新只恢复当前仓库。
- 选中节点重置 per-node 的阅读位置与折叠；工作区目录与分组折叠跨节点保留。

### 数据层与请求

- `api.js` 统一 fetch：每请求带 `sessionId`、`credentials: 'same-origin'`、`cache: 'no-store'`；
  非 2xx 转成 `ApiError`，保留 Host 的 `code`。
- 视图用 `AbortController` 取消过期请求；没有轮询。刷新由挂载、手动按钮、
  重新可见超过 30 s 触发。
- diff 结果按 `repo|scope|path|oldPath|rev|revision` 缓存最近 300 条；刷新或切换仓库时清空。

### 时间线与图

- 时间线第 0 行是工作区虚拟节点（`workingCopy: 'row'`），父节点为 `HEAD`；
  `workingCopy: 'commit'` 的后端不加虚拟节点，`@` 作为真实提交参与布局。
- `buildGraph` 输入按拓扑顺序排好的节点；输出 `paths[] / links[] / dots[] / commitLeftMargin[]`，
  React 只把坐标映射成 SVG path 与行内元素。
- 布局移植 SourceGit 的 `PathHelper`：`pass / goto / end` 遍历活动 lane，第一父延续主 lane，
  其他父建/复用侧 lane，lane 结束时回收颜色；工作区的 lane 标 `dashed`，在 `HEAD` 的 dot 结束，
  随后由同槽位的实线 lane 继续。
- 行高 44 px；只渲染可视区 ±10 行；图与列表共用滚动容器与行高。
  分页追加时整图重算（O(n)），滚动锚点按 commit 恢复。
- `buildPathD` 把点序列转成带二次/三次贝塞尔平滑的 SVG path；`graphWidth` 按最宽 margin 计算图列宽度。
- refs/Selection 作为行数据渲染，不参与 lane 计算。

### 变更树

- 选中节点先归一成 `FileGroup[]`：工作区两组（`staged`、`unstaged`，未跟踪文件与目录并入 `unstaged`），
  提交与 Jujutsu 节点一组。Host 的 status 仍按三组返回，合并只发生在客户端。
- `detail/tree.js` 把分组与展开状态变成一份可见行列表，行有 `group`、`dir`、`file`、`loading` 四种：
  - 行键统一为 `group|path`；分组行的 path 为空，目录键去掉结尾斜杠，文件行键同时是它的 diff section key。
  - 单子目录链压成一行（`src/client/detail`）；Git 整体报告的未跟踪目录按可加载行处理，
    不参与压缩，展开时按需读取直接子项。
  - 文件行携带 `group`、`depth`、`entry` 与行键；分组行携带文件数与增删行数（文件数含未跟踪项，
    行数只累加 Host 给出数值的条目）。
- 渲染、键盘和阅读锚点都读同一份行列表。`sectionsFromRows` 从可见行派生 diff 段；
  `streamSections` 按完全展开的行序计算默认折叠预算。
- `diffTarget` 的 scope 取自文件本身：`?` 请求 `untracked`，其余用所在分组，提交用 `commit` 并带 `rev`；
  重命名带 `oldPath`。

#### 渲染、吸顶与工具栏

- 行高统一 28px（`--vcs-row-height`）。分组行 `position: sticky; top: 0`；展开的文件行在分组行下吸顶
  （`top: 28px`），提交树没有分组行时 `top: 0`；目录行不吸顶。
  只有展开的文件行用 `box-shadow` 画下分隔线，不占布局，所以收起与展开不改变行高。
- 字体：根节点用 `--dsw-font-family`，正文 13px、次要文字 12px、计数与元信息 11px，强调为 500 字重。
  diff 用 `--dsw-font-markdown-code`（12px）与 `--vcs-diff-line-height`（20px），两者都随
  `--dsh-code-font-delta` 变化；`detail.js` 的 `estimateHeight` 按默认 20px 估算未加载的 diff。
- 文件行就是 diff 的文件头：展开时补父目录路径并换文件头底色。行是原生 button，`aria-expanded`
  与 `aria-controls` 指向内容容器的稳定 id（`rowBodyId`）；行间 roving tabindex，整棵树一个 Tab 停靠点。
- 工具栏内容与四个比较基准的文案见 `DESIGN.md` 的“详情”表；`comparisonBase` 按 parents 与
  changeId 能力返回 `parent`、`merge`、`root` 或 `autoMerge`，Client 据此选择本地化文案。
- 变更树窄于 `SPLIT_MIN_WIDTH`（640px）时，左右对比按单栏渲染（传给 `FileDiff` 的 split 为 false）；
  按钮保留用户偏好，悬停提示说明宽度不足。

#### 折叠、加载与键盘

- 默认折叠：分组与目录默认展开；单文件超过 1,000 行改动或整条预算超过 20,000 行时文件默认收起，
  并在行下说明原因。用户的显式选择（`folds`）优先；折叠与展开的语义见 `DESIGN.md` 的“变更树”。
- 工具栏按钮在“全部收起”和“全部展开”之间切换：前者把当前节点所有文件写成显式折叠，
  后者清空显式折叠。两种操作都保持光标行的屏幕位置。
- 收起已吸顶的文件行时，先把滚动位置对到它当前的吸顶槽位再折叠（`pendingAlign`），
  因此下一行接上而不是把读者弹回上方。
- 展开的文件在接近视口时才请求 diff（`IntersectionObserver`，800px 预载），最多 4 个并发，
  离开视口取消；加载前按增删行数估高。diff 缓存按 `repo|scope|path|oldPath|rev|revision` 记最近 300 条。
- 键盘键位见 `DESIGN.md` 的“交互与状态”。实现上只有一个光标：可见行是原生 button，移动时只滚动
  目标行；`]`/`[` 用 hunk 头的 `data-diff-hunk-header` 标记定位；按 `event.key` 匹配，
  `getModifierState('AltGraph')` 为真时不把 Alt 当作修饰键，德语、法语等需要 AltGr 的布局照常可用。
- 键盘滚动把输入来源记为键盘，程序滚动不会反向移动光标；滚轮、触控板与翻页键把来源标成滚动，
  滚动结束后光标跟随正在阅读的行。

#### 阅读位置

- 阅读位置按 `{ key, offset }` 记录，不依赖绝对 `scrollTop`；key 可以是分组、目录或文件行。
- 页面刷新按锚点恢复；锚点行没有渲染时沿祖先降级（文件行 → 目录链 → 分组行）。
- 刷新数据（手动刷新、重新可见超过 30 s）先用刷新前的锚点记下位置，新行到达后恢复一次。
- 全部收起/展开、收起已吸顶的文件行时，用同一套“先记屏幕位置、重排后恢复”的处理。

## 复用与来源

- **diff**：内嵌并改编 DSH 的 `FileDiff`（`src/client/diff/FileDiff.jsx`、`FileDiff.css`、`diff-rows`），
  接本地 `VcsHunk`。外部插件不能加载 Harness Client 包，所以组件与高亮以源码形式打进 bundle。
  与原版的差异：字号用行内代码令牌（12px）而非代码块令牌（11px），行高 20px 而非 22px，行号列按 `ch` 定宽。
- **图**：`src/client/history/layout.js` 是 `git-graph-plus` 的 `git-graph-builder.ts`（commit c6c2a9a）
  的裁剪移植，后者又是 SourceGit 的移植。lane 分配、第一父延续、侧 lane 与颜色回收保留；
  remote-only/local-only 可达性与分支配色移除，因为日志路由不提供 upstream 关系，面板也没有分支配色配置。
- **高亮**：本地 tokenizer，不是宿主 Shiki 组件；span 颜色引用宿主 `--shiki-token-*` 变量，跟随当前主题。
- 不引入第三方 diff/图库，不把 SourceGit 的 C# 渲染层打进 bundle；不复制 `vscode-git-graph`
  （其许可证禁止再分发/子许可/售卖）。

版权、许可文本与逐文件清单见 `NOTICE` 与 `licenses/`。
