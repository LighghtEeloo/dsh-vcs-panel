# dsh-vcs-panel

[English](README.md) | 中文

> DeepSeek Harness 会话里的只读版本管理页：工作区改动、文件 diff，以及带 lane 图的提交历史。

**状态：v0.1.0。** 产品设计见 [`DESIGN.md`](DESIGN.md)，变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 安装

需要 DSH 0.2.2-rc.1 或更新版本，且 Host 提供 Web Client（Desktop 与 Web 均可）。

```sh
dsh plugin --profile desktop add link:/path/to/dsh-vcs-panel
```

也可以用 `plugin_manager` 的 `install_bundle`，或在 Web 侧栏的 **Plugins** > **Add plugin** 里选择该目录。
安装 Host 半之后重启 DSH。

## 能做什么

会话视图页签里会多出一个“版本管理”（英文及其他语言显示 `VCS`，避免名称过长被截断；位于 Chat、Trajectory 之后），不打开终端就能在一条时间线上回答两个问题：现在改了什么，仓库怎么走到这里。

- **时间线**（左侧）。第一行是工作区：改动文件数与增删行数，干净时显示“没有改动”。下面是从 `HEAD` 或所有分支可达的提交与彩色 lane 图；工作区用虚线连到 `HEAD`。提交行分两行：第一行是 subject，第二行是 ref 徽标（`HEAD` 所指分支合成一个高亮徽标，对应 `HEAD -> main`）、短 ID、作者（已加载历史有多位作者时才显示）和时间。
- **详情**（右侧）。选中工作区或提交，显示同一种结构：头部、改动文件列表，以及所有文件的 diff 依次排开。工作区按已暂存、未暂存、未跟踪分组：已暂存对 `HEAD`，未暂存对 index，未跟踪按新增文件。提交显示 subject、作者/提交者、父提交（已加载的父提交可点击跳转）、消息正文，以及各文件相对第一父提交的 diff（根提交与空树比较）。重命名同时显示旧、新路径，并按源路径比较。diff 支持 unified / split 与自动换行。

点击文件列表中的文件，diff 流滚到该文件；文件列表标出正在阅读的文件。diff 在进入视口附近时才加载，同时只发少量请求。改动超过 1,000 行的文件默认折叠；一个节点累计超过 20,000 行改动后，其余文件也默认折叠，点一下即可展开。

顶部栏选择仓库（会话工作目录所属仓库，以及其下一层的子仓库），显示分支与 ahead/behind，并切换历史范围。锁形标识（悬停提示“只读”）是产品边界：所有 Host 路由只读，不做 stage、commit、discard、checkout、merge、rebase、stash、fetch、pull、push。

数据在打开面板、点击刷新、以及面板隐藏超过 30 秒后重新可见时刷新一次；没有定时轮询。刷新后保留选中节点和阅读位置。

## 交互

- 点击时间线中的行查看详情；点击文件跳到它的 diff；点击目录或 diff 头部折叠。
- 没有手动选择时，工作区有改动就显示工作区，干净时显示 `HEAD` 提交；手动选过之后按本次会话的选择，不再自动切换。选中的提交消失（amend、rebase）时回到默认规则。
- 键盘（输入框和下拉框内不拦截）：
  - 时间线：`↑`/`↓` 或 `j`/`k` 选择上一行/下一行；`Enter` 或 `→` 进入文件列表。
  - 文件列表：`↑`/`↓` 或 `j`/`k` 切换文件，diff 流随之滚动；`Enter` 折叠目录；`←` 或 `Esc` 回到时间线。
  - diff 流：`Esc` 回到文件列表。
- 时间线可拖动分隔条调整宽度（280–480 px），分隔条获得焦点后也可用方向键调整。详情区窄于 720 px 时，文件列表收到 diff 上方，作为可折叠列表；面板窄于 760 px 时，时间线和详情分屏显示，详情有返回按钮。
- 仓库、选中节点、历史范围、目录与 diff 的折叠状态、布局选择和阅读位置按会话存在 `sessionStorage`，刷新页面可恢复。
- 明暗主题、系统字号、焦点环和 `prefers-reduced-motion` 走 DSH 约定。

## 上限

| 项目 | 上限 |
| --- | --- |
| 每个会话列出的仓库 | 50（会话仓库 + 一层子仓库） |
| 每组状态文件数 | 500 |
| 展开一个未跟踪目录的条目 | 500 |
| 每个文件渲染的 diff 行数 | 5,000；超出返回 `oversized` |
| 默认展开的 diff | 改动不超过 1,000 行的文件，每个节点累计到 20,000 行改动为止 |
| 同时进行的 diff 请求 | 4 |
| diff 输出 | 2 MB |
| 每页提交 | 300 |
| 最多加载提交 | 10,000；更早的历史明确提示截断 |
| 单次 git 命令 | 30 秒，stdout 8 MB |

## 语言

内置中文、英文、日文、西班牙文、法文、德文、俄文、葡萄牙文字典；缺少字典的语言回退英文。日期、相对时间与数字分组跟随 DSH 当前语言。插件展示信息（标题与描述）在 `locale/*.json`。

## 目录

```text
index.js              Host：认证围栏内的只读 /api/vcs.* 路由
lib/                  Host 内部：git 执行、路径 containment、解析器、路由处理
src/client/           Client 源码（React，不加载任何 Harness Client 包）
  entry.jsx           注册版本管理视图、语言字典与样式
  VcsView.jsx         面板外壳：取数、选中、布局、拖宽、状态恢复
  api.js              Host 路由的 fetch 层
  history/            时间线：lane 布局移植、SVG 图、虚拟列表
  detail/             详情：文件分组、目录树、文件列表、diff 流、请求队列
  diff/               内嵌的 DSH FileDiff + 本地语法 tokenizer
client.js             由 scripts/build.mjs 从 src/client/ 生成，不手改
cordis.patch.yml      插件行（Host 配置 `enabled: false` 时什么都不注册）
locale/               各语言的插件展示信息
test/                 node --test 用例
```

## 配置

唯一的 Host 选项是开关，写在 profile 的 patch 行里：

```yaml
- id: dsh-vcs-panel
  name: dsh-vcs-panel
  config:
    enabled: false
```

`enabled: false` 时 Host 不注册任何路由。Client 半仍随 bundle 加载，因此“版本管理”标签可能仍然可见并提示无法列出仓库；要在界面上完全移除标签，请在 **Plugins** 里关闭该 bundle。关闭 bundle 会同时移除两半。

## 开发

```sh
npm install          # 只有 esbuild 一个开发依赖
node --test          # 单元与路由测试
node scripts/build.mjs
npm pack --dry-run   # 打包检查
```

`client.js` 是产物：改 `src/client/` 后重新构建。Host 半是普通 ESM，无运行时依赖。

安装、升级与卸载验证使用假 `DSH_HOME`；测试期间不要让 `dsh plugin` 指向真实 profile。

## 设计说明与偏差

- **diff 渲染**改编自 DSH 内部的 `FileDiff`（MIT，Copyright (c) 2026 DeepSeek），因为外部插件不应加载 Harness Client 包。内嵌版本保留原有状态、行号、split 同步滚动和截断行为。
- **图的布局**是 `git-graph-plus` 对 SourceGit 移植的裁剪版（Apache-2.0；SourceGit 为 MIT）。日志路由不提供 upstream 关系，因此省略 remote-only/local-only 着色；lane 分配、合并、第一父延续和颜色回收保留。
- **语法高亮**使用本地 tokenizer，而不是宿主未对外导出的 Shiki 组件。span 颜色引用宿主主题的 Shiki CSS 变量（`--shiki-token-*`），跟随当前主题；支持常见源码语言，其余回退纯文本，识别结果允许近似。
- 本版本**不做** hunk 间未改动行展开、blame、图片 diff、submodule 浏览，也不做 `HEAD`/所有分支以外的提交搜索。
- **切换仓库**时，当前视图会记住每个仓库各自的选中节点、目录折叠和历史范围；刷新页面后只恢复刷新前打开的那个仓库。
- **折叠上限**按文件报告的改动行数计算，不是实际渲染行数（后者还包含少量上下文行）。

## 安全

六条路由全部通过 `ctx.connection.fetch` 注册，沿用 DSH 的浏览器认证围栏。请求绑定到活跃会话的工作目录；`repo` 查询必须命中服务端自己发现的仓库集合，每个路径都经组合文件系统解析并要求位于仓库内（含符号链接）。Git 以固定 argv、`--no-pager`、`--no-ext-diff` 和清理过的环境运行，请求值不会作为选项进入 git。输出与时间都有上限，失败统一返回 `{ error: { code, message } }`。

## 许可

MIT。第三方声明见 [`NOTICE`](NOTICE) 与 [`licenses/`](licenses/)。
