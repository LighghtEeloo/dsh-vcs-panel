# 实现：dsh-vcs-panel

本文记录实现契约：Host 路由与安全边界、核心数据形状、资源上限、Client 构建与宿主接缝、图与变更树管线，以及代码复用来源。

## Host 路由、安全与后端

### 注册与路由

Host 端为无运行时依赖的 Node ESM 插件，注入 `['connection', 'sessions', 'subprocess', 'fs']`。`apply` 仅在配置显式为字面量 `enabled: false` 时跳过路由注册（如需同时移除前端页签，需在 Plugins 中停用整个 bundle）。九条只读 `GET` 路由与五条写路由 `POST /api/vcs.sync`、`POST /api/vcs.switch`、`POST /api/vcs.branch`、`POST /api/vcs.tag`、`POST /api/vcs.commit-op` 注册在 `ctx.connection.fetch` 的认证栅栏内。读取的请求 `signal` 与插件生命周期 `AbortController` 组合，取消的请求保留 `AbortError`，不转为错误 JSON；写路由只接插件生命周期的 `signal`，浏览器离开不会中断已开始的抓取、快进、推送、切换、分支操作、标签操作或提交操作。

| 路由 | 查询参数 | 应答字段 |
| --- | --- | --- |
| `GET /api/vcs.repositories` | `sessionId` | `cwd`、`repositories[]`（`path`、`name`、`enclosing`、`vcs`、`capabilities`）、`truncated` |
| `GET /api/vcs.status` | `sessionId`、`repo` | `repo`、`vcs`、`capabilities`、`defaultNode`、`branch`、`workingCopy?`、`groups`、`total`、`truncated` |
| `GET /api/vcs.branches` | `sessionId`、`repo` | `branches[]`（`name`、`current`）、`truncated`（仅 `capabilities.branchSwitch` 为真时可用） |
| `GET /api/vcs.remotes` | `sessionId`、`repo` | `remotes[]`、`truncated`（仅 `capabilities.tagOps` 为真时可用） |
| `GET /api/vcs.untracked` | `sessionId`、`repo`、`path`（`/` 结尾） | `path`、`entries[]`（`name`、`path`、`type`）、`truncated`（仅 `capabilities.untracked` 为真时可用） |
| `GET /api/vcs.diff` | `sessionId`、`repo`、`scope`、`path`、`oldPath?`、`rev?` | `VcsFileDiff` |
| `GET /api/vcs.log` | `sessionId`、`repo`、`ref`、`limit`、`skip` | `commits[]`、`truncated`、`nextSkip` |
| `GET /api/vcs.commit` | `sessionId`、`repo`、`sha` | `commit`（`CommitDetail`，不含 patch）、`truncated` |
| `GET /api/vcs.turn` | `sessionId`、`turn`、`seq?` | `turn`、`head`（`TurnHead \| null`）、`changed`、`added`、`deleted` |
| `POST /api/vcs.sync` | JSON 请求体 `{ sessionId, repo }` | `upstream`、`pulled`、`pushed`（仅 `capabilities.sync` 为真时可用） |
| `POST /api/vcs.switch` | JSON 请求体 `{ sessionId, repo, branch }` | `branch`（仅 `capabilities.branchSwitch` 为真时可用） |
| `POST /api/vcs.branch` | JSON 请求体 `{ sessionId, repo, action, branch, name?, local?, force? }` | 本地：`rename` → `{ from, branch }`；`delete` → `{ branch }`；`merge` → `{ branch, current, result }`；`rebase` → `{ branch, current }`；`push` → `{ branch, upstream, pushed }`。远程：`checkout-remote` → `{ branch, local }`；`delete-remote` → `{ branch }`；`merge-remote` / `pull-remote` → `{ branch, current, result }`（仅 `capabilities.branchOps` 为真时可用） |
| `POST /api/vcs.tag` | JSON 请求体 `{ sessionId, repo, action, tag, remote? }` | `delete` → `{ tag }`；`push` → `{ tag, remote, pushed }`（仅 `capabilities.tagOps` 为真时可用） |
| `POST /api/vcs.commit-op` | JSON 请求体 `{ sessionId, repo, action, sha, name?, message?, mode? }` | `tag` → `{ tag, sha }`；`branch` → `{ branch, sha }`；`checkout` → `{ sha }`；`cherry-pick` / `revert` / `drop` / `rebase` → `{ sha, current }`；`merge` → `{ sha, current, result }`；`reset` → `{ sha, current, mode }`（仅 `capabilities.commitOps` 为真时可用） |

### 输入校验与路径边界

客户端只传会话标识与候选路径，不能凭请求参数让服务端读取任意目录或注入命令选项：

- **会话与仓库白名单**：`sessionId` 必须命中带有效 `header.cwd` 的活跃会话；`repo` 必须命中当次 `discoverRepositories` 的结果（`sameRepoPath`）。
- **仓库发现与符号链接收敛**：从 `cwd` 向上最多 64 层查找最近的仓库标记，再扫描 `cwd` 下一层子目录（忽略 `node_modules`，不递归）。标记用 `lstat` 检测且 `.jj` 优先于 `.git`，兼容 linked worktree 的 `.git` 文件与 submodule。根路径经 `ctx.fs.resolve` 规范化，子仓库规范路径必须仍在 `cwd` 内；读取文件前再经 `containPath` 做 `realpath` 校验，确保目标留在仓库根内。
- **路径与修订号净化**：`validateRelPath` 拒绝绝对路径、反斜杠、空段、`.`、`..`、`-` 前缀与控制字符，Git 侧再包 `:(literal)` pathspec，Jujutsu 侧用 `file:"..."` fileset。提交 ID 先做 7–64 位十六进制校验；Git 再经 `rev-parse --verify <sha>^{commit}` 解析，Jujutsu 仅接受 `@` 或十六进制 ID。
- **写请求栅栏**：`vcs.sync`、`vcs.switch`、`vcs.branch`、`vcs.tag` 与 `vcs.commit-op` 只接受 `POST`，`content-type` 必须是 `application/json`（跨站页面不经 CORS 预检发不出），`Sec-Fetch-Site` 存在且不是 `same-origin` / `none` 时返回 `403 forbidden`；请求体中的 `sessionId` 与 `repo` 再走与读取相同的会话与仓库白名单。切换的 `branch` 与分支操作的 `branch`、`name`、`local` 必须是字符串：拒绝空串、超过 255 字符、空白或控制字符、`-` 前缀。`vcs.branch` 的 `action` 必须是 `rename`、`delete`、`merge`、`rebase`、`push`、`checkout-remote`、`delete-remote`、`merge-remote` 或 `pull-remote` 之一；`name` 只用于 `rename`，`local` 只用于 `checkout-remote`，`force` 只用于 `delete` 且必须是布尔值。本地分支操作的目标必须命中该仓库的本地分支列表；重命名与远程检出的新名字还要通过 `git check-ref-format refs/heads/<name>`。远程分支操作的目标必须由后端按 `git remote` 的最长远程名切分，并命中一个真实、非符号引用的 `refs/remotes/<remote>/<branch>`；不支持 `<remote>/HEAD`。删除只发送 `refs/heads/<branch>` 且不带 `--force`；拉取只抓取命名的 `refs/heads/<branch>` 到对应的 `refs/remotes/<remote>/<branch>`。`vcs.tag` 的 `action` 必须是 `delete` 或 `push`；`tag` 拒绝空串、超过 255 字符、空白或控制字符与 `-` 前缀，再通过 `git check-ref-format refs/tags/<name>` 并确认该 ref 存在；`push` 的 `remote` 必须命中 `git remote` 的结果。`vcs.commit-op` 的 `action` 必须是 `tag`、`branch`、`checkout`、`cherry-pick`、`revert`、`drop`、`merge`、`rebase` 或 `reset`；`sha` 为 7–64 位十六进制；`tag` / `branch` 的 `name` 复用引用名校验；`tag` 的 `message` 是长度不超过 4,000 的字符串；`reset` 的 `mode` 必须是 `soft`、`mixed` 或 `hard`。同一仓库根同时只允许一次写操作，第二次返回 `409 busy`；这些写互相排斥。

失败统一返回 `{ error: { code, message } }`，不携带宿主绝对路径、原始命令或堆栈：

| `code` | HTTP | 触发情形 |
| --- | --- | --- |
| `bad-request` / `not-a-repo` | 400 | 参数非法，或仓库不在当前会话发现列表内 |
| `not-found` | 404 | 目标文件或提交不存在 |
| `no-session` / `no-cwd` | 409 | 会话不存在或无工作目录 |
| `output-too-large` | 413 | 子进程输出超出字节上限（`lossy`） |
| `vcs-missing` / `timeout` | 503 | 宿主缺少 `git`/`jj` 可执行文件，或命令超时 |
| `internal` | 500 | 未预期的后端失败 |
| `forbidden` | 403 | 浏览器声明为跨站的写请求 |
| `busy` | 409 | 同一仓库已有写操作在进行 |
| `no-upstream` | 409 | 分离头指针、分支没有上游，或上游在远程上不存在 |
| `diverged` | 409 | 分支与上游各有新提交 |
| `pull-blocked` | 409 | 快进被拒绝（通常是本地改动会被覆盖） |
| `remote-failed` | 502 | 抓取或推送失败：远程不可达、凭据或远程钩子拒绝、与其他推送者竞争 |
| `switch-blocked` | 409 | 切换被拒绝（本地改动或未跟踪文件会被覆盖、分支已在别的工作树检出） |
| `switch-failed` | 409 | 切换命令因其他原因失败 |
| `branch-invalid` | 400 | 重命名的新名字不是有效分支名 |
| `branch-exists` | 409 | 重命名的新名字已存在 |
| `branch-unmerged` | 409 | 删除的分支未完全合并；客户端据此升级为二次确认 |
| `branch-in-use` | 409 | 目标分支已在另一个工作树检出，或试图删除当前分支 |
| `merge-blocked` | 409 | 合并被冲突、本地改动或未完成的合并阻止；自己发起的合并会中止，已存在的合并不被触碰 |
| `rebase-blocked` | 409 | 变基被冲突、本地改动或未完成的变基阻止；自己发起的变基会中止，已存在的变基不被触碰 |
| `branch-failed` | 409 | 分支命令因其他原因失败 |
| `tag-missing` | 404 | 标签不存在或已删除 |
| `remote-missing` | 409 | 标签推送目标不在当前仓库的远程列表中 |
| `remote-branch-missing` | 409 | 远程分支不存在、已删除，或目标是对应远程的符号 HEAD |
| `tag-push-failed` | 502 | 远程拒绝标签：不可达、凭据或远程钩子拒绝、远程已有不同对象 |
| `tag-failed` | 409 | 标签命令因其他原因失败 |
| `tag-invalid` | 400 | 提交菜单的标签名不合法 |
| `tag-exists` | 409 | 提交菜单要创建的标签已存在 |
| `checkout-blocked` | 409 | 提交检出被拒绝（本地改动或未跟踪文件会被覆盖） |
| `commit-not-on-branch` | 409 | 丢弃的提交不在当前分支上 |
| `commit-conflict` | 409 | 拣选、还原或丢弃冲突并已中止，分支保持不变 |
| `commit-blocked` | 409 | 提交操作被本地改动、已有操作或不支持的提交形态阻止 |
| `commit-failed` | 409 | 提交操作因其他原因失败 |

写操作失败时，`stderr` 末尾三行去掉 URL 中的凭据后只写入 Host 日志（`VcsError.detail`），不进入应答。

### 命令隔离与后端能力

两个后端共用 `CommandRunner`（`lib/command.js`），以固定 argv 直接执行子进程，不经过 shell；环境收窄为 `LC_ALL=C` 加后端白名单，防止仓库配置重定向输出、拉起编辑器或持锁：

- **Git**：固定 `-c core.quotepath=false`，环境设 `GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`；比较命令加 `--no-pager`、`--no-ext-diff`、`--no-color`、`-U3`。
- **Jujutsu**：固定 `--color=never`、`--no-pager`，环境设 `JJ_EDITOR=true`；除工作副本快照外的读取均带 `--ignore-working-copy`。

每个后端实现 `require`、`head`、`status`、`log`、`commit`、`diff`（可选 `untracked`、`sync`、`branches` / `switchBranch`、`renameBranch` / `deleteBranch` / `mergeBranch` / `rebaseBranch` / `pushBranch`、`remotes` / `deleteTag` / `pushTag`、`addTag` / `createBranch` / `checkoutCommit` / `cherryPickCommit` / `revertCommit` / `dropCommit` / `mergeCommit` / `rebaseCommit` / `resetCommit`）并声明 `capabilities`；Client 仅按能力对象驱动布局，不按后端名称分支：

| 能力字段 | Git | Jujutsu |
| --- | --- | --- |
| `workingCopy` / `workingCopyNode` | `'row'` / `null` | `'commit'` / `'@'` |
| `staging` / `untracked` / `aheadBehind` / `sync` / `branchSwitch` / `branchOps` / `tagOps` / `commitOps` | `true` | `false` |
| `changeId` / `snapshots` | `false` | `true` |
| `ranges`（`defaultRange`） | **`HEAD`**、`all` | **`@`**、`all` |

两个后端的读写规则差异：

- **Git**：`head` 仅读取 `symbolic-ref -q --short HEAD` 与 `rev-parse -q --verify HEAD^{commit}`，不扫描索引与工作区；`status` 组合 `status --porcelain=v2 -z --branch --untracked-files=normal` 与两次 `diff --numstat -z`（index 与工作区），按 `XY` 拆成 `staged`、`unstaged`、`untracked`（两侧均改时各出现一次，冲突标 `U`）。`diff` 按 `staged`（对 `HEAD`）、`unstaged`（对 index）、`untracked`（按新文件合成）、`commit`（对第一父，root 对空树）取值；空仓库读取 `HEAD` 日志视为空历史而非错误。
- **Git 同步**（`lib/sync.js`）：从 `symbolic-ref` 与 `branch.<name>.remote` / `branch.<name>.merge` 读出分支与上游（远程名拒绝 `-` 前缀与控制字符，上游必须是 `refs/heads/…`），远程不是 `.` 时执行 `fetch --quiet <remote>`，再用 `rev-list --left-right --count HEAD...@{upstream}` 比较：两侧都有提交返回 `diverged`；只落后执行 `merge --ff-only --quiet @{upstream}`；只领先执行 `push --porcelain <remote> refs/heads/<branch>:<merge>`。不带 `--force`，不跳过钩子，抓取与推送使用远程命令超时。
- **Git 分支切换**：`branches` 用 `for-each-ref --sort=-committerdate --count 501 --format=%(refname:short)%00%(HEAD) refs/heads` 读取本地分支，`current` 来自 `%(HEAD)`；只列 `refs/heads`，远程跟踪分支不在其中，也不会被检出为新的本地分支。`switchBranch` 先在同一列表中确认目标，再用 `git switch --no-guess --quiet <branch>`；不带 `--force`、不贮藏、不丢弃改动，Git 自己拒绝会覆盖本地或未跟踪文件的切换，该拒绝映射为 `switch-blocked`。目标已是当前分支时直接返回，不执行命令。
- **Git 分支操作**（`lib/branch-ops.js`）：本地分支方法先在 `branches` 的结果里确认目标；当前分支上的删除直接返回 `branch-in-use`。
  远程分支方法先用 `remoteNames`（`git remote`）按最长远程名切分 `remote/branch`，再用 `for-each-ref` 确认 `refs/remotes/<remote>/<branch>` 存在且不是符号引用；`refs/remotes/<remote>/HEAD` 一律拒绝。
  `checkoutGitRemoteBranch` 用 `git switch --no-guess --quiet --track -c <local> refs/remotes/<remote>/<branch>` 创建跟踪本地分支并检出，本地名已存在或无效时分别返回 `branch-exists` / `branch-invalid`，切换受阻返回 `switch-blocked`。
  `deleteGitRemoteBranch` 执行 `git push --porcelain <remote> --delete refs/heads/<branch>`，成功后删除对应的远程跟踪引用；远程拒绝返回 `remote-failed`。
  `mergeGitRemoteBranch` 复用本地合并的冲突中止逻辑，只是目标 ref 换成远程跟踪引用。
  `pullGitRemoteBranch` 先用 `fetch --quiet <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>` 更新该跟踪引用，再执行同一合并逻辑；抓取失败返回 `remote-failed`。
  `renameGitBranch` 用 `check-ref-format refs/heads/<name>` 校验新名字、用 `rev-parse` 确认未占用，再执行 `git branch -m <old> <new>`（当前分支会随之移动 `HEAD` 的名称，upstream 配置由 Git 保留）。
  `deleteGitBranch` 默认执行 `git branch -d`；未完全合并时返回 `branch-unmerged`，只有请求带 `force: true`（来自“仍然删除”）才执行 `git branch -D`。
  `mergeGitBranch` 在 `MERGE_HEAD` 已存在时拒绝触碰用户的合并；前置记录 `HEAD` 与目标 tip，执行 `git merge --no-edit --quiet <branch>`，按新 `HEAD` 与两端的关系返回 `up-to-date` / `fast-forward` / `merged`；失败时仅当本次命令留下 `MERGE_HEAD` 才执行 `git merge --abort`，随后返回 `merge-blocked`。
  `rebaseGitBranch` 在 `REBASE_HEAD` 已存在时拒绝触碰用户的变基；执行 `git rebase <branch>`，失败时仅当本次命令留下 `REBASE_HEAD` 才执行 `git rebase --abort`，随后返回 `rebase-blocked`。
  `pushGitBranch` 读取 `branch.<name>.remote` / `merge`（远程拒绝 `-` 前缀与控制字符，上游必须是 `refs/heads/…`），执行 `git push --porcelain <remote> refs/heads/<branch>:<merge>`；不抓取、不快进、不带 `--force`。porcelain 输出中除 `To …` 与 `Done` 外的引用行用于判断是否真的推送（`=` 表示已同步），远程拒绝返回 `remote-failed`。
- **Git 标签操作**（`lib/tag-ops.js`）：`remotes` 读取 `git remote`，丢弃空名、空白/控制字符与 `-` 前缀的名字，最多列出 500 个。`deleteGitTag` 与 `pushGitTag` 先用 `check-ref-format refs/tags/<tag>` 校验名字、再用 `show-ref --verify --quiet` 确认标签存在；删除执行 `git tag --delete <tag>`，只移除本地 ref。推送把 `remote` 与 `git remote` 的结果逐字比对，再执行 `git push --porcelain <remote> refs/tags/<tag>:refs/tags/<tag>`；不带 `--force`，远程已有不同对象时返回 `tag-push-failed`。porcelain 中 `=` 表示已同步，其余引用行表示这次真的推送。
- **Git 提交操作**（`lib/commit-ops.js`）：`addGitTag` 先用 `check-ref-format refs/tags/<name>` 校验并确认未占用，再执行 `git tag`；带 `message` 时创建附注标签。`createGitBranch` 校验 `refs/heads/<name>` 后用 `git branch <name> <sha>` 创建分支，不检出。`checkoutGitCommit` 执行 `git switch --detach --quiet <sha>`。`cherryPickGitCommit` / `revertGitCommit` 分别执行 `git cherry-pick <sha>` / `git revert --no-edit <sha>`，冲突时仅当命令留下 `CHERRY_PICK_HEAD` / `REVERT_HEAD` 才执行对应 `--abort`，返回 `commit-conflict`。`dropGitCommit` 要求目标在当前分支上、只有单父提交，执行 `git rebase --onto <parent> <sha> <branch>`；冲突时执行 `git rebase --abort`。`mergeGitCommit` / `rebaseGitCommit` 与分支版本使用同样的预检与中止规则，引用来自已解析的提交。`resetGitCommit` 只执行 `git reset --soft|--mixed|--hard <sha>`；Hard 是唯一会丢弃索引/工作区改动的路径，且必须由对话框明确选择。
- **Git 远程引用标注**：`log` 解析 `refs/remotes/...` 后，若有远程引用则读取 `git remote`，用最长远程名给每个引用补上 `remote` 与 `branch`；`origin/HEAD` 这类符号引用不标注。时间线只对有这两个字段的远程徽标开放菜单，服务端仍会再次校验。
- **Jujutsu**：每次 `status` 刷新执行一次 `jj log --no-graph -r @ -T commit_id` 快照工作副本（并发请求复用同一 Promise，失败清空缓存），其余读取（含轮末 `head` 读取 `change_id`）均带 `--ignore-working-copy` 复用已记录状态，不触发额外快照。`log` 使用 `::@ ~ root()` 或 `all() ~ root()`；`diff` 使用 `jj diff --git -r <rev>`，输出含 NUL 或 `U+FFFD` 时按二进制处理。
- **每轮摘要与头指针记录**：`createTurnTracker`（`lib/turns.js`）监听活跃会话的 `session/event`、`agent/turn-stopping`、`tools/pre-execute` 与 `session/disposed`，在有工具执行或 `workspace/changes` 的轮次结束时串行读取外围仓库的 `head`（下一轮工具执行前等待上一轮完成，防止跨轮切分支串台）。`vcs.turn` 通过 `ctx.get('workspaceChanges')` 可选读取宿主的每轮 `{ total, added, deleted }`（校验 `turn` 与 `seq` 归属一致，剔除宿主路径与文件明细），并与该轮 `head` 合并返回；两者均不存在（如 Host 重启后的历史轮次）时返回 `404 not-found`。

## 核心数据形状

```ts
type RefKind = 'head' | 'branch' | 'bookmark' | 'remote' | 'tag'
// Git：HEAD 指向的当前分支带 current: true，分离头指针才单独出现 head
// Jujutsu：本地书签为 bookmark，远程书签为 remote（如 main@origin）
// Git 的远程跟踪引用额外带 remote 与 branch（如 origin + topic）；解析不出时为 undefined
type Ref = { name: string; kind: RefKind; current?: true; conflict?: true; remote?: string; branch?: string }

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
| 每组状态文件数（Git）/ 单提交详情文件数 / 未跟踪目录展开条目数 / 本地分支列表 / 远程列表 | 各 500 | Host `status` / `commit` / `untracked` / `branches` / `remotes` |
| 单文件 diff 输出 / 渲染行数 | 2 MB / 5,000 行 | Host `diff`、Client `FileDiff` |
| “全部展开”的 diff 预算 | 单文件 1,000 行；单节点累计 20,000 行 | Client `budgetFolds`、`expandedFileFolds` |
| diff 请求并发 / 视口预载距离 / 结果缓存 | 4 个并发 / 800 px / 最近 300 条 | Client 请求队列与缓存 |
| 历史分页 / 最多加载提交数 | 300 条/页，最多 10,000 条 | Host `log` |
| 单会话保留的轮末头指针 / 客户端空闲轮次摘要缓存 | 2,000 轮 / 500 条 | Host `TurnTracker`、Client `turn-summary` |
| 单条后端命令 | 30 s 超时（远程抓取与推送 120 s，含钩子），stdout 8 MB，stderr 尾部 16 KB，终止宽限 2 s | Host `CommandRunner`、`lib/sync.js`、`lib/branch-ops.js`、`lib/tag-ops.js`、`lib/commit-ops.js` |
| 页面重新可见自动刷新阈值 / Jujutsu 快照频率 | 隐藏超过 30 s 刷新一次 / 每次刷新快照一次 | Client 可见性监听、Jujutsu 后端 |
| 加载轮廓与进度线的淡入延迟 | 180 ms（`--vcs-skeleton-delay`） | Client `styles.css` |
| 转动图标：巡航周期 / 起转 / 收尾滑行 | 900 ms 一圈（减少动效 2,400 ms）/ 加速 90° / 250–1,000 ms | Client `turning.js` |
| 进度线淡出 | 240 ms（`PROGRESS_FADE`） | Client `TopBar.jsx`、`styles.css` |

变更树当前一次渲染全部可见行，仅按需加载 diff 本体。

## Client 构建、宿主接缝与状态

### 构建与本地化

`scripts/build.mjs` 用 esbuild 将 `src/client/entry.jsx` 打成单文件 CommonJS 产物 `client.js`（`--check` 校验产物是否最新），仅将宿主模块表提供的 `react` 与 `react/jsx-runtime` 设为 external，并在外层包裹 `window.__ModuleLoader__.load({ id, factory })`。CSS 以文本打入 bundle，挂载时注入单个 `<style>`，类名统一使用 `vcs-` 前缀。八种界面语言注册在 `vcs` 命名空间，插件列表展示名与描述位于 `locale/*.json`。

### 宿主接缝

Client 顶层注入 `['slots', 'locale', 'uiConversation', 'sidebarRight', 'sidebarRightTabs']`。以下宿主接缝均设有明确的恢复或降级边界：

- **页签注册与崩溃隔离**：注册右侧栏页签类型 `{ id: 'dsh-vcs-panel', kind: 'vcs', guide: [...] }`，正文与标题分别注册到 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`，key 均为 `dsh-vcs-panel`。引导卡片用 `view.label` 作标题、`sidebar.guide` 作说明、轮末横幅的 `GitBranchIcon` 作图标，并显示快捷键；`order: 15` 让卡片紧跟在文件卡片（10）之后、终端（20）之前。正文内包 `ViewErrorBoundary`：捕获渲染错误后展示重试页，将时间、错误与截断至 12,000 字符的调用栈写入 `sessionStorage` 的 `vcs:last-error`，重试时保留原会话状态重新挂载。
- **Turn 改动判定与每轮摘要缓存**：`createTurnChangesDefinition` 注册 `vcs-changes` 事件定义，聚合每轮最新的 `workspace/changes` 事件序号（`seq`）与成功的文件写入工具结果；Conversation 引擎要求 Location 数据键与定义 `kind` 完全同名，因此键固定为 `vcs-changes`。`conversation.chat.turnTail` 条目（`order: -10`）仅在该标志为真时按 `(sessionId, turn, seq)` 从 `turn-summary.js` 读取一次 `/api/vcs.turn`：已解析结果在客户端按 LRU 缓存，切回 Chat 直接同步渲染；`404`/`400`/`409` 记为 `missing` 不再重复请求（回退展示“打开版本管理”）；净改动文件数为 0 的轮次隐藏横幅；连接重置（`connection/reset`）时仅重拉未就绪条目。点击横幅调用 `ctx.sidebarRight.openTab('vcs')`。
- **入口与键盘焦点**：轮末横幅与全局快捷键打开同一个右侧栏页签。快捷键 `vcs.view.toggle` 在可选的 `['shortcuts', 'sessions']` 作用域注册（默认键位冲突时回退为空绑定），用 `mainSessionId` 与 `sidebar.mounted` 确认控制器作用在屏幕上的会话；右侧栏正展开且活动页签是 VCS 时 `hide(tab.id)` 收起右侧栏——页签与正文保持挂载，宿主滑走的是面板本身，避免关闭页签后先卸载内容再收起造成的跳变；否则 `openTab('vcs')` 打开或显示页签。正文通过框架注入的 `useTabInfo()` 读取 `tab`：页签可见且 `tab.navigation.revision > 0` 时递增聚焦请求；`VcsView` 等宿主聚焦面板容器后再把焦点移到时间线当前行。页面恢复的页签（revision 0）不抢焦点。
- **隐藏宿主改动卡片**：`workspace-changes` 拒绝 `maxFiles: 0`，因此 `cordis.patch.yml` 不改动宿主配置，改由样式规则 `[data-turn-tail] [data-changed-files] { display: none !important; }` 仅隐藏文件卡片，保留改动记录器与 `present` 交付卡片。宿主 DOM 标记变更时仅退化为重新显示原卡片。

### 状态持久化与锚点恢复

会话状态保存在 `sessionStorage` 的 `vcs:<sessionId>`，包含 `repo`、`node`、`nodeChosen`、`ref`、`dirs`、`collapsed`、`folds`、`anchor`（`{ key, offset }`）、`split`、`wrap`、`twoColumns`（默认 `true`，只有显式 `false` 表示单栏）、`sidebarWidth` 与 `timelineScroll`；内存另外按仓库记住切换前的选中节点、目录折叠与历史范围。页签身份与右侧栏布局由宿主的 `sidebarRight` 存储按会话保存，应用重启后恢复；面板自己的阅读状态（含时间线宽度）单独保存。

`folds` 只为用户显式操作过的文件保存布尔值：空记录表示文件全部收起，也就是详情的默认形态。行键前缀白名单为 `staged|`、`unstaged|`、`commit|`；`sanitizeState` 在读取时丢弃未知字段与旧版遗留的 `untracked|` 键。数据刷新、折叠全部文件或收起吸顶文件头时，统一先记录锚点行与行内像素偏移，重排后恢复；锚点行未渲染时沿“文件行 → 父目录链 → 分组行”降级。

顶部栏的分支菜单不进入持久化状态：每次打开菜单都重新读取本地分支（分支可能在面板外被创建或改名），上一份列表在重读期间保留。分支、远程分支、标签与提交操作菜单由 `VcsView` 持有与渲染（`RefActionsMenu`），顶部栏的分支控件、提交历史里的分支/远程分支/标签徽标和提交行都只上报被右键的 ref 或提交、指针位置与焦点归还目标；菜单的键盘、关闭与定位因此只有一份实现。分支、远程分支、标签与提交操作的对话框、错误与进行中状态也只留在内存；操作成功后关闭对话框、重新读取状态与历史，并让分支菜单下次打开时刷新分支列表。标签推送对话框在打开时读取 `/api/vcs.remotes`，关闭或切换仓库时中止这次读取；删除只移除本地标签，推送不强制，失败留在对话框里供重试或取消。提交操作中，检出与 Hard 重置成功后清空旧 HEAD 的选中节点、折叠、锚点与 diff 缓存；其余动作保留阅读位置，节点被改写时由详情的 `onMissing` 回退。切换成功后，选中节点、折叠记录、未跟踪目录展开、阅读锚点与 diff 缓存一并清空，由状态应答按新分支重新选择默认节点；切换被拒绝时只显示提示，视图保持原样。其他分支、远程分支、标签或提交操作成功后保留当前选中节点与阅读位置，节点若已被改写则由详情的 `onMissing` 回退到默认节点。

### 图布局与变更树管线

- **时间线图布局**：`buildGraph` 接收拓扑序节点，按 `pass / goto / end` 遍历活动 lane（第一父延续当前 lane，其余父节点分配或复用侧 lane，lane 结束时回收颜色；Git 工作区虚节点以虚线连向 `HEAD`），输出路径与圆点坐标，与虚拟列表共用滚动容器渲染；分页追加时 O(n) 重算整图并按提交锚点恢复位置。
- **变更树与请求调度**：客户端将 Git 的 `untracked` 条目并入 `unstaged` 分组（可按需展开的未跟踪目录不参与单子目录链压缩），生成单一扁平行列表供渲染、roving tabindex 键盘导航与滚动锚点共用；文件默认收起，只有展开的行才请求 `vcs.diff`。发起请求时仍按条目自身状态还原 `scope`（`?` 走 `untracked`，重命名带 `oldPath`）。变更树窄于 640 px（`SPLIT_MIN_WIDTH`）时将 `FileDiff` 的 `split` 置为 `false` 单栏渲染。展开文件由 `IntersectionObserver` 入队请求，离开视口时经 `AbortController` 取消。`↑` / `↓` 或 `j` / `k` 沿一条纵向列表移动：分组、目录、文件行与展开文件的 hunk header 共用同一光标，hunk header 设 `tabIndex=-1` 以便程序聚焦但仍沿用行的 roving tabindex；`[` / `]` 只按树行移动。滚动时按当前阅读位置把光标同步到所在行或 hunk，并保持阅读行、焦点和吸顶标题指向同一位置；`←` / `h` 在当前行是展开文件时先收起它，已收起时才回到时间线，`Esc` 保留为直接返回。键盘匹配排除 `AltGraph`，保证需要 AltGr 输入 `[` / `]` 的键盘布局可用。
- **右侧栏布局**：`VcsView` 按自身宽度与 `twoColumns` 偏好决定栏数：`singleColumn = narrow || !twoColumns`，`narrow` 为根节点宽度 `< 760px`（`NARROW_WIDTH`）；不为对话输入框预留底部空间。单栏时 `singleView`（`'timeline'` / `'detail'`）决定显示哪一栏，选中或进入节点切到详情，返回按钮与 `Esc` 回到时间线，切换仓库或会话时回到时间线。根节点的 `data-narrow` 只管窄栏顶部栏换行与高度自适应（避免右端控件被裁掉），`data-single-column` 让时间线在单栏时占满整宽。顶部栏开关（`.vcs-columns-toggle`）调用 `setTwoColumns`：宽栏里关掉时有选中节点则切到详情；窄栏只改偏好，不改正在显示的栏。

## 复用与来源

- **diff 与语法高亮**：外部插件不能加载 Harness Client 内部包，因此源码内嵌并适配 DSH 的 `FileDiff`（`src/client/diff/`），配合本地语法 tokenizer 引用宿主 `--shiki-token-*` CSS 变量跟随主题着色。
- **lane 图算法**：`src/client/history/layout.js` 裁剪移植自 `git-graph-plus` 的 `git-graph-builder.ts`（commit `c6c2a9a`，源自 SourceGit `PathHelper`），移除本面板不使用的 upstream 可达性与分支自定义配色；不引入第三方运行库，也不采用禁止再分发的 `vscode-git-graph`。
