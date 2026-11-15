# TODO

本文记录实现状态、待验证项与排期。产品形态见 `DESIGN.md`，实现契约见 `IMPLEMENTATION.md`。

## 变更树（2026-11-15 落地）

`DESIGN.md` 的“详情”“变更树”与“交互与状态”已按实现改写；
`IMPLEMENTATION.md` 的“变更树”“状态与持久化”“上限”与 README 的 “One change tree” 描述当前实现。

### Client

- [x] 行模型：`detail/tree.js` 产出分组行、压缩后的目录链与文件行；可加载的未跟踪目录不参与压缩、
  默认收起、展开时按需读取。文件行携带 section key；渲染、键盘与按需加载共用这一份行列表，
  `streamSections` 从它派生。
- [x] 组件：`ChangeTree.jsx` 取代 `FileNav.jsx` 与 `DiffStream.jsx`，沿用请求队列、缓存、
  `IntersectionObserver` 与估高；删除 `navInline`、`SIDE_NAV_WIDTH`、`INLINE_NAV_OPEN` 及旧样式。
- [x] 两组：`worktreeGroups` 把 status 的 `untracked` 并入 `unstaged`；`diffTarget` 的 scope 取自文件；
  未跟踪目录的 `dirs`/`dirChildren` 键挂在 `unstaged` 分组下；分组文件数含未跟踪项，
  `worktreeSummary` 的增删行数口径不变。
- [x] 折叠：分组与目录记在 `collapsed`（分组键 `staged|` / `unstaged|`），文件记在 `folds`；
  `defaultFolds` 的预算按完全展开顺序计算。
- [x] 吸顶：分组行 `top: 0`；展开文件行 `top: 28px`（无分组行时为 0）；目录行不吸顶；展开文件行显示父路径；
  收起已吸顶的文件行时它留在原位、下一行接上。
- [x] 工具栏：全部收起/展开按钮（图标、`aria-label`、悬停提示）；提交节点补文件数、增删行数与
  四种比较基准；左右对比的 640px 回退阈值写入 `IMPLEMENTATION.md` 的“上限”。
- [x] 键盘：单一区域的光标模型、`]` / `[` hunk 跳转、键盘滚动与用户滚动区分、`keys.js` 注释与 AltGr 判断。
- [x] 无障碍：disclosure 语义、`aria-controls`、roving tabindex、`aria-current` 标记阅读行。
- [x] 阅读位置：anchor 的 key 扩展为任意行键；刷新数据后按刷新前锚点恢复；旧 `untracked|` 键丢弃。
- [x] 本地化（八种语言）：分组/提交比较基准、全部收起/展开、单栏回退提示；删除 `nav.*`、
  `changes.untracked`、`stream.label`。

### 测试

- [x] `tree.js`：分组行、目录链压缩、可加载目录不压缩、收起后子行与对应 section 一起消失。
- [x] `detail.js`：预算与目录折叠无关；全部收起/展开与默认规则的关系；未跟踪文件进入 `unstaged`
  但按 `untracked` scope 请求、与已跟踪文件同目录排序、未跟踪目录带 `?` 且不被压缩。
- [x] 键盘：`keys.test.mjs` 覆盖方向词汇、方括号与 AltGr；交互行为由夹具页验证（见任务 `evidence/`）。
- [x] 状态：新字段的 `sanitizeState`；旧 anchor 与旧 `untracked|` 键的兼容。

### 文档（已同步）

- [x] `IMPLEMENTATION.md`：“变更树”“状态与持久化”“上限”。
- [x] `README.md` 与 `README.zh.md` 的详情描述。
- [x] `CHANGELOG.md`。

### 待验证

- 两层吸顶在矮窗口的观感：夹具页在 1200×500 下量得分组行 28px + 文件行 28px，diff 仍有约 330px 可读区，
  保留两层吸顶。实机窗口复核见任务 `evidence/`。
- `]` / `[` 在德语、法语等 AltGr 布局下的实机按键：`keys.test.mjs` 覆盖 `AltGraph` 判定；
  实机键盘布局未在夹具环境验证，需要一次实机复核。
- “全部展开”回到默认规则、不恢复收起前的逐个选择：按设计保留；夹具页验证了过大的文件仍收起。
  若用户反馈应恢复逐个选择，属于产品调整，先问用户。
- 行目前不虚拟化：夹具页 50 个可见行的折叠/滚动未出现明显卡顿，未测数百个文件；
  出现卡顿时先记录行数、滚动帧率与操作步骤，再提虚拟化方案。
- 实机验证：在运行中的 DSH Web 界面检查常用操作、键盘焦点、窗口尺寸与状态恢复；
  记录在任务 `evidence/`，与夹具测试分开报告。
