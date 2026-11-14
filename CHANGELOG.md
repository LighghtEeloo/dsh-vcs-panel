# 变更日志

## 0.1.0

首个版本：只读版本管理面板。

- 会话视图新增“版本管理”页（英文及其他语言显示 `VCS`，避免名称过长被截断），位于 Chat、Trajectory 之后。
- `Changes`：已暂存 / 未暂存 / 未跟踪三组、可折叠目录树、文件增删行数、untracked 目录按需展开；选中文件显示 unified / split diff，支持自动换行、创建/删除/无变化/二进制/超大/读取失败状态；重命名按源路径比较并显示旧 → 新名字。
- `History`：`HEAD` / 所有分支两种范围，300 条一页、最多 10,000 条；lane 图与虚拟列表共用滚动容器；提交详情包含完整 ID、父提交、作者/提交者、消息和变更文件；选中文件显示相对第一父提交的 diff。
- 六条只读 Host 路由：`vcs.repositories`、`vcs.status`、`vcs.untracked`、`vcs.diff`、`vcs.log`、`vcs.commit`，全部注册在 `ctx.connection.fetch` 的认证围栏内。
- 路径 containment（含符号链接）、仓库白名单、SHA 校验、固定 argv 与清理环境，防止选项注入与目录逃逸。
- 会话内恢复仓库、页签、选中项、展开目录、布局与滚动位置；切换仓库时记住各自的选中项与历史范围；刷新按钮与重新可见时的轻量刷新，无轮询。
- 工作区没有改动时默认打开 `History`，有改动时默认打开 `Changes`；用户选择页签后不再自动切换。
- 修复：未跟踪目录截断提示缺少 `{count}` 参数；仓库数量上限提示使用实际列表长度。
- 日期、相对时间与数字分组按 DSH 当前语言格式化，切换语言后更新；数字与截断提示统一走本地化格式化。
- 修复：DSH 使用 React 18，`ref` 不会传入函数组件 props；历史列表的 ref 徽标改用普通 `reference` prop，避免打开历史时白屏。
- 八种语言（zh、en、ja、es、fr、de、ru、pt）。
- 内嵌 DSH `FileDiff`（MIT）并适配本地 hunk；移植裁剪后的 git-graph-plus lane 布局（Apache-2.0）；本地语法 tokenizer 使用宿主 Shiki CSS 变量着色。
