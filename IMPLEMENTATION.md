# 实现：dsh-vcs-panel

本文记录实现契约：Host 路由与安全边界、核心数据形状、资源上限、Client 构建与宿主接缝、图与变更树管线，以及代码复用来源。

## Host 路由、安全与后端

### 注册与路由

Host 端为无运行时依赖的 Node ESM 插件，注入 `['connection', 'sessions', 'subprocess', 'fs']`。`apply` 仅在配置显式为字面量 `enabled: false` 时跳过路由注册（如需同时移除前端页签，需在 Plugins 中停用整个 bundle）。七条只读 `GET` 路由注册在 `ctx.connection.fetch` 的认证栅栏内；请求 `signal` 与插件生命周期 `AbortController` 组合，取消的请求保留 `AbortError`，不转为错误 JSON。

| 路由 | 查询参数 | 应答字段 |
| --- | --- | --- |
| `GET /api/vcs.repositories` | `sessionId` | `cwd`、`repositories[]`（`path`、`name`、`enclosing`、`vcs`、`capabilities`）、`truncated` |
| `GET /api/vcs.status` | `sessionId`、`repo` | `repo`、`vcs`、`capabilities`、`defaultNode`、`branch`、`workingCopy?`、`groups`、`total`、`truncated` |
| `GET /api/vcs.untracked` | `sessionId`、`repo`、`path`（`/` 结尾） | `path`、`entries[]`（`name`、`path`、`type`）、`truncated`（仅 `capabilities.untracked` 为真时可用） |
| `GET /api/vcs.diff` | `sessionId`、`repo`、`scope`、`path`、`oldPath?`、`rev?` | `VcsFileDiff` |
| `GET /api/vcs.log` | `sessionId`、`repo`、`ref`、`limit`、`skip` | `commits[]`、`truncated`、`nextSkip` |
| `GET /api/vcs.commit` | `sessionId`、`repo`、`sha` | `commit`（`CommitDetail`，不含 patch）、`truncated` |
| `GET /api/vcs.turn` | `sessionId`、`turn`、`seq?` | `turn`、`head`（`TurnHead \| null`）、`changed`、`added`、`deleted` |

### 输入校验与路径边界

客户端只传会话标识与候选路径，不能凭请求参数让服务端读取任意目录或注入命令选项：

- **会话与仓库白名单**：`sessionId` 必须命中带有效 `header.cwd` 的活跃会话；`repo` 必须命中当次 `discoverRepositories` 的结果（`sameRepoPath`）。
- **仓库发现与符号链接收敛**：从 `cwd` 向上最多 64 层查找最近的仓库标记，再扫描 `cwd` 下一层子目录（忽略 `node_modules`，不递归）。标记用 `lstat` 检测且 `.jj` 优先于 `.git`，兼容 linked worktree 的 `.git` 文件与 submodule。根路径经 `ctx.fs.resolve` 规范化，子仓库规范路径必须仍在 `cwd` 内；读取文件前再经 `containPath` 做 `realpath` 校验，确保目标留在仓库根内。
- **路径与修订号净化**：`validateRelPath` 拒绝绝对路径、反斜杠、空段、`.`、`..`、`-` 前缀与控制字符，Git 侧再包 `:(literal)` pathspec，Jujutsu 侧用 `file:"..."` fileset。提交 ID 先做 7–64 位十六进制校验；Git 再经 `rev-parse --verify <sha>^{commit}` 解析，Jujutsu 仅接受 `@` 或十六进制 ID。

失败统一返回 `{ error: { code, message } }`，不携带宿主绝对路径、原始命令或堆栈：

| `code` | HTTP | 触发情形 |
| --- | --- | --- |
| `bad-request` / `not-a-repo` | 400 | 参数非法，或仓库不在当前会话发现列表内 |
| `not-found` | 404 | 目标文件或提交不存在 |
| `no-session` / `no-cwd` | 409 | 会话不存在或无工作目录 |
| `output-too-large` | 413 | 子进程输出超出字节上限（`lossy`） |
| `vcs-missing` / `timeout` | 503 | 宿主缺少 `git`/`jj` 可执行文件，或命令超时 |
| `internal` | 500 | 未预期的后端失败 |

### 命令隔离与后端能力

两个后端共用 `CommandRunner`（`lib/command.js`），以固定 argv 直接执行子进程，不经过 shell；环境收窄为 `LC_ALL=C` 加后端白名单，防止仓库配置重定向输出、拉起编辑器或持锁：

- **Git**：固定 `-c core.quotepath=false`，环境设 `GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`；比较命令加 `--no-pager`、`--no-ext-diff`、`--no-color`、`-U3`。
- **Jujutsu**：固定 `--color=never`、`--no-pager`，环境设 `JJ_EDITOR=true`；除工作副本快照外的读取均带 `--ignore-working-copy`。

每个后端实现 `require`、`head`、`status`、`log`、`commit`、`diff`（可选 `untracked`）并声明 `capabilities`；Client 仅按能力对象驱动布局，不按后端名称分支：

| 能力字段 | Git | Jujutsu |
| --- | --- | --- |
| `workingCopy` / `workingCopyNode` | `'row'` / `null` | `'commit'` / `'@'` |
| `staging` / `untracked` / `aheadBehind` | `true` | `false` |
| `changeId` / `snapshots` | `false` | `true` |
| `ranges`（`defaultRange`） | **`HEAD`**、`all` | **`@`**、`all` |

两个后端的读取规则差异：

- **Git**：`head` 仅读取 `symbolic-ref -q --short HEAD` 与 `rev-parse -q --verify HEAD^{commit}`，不扫描索引与工作区；`status` 组合 `status --porcelain=v2 -z --branch --untracked-files=normal` 与两次 `diff --numstat -z`（index 与工作区），按 `XY` 拆成 `staged`、`unstaged`、`untracked`（两侧均改时各出现一次，冲突标 `U`）。`diff` 按 `staged`（对 `HEAD`）、`unstaged`（对 index）、`untracked`（按新文件合成）、`commit`（对第一父，root 对空树）取值；空仓库读取 `HEAD` 日志视为空历史而非错误。
- **Jujutsu**：每次 `status` 刷新执行一次 `jj log --no-graph -r @ -T commit_id` 快照工作副本（并发请求复用同一 Promise，失败清空缓存），其余读取（含轮末 `head` 读取 `change_id`）均带 `--ignore-working-copy` 复用已记录状态，不触发额外快照。`log` 使用 `::@ ~ root()` 或 `all() ~ root()`；`diff` 使用 `jj diff --git -r <rev>`，输出含 NUL 或 `U+FFFD` 时按二进制处理。
- **每轮摘要与头指针记录**：`createTurnTracker`（`lib/turns.js`）监听活跃会话的 `session/event`、`agent/turn-stopping`、`tools/pre-execute` 与 `session/disposed`，在有工具执行或 `workspace/changes` 的轮次结束时串行读取外围仓库的 `head`（下一轮工具执行前等待上一轮完成，防止跨轮切分支串台）。`vcs.turn` 通过 `ctx.get('workspaceChanges')` 可选读取宿主的每轮 `{ total, added, deleted }`（校验 `turn` 与 `seq` 归属一致，剔除宿主路径与文件明细），并与该轮 `head` 合并返回；两者均不存在（如 Host 重启后的历史轮次）时返回 `404 not-found`。

## 核心数据形状

```ts
type RefKind = 'head' | 'branch' | 'bookmark' | 'remote' | 'tag'
// Git：HEAD 指向的当前分支带 current: true，分离头指针才单独出现 head
// Jujutsu：本地书签为 bookmark，远程书签为 remote（如 main@origin）
type Ref = { name: string; kind: RefKind; current?: true; conflict?: true }

type CommitNode = {
  sha: string
  changeId?: string
  parents: string[]
  refs: Ref[]
  author: string
  authorTime: number
  subject: string
  workingCopy?: boolean
  empty?: boolean
  conflict?: boolean
}

type CommitDetail = CommitNode & {
  committer?: string
  committerTime?: number
  message?: string
  files: FileEntry[]
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

type FileEntry = {
  path: string
  origPath?: string       // 重命名/复制的源路径（请求 diff 时传为 oldPath）
  status: string          // M | A | D | R | U | ?
  added: number | null
  deleted: number | null
  binary?: boolean
  directory?: boolean     // Git 未展开的未跟踪目录
  conflict?: boolean
}

type VcsHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]         // 保留 +/-/空格 前缀
}

type VcsFileDiff =
  | { kind: 'text'; path: string; before: boolean; after: boolean; hunks: VcsHunk[]; coarse?: boolean }
  | { kind: 'binary'; path: string }
  | { kind: 'oversized'; path: string }
// Client 视图层在此之上另有 'loading' | 'missing' | 'error' 三种状态

type TurnHead =
  | { kind: 'branch'; name: string }
  | { kind: 'detached' }
  | { kind: 'unborn' }
  | { kind: 'workingCopy'; changeId: string | null }

type TurnSummary = {
  turn: number
  head: TurnHead | null
  changed: number | null
  added: number | null
  deleted: number | null
}
```

## 上限

数据超限时返回 `oversized`、`truncated` 或截断提示；子进程超时或超限返回结构化错误：

| 项目 | 上限 | 执行位置 |
| --- | --- | --- |
| 单会话列出的仓库数 | 50 | Host `discoverRepositories` |
| 每组状态文件数（Git）/ 单提交详情文件数 / 未跟踪目录展开条目数 | 各 500 | Host `status` / `commit` / `untracked` |
| 单文件 diff 输出 / 渲染行数 | 2 MB / 5,000 行 | Host `diff`、Client `FileDiff` |
| “全部展开”的 diff 预算 | 单文件 1,000 行；单节点累计 20,000 行 | Client `budgetFolds`、`expandedFileFolds` |
| diff 请求并发 / 视口预载距离 / 结果缓存 | 4 个并发 / 800 px / 最近 300 条 | Client 请求队列与缓存 |
| 历史分页 / 最多加载提交数 | 300 条/页，最多 10,000 条 | Host `log` |
| 单会话保留的轮末头指针 / 客户端空闲轮次摘要缓存 | 2,000 轮 / 500 条 | Host `TurnTracker`、Client `turn-summary` |
| 单条后端命令 | 30 s 超时，stdout 8 MB，stderr 尾部 16 KB，终止宽限 2 s | Host `CommandRunner` |
| 页面重新可见自动刷新阈值 / Jujutsu 快照频率 | 隐藏超过 30 s 刷新一次 / 每次刷新快照一次 | Client 可见性监听、Jujutsu 后端 |

变更树当前一次渲染全部可见行，仅按需加载 diff 本体。

## Client 构建、宿主接缝与状态

### 构建与本地化

`scripts/build.mjs` 用 esbuild 将 `src/client/entry.jsx` 打成单文件 CommonJS 产物 `client.js`（`--check` 校验产物是否最新），仅将宿主模块表提供的 `react` 与 `react/jsx-runtime` 设为 external，并在外层包裹 `window.__ModuleLoader__.load({ id, factory })`。CSS 以文本打入 bundle，挂载时注入单个 `<style>`，类名统一使用 `vcs-` 前缀。八种界面语言注册在 `vcs` 命名空间，插件列表展示名与描述位于 `locale/*.json`。

### 宿主接缝

Client 顶层注入 `['slots', 'locale', 'uiConversation']`，在四处与 DSH 宿主内部机制衔接，每处均设有降级或恢复边界：

- **视图槽位与崩溃隔离**：注册 `conversation.view`（`id: 'vcs'`，`order: 20`）。DSH 的 `SlotErrorBoundary` 捕获异常后会将条目永久标为 abdicated 并移除页签，因此视图内部包有 `ViewErrorBoundary`：捕获渲染错误后展示重试页，将时间、错误与截断至 12,000 字符的调用栈写入 `sessionStorage` 的 `vcs:last-error`，重试时保留原会话状态重新挂载。
- **Turn 改动判定与每轮摘要缓存**：`createTurnChangesDefinition` 注册 `vcs-changes` 事件定义，聚合每轮最新的 `workspace/changes` 事件序号（`seq`）与成功的文件写入工具结果；Conversation 引擎要求 Location 数据键与定义 `kind` 完全同名，因此键固定为 `vcs-changes`。`conversation.chat.turnTail` 条目（`order: -10`）仅在该标志为真时按 `(sessionId, turn, seq)` 从 `turn-summary.js` 读取一次 `/api/vcs.turn`：已解析结果在客户端按 LRU 缓存，切回 Chat 直接同步渲染；`404`/`400`/`409` 记为 `missing` 不再重复请求（回退展示“打开版本管理”）；净改动文件数为 0 的轮次隐藏横幅；连接重置（`connection/reset`）时仅重拉未就绪条目。
- **隐藏宿主改动卡片**：`workspace-changes` 拒绝 `maxFiles: 0`，因此 `cordis.patch.yml` 不改动宿主配置，改由样式规则 `[data-turn-tail] [data-changed-files] { display: none !important; }` 仅隐藏文件卡片，保留改动记录器与 `present` 交付卡片。宿主 DOM 标记变更时仅退化为重新显示原卡片。
- **会话 Store 借用与全局快捷键**：DSH 未将视图切换暴露为独立服务，当前视图保存在 `conversation.session` 槽位声明的 Store 中。Turn 横幅与 `conversation.session.header.utilities` 上的零渲染桥接条目（`dsh-vcs-panel:view-bridge`）通过声明同一 Store handle 拿到 `actions`（槽位未就绪时订阅等待，缺失时不挂载）。快捷键 `vcs.view.toggle` 在可选的 `['shortcuts', 'sessions']` 作用域注册（默认键位冲突时回退为空绑定）：进入 VCS 调用 `activate('vcs')` + `openView('vcs', source)` 留下聚焦请求；返回上一非 VCS 视图调用 `activate(view)` + `setView(view)` + `completeViewRequest()`，清除可能尚未消费的聚焦请求。模态框打开或无活跃主视图会话（`retainedBy.mainView > 0`）时返回 `pass`。

### 状态持久化与锚点恢复

会话状态保存在 `sessionStorage` 的 `vcs:<sessionId>`，包含 `repo`、`node`、`nodeChosen`、`ref`、`dirs`、`collapsed`、`folds`、`anchor`（`{ key, offset }`）、`split`、`wrap`、`sidebarWidth` 与 `timelineScroll`；内存另外按仓库记住切换前的选中节点、目录折叠与历史范围。

`folds` 只为用户显式操作过的文件保存布尔值：空记录表示文件全部收起，也就是详情的默认形态。行键前缀白名单为 `staged|`、`unstaged|`、`commit|`；`sanitizeState` 在读取时丢弃未知字段与旧版遗留的 `untracked|` 键。数据刷新、折叠全部文件或收起吸顶文件头时，统一先记录锚点行与行内像素偏移，重排后恢复；锚点行未渲染时沿“文件行 → 父目录链 → 分组行”降级。

### 图布局与变更树管线

- **时间线图布局**：`buildGraph` 接收拓扑序节点，按 `pass / goto / end` 遍历活动 lane（第一父延续当前 lane，其余父节点分配或复用侧 lane，lane 结束时回收颜色；Git 工作区虚节点以虚线连向 `HEAD`），输出路径与圆点坐标，与虚拟列表共用滚动容器渲染；分页追加时 O(n) 重算整图并按提交锚点恢复位置。
- **变更树与请求调度**：客户端将 Git 的 `untracked` 条目并入 `unstaged` 分组（可按需展开的未跟踪目录不参与单子目录链压缩），生成单一扁平行列表供渲染、roving tabindex 键盘导航与滚动锚点共用；文件默认收起，只有展开的行才请求 `vcs.diff`。发起请求时仍按条目自身状态还原 `scope`（`?` 走 `untracked`，重命名带 `oldPath`）。变更树窄于 640 px（`SPLIT_MIN_WIDTH`）时将 `FileDiff` 的 `split` 置为 `false` 单栏渲染。展开文件由 `IntersectionObserver` 入队请求，离开视口时经 `AbortController` 取消。当前行是展开文件时，`j` / `k` 跳到下一个/上一个 hunk，其他行按方向移动光标；`[` / `]` 始终在行之间移动。键盘匹配排除 `AltGraph`，保证需要 AltGr 输入 `[` / `]` 的键盘布局可用。

## 复用与来源

- **diff 与语法高亮**：外部插件不能加载 Harness Client 内部包，因此源码内嵌并适配 DSH 的 `FileDiff`（`src/client/diff/`），配合本地语法 tokenizer 引用宿主 `--shiki-token-*` CSS 变量跟随主题着色。
- **lane 图算法**：`src/client/history/layout.js` 裁剪移植自 `git-graph-plus` 的 `git-graph-builder.ts`（commit `c6c2a9a`，源自 SourceGit `PathHelper`），移除本面板不使用的 upstream 可达性与分支自定义配色；不引入第三方运行库，也不采用禁止再分发的 `vscode-git-graph`。
