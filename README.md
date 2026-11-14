# dsh-vcs-panel

English | [中文](README.zh.md)

> A read-only version control tab for DeepSeek Harness conversations: working changes, file diffs, and commit history with a lane graph, for Git and Jujutsu repositories.

**Status: v0.1.0.** See [`DESIGN.md`](DESIGN.md) for the product design and [`CHANGELOG.md`](CHANGELOG.md) for changes.

## Install

Requires DSH 0.2.2-rc.1 or later, with a Host that serves the Web Client (Desktop and Web both work).

```sh
dsh plugin --profile desktop add link:/path/to/dsh-vcs-panel
```

You can also install the directory with `plugin_manager`'s `install_bundle`, or with **Plugins** > **Add plugin** in the Web sidebar.
Restart DSH after installing the Host half.

## What you get

A `VCS` (version control) view appears in the conversation view tabs, after Chat and Trajectory. It answers two questions without opening a terminal — what is changing now, and how the repository got here — on one timeline.

The view reads a repository through a backend chosen by its marker: `.jj` (Jujutsu, preferred when both markers exist) or `.git`. The layout then follows the backend's model. Git keeps a working tree beside `HEAD`; Jujutsu's working copy is the commit `@`, so `@` is an ordinary first row. The Host exposes capabilities (working-copy shape, staging, change ids, ranges), and the client lays itself out from those rather than from a backend name. Jujutsu repositories need `jj` on the Host's `PATH`; without it the repository is still listed and reads report `vcs-missing`.

- **Timeline** (left). With Git the first row is the working tree: how many files changed and the added/deleted lines, or "Nothing changed"; it hangs off `HEAD` with a dashed lane. With Jujutsu the first row is the working-copy commit `@`, marked with an `@` badge and carrying its change id and change counts. Below either are commits with a colored lane graph, with short ids or change ids, refs, author (only when the loaded history has more than one), and time. Git's refs are branches, remotes, and tags; Jujutsu's are bookmarks, remote bookmarks (`main@origin`), and tags.
- **Detail** (right). Selecting the working state or a commit shows the same layout: a header, the changed files, and every file's diff one after another. Git's working tree groups its files as staged, unstaged, and untracked and compares staged files with `HEAD`, unstaged files with the index, and untracked files as new. Jujutsu's `@` and every other commit show one changes list; a commit's files are compared against the automatic merge of its parents, which is Jujutsu's own `jj diff` meaning, and the header also shows the change id. A commit shows its subject, author/committer, parents (loaded parents open with a click), message body, and files (root commits compare against the empty tree). Renames show both names and compare against the source path. Diffs are unified or split, with optional line wrapping; both switches are icon buttons in the detail toolbar, matching DSH's built-in diff viewer.

Clicking a file in the file list scrolls the diff stream to it, and the list marks the file being read. Diffs load as they come into view, a few at a time. A file with more than 1,000 changed lines starts collapsed, as does everything after the first 20,000 changed lines of one node; expanding is one click.

The top bar picks the repository (the one containing the session's working directory plus repositories nested one level below it), shows the branch with ahead/behind counts (Git) or `@` with its change id and bookmarks (Jujutsu), and switches the history range: `HEAD` / all commits for Git, `@` / all commits for Jujutsu. The lock marker is part of the contract: every Host route reads; there is no staging, committing, discarding, checkout, merge, rebase, stash, fetch, pull, or push. Jujutsu reading itself snapshots the working copy, so the lock tooltip states that exception.

Data refreshes on opening, on the refresh button, and once when the panel becomes visible after being hidden for more than 30 seconds. There is no polling. A refresh keeps the selected node and the reading position.

## Interaction

- Click a timeline row to show its detail; click a file to jump to its diff; click a folder or a diff header to fold it.
- Until you pick a row, the backend's default is shown: the working tree when it has changes and the `HEAD` commit when it is clean (Git), or the working-copy commit `@` (Jujutsu). Once you pick one, the choice is kept for the session; a picked commit that disappears (amend, rebase, rewrite) falls back to that default.
- Keyboard, ignored in text inputs and selects:
  - Timeline: `↑`/`↓` or `j`/`k` select the previous/next row; `Enter` or `→` moves into the file list.
  - File list: `↑`/`↓` or `j`/`k` move between files and scroll the diffs along; `Enter` folds a folder; `←` or `Esc` returns to the timeline.
  - Diff stream: `Esc` returns to the file list.
- The timeline is resizable (280–480 px) by dragging the divider; arrow keys adjust it when it has focus. When the detail is narrower than 720 px the file list moves above the diffs as a collapsible list; below 760 px the panel shows the timeline and the detail one at a time, with a back button.
- Repository, selected row, history range, folded folders and diffs, layout choices, and reading positions are stored per session in `sessionStorage` and restored after a page refresh.
- Light and dark themes, system font sizing, focus rings, and `prefers-reduced-motion` follow DSH.

## Limits

| Limit | Value |
| --- | --- |
| Repositories listed per session | 50 (session repository plus one level of children) |
| Files per status group (Git) | 500 |
| Files per commit detail | 500 |
| Entries when opening one untracked directory (Git) | 500 |
| Rendered diff lines per file | 5,000; larger comparisons report `oversized` |
| Diffs unfolded by default | files up to 1,000 changed lines, until 20,000 changed lines per node |
| Diff requests in flight | 4 |
| Diff output | 2 MB |
| Commits per page | 300 |
| Commits loaded at most | 10,000; older history is reported as truncated |
| Backend command | 30 s, 8 MB stdout |
| Jujutsu snapshot | once per refresh; every other read reuses it with `--ignore-working-copy` |

## Languages

The panel ships Chinese, English, Japanese, Spanish, French, German, Russian, and Portuguese dictionaries. A locale without a dictionary falls back to English. Dates, relative times, and digit grouping follow the active DSH language. Plugin metadata (title and description) is in `locale/*.json`.

## Layout

```text
index.js              Host: authenticated read-only /api/vcs.* routes
lib/                  Host internals: command runner, repository discovery, path containment, parsers
lib/vcs/              Backend registry and capabilities; git.js, jujutsu.js
lib/jujutsu.js        Jujutsu templates, JSON records, refs, and file-list helpers
src/client/           Client sources (React, no Harness Client package imports)
  entry.jsx           Registers the version control view, locale dictionaries, and stylesheet
  VcsView.jsx         Panel shell: data loading, selection, layout, resizing, persistence
  api.js              Fetch layer for the Host routes
  history/            Timeline: lane layout port, SVG graph, virtual list
  detail/             Detail pane: file groups, directory tree, file list, diff stream, request queue
  diff/               Vendored DSH FileDiff + local syntax tokenizer
client.js             Built from src/client/ by scripts/build.mjs; do not edit by hand
cordis.patch.yml      Plugin row (Host config `enabled: false` registers nothing)
locale/               Plugin metadata per language
test/                 node --test suites
```

## Configuration

The only Host option is the on/off switch, set in the profile patch row:

```yaml
- id: dsh-vcs-panel
  name: dsh-vcs-panel
  config:
    enabled: false
```

With `enabled: false` the Host registers no routes. The Client half still loads with the bundle, so its `VCS` tab can remain visible and reports that repositories cannot be listed; turn the bundle off in **Plugins** to remove the tab. Turning the feature off at the bundle level removes both halves.

## Development

```sh
npm install          # esbuild, the only development dependency
node --test          # unit and route tests
node scripts/build.mjs
npm pack --dry-run   # packaging check
```

`client.js` is generated; edit `src/client/` and rebuild. The Host half is plain ESM with no runtime dependencies. Jujutsu route tests run when `jj` is on `PATH` and are skipped otherwise.

Install, upgrade, and uninstall checks use a fake `DSH_HOME`; do not point `dsh plugin` at the real profile during testing.

## Design notes and deviations

- **Backend capabilities** are data on the discovery and status answers: `workingCopy` (`row` or `commit`), `workingCopyNode`, `staging`, `untracked`, `changeId`, `aheadBehind`, `snapshots`, `ranges`, and `defaultRange`. A new backend supplies its routes and this object; the client has no branch on a backend name.
- **Jujutsu reading writes the working copy.** `jj` snapshots the working copy as part of reading it, so `@` cannot be current without that write. The panel snapshots once per refresh and reuses that answer for the refresh, then reads everything with `--ignore-working-copy`; it never creates, moves, or rewrites a user commit or bookmark.
- **Diff rendering** is adapted from DSH's internal `FileDiff` (MIT, Copyright (c) 2026 DeepSeek), because external plugins must not load Harness Client packages. The vendored copy keeps the original states, line numbering, split scrolling, and truncation.
- **Graph layout** is a trimmed port of `git-graph-plus`'s SourceGit port (Apache-2.0; SourceGit is MIT). Remote-only/local-only coloring is omitted because the log route does not expose upstream tracking; lane allocation, merges, first-parent continuation, and color recycling remain.
- **Syntax highlighting** is a local tokenizer, not the host's Shiki component, which is not exposed to external plugins. It emits spans colored with the host theme's Shiki CSS variables (`--shiki-token-*`), so colors follow the active theme. It supports common source languages and falls back to plain text for the rest; highlighting can be approximate.
- **No hunk gap expansion**, no blame, no image diff, no submodule browsing, and no commit search beyond the current range or all commits in this version.
- **Repository switching** remembers the selected node, folders, and history range of each repository for the current view instance; the persisted state restores only the repository that was open when the page reloaded.
- **Fold limits** count the changed lines a file reports, not rendered lines, which also include a few lines of context.

## Security

All six routes are registered through `ctx.connection.fetch`, so they inherit DSH's browser authentication fence. Each request is tied to a live session's working directory; repository queries are checked against the server's own discovery result, and every path is resolved with the composed filesystem and required to be contained in the repository (symlinks included). The selected backend runs with fixed argv and a scrubbed environment; request values never reach a command as options. Git adds `--no-pager`, `--no-ext-diff`, and no optional locks; Jujutsu adds `--color=never`, `--no-pager`, and `--ignore-working-copy` for every read after the snapshot. Output and time are bounded, and failures return a stable `{ error: { code, message } }` shape.

## License

MIT. Third-party notices are in [`NOTICE`](NOTICE) and [`licenses/`](licenses/).
