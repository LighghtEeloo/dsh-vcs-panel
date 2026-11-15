# TODO

本文记录实现状态、待验证项与排期。产品形态见 `DESIGN.md`，实现契约见 `IMPLEMENTATION.md`。

## 变更树（设计已定，未实现）

`DESIGN.md` 自 2026-11-15 起按“变更树”描述详情区；代码仍是“文件导航 + diff 流”两个区域。
落地之前，`IMPLEMENTATION.md` 的“详情与 diff”“状态与持久化”与 README 的 “One detail view” 仍描述现有实现。

### Client

- [ ] 行模型：`detail/tree.js` 产出分组行、压缩后的目录链与文件行；可加载的未跟踪目录不参与压缩。
  文件行携带 section key，渲染、键盘与按需加载共用这一份行列表，`streamSections` 改为从它派生。
- [ ] 组件：新的 `ChangeTree` 取代 `FileNav.jsx` 与 `DiffStream.jsx`，沿用 `DiffStream` 的请求队列、缓存、
  `IntersectionObserver` 与估高。移除 `navInline`、`SIDE_NAV_WIDTH`、`INLINE_NAV_OPEN`，
  以及 `.vcs-detail-nav`、`.vcs-inline-nav*`、`.vcs-stream-group` 等样式。
- [ ] 两组：`worktreeGroups` 把 status 的 `untracked` 并入 `unstaged`，Host 应答不变。
  `diffTarget` 的 scope 改为取自文件本身（`?` 为 `untracked`），不再等于所在分组；
  未跟踪目录的子项读取（`dirChildren`、`dirs` 的键）改挂在 `unstaged` 分组下；
  分组文件数包含未跟踪项，`worktreeSummary` 的增删行数口径不变。
  旧会话里以 `untracked|` 开头的折叠与目录键失效一次，`sanitizeState` 可直接丢弃。
- [ ] 折叠：分组与目录记在 `collapsed`，分组键需要与目录键不冲突的形式；文件记在 `folds`。
  `defaultFolds` 的预算继续按完全展开的顺序计算。
- [ ] 吸顶：分组行 `top: 0`；展开文件行的 `top` 等于分组行高度，没有分组行时为 0。展开文件行显示父路径。
- [ ] 工具栏：全部收起/展开按钮（图标、`aria-label`、悬停提示）；提交节点补文件数、增删行数与比较基准；
  左右对比的宽度回退阈值写入 `IMPLEMENTATION.md` 的“上限”。
- [ ] 键盘：单一区域的光标模型；`]` / `[` hunk 跳转；区分键盘驱动的滚动与用户滚动，决定谁跟随谁；
  `keys.js` 的注释同步为“时间线与变更树”。
- [ ] 无障碍：disclosure 语义、`aria-controls`、roving tabindex。
- [ ] 阅读位置：anchor 的 key 扩展为任意行键；旧会话保存的段 key 与文件行键同形，可直接沿用。
- [ ] 本地化（八种语言）：分组比较基准、提交比较基准（普通、merge、root、Jujutsu）、全部收起/展开、
  左右对比的宽度回退提示；删除不再使用的 `nav.*` 键与 `changes.untracked` 分组名。

### 测试

- [ ] `tree.js`：分组行、目录链压缩、可加载目录不压缩、收起后子行与对应 section 一起消失。
- [ ] `detail.js`：预算与目录折叠无关；全部收起/展开的状态变换与默认规则的关系；
  未跟踪文件进入 `unstaged` 分组但按 `untracked` scope 请求，与已跟踪文件同目录排序，未跟踪目录带 `?` 且不被压缩。
- [ ] 键盘：移动越过 diff 本体、`→` 展开或进入、`]` / `[` 跳过收起的文件、`←` / `Esc` 回时间线。
- [ ] 状态：新字段的 `sanitizeState`；旧 anchor 的兼容。

### 文档（落地时）

- [ ] `IMPLEMENTATION.md`：“详情与 diff”“状态与持久化”“上限”。
- [ ] `README.md` 与 `README.zh.md` 的详情描述。
- [ ] `CHANGELOG.md`。

### 待验证

- 两层吸顶在矮窗口（约 500px 高）里留给 diff 的高度；不够时是否只吸文件行。
- `]` / `[` 在德语、法语等布局下需要 AltGr，会被 `unmodified` 判为带修饰键；需要备用键或放宽判断。
- “全部展开”回到默认规则，而不是恢复收起前的逐个选择，是否符合预期。
- 数百个文件全部收起时的行数与滚动性能；行目前不虚拟化。
- 实机验证：在运行中的 DSH Web 界面检查常用操作、键盘焦点、窗口尺寸与状态恢复，并与夹具测试分开报告。
