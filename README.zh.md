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

会话视图页签里会多出一个“版本管理”（英文及其他语言显示 `VCS`，避免名称过长被截断；位于 Chat、Trajectory 之后），不打开终端就能回答两个问题：

- **Changes（改动）** — 现在改了什么。已暂存、未暂存、未跟踪三组，可折叠目录树，文件级增删行数，以及选中文件的 unified / split diff（可自动换行）。重命名会同时显示旧、新路径，并按源路径比较。
- **History（历史）** — 仓库怎么走到这里。从 `HEAD` 或所有分支可达的提交、彩色 lane 图、ref 徽标（`HEAD` 所指分支合成一个高亮徽标，对应 `HEAD -> main`），以及选中提交的完整 ID、父提交、作者/提交者、消息正文和变更文件。已加载历史中的父提交可点击跳转。已加载的提交只有一位作者时，行内不显示作者；列表较窄时也不显示。提交内选中文件后，显示相对第一父提交的 diff（根提交与空树比较）。

顶部栏选择仓库：会话工作目录所属仓库，以及其下一层的子仓库。分支、ahead/behind、改动摘要始终可见。顶部栏的锁形标识（悬停提示“只读”）是产品边界：所有 Host 路由只读，不做 stage、commit、discard、checkout、merge、rebase、stash、fetch、pull、push。

数据在打开面板、点击刷新、以及面板隐藏超过 30 秒后重新可见时刷新一次；没有定时轮询。

## 交互

- 点击文件或目录选择、折叠；点击提交查看详情。
- 工作区干净时默认打开 History，有改动时默认打开 Changes；点过页签后按本次会话的选择，不再自动切换。
- 键盘：`↑`/`↓` 或 `j`/`k` 移动，`Enter` 打开，`Esc` 在窄窗口返回；输入框和下拉框内不拦截按键。
- 侧栏可拖动分隔条调整宽度（280–480 px），分隔条获得焦点后也可用方向键调整。
- 仓库、页签、选中项、展开的目录、布局选择和滚动位置按会话存在 `sessionStorage`，刷新页面可恢复。
- 明暗主题、系统字号、焦点环和 `prefers-reduced-motion` 走 DSH 约定。

## 上限

| 项目 | 上限 |
| --- | --- |
| 每个会话列出的仓库 | 50（会话仓库 + 一层子仓库） |
| 每组状态文件数 | 500 |
| 展开一个未跟踪目录的条目 | 500 |
| 渲染的 diff 行数 | 5,000；超出返回 `oversized` |
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
  entry.jsx           注册 Git 视图、语言字典与样式
  VcsView.jsx         面板外壳：取数、选中、键盘、拖宽、状态恢复
  api.js              Host 路由的 fetch 层
  changes/            改动列表、目录树、diff 面板
  diff/               内嵌的 DSH FileDiff + 本地语法 tokenizer
  history/            lane 布局移植、SVG 图、虚拟列表、提交面板
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

`enabled: false` 时 Host 不注册任何路由。Client 半仍随 bundle 加载，因此 `Git` 标签可能仍然可见并提示无法列出仓库；要在界面上完全移除标签，请在 **Plugins** 里关闭该 bundle。关闭 bundle 会同时移除两半。

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
- **切换仓库**时，当前视图会记住每个仓库各自的选中项、展开目录和历史范围；刷新页面后只恢复刷新前打开的那个仓库。

## 安全

六条路由全部通过 `ctx.connection.fetch` 注册，沿用 DSH 的浏览器认证围栏。请求绑定到活跃会话的工作目录；`repo` 查询必须命中服务端自己发现的仓库集合，每个路径都经组合文件系统解析并要求位于仓库内（含符号链接）。Git 以固定 argv、`--no-pager`、`--no-ext-diff` 和清理过的环境运行，请求值不会作为选项进入 git。输出与时间都有上限，失败统一返回 `{ error: { code, message } }`。

## 许可

MIT。第三方声明见 [`NOTICE`](NOTICE) 与 [`licenses/`](licenses/)。
