# 设计：dsh-vcs-panel

## 要解决的问题

在 DSH 的会话里，用户经常要回答两个问题：**当前工作区改了什么？这些提交是怎么走到今天的？**
现在要么切到终端跑 `git status` / `git diff` / `git log --graph`，要么装一个 Git 插件；后者常把
staging、commit、push、分支、stash、rebase 全部堆进一个面板，看和改混在一起，diff 与历史图反而被挤成小区域。

这个插件只服务一条路径：**看改动 → 看历史 → 需要时再动手**。
“动手”留给终端或其他工具；V1 的插件本身只读。

只读是这一版的产品边界，不是永久限制。写操作需要单独设计授权、确认和冲突处理，不进入本设计。

## 理念

1. **先看，不改。** V1 的所有 Host 路由只读；不 stage、commit、checkout、merge、rebase、push、pull、fetch。
   把“读”做快、做准、做稳，比把 Git 的全部能力塞进一个面板更有价值。
2. **两个问题，两个视图。** `Changes` 回答“正在改什么”，`History` 回答“怎么走到这里”；
   不做一个 Git 命令控制台，也不把提交图和文件 diff 挤在同一列。
3. **长在 DSH 上。** 复用 primitives 的高亮、图标、菜单、弹层、代码块和主题 token；
   用户不应看出这是另一套界面。
4. **大仓库是常态。** 虚拟列表、分页、明确的行数/字节上限、显式截断提示；
   不为了一次性读全文件或全历史，把页面拖死。
5. **安静、可恢复。** 不自动弹窗、不轮询刷屏；切走再回来保留仓库、页签、选中项和滚动位置；
   刷新是显式动作，或在重新可见时做一次轻量刷新。
6. **复用先于重写。** diff 内嵌 DSH 内置 `FileDiff` 的源码，适配本地 hunk 类型；图的 lane 算法用
   `git-graph-plus` 对 SourceGit 的 TypeScript 移植。每一处复用都保留原许可声明。
7. **键盘可达。** 列表可上下移动、Enter 打开、Esc 返回；焦点始终可见，常用操作不依赖鼠标。

## 体验

### 位置与布局

插件注册到 `conversation.view` ring，id 为 `vcs`，order 20：Chat（0）、Trajectory（10）之后。
标签为 `Git`。

```text
┌──────────────────────────────────────────────────────────────┐
│ [repo ▾]  main ↑2 ↓0   ● 3 changed   [刷新]        [只读]  │
├───────────────────┬──────────────────────────────────────────┤
│ Changes │ History │  diff / commit detail                    │
│                   │                                          │
│ ▾ Staged (2)      │  src/view.jsx                  +12 −3    │
│   M src/view.jsx  │  ┌────────────────────────────────────┐  │
│   A src/new.js    │  │ @@ -40,6 +40,9 @@                 │  │
│ ▾ Unstaged (1)    │  │  40  40  const ...                 │  │
│   M README.md     │  │  41     - old                      │  │
│ ▾ Untracked (1)   │  │       42 + new                     │  │
│   ? notes.md      │  └────────────────────────────────────┘  │
└───────────────────┴──────────────────────────────────────────┘
```

- 顶部栏：仓库选择器、当前分支与 ahead/behind、改动摘要、刷新、只读标识。
- 左侧栏宽 280–480px，可拖拽；宽度按会话保存。
- 左侧上部是 `Changes / History` 切换；右侧是当前选中项的详情。
- 窄窗口（< 760px）退化为单栏：先列表，选中后进入详情，详情有返回按钮。

### Changes

- 三个分组：`Staged`、`Unstaged`、`Untracked`；空组不显示，全干净时显示空态。
- 文件行：状态字母/图标（M、A、D、R、U、?）、路径、增删行数；目录可折叠。
- 选中文件后，右侧显示该文件的 diff：
  - 顶部操作条：路径、增删统计、`Unified / Split`、自动换行、刷新/返回；diff 本体用内嵌的 DSH `FileDiff`。
  - `FileDiff` 接收已算好的 hunk（`oldStart/oldLines/newStart/newLines/lines`），支持 split/unified、
    旧/新行号、hunk header、Shiki 高亮、创建/删除/无变化提示、二进制/超大/读取失败状态。
  - 单文件最多 5000 行（与 `FileDiff` 的 `MAX_RENDERED_LINES` 一致）；超过时 Host 返回 oversized。
  - V1 不做 hunk 间未改动行的 gap 展开，也不做整文件模式；`FileDiff` 本身没有这两项。
- 多个仓库：仓库选择器列出会话工作目录所属仓库，以及工作区内一层深的子仓库；切换仓库保留各自的选中项。
- 刷新：手动按钮；重新可见时若数据超过一个短 TTL 才自动刷新。没有定时轮询。

### History

- 提交列表：左侧 lane 图（SVG），右侧 subject、refs、作者、时间；固定行高，虚拟滚动。
- refs：当前分支（HEAD）、本地分支、远程分支、tag 用不同徽标；选中提交高亮。
- 默认看当前 `HEAD` 的历史；可切到“所有分支”，选择按会话保存。
- 分页：每页 300 条，底部“加载更多”；最多 10,000 条，超过时明确提示。
  追加后重新生成图，保持滚动锚点。
- 选中提交：右侧显示完整 SHA（可复制）、父提交、作者/提交者、refs、完整消息、变更文件列表；
  选中文件后显示该提交相对第一父提交的 diff；root commit 与空树比较。
- 空仓库、无提交、读取失败、历史被截断都有独立状态。

### 交互与状态

- 键盘：`↑/↓` 或 `j/k` 移动，`Enter` 打开，`Esc` 返回；输入框内不拦截。
- 工作区没有改动时默认打开 `History`，有改动时默认打开 `Changes`；用户点过页签后按用户选择，不再自动切换。
- 选中项、页签、仓库、滚动位置按 `sessionId` 存在 `sessionStorage`；刷新页面可恢复。
- 不提供设置页；只在 Host 配置层保留 `enabled: false` 的关闭开关，关闭时不注册路由与视图。
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

所有路由通过 `ctx.connection.fetch.register` 注册，和 DSH 其他路由共用认证栅栏；只读。
未跟踪目录默认只显示目录行，展开时走 `vcs.untracked`，避免 status 一次列出全部文件。
Host 计算并归一化 hunk；客户端 `FileDiff` 只负责渲染，不再二次比较。
Git 通过注入的 `subprocess` 执行，固定 argv、`--no-pager`、`--no-ext-diff`、`GIT_OPTIONAL_LOCKS=0`；
不经过 shell，不用用户输入拼接选项。读取路径必须落在会话仓库根内：
先 `realpath` 再做 containment，符号链接不能逃逸；拒绝 `-` 开头的 ref/path。

限制：单条 git 命令 30s 超时、stdout 8 MB、stderr 保留尾部；超时/超限返回结构化错误，
不把原始环境或绝对路径堆栈抛给浏览器。错误统一为 `{ code, message }`，客户端按状态展示。

### Client

- 构建：`src/entry.jsx` 由 esbuild 打成 CommonJS，React、`react/jsx-runtime`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store` 保持 external，
  再由 `scripts/wrap.mjs` 加上 `window.__ModuleLoader__.load` 包装，输出单文件 `client.js`。
  `client.js` 是产物，不手改。
- 注册：`ctx.slots.inject('conversation.view', ...)` 注册 `vcs` 页；inject `slots`、`uiSession`、`locale`。
- 语言：`locale` NS 为 `vcs`，维护 zh、en、ja、es、fr、de、ru、pt 八种语言；没有字典时回退英文。
  日期、相对时间与数字分组按当前语言格式化，语言切换后随视图重新渲染。
- 状态：视图内 React state + `sessionStorage`（key 为 `vcs:<sessionId>`），不写 Host；
  仓库/页签/选中路径/滚动位置可恢复。
- 数据层：`api.js` 统一 fetch，`AbortController` 取消过期请求；按 `repo + scope + path + rev` 缓存最近结果；
  不轮询，刷新由挂载、手动按钮、重新可见触发。
- diff：`vcs.diff` 返回 hunk，转成 `FileDiff` 的 state；`FileDiff` 负责 split/unified、行号、hunk header、
  Shiki 高亮和状态；`t` 走 vcs locale 适配。内容全部走 React 文本，不塞 `dangerouslySetInnerHTML`。
- `FileDiff` 源码内嵌在 `src/client/diff/`（组件 + CSS + `diff-rows`），不深引用 deliverables 包；
  源码头的 MIT/来源说明保留。CSS module 用 esbuild 的 `local-css` loader；若不想依赖 loader，改成 `vcs-diff-`
  前缀的普通 CSS。提交详情复用同一个 `FileDiff`，不维护第二套 diff 组件。
- 图：`src/client/history/layout.js` 是 git-graph-plus `buildFullGraph` 的移植/裁剪，
  `src/client/history/Graph.jsx` 用 SVG 画 lanes/links/dots；列表固定行高 30px，只渲染可视区 ±10 行；
  图与列表共用滚动容器/行高，避免错位。

### 数据形状

```ts
type RefKind = 'head' | 'branch' | 'remote' | 'tag'
type Ref = { name: string; kind: RefKind }
type CommitNode = {
  sha: string
  parents: string[]
  refs: Ref[]
  author: string
  authorTime: number
  subject: string
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
- 输出 `paths[] / links[] / dots[] / commitLeftMargin[]`；React 只负责把坐标映射成 SVG path 与行内元素。
- 分页追加时整图重算（O(n)，10k 内可接受），不尝试增量修补 lane；滚动锚点按 commit sha 恢复。
- refs/Selection 作为行数据渲染，不参与 lane 计算；HEAD/merge/root 的 dot 样式单独处理。

### 复用与许可

| 来源 | 用法 | 许可 |
| --- | --- | --- |
| `git-graph-plus` | 移植 `git-graph-builder.ts` 的 lane 算法与 `buildPathD` 曲线 | Apache-2.0，保留 NOTICE/署名 |
| SourceGit | 图算法语义与边界情况对照 | MIT，保留版权声明 |
| DSH deliverables `FileDiff` | 内嵌/改编 `FileDiff.tsx` + CSS + `diff-rows`，接本地 `VcsHunk` | MIT，保留版权/NOTICE |
| DSH primitives | `Button`、`Menu`、`Modal`、`useCodeHighlighter`、图标、弹层 | 跟随 DSH |

diff 只有内嵌 `FileDiff` 一套实现；不引入第三方 diff/图库，不把图形库或 SourceGit 的 C# 渲染层打进 bundle。

## 成功标准

- 打开面板后，普通仓库的状态与文件列表在首次加载中完成，不等待后续全量读取；选中文件能用 `FileDiff` 看到 split/unified diff。
- History 在 5,000 条提交、5,000 行 diff 下仍可滚动/选中，不冻结页面；超出上限有明确提示。
- 切换仓库、页签、选中项、滚动位置后，重新可见能恢复；刷新不会把用户弹回顶部。
- 明暗主题、窄窗口、键盘操作、八种语言都能用；焦点顺序合理。
- 路由表里没有任何写操作；路径逃逸、选项注入、符号链接逃逸测试全部通过。
- 真实使用中，用户不需要为了“看一眼”而打开终端。

## 非目标与后续

V1 刻意不写仓库。后续若要加 stage/commit，必须先补：显式确认、写路由的 CSRF/认证边界、
失败回滚与并发保护；那是另一个设计，不在这里顺手加。
