# 设计：dsh-vcs-panel

## 要解决的问题

在 DSH 的会话里，用户经常要回答两个问题：**当前工作区改了什么？这些提交是怎么走到今天的？**
现在要么切到终端跑 `git status` / `git diff` / `git log --graph`，要么装一个 Git 插件；后者常把
staging、commit、push、分支、stash、rebase 全部堆进一个面板，看和改混在一起，diff 与历史图反而被挤成小区域。

这两个问题落在同一条时间线上：未提交的改动是最新的一段，提交是更早的各段。
读每一段的方式也相同：先看这一步动了哪些文件，再逐个读 diff。
所以面板用一条时间线回答“走到了哪里”，用一种详情回答“这一步改了什么”。

这个插件只服务一条路径：**看改动 → 看历史 → 需要时再动手**。
“动手”留给终端或其他工具；V1 的插件本身只读。

只读是这一版的产品边界，不是永久限制。写操作需要单独设计授权、确认和冲突处理，不进入本设计。

## 理念

1. **先看，不改。** V1 的所有 Host 路由只读；不 stage、commit、checkout、merge、rebase、push、pull、fetch。
   把“读”做快、做准、做稳，比把 Git 的全部能力塞进一个面板更有价值。
2. **一条时间线。** 工作区是时间线最新的一端，提交按拓扑顺序排在下面；
   从“看改动”到“看历史”是一次向下滚动，不需要在视图之间切换。面板不做 Git 命令控制台。
3. **一种详情。** 无论选中工作区还是提交，详情都回答同一个问题：这一步改了哪些文件、每个文件怎么改。
   两者共用“头部 + 文件导航 + diff 流”的结构，只有头部的元数据不同；
   一个节点的全部 diff 依次排开，文件导航负责定位，读完一步不必逐个文件点进点出。
4. **长在 DSH 上。** 颜色、字体、圆角、焦点环与 `prefers-reduced-motion` 跟随宿主 token 和约定；
   用户不应看出这是另一套界面。
5. **大仓库是常态。** 虚拟列表、分页、按需加载、明确的行数/字节上限、显式截断提示；
   不为了一次性读全文件、全历史或全部 diff，把页面拖死。
6. **安静、可恢复。** 不自动弹窗、不轮询刷屏；切走再回来保留仓库、选中节点和阅读位置；
   刷新是显式动作，或在重新可见时做一次轻量刷新。
7. **复用先于重写。** diff 内嵌 DSH 内置 `FileDiff` 的源码，适配本地 hunk 类型；图的 lane 算法用
   `git-graph-plus` 对 SourceGit 的 TypeScript 移植。每一处复用都保留原许可声明。
8. **键盘可达。** 时间线、文件导航和 diff 流都能用键盘移动与跳转；焦点始终可见，常用操作不依赖鼠标。

## 体验

### 位置与布局

插件注册到 `conversation.view` ring，id 为 `vcs`，order 20：Chat（0）、Trajectory（10）之后。
标签：中文为“版本管理”，其余语言为 `VCS`（避免名称过长被截断）。

```text
┌────────────────────────────────────────────────────────────────────────┐
│ [repo ▾]  main ↑2 ↓0   [HEAD | All]                         (lock) (↻) │
├────────────────────────┬───────────────────────────────────────────────┤
│ ◌ Working tree         │ Working tree · 3 files +41 −7 [Unified|Split] │
│ ┊ 3 changed  +41 −7    ├──────────────┬────────────────────────────────┤
│ ◉ incr: rename the vi… │ Staged       │ src/view.jsx            +12 −3 │
│ │ HEAD → main · 9e4d7… │ ▸ M view.jsx │ @@ -40,6 +40,9 @@              │
│ ● incr: default to hi… │ Unstaged     │  40  40  const ...             │
│ │ 2f8acea · 15 min     │   M README   │  41     - old                  │
│ ● feat: add read-only… │ Untracked    │       42 + new                 │
│ │ 4cdb773 · 31 min     │   ? notes.md │ README.md                +2 −1 │
│ ● repo: add gitignore… │              │ @@ -1,4 +1,5 @@                │
└────────────────────────┴──────────────┴────────────────────────────────┘
  timeline                 file nav       diff stream
```

- 顶部栏：仓库选择器、当前分支与 ahead/behind、历史范围（`HEAD` / 所有分支）、只读标识、刷新。
  只读标识是带说明的锁形图标：它陈述面板的契约，不是可切换的模式。
- 左栏是时间线，宽 280–480px，可拖拽；宽度按会话保存。
- 右侧是详情：头部、文件导航、diff 流。详情区宽度 ≥ 720px 时文件导航与 diff 流并排；
  更窄时文件导航收进头部下方，作为可折叠的文件列表。
- 窄窗口（< 760px）退化为单栏：先时间线，选中节点后进入详情，详情有返回按钮。

### 时间线

- 第一行固定是工作区节点：图上画成空心虚线圆，用虚线连到 `HEAD` 所在的提交；
  第二行文字显示改动文件数与增删行数。
- 工作区没有改动时这一行仍然保留，变暗并显示“没有改动”：它标出“现在”的位置，也让干净状态有处可说。
- 提交行是两行固定行高：第一行是占满宽度的 subject；第二行是 refs、短 SHA、作者、相对时间。
  subject 是辨认提交的主要依据，不和元数据争同一行的宽度。
- refs：`HEAD` 指向的分支合成一个徽标（`HEAD → main`），只有分离头指针时才单独显示 `HEAD`；
  本地分支、远程分支、tag 用不同徽标；选中节点高亮。
- 范围：默认看当前 `HEAD` 的历史，可切到所有分支，选择按会话保存。范围只影响提交，不影响工作区节点。
- 分页：每页 300 条，底部“加载更多”；最多 10,000 条，超过时明确提示。追加后重新生成图，保持滚动锚点。
- 仓库还没有提交时，时间线只有工作区节点；读取失败、历史被截断有独立状态。

### 详情

详情区对两类节点使用同一结构，差别集中在头部和 diff 的比较基准：

| 段 | 工作区节点 | 提交节点 |
| --- | --- | --- |
| 头部 | “工作区”、分支、文件数与增删行数 | subject、短 SHA（可复制）、refs、作者/提交者与时间、父提交、正文 |
| 文件导航 | 已暂存 / 未暂存 / 未跟踪三组 | 一组变更文件 |
| diff 基准 | 已暂存对 `HEAD`，未暂存对 index，未跟踪按新增文件 | 对第一父提交；root commit 对空树 |

- 头部：提交正文只显示 subject 之后的部分，没有正文时不显示消息块。
  父提交可点击，在已加载范围内时选中时间线上的该提交并滚动到该行。
- 文件导航：两类节点共用一个组件。目录可折叠；文件行显示状态字母（M、A、D、R、U、?）、文件名与增删行数，
  统计紧跟文件名。重命名显示旧 → 新名字。未跟踪目录默认只显示目录行，展开时按需读取直接子项。
  同一文件同时有已暂存和未暂存改动时，在两组各出现一次，diff 流里也是两段。
- diff 流：按文件导航的顺序依次排列。每段有吸顶的文件头（状态、路径、增删、折叠），
  本体用内嵌的 `FileDiff`：split/unified、旧/新行号、hunk header、语法高亮，以及创建/删除/无变化/二进制/超大/读取失败状态。
  `Unified / Split` 与自动换行是详情级开关，作用于整条流。
- 定位：点文件导航中的文件，diff 流滚到该段；滚动 diff 流时，文件导航高亮当前段。
- 按需加载：一段接近视口时才请求它的 diff，同时最多 4 个请求；离开视口的未完成请求取消。
- 上限：
  - 单文件最多 5000 行（与 `FileDiff` 的 `MAX_RENDERED_LINES` 一致），超过时 Host 返回 oversized。
  - 单段改动超过 1,000 行时默认折叠。
  - 整条流累计渲染超过 20,000 行后，后续段默认折叠；展开是显式操作。
- V1 不做 hunk 间未改动行的 gap 展开，也不做整文件模式；`FileDiff` 本身没有这两项。

### 交互与状态

- 默认选中：没有显式选择时，工作区有改动就选中工作区节点，没有改动就选中 `HEAD` 提交。
  用户选过节点后按用户选择，不再自动切换；选中的提交在刷新后不存在（例如被 amend）时，回到默认规则。
- 键盘（输入框内不拦截）：
  - 时间线：`↑/↓` 或 `j/k` 切换节点；`Enter` 或 `→` 进入文件导航。
  - 文件导航：`↑/↓` 或 `j/k` 切换文件，diff 流随之滚到该段；`Enter` 折叠/展开目录；`←` 或 `Esc` 回到时间线。
  - diff 流：`Esc` 回到文件导航中正在阅读的文件。
  - 窄布局：`Esc` 从详情返回时间线。
- 多个仓库：仓库选择器列出会话工作目录所属仓库，以及工作区内一层深的子仓库；切换仓库保留各自的选中节点与范围。
- 刷新：手动按钮；重新可见时若数据超过一个短 TTL 才自动刷新。没有定时轮询。
  刷新后保留选中节点，diff 流按“当前文件 + 段内偏移”恢复阅读位置。
- 仓库、选中节点、范围、阅读位置、目录与段的折叠状态、布局开关、栏宽按 `sessionId` 存在 `sessionStorage`；刷新页面可恢复。
- 不提供设置页；只在 Host 配置层保留 `enabled: false` 的关闭开关，关闭时 Host 不注册路由。
  视图随 bundle 加载，要移除视图需在 Plugins 里关闭整个 bundle。
- 明暗主题、焦点环、`prefers-reduced-motion` 全部走宿主 token/约定。

### 不做（V1）

- 不写工作区：不 stage/unstage、不 commit、不 discard、不 checkout、不 merge/rebase/cherry-pick/reset、不 stash、不 push/pull/fetch。
- 不自研 diff 算法/渲染：内嵌 `FileDiff` 源码并适配数据，不引入第三方 diff 组件。
- 不做冲突编辑、blame、submodule、LFS、GitHub/GitLab API、图片 diff。
- 不做提交搜索/过滤（除了 HEAD/所有分支）、不做自动刷新定时器、不做多窗口。
- 不复制 `vscode-git-graph` 的代码（其许可证禁止再分发/子许可/售卖）。

## 机制

### Host

Host 半是普通 Node 插件，注册在 DSH 的认证路由栅栏内：

```js
export const inject = ['connection', 'sessions', 'subprocess', 'fs']
```

| 路由 | 作用 | 关键约束 |
| --- | --- | --- |
| `GET /api/vcs.repositories` | 工作目录所属仓库 + 一层深子仓库 | 最多 50 个；忽略 `node_modules`；不递归 |
| `GET /api/vcs.status` | 分支、ahead/behind、三组文件与增删统计 | 最多 500 个文件；`--porcelain=v2` |
| `GET /api/vcs.untracked` | 展开一个未跟踪目录的直接子项 | 最多 500 项；路径 containment；不递归 |
| `GET /api/vcs.diff` | 一个文件的 hunk：`scope=unstaged/staged/untracked/commit` | `commit` 必带 `rev`；最多 2 MB/5000 行；返回 `before/after` |
| `GET /api/vcs.log` | 提交列表：`ref=HEAD/all`、`limit`、`skip` | 每页 300；最多 10,000；`--topo-order` |
| `GET /api/vcs.commit` | 一个提交的元数据与变更文件列表 | `sha` 必须是十六进制并解析成 commit；不返回 patch |

时间线与统一详情是客户端的组织方式，路由保持按文件粒度：工作区节点来自 `vcs.status`，
提交节点来自 `vcs.log` 与 `vcs.commit`，diff 流的每一段是一次 `vcs.diff`。
按文件请求让每段各自受 5000 行/2 MB 上限约束，能单独取消和重试，
也避免一次请求把大提交的全部 patch 读进 Host 内存。

所有路由通过 `ctx.connection.fetch.register` 注册，和 DSH 其他路由共用认证栅栏；只读。
未跟踪目录默认只显示目录行，展开时走 `vcs.untracked`，避免 status 一次列出全部文件。
Host 计算并归一化 hunk；客户端 `FileDiff` 只负责渲染，不再二次比较。
Git 通过注入的 `subprocess` 执行，固定 argv、`--no-pager`、`--no-ext-diff`、`GIT_OPTIONAL_LOCKS=0`；
不经过 shell，不用用户输入拼接选项。读取路径必须落在会话仓库根内：
先 `realpath` 再做 containment，符号链接不能逃逸；拒绝 `-` 开头的 ref/path。

限制：单条 git 命令 30s 超时、stdout 8 MB、stderr 保留尾部；超时/超限返回结构化错误，
不把原始环境或绝对路径堆栈抛给浏览器。错误统一为 `{ code, message }`，客户端按状态展示。

### Client

- 构建：`src/client/entry.jsx` 由 esbuild 打成 CommonJS，只有 `react`、`react/jsx-runtime` 保持 external，
  由宿主模块表提供；`scripts/build.mjs` 再加上 `window.__ModuleLoader__.load` 包装，输出单文件 `client.js`。
  外部插件不能加载 Harness Client 包，所以 diff 组件与高亮都以内嵌源码的方式打进 bundle。
  CSS 以文本打包，挂载时注入一个 `<style>`，类名统一使用 `vcs-` 前缀。`client.js` 是产物，不手改。
- 注册：`ctx.slots.inject('conversation.view', ...)` 注册 `vcs` 页；inject `slots`、`locale`。
- 语言：`locale` NS 为 `vcs`，维护 zh、en、ja、es、fr、de、ru、pt 八种语言；没有字典时回退英文。
  日期、相对时间与数字分组按当前语言格式化，语言切换后随视图重新渲染。
- 状态：视图内 React state + `sessionStorage`（key 为 `vcs:<sessionId>`），不写 Host。
- 数据层：`api.js` 统一 fetch，`AbortController` 取消过期请求；diff 结果按 `repo + scope + path + rev` 缓存最近 300 条，
  刷新时清空。不轮询，刷新由挂载、手动按钮、重新可见触发。
- 时间线：工作区节点作为虚拟节点放在第 0 行，与提交一起交给 lane 布局（见“图的布局”）。
  列表固定行高 44px（两行文本），只渲染可视区 ±10 行；图与列表共用滚动容器和行高，避免错位。
- 详情：选中节点先归一成 `FileGroup[]`，文件导航与 diff 流都只读这一结构；
  工作区与提交的差别只在构造分组和头部时出现。diff 流是分组按导航顺序完全展开后的 `DiffTarget` 序列。
- diff 流：每段由 `IntersectionObserver` 在接近视口时入队，队列限制并发并取消离开视口的请求；
  段高度在加载前按增删行数估算，加载后以实测高度为准；阅读位置按“文件 + 段内偏移”记录，不依赖绝对 `scrollTop`。
- diff：`vcs.diff` 返回 hunk，转成 `FileDiff` 的 state；`FileDiff` 负责 split/unified、行号、hunk header 和状态；
  `t` 走 vcs locale 适配。内容全部走 React 文本，不塞 `dangerouslySetInnerHTML`。
- `FileDiff` 源码内嵌在 `src/client/diff/`（组件 + CSS + `diff-rows`），源码头的 MIT/来源说明保留。
  语法高亮用本地 tokenizer，以宿主主题的 `--shiki-token-*` 变量着色，颜色随主题切换；不支持的语言回退纯文本。
  工作区与提交的 diff 都用这一个 `FileDiff`，不维护第二套 diff 组件。

### 数据形状

```ts
type RefKind = 'head' | 'branch' | 'remote' | 'tag'
// current：HEAD 指向的分支（`HEAD -> main`）；只有分离头指针时才出现 kind 为 head 的 Ref
type Ref = { name: string; kind: RefKind; current?: true }
type CommitNode = {
  sha: string
  parents: string[]
  refs: Ref[]
  author: string
  authorTime: number
  subject: string
}
type TimelineNode =
  | { kind: 'worktree'; changed: number; added: number; deleted: number }
  | { kind: 'commit'; commit: CommitNode }

type FileEntry = {
  path: string
  origPath?: string // 重命名/复制的源路径
  status: string // M、A、D、R、U、?
  added: number | null
  deleted: number | null
  binary?: boolean
  directory?: boolean // 未展开的未跟踪目录
}
type FileGroup = { id: 'staged' | 'unstaged' | 'untracked' | 'commit'; entries: FileEntry[] } // 截断由 status / commit 回答整体标记
type DiffTarget = {
  scope: 'staged' | 'unstaged' | 'untracked' | 'commit'
  path: string
  oldPath?: string // vcs.diff 的查询参数，取自 FileEntry.origPath
  rev?: string // scope 为 commit 时必填
}

type VcsHunk = {
  oldStart: number; oldLines: number
  newStart: number; newLines: number
  lines: string[] // 保留 +/-/空格 前缀
}
type VcsFileDiff =
  | { kind: 'text'; path: string; before: boolean; after: boolean; hunks: VcsHunk[]; coarse?: boolean }
  | { kind: 'binary'; path: string }
  | { kind: 'oversized'; path: string }
type VcsDiffState = 'loading' | 'missing' | 'error' | VcsFileDiff
```

### 图的布局

- 输入是按 `git log --topo-order` 排好的 `CommitNode[]`；lane 分配参考 SourceGit 的 `PathHelper`：
  `Pass / Goto / End / Highlight`，第一父延续主 lane，其他父建/复用侧 lane，lane 结束时回收颜色。
- 工作区虚拟节点以固定 id 放在输入的第 0 行，父节点是 `HEAD` 的 sha，因此沿第一父规则延续 `HEAD` 的 lane；
  渲染时用虚线 path 和空心 dot 区分。范围为所有分支时 `HEAD` 不一定紧跟其后，虚线一直连到 `HEAD` 所在行；
  仓库还没有提交时虚拟节点没有父节点。
- 输出 `paths[] / links[] / dots[] / commitLeftMargin[]`；React 只负责把坐标映射成 SVG path 与行内元素。
- 分页追加时整图重算（O(n)，10k 内可接受），不尝试增量修补 lane；滚动锚点按 commit sha 恢复。
- refs/Selection 作为行数据渲染，不参与 lane 计算；HEAD/merge/root/工作区的 dot 样式单独处理。

### 复用与许可

| 来源 | 用法 | 许可 |
| --- | --- | --- |
| `git-graph-plus` | 移植 `git-graph-builder.ts` 的 lane 算法与 `buildPathD` 曲线 | Apache-2.0，保留 NOTICE/署名 |
| SourceGit | 图算法语义与边界情况对照 | MIT，保留版权声明 |
| DSH deliverables `FileDiff` | 内嵌/改编 `FileDiff.tsx` + CSS + `diff-rows`，接本地 `VcsHunk` | MIT，保留版权/NOTICE |
| DSH 主题 | 颜色、字体、圆角、焦点环与 Shiki token 走宿主 CSS 变量 | 跟随 DSH |

diff 只有内嵌 `FileDiff` 一套实现；不引入第三方 diff/图库，不把图形库或 SourceGit 的 C# 渲染层打进 bundle。

## 成功标准

- 打开面板后，工作区节点与第一页提交在首次加载中出现；默认选中节点的详情先显示头部和文件导航，不等待全部 diff。
- 读完一个节点的全部改动只需要滚动；不需要逐个文件点进点出。
- 5,000 条提交的时间线、200 个文件的 diff 流、5,000 行的单文件 diff 下仍可滚动/选中，不冻结页面；超出上限有明确提示。
- 切换仓库、选中节点、阅读位置后，重新可见能恢复；刷新不会把用户弹回顶部。
- 明暗主题、窄窗口、键盘操作、八种语言都能用；焦点顺序合理。
- 路由表里没有任何写操作；路径逃逸、选项注入、符号链接逃逸测试全部通过。
- 真实使用中，用户不需要为了“看一眼”而打开终端。

## 非目标与后续

V1 刻意不写仓库。后续若要加 stage/commit，必须先补：显式确认、写路由的 CSRF/认证边界、
失败回滚与并发保护；那是另一个设计，不在这里顺手加。

时间线让另外两类读操作变得自然，它们同样留给单独的设计：

- 范围对比：在时间线上选两个节点，看它们之间的累计 diff，详情沿用同一结构。
- 会话关联：把改动对应到会话轮次，回答“agent 这一轮改了什么”。
  这需要在会话开始或每轮结束时记录基线，会触及只读边界（例如 `git stash create` 会写对象库），必须先界定。
