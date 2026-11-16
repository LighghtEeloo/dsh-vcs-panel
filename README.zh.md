# dsh-vcs-panel

[English](README.md) | 中文

> DeepSeek Harness 里的只读版本管理页：工作区改动、文件 diff，以及带 lane 图的提交历史；支持 Git 与 Jujutsu 仓库。

**v0.1.0**

## 能做什么

会话视图里的 `VCS` 页把工作区与提交历史放在一条时间线上，并用一棵变更树回答“这一步改了什么”：每个改动文件是一行，文件的 diff 就在它自己那一行下面展开。不用打开终端或完整的 Git 客户端，就能回答“现在改了什么”和“仓库怎么走到这里”。

- **一条时间线。** Git 的工作区或 Jujutsu 的工作副本提交 `@` 是第一行；提交按拓扑顺序排在下面，带彩色 lane 图、ref、短 ID、作者和时间。
- **一种详情：变更树。** 选中任意行，节点的改动成为一棵树。全部收起时它就是文件列表；展开一个文件，diff 就在该行下面读。单子目录链压成一行，阅读时分组行与文件行吸顶，diff 在接近视口时才加载；`[` / `]` 跨 hunk 与文件跳转，工具栏一个按钮在文件列表与整条阅读流之间切换。
- **Git 与 Jujutsu 按各自的模型显示。** 仓库根目录的标记决定后端：Git 显示工作区、已暂存/未暂存两组（未跟踪项以 `?` 并入未暂存）、分支与 ahead/behind；Jujutsu 显示 `@`、变更 ID、书签，每个提交只有一组改动。
- **面向大仓库。** 虚拟列表、按文件请求、明确的上限和截断提示，保证面板在大历史和大 diff 下仍然可用。
- **对话结束只有一个入口。** 有文件改动的一轮结束时显示一条全宽版本管理横幅（左侧为分支或 `@` 状态与改动文件数，右侧为当前工作状态的总增删行数 `+` / `−` 与跳转图标），替代 DSH 自带的改动文件卡片；点击横幅切到本页。每轮文件列表被有意去掉，工作区改动始终在页内完整可见。横幅在该轮的 DSH 改动记录出现时显示（shell 命令计入，同一工作区内的子代理改动也计入），或该轮有成功的文件写入工具调用时显示。
- **一个键回到改动。** macOS 用 `⌘⇧G`，其他平台用 `Ctrl+Shift+G`，在会话内任意位置切换版本管理视图；再按一次回到离开前的视图。可在 **Settings → Shortcuts** 中重绑定；Web 上默认键位可能与浏览器自带快捷键冲突。
- **长在 DSH 上。** 主题 token、焦点环、`prefers-reduced-motion` 和键盘操作跟随宿主；面板会记住本次会话的仓库、选中项和阅读位置。
- **只读。** 不 stage、commit、checkout、merge、rebase、stash、fetch、pull 或 push；Jujutsu 读取时的快照是面板唯一的写入，锁形提示会说明。
- **八种界面语言。** 中文、英文、日文、西班牙文、法文、德文、俄文、葡萄牙文；日期、相对时间与数字分组跟随 DSH。

## 安装

需要 DSH 0.2.2-rc.1 或更新版本，且 Host 提供 Web Client（Desktop 与 Web 均可）。

```sh
dsh plugin --profile desktop add link:/path/to/dsh-vcs-panel
```

也可以用 `plugin_manager` 的 `install_bundle`，或在 Web 侧栏的 **Plugins** > **Add plugin** 里选择该目录。安装后重启 DSH；`VCS` 页签位于 Chat、Trajectory 之后。

安装同时会隐藏 DSH 在对话里显示的每轮改动卡片，改由版本管理横幅作为入口；改动记录器、交付卡片与本机打开都继续工作。卸载插件后卡片恢复。

Jujutsu 仓库需要 Host 的 `PATH` 上有 `jj`；缺少时仍会列出仓库，读取返回 `vcs-missing`。

面板内没有自己的设置页；快捷键在 DSH 的 **Settings → Shortcuts** 中重绑定。要移除页签，在 **Plugins** 里关闭或卸载该插件。

## 开发

```sh
npm install          # 只有 esbuild 一个开发依赖
npm run check        # node --test，然后检查 client.js 是否为最新
npm run build        # 从 src/client/ 重新生成 client.js
npm pack --dry-run   # 打包检查
```

`client.js` 是产物：改 `src/client/` 后重新构建，不手改。Host 侧是普通 ESM，无运行时依赖。`PATH` 上有 `jj` 时运行 Jujutsu 路由测试，否则跳过。安装、升级与卸载验证使用假 `DSH_HOME`；测试期间不要让 `dsh plugin` 指向真实 profile。

## 文档

产品设计：`DESIGN.md`。路由、数据形状、构建与上限：`IMPLEMENTATION.md`。变更：`CHANGELOG.md`。

## 许可

MIT。第三方声明见 `NOTICE` 与 `licenses/`。
