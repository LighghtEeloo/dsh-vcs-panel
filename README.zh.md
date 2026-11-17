# dsh-vcs-panel

[English](README.md) | 中文

DeepSeek Harness 会话内的版本管理插件。在会话视图新增 `版本管理` 页签（其他语言为 `VCS`），支持 **Git** 与 **Jujutsu** 仓库的工作区改动、语法高亮 diff，以及带 lane 图的提交历史，并可将 Git 分支与上游同步或切换本地分支。

## 功能概览

- **时间线与 lane 图。** 工作改动（Git 的工作区或 Jujutsu 的 `@`）固定在顶部，下方按拓扑顺序排列提交历史，展示分支、书签、标签，并可在 `HEAD` / `@` 与全部提交之间切换范围；支持多仓库工作区。
- **内联变更树。** 收起时作为可折叠文件列表浏览，展开任一文件即可在原位阅读 diff，支持文件头吸顶、单栏或左右对比、自动换行。
- **贴合 Git 与 Jujutsu 模型。** Git 显示已暂存 / 未暂存分组（未跟踪项标为 `?`）与 ahead/behind；Jujutsu 显示 `@`、变更 ID 与书签。
- **轮末横幅与全局快捷键。** 有文件改动的对话轮次末尾显示紧凑的版本管理横幅（展示该轮所在的分支或 `@`、本轮改动文件数与 `+` / `−` 行数统计），替代对话自带的改动文件卡片；在任意视图按 `⌘⇧G` / `Ctrl+Shift+G` 即可切入或返回。
- **一键同步。** Git 分支旁的按钮显示 ahead/behind 计数；点击后抓取上游，再快进或推送。分支已分叉、快进会覆盖本地改动或分支没有上游时不做改动，并提示下一步怎么做。
- **切换分支。** 分支名本身是菜单：展开仓库的本地分支，选中即检出。菜单只列本地分支，不隐式创建远程分支的本地副本；会覆盖本地改动时 Git 拒绝，面板不贮藏、不丢弃、不强制。
- **其余只读。** 同步与切换分支是仅有的写操作：不执行暂存、提交、合并、变基、强制推送、丢弃改动或创建分支（Jujutsu 仅在读取时快照工作副本）。跟随 DSH 主题与全部 8 种界面语言，大历史与大 diff 按需加载。

## 快捷键

| 按键 | 操作 |
| --- | --- |
| `⌘⇧G` / `Ctrl+Shift+G` | 打开 `版本管理` 或返回上一视图（可在 **Settings → Shortcuts** 重绑定） |
| `↑` `↓` 或 `j` `k` | 沿一条纵向列表移动：变更树的行与展开文件的 hunk header |
| `←` `→` 或 `h` `l` | 进入变更树或展开的行；`←` / `h` 先收起展开的文件，再按才返回时间线 |
| `Enter`、`Space`、`Esc` | 折叠/展开当前行；`Esc` 返回时间线 |
| `↑` `↓`、`Home` `End` | 在展开的分支菜单内移动；`Esc` 关闭菜单 |
| `[` / `]` | 在变更树中移动到上一行 / 下一行，跳过 hunk header |

## 安装

需要 **DSH 0.2.2-rc.1+**（Desktop 或 Web），且 `PATH` 中包含 `git` 或 `jj`。

- **界面安装：** 打开 **Plugins → Add plugin**，选择本目录后重启 DSH。
- **命令行安装：**
  ```sh
  dsh plugin --profile desktop add link:/path/to/dsh-vcs-panel
  ```
  添加后重启 DSH。可随时在 **Plugins** 中停用或卸载（卸载后恢复对话默认的改动文件卡片）。

## 开发

```sh
npm install          # 安装开发依赖 esbuild
npm run build        # 从 src/client/ 构建 client.js
npm run check        # 运行 node --test 并检查 client.js 是否为最新
npm pack --dry-run   # 检查打包内容
```

修改客户端代码请编辑 `src/client/` 并运行 `npm run build` 更新产物 `client.js`。验证 `dsh plugin` 安装、升级与卸载时请使用临时 `DSH_HOME`，保持真实 profile 独立。

产品设计：[`DESIGN.md`](DESIGN.md) · 实现与上限：[`IMPLEMENTATION.md`](IMPLEMENTATION.md) · 变更日志：[`CHANGELOG.md`](CHANGELOG.md) · 许可：MIT（[`LICENSE`](LICENSE)、[`NOTICE`](NOTICE)）
